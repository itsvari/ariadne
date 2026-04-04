import WebSocket from 'ws';
import type { TTSProvider, TTSRequest } from '@ariadne/shared-contracts';

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/speak';

function resolveDeepgramEncoding(format?: string): 'mp3' | 'opus' | 'linear16' {
  if (format === 'opus') {
    return 'opus';
  }
  if (format === 'pcm') {
    return 'linear16';
  }
  return 'mp3';
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

          socket.on('open', () => {
            socket.send(
              JSON.stringify({
                type: 'Speak',
                text,
              }),
            );
            socket.send(JSON.stringify({ type: 'Flush' }));
          });

          socket.on('message', (data: WebSocket.Data) => {
            if (Buffer.isBuffer(data)) {
              controller.enqueue(new Uint8Array(data));
            } else if (typeof data === 'string') {
              try {
                const message = JSON.parse(data) as { type?: string; err_msg?: string };

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
            }
          });

          socket.on('error', (error) => {
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
