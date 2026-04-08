import http from 'http';
import dgram from 'dgram';
import os from 'os';
import cors from 'cors';
import express from 'express';
import { DeepgramClient } from '@deepgram/sdk';
import { SharedBeliefStore } from '@ariadne/shared-belief-store';
import { OpenRouterChatProvider, CerebrasChatProvider } from '@ariadne/chat-providers';
import { DeepgramTTSProvider } from '@ariadne/tts-client';
import { AriadneOrchestrator } from './orchestrator';

const PORT = Number(process.env.PORT ?? 8081);
const DISCOVERY_ENABLED = (process.env.DISCOVERY_ENABLED ?? 'true').toLowerCase() !== 'false';
const DISCOVERY_PORT = Number(process.env.DISCOVERY_PORT ?? 9876);
const MAX_REQUEST_BODY_SIZE = '10mb';
const FLUX_SAMPLE_RATE_HZ = 16000;
const FLUX_TRANSCRIBE_TIMEOUT_MS = Number(process.env.FLUX_TRANSCRIBE_TIMEOUT_MS ?? 10000);
const FLUX_EOT_THRESHOLD = process.env.FLUX_EOT_THRESHOLD ?? '0.35';
const FLUX_EAGER_EOT_THRESHOLD = process.env.FLUX_EAGER_EOT_THRESHOLD ?? '0.25';
const FLUX_EOT_TIMEOUT_MS = process.env.FLUX_EOT_TIMEOUT_MS ?? '1200';

interface DiscoveryRequest {
  type?: string;
  protocolVersion?: string;
}

interface DiscoveryResponse {
  type: 'ariadne.discover.response';
  protocolVersion: 'v1';
  transport: 'ws';
  wsPort: number;
  wsPath: '/events';
  serverName: string;
  timestamp: string;
}

