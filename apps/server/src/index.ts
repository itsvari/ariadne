import http from 'http';
import cors from 'cors';
import express from 'express';
import { SharedBeliefStore } from '@ariadne/shared-belief-store';
import { OpenRouterChatProvider, CerebrasChatProvider } from '@ariadne/chat-providers';
import { InworldTTSProvider } from '@ariadne/tts-client';
import { AriadneOrchestrator } from './orchestrator';

const PORT = Number(process.env.PORT ?? 8081);

async function bootstrap(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required to start apps/server');
  }

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  const server = http.createServer(app);
  const beliefStore = new SharedBeliefStore();
  const redisHealthy = await beliefStore.healthCheck();
  if (!redisHealthy) {
    throw new Error('Redis health check failed');
  }

  const talkerProvider = new OpenRouterChatProvider();
  const thinkerProvider = process.env.CEREBRAS_API_KEY
    ? new CerebrasChatProvider()
    : talkerProvider;
  const ttsProvider = new InworldTTSProvider();

  const orchestrator = new AriadneOrchestrator({
    httpServer: server,
    beliefStore,
    talkerProvider,
    thinkerProvider,
    ttsProvider,
  });

  app.get('/health', async (_req, res) => {
    res.json({
      ok: true,
      redis: await beliefStore.healthCheck(),
      openrouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
      cerebrasConfigured: Boolean(process.env.CEREBRAS_API_KEY),
      inworldConfigured: Boolean(process.env.INWORLD_API_KEY),
    });
  });

  app.post('/session/start', async (req, res) => {
    try {
      const sessionId = String(req.body.sessionId ?? crypto.randomUUID());
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

  server.listen(PORT, () => {
    console.log(`Ariadne server listening on http://localhost:${PORT}`);
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown server error';
}

void bootstrap();
