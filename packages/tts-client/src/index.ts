import WebSocket from 'ws';
import type { TTSProvider, TTSRequest } from '@ariadne/shared-contracts';

const INWORLD_WS_URL = 'wss://api.inworld.ai/tts/v1/voice:streamBidirectional';

export class InworldTTSProvider implements TTSProvider {
  private apiKey: string;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.INWORLD_API_KEY;
    if (!key) {
      throw new Error('INWORLD_API_KEY is not configured');
    }
    this.apiKey = key;
  }

  synthesize(
    text: string,
    options?: { voiceId?: string; format?: string },
  ): Promise<ReadableStream<Uint8Array>> {
    const voiceId = options?.voiceId ?? 'Clive';
    const format = (options?.format ?? 'mp3').toUpperCase();
    const authHeader = this.apiKey.startsWith('Basic') ? this.apiKey : `Basic ${this.apiKey}`;

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

          const socket = new WebSocket(INWORLD_WS_URL, {
            headers: { Authorization: authHeader },
          });
          const contextId = crypto.randomUUID();

          socket.on('open', () => {
            socket.send(
              JSON.stringify({
                context_id: contextId,
                create: {
                  voice_id: voiceId,
                  model_id: 'inworld-tts-1.5-mini',
                  audio_config: {
                    audio_encoding: format,
                    sample_rate_hertz: 24000,
                  },
                },
              }),
            );
            socket.send(
              JSON.stringify({
                context_id: contextId,
                send_text: { text, flush_context: {} },
              }),
            );
            socket.send(JSON.stringify({ context_id: contextId, close_context: {} }));
          });

          socket.on('message', (data: Buffer) => {
            try {
              const message = JSON.parse(data.toString()) as {
                error?: { message?: string };
                result?: {
                  audioChunk?: { audioContent?: string };
                  audioContent?: string;
                  contextClosed?: boolean;
                };
                done?: boolean;
              };

              if (message.error?.message) {
                controller.error(new Error(message.error.message));
                socket.close();
                return;
              }

              const chunk = message.result?.audioChunk?.audioContent ?? message.result?.audioContent;
              if (chunk) {
                controller.enqueue(Buffer.from(chunk, 'base64'));
              }

              if (message.result?.contextClosed || message.done) {
                closeStream();
                socket.close();
              }
            } catch {
              // no-op
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
