import WebSocket from 'ws';
import type { TTSProvider, TTSRequest } from '@ariadne/shared-contracts';

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/speak';

function resolveDeepgramEncoding(format?: string): 'linear16' | 'mulaw' | 'alaw' {
  if (format === 'mulaw') {
    return 'mulaw';
  }
  if (format === 'alaw') {
    return 'alaw';
  }
  return 'linear16';
}

export class DeepgramTTSProvider implements TTSProvider {
  private apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.DEEPGRAM_API_KEY;
    if (!key) {
      throw new Error('DEEPGRAM_API_KEY is not configured');
    }
    this.apiKey = key;
  }

  synthesize(
    text: string,
    options?: { voiceId?: string; format?: string; sampleRate?: number },
  ): Promise<ReadableStream<Uint8Array>> {
    const model = options?.voiceId ?? 'aura-2-thalia-en';
    const encoding = resolveDeepgramEncoding(options?.format);
    const sampleRate = options?.sampleRate ?? 24000;
    const apiKey = this.apiKey;

    return Promise.resolve(
      new ReadableStream<Uint8Array>({
        start(controller) {
          let isClosed = false;

          const closeStream = () => {
            if (isClosed) {
              return;
            }
            isClosed = true;
            try {
              controller.close();
            } catch {
              // no-op
            }
          };

          const wsUrl = `${DEEPGRAM_WS_URL}?model=${encodeURIComponent(model)}&encoding=${encodeURIComponent(encoding)}&sample_rate=${sampleRate}`;
          const socket = new WebSocket(wsUrl, {
            headers: { Authorization: `Token ${apiKey}` },
          });

          socket.on('unexpected-response', (_req, response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            response.on('end', () => {
              const responseBody = Buffer.concat(chunks).toString('utf8');
              const details = responseBody
                ? `${response.statusCode ?? 'unknown'} ${response.statusMessage ?? ''} - ${responseBody}`
                : `${response.statusCode ?? 'unknown'} ${response.statusMessage ?? ''}`;
              const error = new Error(`Deepgram TTS websocket handshake failed: ${details}`);
              console.error(error.message);
              controller.error(error);
              closeStream();
            });
          });

          socket.on('open', () => {
            socket.send(
              JSON.stringify({
                type: 'Speak',
                text,
              }),
            );
            socket.send(JSON.stringify({ type: 'Flush' }));
          });

          socket.on('message', (data: WebSocket.Data, isBinary: boolean) => {
            if (isBinary) {
              if (Buffer.isBuffer(data)) {
                controller.enqueue(new Uint8Array(data));
              } else if (data instanceof ArrayBuffer) {
                controller.enqueue(new Uint8Array(data));
              } else if (Array.isArray(data)) {
                const merged = Buffer.concat(data.filter((chunk): chunk is Buffer => Buffer.isBuffer(chunk)));
                if (merged.length > 0) {
                  controller.enqueue(new Uint8Array(merged));
                }
              }
              return;
            }

            const text = typeof data === 'string'
              ? data
              : Buffer.isBuffer(data)
                ? data.toString('utf8')
                : data instanceof ArrayBuffer
                  ? Buffer.from(data).toString('utf8')
                  : '';

            if (!text) {
              return;
            }

            try {
              const message = JSON.parse(text) as { type?: string; err_msg?: string };

              if (message.type === 'Error') {
                controller.error(new Error(message.err_msg ?? 'Deepgram error'));
                socket.close();
              } else if (message.type === 'Flushed') {
                socket.send(JSON.stringify({ type: 'Close' }));
              } else if (message.type === 'Close') {
                closeStream();
                socket.close();
              }
            } catch {
              // no-op
            }
          });

          socket.on('error', (error) => {
            console.error('Deepgram TTS websocket error:', error);
            controller.error(error);
            closeStream();
          });

          socket.on('close', closeStream);
        },
      }),
    );
  }
}

export async function synthesizeSpeech(
  provider: TTSProvider,
  request: TTSRequest,
): Promise<ReadableStream<Uint8Array>> {
  return provider.synthesize(request.text, {
    voiceId: request.voiceId,
    format: request.format,
  });
}
