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
  app.use(express.json({ limit: '10mb' }));

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

  app.get('/health', async (_req, res) => {
    res.json({
      ok: true,
      valkey: await beliefStore.healthCheck(),
      openrouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
      cerebrasConfigured: Boolean(process.env.CEREBRAS_API_KEY),
      deepgramTTSConfigured: Boolean(process.env.DEEPGRAM_API_KEY),
    });
  });

  app.post('/session/start', async (req, res) => {
    try {
      const sessionId = String(req.body.sessionId || crypto.randomUUID());
      const status = await orchestrator.startSession(sessionId, req.body.sessionConfig ?? {});
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.post('/session/stop', async (req, res) => {
    try {
      const sessionId = String(req.body.sessionId ?? '');
      const status = await orchestrator.stopSession(sessionId);
      if (!status) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      res.json(status);
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.post('/utterance', async (req, res) => {
    try {
      await orchestrator.handleUtterance({
        sessionId: String(req.body.sessionId),
        text: String(req.body.text ?? ''),
        speakerId: req.body.speakerId ? String(req.body.speakerId) : undefined,
      });
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.post('/utterance/audio', async (req, res) => {
    try {
      if (!deepgram) {
        res.status(503).json({ error: 'DEEPGRAM_API_KEY is not configured on the server.' });
        return;
      }

      const sessionId = String(req.body.sessionId ?? '');
      const speakerId = req.body.speakerId ? String(req.body.speakerId) : undefined;
      const audioBase64 = String(req.body.audioBase64 ?? '');
      const sampleRateHz = Number(req.body.sampleRateHz ?? 16000);
      const channels = Number(req.body.channels ?? 1);

      if (!audioBase64) {
        res.status(400).json({ error: 'No audio data received.' });
        return;
      }

      const audioBuffer = Buffer.from(audioBase64, 'base64');
      const transcript = await transcribeAudioBuffer(deepgram, audioBuffer, {
        sampleRateHz,
        channels,
      });
      if (!transcript) {
        res.json({ ok: true, transcript: '' });
        return;
      }

      await orchestrator.handleUtterance({ sessionId, text: transcript, speakerId });
      res.json({ ok: true, transcript });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.post('/thinker/trigger', async (req, res) => {
    try {
      await orchestrator.triggerThinker(String(req.body.sessionId), String(req.body.reason ?? 'manual'));
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.post('/world-state', async (req, res) => {
    try {
      await orchestrator.handleWorldStateUpdate(String(req.body.sessionId), req.body.state);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.get('/session/status', async (req, res) => {
    try {
      const sessionId = req.query.sessionId ? String(req.query.sessionId) : undefined;
      if (!sessionId) {
        res.json({ sessions: orchestrator.listSessions() });
        return;
      }
      res.json({ status: orchestrator.getSessionStatus(sessionId), events: orchestrator.getRecentEvents(sessionId) });
    } catch (error) {
      res.status(404).json({ error: toErrorMessage(error) });
    }
  });

  app.get('/belief-store', async (req, res) => {
    try {
      const sessionId = String(req.query.sessionId ?? '');
      res.json(await beliefStore.readBeliefStore(sessionId));
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  app.get('/directives', async (req, res) => {
    try {
      const sessionId = String(req.query.sessionId ?? '');
      res.json({
        pending: await beliefStore.getDirectives(sessionId),
        fulfilled: await beliefStore.getFulfilledDirectives(sessionId),
      });
    } catch (error) {
      res.status(500).json({ error: toErrorMessage(error) });
    }
  });

  const closeDiscoveryResponder = startDiscoveryResponder(PORT);

  server.listen(PORT, () => {
    console.log(`Ariadne server listening on http://localhost:${PORT}`);
  });

  const shutdown = (): void => {
    closeDiscoveryResponder();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
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

  discoverySocket.on('message', (rawMessage, remoteInfo) => {
    const request = parseDiscoveryRequest(rawMessage);
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
      // Best-effort cleanup on process shutdown.
    }
  };
}

function parseDiscoveryRequest(rawMessage: Buffer): DiscoveryRequest | null {
  try {
    return JSON.parse(rawMessage.toString('utf8')) as DiscoveryRequest;
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
    model: 'nova-3',
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