async function bootstrap(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required to start apps/server');
  }

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: MAX_REQUEST_BODY_SIZE }));

  const server = http.createServer(app);
  const beliefStore = new SharedBeliefStore();
  const valkeyHealthy = await beliefStore.healthCheck();
  if (!valkeyHealthy) {
    throw new Error('Valkey health check failed');
  }

  const talkerProvider = new CerebrasChatProvider();
  const thinkerProvider = new OpenRouterChatProvider();
  const ttsProvider = new DeepgramTTSProvider();
  const deepgram = process.env.DEEPGRAM_API_KEY
    ? new DeepgramClient({ apiKey: process.env.DEEPGRAM_API_KEY })
    : undefined;

  const orchestrator = new AriadneOrchestrator({
    httpServer: server,
    beliefStore,
    talkerProvider,
    thinkerProvider,
    ttsProvider,
    deepgramApiKey: process.env.DEEPGRAM_API_KEY,
    transcribeAudio: async ({ audioBuffer, sampleRateHz, channels }) => {
      if (!deepgram) {
        return null;
      }
      return transcribeAudioBuffer(deepgram, audioBuffer, {
        sampleRateHz,
        channels,
      });
    },
  });

  app.get('/health', async (_request, response) => {
    response.json({
      ok: true,
      valkey: await beliefStore.healthCheck(),
      openrouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
      cerebrasConfigured: Boolean(process.env.CEREBRAS_API_KEY),
      deepgramTTSConfigured: Boolean(process.env.DEEPGRAM_API_KEY),
    });
  });

  app.post('/session/start', async (request, response) => {
    try {
      const sessionId = String(request.body.sessionId || crypto.randomUUID());
      const status = await orchestrator.startSession(sessionId, request.body.sessionConfig ?? {});
      response.json(status);
    } catch (error) {
      response.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.post('/session/stop', async (request, response) => {
    try {
      const sessionId = String(request.body.sessionId ?? '');
      const status = await orchestrator.stopSession(sessionId);
      if (!status) {
        response.status(404).json({ error: 'Session not found' });
        return;
      }
      response.json(status);
    } catch (error) {
      response.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.post('/utterance', async (request, response) => {
    try {
      await orchestrator.handleUtterance({
        sessionId: String(request.body.sessionId),
        text: String(request.body.text ?? ''),
        speakerId: request.body.speakerId ? String(request.body.speakerId) : undefined,
      });
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.post('/utterance/audio', async (request, response) => {
    try {
      if (!deepgram) {
        response.status(503).json({ error: 'DEEPGRAM_API_KEY is not configured on the server.' });
        return;
      }

      const sessionId = String(request.body.sessionId ?? '');
      const speakerId = request.body.speakerId ? String(request.body.speakerId) : undefined;
      const audioBase64 = String(request.body.audioBase64 ?? '');
      const sampleRateHz = Number(request.body.sampleRateHz ?? 16000);
      const channels = Number(request.body.channels ?? 1);

      if (!audioBase64) {
        response.status(400).json({ error: 'No audio data received.' });
        return;
      }

      const audioBuffer = Buffer.from(audioBase64, 'base64');
      const transcript = await transcribeAudioBuffer(deepgram, audioBuffer, {
        sampleRateHz,
        channels,
      });
      if (!transcript) {
        response.json({ ok: true, transcript: '' });
        return;
      }

      await orchestrator.handleUtterance({ sessionId, text: transcript, speakerId });
      response.json({ ok: true, transcript });
    } catch (error) {
      response.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.post('/thinker/trigger', async (request, response) => {
    try {
      await orchestrator.triggerThinker(String(request.body.sessionId), String(request.body.reason ?? 'manual'));
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.post('/world-state', async (request, response) => {
    try {
      await orchestrator.handleWorldStateUpdate(String(request.body.sessionId), request.body.state);
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.get('/session/status', async (request, response) => {
    try {
      const sessionId = request.query.sessionId ? String(request.query.sessionId) : undefined;
      if (!sessionId) {
        response.json({ sessions: orchestrator.listSessions() });
        return;
      }
      response.json({ status: orchestrator.getSessionStatus(sessionId), events: orchestrator.getRecentEvents(sessionId) });
    } catch (error) {
      response.status(404).json({ error: toErrorMessage(error) });
    }
  });

  app.get('/belief-store', async (request, response) => {
    try {
      const sessionId = String(request.query.sessionId ?? '');
      response.json(await beliefStore.readBeliefStore(sessionId));
    } catch (error) {
      response.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.get('/directives', async (request, response) => {
    try {
      const sessionId = String(request.query.sessionId ?? '');
      response.json({
        pending: await beliefStore.getDirectives(sessionId),
        fulfilled: await beliefStore.getFulfilledDirectives(sessionId),
      });
    } catch (error) {
      response.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.get('/belief-store/archives', async (request, response) => {
    try {
      const sessionId = String(request.query.sessionId ?? '');
      if (!sessionId) {
        response.status(400).json({ error: 'sessionId is required' });
        return;
      }

      response.json({
        sessionId,
        archives: await beliefStore.listSessionArchives(sessionId),
      });
    } catch (error) {
      response.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.get('/belief-store/archive', async (request, response) => {
    try {
      const archiveId = String(request.query.archiveId ?? '');
      if (!archiveId) {
        response.status(400).json({ error: 'archiveId is required' });
        return;
      }

      const archive = await beliefStore.readSessionArchive(archiveId);
      if (!archive) {
        response.status(404).json({ error: 'Archive not found' });
        return;
      }

      response.json({ archive });
    } catch (error) {
      response.status(500).json({ error: toErrorMessage(error) });
    }
  });

  const closeDiscoveryResponder = startDiscoveryResponder(PORT);

  server.listen(PORT, () => {
    console.log(`Ariadne server listening on http://localhost:${PORT}`);
  });

  let shutdownInProgress = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownInProgress) {
      return;
    }
    shutdownInProgress = true;

    closeDiscoveryResponder();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    await beliefStore.disconnect();
  };

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown server error';
}

function startDiscoveryResponder(httpPort: number): () => void {
  if (!DISCOVERY_ENABLED) {
    return () => undefined;
  }

  const discoverySocket = dgram.createSocket('udp4');
  discoverySocket.on('error', (error) => {
    console.warn(`[discovery] UDP responder error: ${toErrorMessage(error)}`);
  });

  discoverySocket.on('message', (messageBytes, remoteInfo) => {
    const request = parseDiscoveryRequest(messageBytes);
    if (!request || request.type !== 'ariadne.discover.request') {
      return;
    }

    const response: DiscoveryResponse = {
      type: 'ariadne.discover.response',
      protocolVersion: 'v1',
      transport: 'ws',
      wsPort: httpPort,
      wsPath: '/events',
      serverName: os.hostname(),
      timestamp: new Date().toISOString(),
    };

    const responsePayload = Buffer.from(JSON.stringify(response));
    discoverySocket.send(responsePayload, remoteInfo.port, remoteInfo.address);
  });

  discoverySocket.bind(DISCOVERY_PORT, () => {
    discoverySocket.setBroadcast(true);
    console.log(`[discovery] UDP responder listening on port ${DISCOVERY_PORT}`);
  });

  return () => {
    try {
      discoverySocket.close();
    } catch {
      // best-effort cleanup on process shutdown.
    }
  };
}

function parseDiscoveryRequest(messageBytes: Buffer): DiscoveryRequest | null {
  try {
    return JSON.parse(messageBytes.toString('utf8')) as DiscoveryRequest;
  } catch {
    return null;
  }
}

async function transcribeAudioBuffer(
  deepgram: DeepgramClient,
  audioBuffer: Buffer,
  options?: {
    sampleRateHz?: number;
    channels?: number;
  },
): Promise<string | null> {
  const sampleRateHz = options?.sampleRateHz ?? FLUX_SAMPLE_RATE_HZ;
  const channels = options?.channels ?? 1;
  const normalizedAudio = normalizeAudioForFlux(audioBuffer, sampleRateHz, channels);

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    return null;
  }

  const connectArgs: Parameters<typeof deepgram.listen.v2.connect>[0] = {
    Authorization: `Token ${apiKey}`,
    model: 'flux-general-en',
    encoding: 'linear16',
    sample_rate: String(FLUX_SAMPLE_RATE_HZ),
  };

  if (FLUX_EOT_THRESHOLD) {
    connectArgs.eot_threshold = FLUX_EOT_THRESHOLD;
  }
  if (FLUX_EAGER_EOT_THRESHOLD) {
    connectArgs.eager_eot_threshold = FLUX_EAGER_EOT_THRESHOLD;
  }
  if (FLUX_EOT_TIMEOUT_MS) {
    connectArgs.eot_timeout_ms = FLUX_EOT_TIMEOUT_MS;
  }

  const connection = await deepgram.listen.v2.connect(connectArgs);

  let latestTranscript = '';
  let eagerEndOfTurnTranscript = '';
  let endOfTurnTranscript = '';

  const transcriptPromise = new Promise<string | null>((resolve) => {
    let settled = false;

    const resolveOnce = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    const bestAvailableTranscript = (): string | null => {
      const candidate = endOfTurnTranscript || eagerEndOfTurnTranscript || latestTranscript;
      const cleaned = candidate.trim();
      return cleaned || null;
    };

    const timeout = setTimeout(() => {
      resolveOnce(bestAvailableTranscript());
    }, FLUX_TRANSCRIBE_TIMEOUT_MS);

    connection.on('message', (message) => {
      if (message.type !== 'TurnInfo') {
        return;
      }

      latestTranscript = message.transcript ?? latestTranscript;
      if (message.event === 'EagerEndOfTurn') {
        eagerEndOfTurnTranscript = message.transcript ?? eagerEndOfTurnTranscript;
        return;
      }

      if (message.event === 'TurnResumed') {
        eagerEndOfTurnTranscript = '';
        return;
      }

      if (message.event === 'EndOfTurn') {
        endOfTurnTranscript = message.transcript ?? endOfTurnTranscript;
        clearTimeout(timeout);
        resolveOnce(bestAvailableTranscript());
      }
    });

    connection.on('error', () => {
      clearTimeout(timeout);
      resolveOnce(bestAvailableTranscript());
    });

    connection.on('close', () => {
      clearTimeout(timeout);
      resolveOnce(bestAvailableTranscript());
    });
  });

  connection.connect();
  await connection.waitForOpen();
  connection.sendMedia(normalizedAudio);
  connection.sendCloseStream({ type: 'Finalize' });

  const transcript = await transcriptPromise;
  connection.close();
  return transcript;
}

function normalizeAudioForFlux(
  audioBuffer: Buffer,
  inputSampleRateHz: number,
  inputChannels: number,
): Buffer {
  const sourceSampleRate = Number.isFinite(inputSampleRateHz) && inputSampleRateHz > 0
    ? inputSampleRateHz
    : FLUX_SAMPLE_RATE_HZ;
  const sourceChannels = Number.isFinite(inputChannels) && inputChannels > 0
    ? Math.floor(inputChannels)
    : 1;

  if (audioBuffer.length % 2 !== 0) {
    throw new Error('Audio buffer must contain 16-bit PCM samples.');
  }

  const monoFloat = decodeLinear16ToMonoFloat32(audioBuffer, sourceChannels);
  if (monoFloat.length === 0) {
    return Buffer.alloc(0);
  }

  const resampledFloat = sourceSampleRate === FLUX_SAMPLE_RATE_HZ
    ? monoFloat
    : resampleLinear(monoFloat, sourceSampleRate, FLUX_SAMPLE_RATE_HZ);

  return encodeFloat32ToLinear16(resampledFloat);
}

function decodeLinear16ToMonoFloat32(pcm16: Buffer, channels: number): Float32Array {
  const totalSamples = pcm16.length / 2;
  const frames = Math.floor(totalSamples / channels);
  const mono = new Float32Array(frames);

  let sampleIndex = 0;
  for (let frame = 0; frame < frames; frame++) {
    let mixed = 0;
    for (let channel = 0; channel < channels; channel++) {
      const sample = pcm16.readInt16LE(sampleIndex * 2) / 32768;
      mixed += sample;
      sampleIndex += 1;
    }
    mono[frame] = mixed / channels;
  }

  return mono;
}

function resampleLinear(input: Float32Array, fromHz: number, toHz: number): Float32Array {
  if (input.length <= 1 || fromHz === toHz) {
    return input;
  }

  const ratio = toHz / fromHz;
  const outputLength = Math.max(1, Math.round(input.length * ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i / ratio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(leftIndex + 1, input.length - 1);
    const weight = sourceIndex - leftIndex;

    output[i] = input[leftIndex] * (1 - weight) + input[rightIndex] * weight;
  }

  return output;
}

function encodeFloat32ToLinear16(samples: Float32Array): Buffer {
  const output = Buffer.alloc(samples.length * 2);

  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF;
    output.writeInt16LE(int16, i * 2);
  }

  return output;
}

void bootstrap();
