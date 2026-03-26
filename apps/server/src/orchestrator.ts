import type { Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { EventBus } from '@ariadne/event-bus';
import {
  OpenRouterChatProvider,
  CerebrasChatProvider,
} from '@ariadne/chat-providers';
import { SharedBeliefStore } from '@ariadne/shared-belief-store';
import {
  createEmptyBeliefStore,
  utteranceToChatMessage,
  type ChatProvider,
  type SessionConfig,
  type TalkerRequest,
  type Utterance,
  type WorldState,
  type WsMessage,
} from '@ariadne/shared-contracts';
import { runTalkerTurn } from '@ariadne/talker';
import { runThinkerTurn, startThinkerScheduler, type ThinkerSchedulerControls } from '@ariadne/thinker';
import { DeepgramTTSProvider, synthesizeSpeech } from '@ariadne/tts-client';

export interface SessionStatus {
  sessionId: string;
  active: boolean;
  talkerStatus: 'idle' | 'active' | 'waiting';
  thinkerStatus: 'idle' | 'running' | 'scheduled';
  interventionMode: SessionConfig['interventionMode'];
  thinkerIntervalSec: number;
  lastThinkerRunAt: string | null;
  startedAt: string;
  lastActivityAt: string;
}

interface SessionState extends SessionStatus {
  config: SessionConfig;
  sockets: Set<WebSocket>;
  scheduler?: ThinkerSchedulerControls;
  events: WsMessage[];
  thinkerRunInFlight?: Promise<void>;
}

export interface AriadneOrchestratorOptions {
  httpServer: HttpServer;
  beliefStore: SharedBeliefStore;
  talkerProvider?: ChatProvider;
  thinkerProvider?: ChatProvider;
  ttsProvider?: DeepgramTTSProvider;
}

export class AriadneOrchestrator {
  private sessions = new Map<string, SessionState>();
  private bus = new EventBus();
  private wsServer: WebSocketServer;
  private beliefStore: SharedBeliefStore;
  private talkerProvider: ChatProvider;
  private thinkerProvider: ChatProvider;
  private ttsProvider: DeepgramTTSProvider;

  constructor(options: AriadneOrchestratorOptions) {
    this.beliefStore = options.beliefStore;
    this.talkerProvider = options.talkerProvider ?? new OpenRouterChatProvider();
    this.thinkerProvider =
      options.thinkerProvider ??
      (process.env.CEREBRAS_API_KEY
        ? new CerebrasChatProvider()
        : this.talkerProvider);
    this.ttsProvider = options.ttsProvider ?? new DeepgramTTSProvider();

    this.wsServer = new WebSocketServer({ noServer: true });
    options.httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname !== '/events') {
        socket.destroy();
        return;
      }

      this.wsServer.handleUpgrade(request, socket, head, (ws) => {
        const sessionId = url.searchParams.get('sessionId') ?? 'default';
        this.attachSocket(ws, sessionId);
      });
    });
  }

  async startSession(sessionId: string, config: Partial<SessionConfig> = {}): Promise<SessionStatus> {
    const previous = this.sessions.get(sessionId);
    previous?.scheduler?.stop();

    const normalizedConfig: SessionConfig = {
      interventionMode: config.interventionMode ?? 'control',
      groupSize: config.groupSize,
      taskId: config.taskId,
      phase: config.phase,
      thinkerIntervalSec: config.thinkerIntervalSec ?? 60,
    };

    const now = new Date().toISOString();
    const session: SessionState = {
      sessionId,
      active: true,
      talkerStatus: 'idle',
      thinkerStatus: 'scheduled',
      interventionMode: normalizedConfig.interventionMode,
      thinkerIntervalSec: normalizedConfig.thinkerIntervalSec,
      lastThinkerRunAt: previous?.lastThinkerRunAt ?? null,
      startedAt: previous?.startedAt ?? now,
      lastActivityAt: now,
      config: normalizedConfig,
      sockets: previous?.sockets ?? new Set<WebSocket>(),
      events: previous?.events ?? [],
    };

    session.scheduler = startThinkerScheduler(normalizedConfig.thinkerIntervalSec * 1000, async () => {
      await this.triggerThinker(sessionId, 'scheduled');
    });

    this.sessions.set(sessionId, session);

    const existingBeliefs = await this.beliefStore.readBeliefStore(sessionId);
    if (!existingBeliefs.updatedAt) {
      await this.beliefStore.writeBeliefStore(sessionId, createEmptyBeliefStore());
    }

    this.broadcast(sessionId, 'session.status', this.getSessionStatus(sessionId));
    return this.getSessionStatus(sessionId);
  }

  async stopSession(sessionId: string): Promise<SessionStatus | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    session.scheduler?.stop();
    session.active = false;
    session.talkerStatus = 'idle';
    session.thinkerStatus = 'idle';
    session.lastActivityAt = new Date().toISOString();
    this.broadcast(sessionId, 'session.status', this.serializeSession(session));
    return this.serializeSession(session);
  }

  getSessionStatus(sessionId: string): SessionStatus {
    const session = this.getRequiredSession(sessionId);
    return this.serializeSession(session);
  }

  listSessions(): SessionStatus[] {
    return Array.from(this.sessions.values()).map((session) => this.serializeSession(session));
  }

  getRecentEvents(sessionId: string): WsMessage[] {
    return this.getRequiredSession(sessionId).events;
  }

  async handleWorldStateUpdate(sessionId: string, state: WorldState): Promise<void> {
    const session = this.getRequiredSession(sessionId);
    await this.beliefStore.setWorldState(sessionId, state);
    session.lastActivityAt = new Date().toISOString();
    await this.bus.publish({
      type: 'WorldStateUpdate',
      sessionId,
      timestamp: new Date().toISOString(),
      payload: state,
    });
    this.broadcast(sessionId, 'world_state.update', state);
  }

  async handleUtterance(input: {
    sessionId: string;
    text: string;
    speakerId?: string;
  }): Promise<{ ok: true }> {
    const session = this.getRequiredSession(input.sessionId);
    const utterance: Utterance = {
      id: crypto.randomUUID(),
      role: 'user',
      speakerId: input.speakerId,
      text: input.text,
      timestamp: new Date().toISOString(),
    };

    await this.beliefStore.appendHistory(input.sessionId, utterance);
    session.lastActivityAt = utterance.timestamp;

    await this.bus.publish({
      type: 'UtteranceFinal',
      sessionId: input.sessionId,
      timestamp: utterance.timestamp,
      payload: {
        utteranceId: utterance.id,
        speakerId: utterance.speakerId,
        text: utterance.text,
      },
    });

    this.broadcast(input.sessionId, 'utterance.final', utterance);
    await this.invokeTalker(input.sessionId);
    return { ok: true };
  }

  async triggerThinker(sessionId: string, reason = 'manual'): Promise<{ ok: true }> {
    const session = this.getRequiredSession(sessionId);
    if (session.thinkerRunInFlight) {
      await session.thinkerRunInFlight;
      return { ok: true };
    }

    session.thinkerStatus = 'running';
    session.lastActivityAt = new Date().toISOString();
    this.broadcast(sessionId, 'session.status', this.serializeSession(session));

    session.thinkerRunInFlight = (async () => {
      try {
        const history = await this.beliefStore.getHistory(sessionId);
        const worldState = await this.beliefStore.getWorldState(sessionId);
        const currentBeliefStore = await this.beliefStore.readBeliefStore(sessionId);

        const result = await runThinkerTurn({
          provider: this.thinkerProvider,
          sessionId,
          fullHistory: history,
          worldState,
          currentBeliefStore,
          toolRuntime: {
            write_belief_store: async ({ store }) => {
              const nextStore = store ?? currentBeliefStore;
              await this.beliefStore.writeBeliefStore(sessionId, nextStore);
              return nextStore;
            },
            enqueue_directive: async ({ directive }) => {
              if (!directive) {
                return null;
              }
              await this.beliefStore.enqueueDirective(sessionId, directive);
              return directive;
            },
            read_world_state: async () => this.beliefStore.getWorldState(sessionId),
            compact_history: async ({ summary }) => {
              const nextSummary = summary?.trim() || currentBeliefStore.conversation_summary || 'No summary yet.';
              await this.beliefStore.compactHistory(sessionId, nextSummary);
              return { compacted: true, summary: nextSummary };
            },
            avatar_command: async (args) => {
              await this.bus.publish({
                type: 'AvatarCommand',
                sessionId,
                timestamp: new Date().toISOString(),
                payload: { ...args, priority: 'planned' },
              });
              this.broadcast(sessionId, 'avatar.command', { ...args, priority: 'planned' });
              return { queued: true };
            },
          },
          onTelemetry: (event) => {
            this.broadcast(sessionId, 'telemetry', event);
          },
        });

        session.lastThinkerRunAt = new Date().toISOString();
        session.thinkerStatus = session.active ? 'scheduled' : 'idle';
        session.lastActivityAt = session.lastThinkerRunAt;
        await this.bus.publish({
          type: 'ReasonerComplete',
          sessionId,
          timestamp: session.lastThinkerRunAt,
          payload: { reason, directiveCount: result.directives.length },
        });

        this.broadcast(sessionId, 'reasoner.complete', {
          reason,
          directiveCount: result.directives.length,
          updatedBeliefStore: result.updatedBeliefStore,
        });
        this.broadcast(sessionId, 'session.status', this.serializeSession(session));
      } finally {
        session.thinkerRunInFlight = undefined;
      }
    })();

    await session.thinkerRunInFlight;
    return { ok: true };
  }

  private async invokeTalker(sessionId: string): Promise<void> {
    const session = this.getRequiredSession(sessionId);
    session.talkerStatus = 'active';
    this.broadcast(sessionId, 'session.status', this.serializeSession(session));

    try {
      const history = await this.beliefStore.getHistory(sessionId, 12);
      const beliefSnapshot = await this.beliefStore.readBeliefStore(sessionId);
      const directives = await this.beliefStore.getDirectives(sessionId);
      const worldState = await this.beliefStore.getWorldState(sessionId);

      const request: TalkerRequest = {
        sessionId,
        messages: history.map(utteranceToChatMessage),
        beliefSnapshot,
        directives,
        worldState,
        sessionConfig: session.config,
      };

      const result = await runTalkerTurn({
        provider: this.talkerProvider,
        request,
        toolRuntime: {
          speak: async ({ text }) => {
            const spokenText = text?.trim() ?? '';
            if (!spokenText) {
              return { spoken: false };
            }

            const utterance: Utterance = {
              id: crypto.randomUUID(),
              role: 'assistant',
              text: spokenText,
              timestamp: new Date().toISOString(),
            };
            await this.beliefStore.appendHistory(sessionId, utterance);
            this.broadcast(sessionId, 'speak', { text: spokenText });

            const audio = await synthesizeSpeech(this.ttsProvider, { text: spokenText });
            const reader = audio.getReader();
            let sequence = 0;

            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }

              this.broadcast(sessionId, 'tts.audio.chunk', {
                seq: sequence,
                audioBase64: Buffer.from(value).toString('base64'),
              });
              sequence += 1;
            }

            this.broadcast(sessionId, 'tts.audio.done', { totalChunks: sequence });
            return { spoken: true, text: spokenText };
          },
          avatar_command: async (args) => {
            await this.bus.publish({
              type: 'AvatarCommand',
              sessionId,
              timestamp: new Date().toISOString(),
              payload: { ...args, priority: 'reactive' },
            });
            this.broadcast(sessionId, 'avatar.command', { ...args, priority: 'reactive' });
            return { ok: true };
          },
          trigger_reasoner: async ({ reason }) => {
            await this.bus.publish({
              type: 'TalkerWaitFlag',
              sessionId,
              timestamp: new Date().toISOString(),
              payload: { reason: reason ?? 'Talker requested help' },
            });
            void this.triggerThinker(sessionId, reason ?? 'talker_trigger');
            return { triggered: true };
          },
          wait_for_reasoner: async ({ reason }) => {
            session.talkerStatus = 'waiting';
            this.broadcast(sessionId, 'session.status', this.serializeSession(session));
            await this.triggerThinker(sessionId, reason ?? 'talker_wait');
            return {
              beliefStore: await this.beliefStore.readBeliefStore(sessionId),
              directives: await this.beliefStore.getDirectives(sessionId),
            };
          },
          read_belief_store: async () => this.beliefStore.readBeliefStore(sessionId),
          dequeue_directive: async () => this.beliefStore.dequeueDirective(sessionId),
        },
        onTelemetry: (event) => {
          this.broadcast(sessionId, 'telemetry', event);
        },
      });

      if (result.content) {
        const utterance: Utterance = {
          id: crypto.randomUUID(),
          role: 'system',
          text: result.content,
          timestamp: new Date().toISOString(),
        };
        await this.beliefStore.appendHistory(sessionId, utterance);
      }

      this.broadcast(sessionId, 'talker.output', result);
    } catch (error) {
      this.broadcast(sessionId, 'error', {
        message: error instanceof Error ? error.message : 'Talker invocation failed',
      });
      throw error;
    } finally {
      session.talkerStatus = 'idle';
      session.lastActivityAt = new Date().toISOString();
      this.broadcast(sessionId, 'session.status', this.serializeSession(session));
    }
  }

  private attachSocket(socket: WebSocket, sessionId: string): void {
    const session = this.sessions.get(sessionId) ?? {
      sessionId,
      active: false,
      talkerStatus: 'idle',
      thinkerStatus: 'idle',
      interventionMode: 'control',
      thinkerIntervalSec: 60,
      lastThinkerRunAt: null,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      config: {
        interventionMode: 'control',
        thinkerIntervalSec: 60,
      },
      sockets: new Set<WebSocket>(),
      events: [],
    } satisfies SessionState;

    session.sockets.add(socket);
    this.sessions.set(sessionId, session);
    this.sendSocketMessage(socket, {
      type: 'session.status',
      sessionId,
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: this.serializeSession(session),
    });

    socket.on('close', () => {
      session.sockets.delete(socket);
    });
  }

  private broadcast(sessionId: string, type: string, payload: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    const message: WsMessage = {
      type,
      sessionId,
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload,
    };

    session.events = [...session.events.slice(-99), message];
    for (const socket of session.sockets) {
      this.sendSocketMessage(socket, message);
    }
  }

  private sendSocketMessage(socket: WebSocket, message: WsMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private getRequiredSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return session;
  }

  private serializeSession(session: SessionState): SessionStatus {
    return {
      sessionId: session.sessionId,
      active: session.active,
      talkerStatus: session.talkerStatus,
      thinkerStatus: session.thinkerStatus,
      interventionMode: session.config.interventionMode,
      thinkerIntervalSec: session.config.thinkerIntervalSec,
      lastThinkerRunAt: session.lastThinkerRunAt,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
    };
  }
}
