import WebSocket from 'ws';
import type { TTSProvider } from '../../contracts/ai';

const INWORLD_WS_URL =
  'wss://api.inworld.ai/tts/v1/voice:streamBidirectional';

export class InworldTTSProvider implements TTSProvider {
  private apiKey: string;

  constructor(apiKey?: string) {
    const key =
      apiKey ??
      process.env.NEXT_PUBLIC_INWORLD_API_KEY ??
      process.env.INWORLD_API_KEY;
    if (!key) {
      throw new Error('Inworld API key is not configured');
    }
    this.apiKey = key;
  }

  synthesize(
    text: string,
    options?: { voiceId?: string; format?: string },
  ): Promise<ReadableStream<Uint8Array>> {
    const voiceId = options?.voiceId ?? 'Clive';
    const encoding = (options?.format ?? 'MP3').toUpperCase();
    const authHeader = this.apiKey.startsWith('Basic')
      ? this.apiKey
      : `Basic ${this.apiKey}`;

    return Promise.resolve(
      new ReadableStream<Uint8Array>({
        start(controller) {
          let isClosed = false;

          const closeDown = () => {
            if (!isClosed) {
              isClosed = true;
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            }
          };

          const ws = new WebSocket(INWORLD_WS_URL, {
            headers: { Authorization: authHeader },
          });

          const ctxId = crypto.randomUUID();

          ws.on('open', () => {
            ws.send(
              JSON.stringify({
                context_id: ctxId,
                create: {
                  voice_id: voiceId,
                  model_id: 'inworld-tts-1.5-mini',
                  audio_config: {
                    audio_encoding: encoding,
                    sample_rate_hertz: 24000,
                  },
                },
              }),
            );
            ws.send(
              JSON.stringify({
                context_id: ctxId,
                send_text: { text, flush_context: {} },
              }),
            );
            ws.send(
              JSON.stringify({ context_id: ctxId, close_context: {} }),
            );
          });

          ws.on('message', (data: Buffer) => {
            try {
              const response = JSON.parse(data.toString());

              if (response.error) {
                if (!isClosed) controller.error(new Error(response.error.message));
                ws.close();
                return;
              }

              if (response.result?.audioChunk) {
                const b64 =
                  response.result.audioChunk.audioContent ??
                  response.result.audioContent;
                if (b64) {
                  const audioBytes = Buffer.from(b64, 'base64');
                  if (!isClosed) controller.enqueue(audioBytes);
                }
              }

              if (response.result?.contextClosed || response.done) {
                closeDown();
                ws.close();
              }
            } catch {
              /* ignore parse errors */
            }
          });

          ws.on('close', closeDown);

          ws.on('error', (err) => {
            if (!isClosed) controller.error(err);
            closeDown();
          });
        },
      }),
    );
  }
}
