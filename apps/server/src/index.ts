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
  const sampleRateHz = options?.sampleRateHz ?? 16000;
  const channels = options?.channels ?? 1;

  const request = {
    model: 'nova-2',
    encoding: 'linear16',
    sample_rate: sampleRateHz,
    channels,
  } as unknown as Parameters<typeof deepgram.listen.v1.media.transcribeFile>[1];

  const result = await deepgram.listen.v1.media.transcribeFile(audioBuffer, request);

  const transcript = 'results' in result
    ? result.results?.channels[0]?.alternatives?.[0]?.transcript?.trim()
    : undefined;
  return transcript || null;
}

void bootstrap();
