import type { TTSProvider, TTSRequest } from '../contracts/ai';
import { telemetry } from '../telemetry/emitter';

export interface SynthesizeSpeechOpts {
  provider: TTSProvider;
  request: TTSRequest;
  sessionId?: string;
}

export async function synthesizeSpeech(
  opts: SynthesizeSpeechOpts,
): Promise<ReadableStream<Uint8Array>> {
  const { provider, request, sessionId } = opts;
  const startMs = Date.now();

  const stream = await provider.synthesize(request.text, {
    voiceId: request.voiceId,
    format: request.format,
  });

  if (sessionId) {
    const latencyMs = Date.now() - startMs;
    telemetry.emit({
      type: 'system.latency',
      sessionId,
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: { component: 'tts', latencyMs, voiceId: request.voiceId },
    });
  }

  return stream;
}
