import type { Server as HttpServer } from 'http';
import { createWriteStream, mkdirSync, type WriteStream } from 'fs';
import { dirname, resolve } from 'path';
import WS, { WebSocketServer, WebSocket } from 'ws';
import { DeepgramClient } from '@deepgram/sdk';
import { EventBus } from '@ariadne/event-bus';
import {
  OpenRouterChatProvider,
  CerebrasChatProvider,
} from '@ariadne/chat-providers';
import { SharedBeliefStore } from '@ariadne/shared-belief-store';
import {
  type ClientAudioChunkPayload,
  type ClientAudioCommitPayload,
  ClientWsMessageSchema,
  utteranceToChatMessage,
  type ChatProvider,
  type ClientHelloPayload,
  type ClientWsMessage,
  type SessionConfig,
  type TalkerRequest,
  type Utterance,
  type WorldState,
  type WsMessage,
} from '@ariadne/shared-contracts';
import { runTalkerTurn } from '@ariadne/talker';
import { runThinkerTurn, startThinkerScheduler, type ThinkerSchedulerControls } from '@ariadne/thinker';
import { DeepgramTTSProvider } from '@ariadne/tts-client';

const MAX_RECENT_EVENTS = 99;
const MAX_LOG_PREVIEW_LENGTH = 700;
const DEFAULT_TALKER_HISTORY_TURNS = 10;
const TTS_ENCODING = 'linear16';
const TTS_SAMPLE_RATE_HZ = 24_000;
const TTS_CHANNELS = 1;

export interface SessionStatus {
  sessionId: string;
  active: boolean;
  talkerStatus: 'idle' | 'active' | 'waiting';
  thinkerStatus: 'idle' | 'running' | 'scheduled';
  connectedClients?: number;
  interventionMode: SessionConfig['interventionMode'];
  thinkerIntervalSec: number;
  lastThinkerRunAt: string | null;
  startedAt: string;
  lastActivityAt: string;
}

interface SocketClientMetadata {
  clientId: string;
  participantId?: string;
  joinedAt: string;
}

interface SocketAudioBufferState {
  chunks: Buffer[];
  sampleRateHz: number;
  channels: number;
  bytesBuffered: number;
  speakerId?: string;
}

type V2Socket = Awaited<ReturnType<DeepgramClient['listen']['v2']['connect']>>;

interface DeepgramLiveConnection {
  connection: V2Socket;
  sampleRateHz: number;
  channels: number;
  interimTranscript: string;
}

interface SocketStreamingState {
  sessionId: string;
  connectionsBySpeaker: Map<string, DeepgramLiveConnection>;
  sampleRateHz: number;
  channels: number;
  speakerId?: string;
  finalizedTranscripts: string[];
}

type StreamReader = ReturnType<ReadableStream<Uint8Array>['getReader']>;

interface ActiveSpeechState {
  id: string;
  interrupted: boolean;
  doneEmitted: boolean;
  reader?: StreamReader;
}

interface SessionState extends SessionStatus {
  config: SessionConfig;
  sockets: Set<WebSocket>;
  scheduler?: ThinkerSchedulerControls;
  events: WsMessage[];
  thinkerRunInFlight?: Promise<void>;
  talkerRunInFlight?: Promise<void>;
  talkerRerunRequested?: boolean;
  activeSpeech?: ActiveSpeechState;
}

export interface AriadneOrchestratorOptions {
  httpServer: HttpServer;
  beliefStore: SharedBeliefStore;
  talkerProvider?: ChatProvider;
  thinkerProvider?: ChatProvider;
  ttsProvider?: DeepgramTTSProvider;
  deepgramApiKey?: string;
  transcribeAudio?: (input: {
    audioBuffer: Buffer;
    sampleRateHz: number;
    channels: number;
  }) => Promise<string | null>;
}

export class AriadneOrchestrator {
  private sessions = new Map<string, SessionState>();
  private socketClientMetadata = new WeakMap<WebSocket, SocketClientMetadata>();
  private socketAudioBuffers = new WeakMap<WebSocket, SocketAudioBufferState>();
  private socketStreamingStates = new WeakMap<WebSocket, SocketStreamingState>();
  private bus = new EventBus();
  private wsServer: WebSocketServer;
  private beliefStore: SharedBeliefStore;
  private talkerProvider: ChatProvider;
  private thinkerProvider: ChatProvider;
  private ttsProvider: DeepgramTTSProvider;
  private deepgramApiKey?: string;
  private transcribeAudio?: AriadneOrchestratorOptions['transcribeAudio'];
  private readonly logSystemEvents = (process.env.LOG_SYSTEM_EVENTS ?? 'true').toLowerCase() !== 'false';
  private readonly logSystemEventsToFile = (process.env.LOG_SYSTEM_EVENTS_TO_FILE ?? 'true').toLowerCase() !== 'false';
  private readonly systemEventsLogFilePath = process.env.LOG_SYSTEM_EVENTS_FILE?.trim() || 'logs/system-events.ndjson';
  private readonly talkerHistoryTurns = this.parsePositiveInteger(process.env.TALKER_CONTEXT_TURNS, DEFAULT_TALKER_HISTORY_TURNS);
  private systemEventsLogStream?: WriteStream;

  private static readonly SUPPRESSED_LOG_EVENT_TYPES = new Set([
    'tts.audio.chunk',
    'client.audio.chunk',
  ]);

  private static readonly MAX_BUFFERED_AUDIO_BYTES = 2_000_000;

  constructor(options: AriadneOrchestratorOptions) {
    this.beliefStore = options.beliefStore;
    this.talkerProvider = options.talkerProvider ?? new CerebrasChatProvider();
    this.thinkerProvider = options.thinkerProvider ?? new OpenRouterChatProvider();
    this.ttsProvider = options.ttsProvider ?? new DeepgramTTSProvider();
    this.deepgramApiKey = options.deepgramApiKey ?? process.env.DEEPGRAM_API_KEY;
    this.transcribeAudio = options.transcribeAudio;
    this.systemEventsLogStream = this.createSystemEventsLogStream();

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

    await this.beliefStore.resetSessionForNewRun(sessionId);

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
    this.interruptActiveSpeech(sessionId, 'session_stopped');
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
    const session = await this.ensureSessionReady(sessionId);
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
    const session = await this.ensureSessionReady(input.sessionId);
    this.interruptActiveSpeech(input.sessionId, 'user_barge_in');

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
    await this.scheduleTalker(input.sessionId);
    return { ok: true };
  }

  async triggerThinker(sessionId: string, reason = 'manual'): Promise<{ ok: true }> {
    const session = await this.ensureSessionReady(sessionId);
    if (session.thinkerRunInFlight) {
      await session.thinkerRunInFlight;
      return { ok: true };
    }

    session.thinkerStatus = 'running';
    session.lastActivityAt = new Date().toISOString();
    this.broadcast(sessionId, 'session.status', this.serializeSession(session));
    const thinkerRunStartedAtIso = new Date().toISOString();

    session.thinkerRunInFlight = this.executeThinkerTurn(sessionId, reason, thinkerRunStartedAtIso);

    await session.thinkerRunInFlight;
    return { ok: true };
  }

  private async executeThinkerTurn(sessionId: string, reason: string, thinkerRunStartedAtIso: string): Promise<void> {
    const session = this.getRequiredSession(sessionId);

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
        model: process.env.OPENROUTER_THINKER_MODEL ?? 'qwen/qwen3.6-plus:free',
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

      await this.handleThinkerCompletion(sessionId, reason, thinkerRunStartedAtIso, result);
    } catch (error) {
      this.handleThinkerError(sessionId, error);
      throw error;
    } finally {
      session.thinkerRunInFlight = undefined;
    }
  }

  private async handleThinkerCompletion(
    sessionId: string,
    reason: string,
    thinkerRunStartedAtIso: string,
    result: { directives: Array<{ id: string }>; updatedBeliefStore: unknown },
  ): Promise<void> {
    const session = this.getRequiredSession(sessionId);

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

    if (!session.active || session.talkerStatus !== 'idle' || result.directives.length === 0) {
      return;
    }

    await this.maybeTriggerTalkerForDirectives(sessionId, reason, thinkerRunStartedAtIso);
  }

  private async maybeTriggerTalkerForDirectives(
    sessionId: string,
    reason: string,
    thinkerRunStartedAtIso: string,
  ): Promise<void> {
    const latestHistory = await this.beliefStore.getHistory(sessionId, 4);
    const latestUserUtterance = [...latestHistory]
      .reverse()
      .find((entry) => entry.role === 'user');

    const conversationMovedOn = Boolean(
      latestUserUtterance
        && Date.parse(latestUserUtterance.timestamp) > Date.parse(thinkerRunStartedAtIso),
    );

    if (conversationMovedOn) {
      this.broadcast(sessionId, 'telemetry', {
        type: 'reasoner.skip_talker_stale_directives',
        sessionId,
        directiveCount: 0,
        reason,
        thinkerRunStartedAt: thinkerRunStartedAtIso,
        latestUserUtteranceAt: latestUserUtterance?.timestamp,
      });
      return;
    }

    this.broadcast(sessionId, 'telemetry', {
      type: 'reasoner.trigger_talker',
      sessionId,
      directiveCount: 0,
      reason,
    });
    await this.scheduleTalker(sessionId);
  }

  private handleThinkerError(sessionId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : 'Thinker invocation failed';
    console.error(`[thinker] session ${sessionId} failed:`, error);
    const session = this.getRequiredSession(sessionId);
    session.thinkerStatus = session.active ? 'scheduled' : 'idle';
    session.lastActivityAt = new Date().toISOString();
    this.broadcast(sessionId, 'error', { message });
    this.broadcast(sessionId, 'session.status', this.serializeSession(session));
  }

  private async scheduleTalker(sessionId: string): Promise<void> {
    const session = this.getRequiredSession(sessionId);

    if (session.talkerRunInFlight) {
      session.talkerRerunRequested = true;
      await session.talkerRunInFlight;
      return;
    }

    session.talkerRunInFlight = (async () => {
      do {
        session.talkerRerunRequested = false;
        await this.invokeTalkerTurn(sessionId);
      } while (session.active && session.talkerRerunRequested);
    })().finally(() => {
      session.talkerRunInFlight = undefined;
    });

    await session.talkerRunInFlight;
  }

  private async invokeTalkerTurn(sessionId: string): Promise<void> {
    const session = this.getRequiredSession(sessionId);
    session.talkerStatus = 'active';
    this.broadcast(sessionId, 'session.status', this.serializeSession(session));

    try {
      const history = await this.beliefStore.getHistory(sessionId, this.talkerHistoryTurns * 2);
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
        model: process.env.CEREBRAS_TALKER_MODEL ?? 'gpt-oss-120b',
        toolRuntime: this.buildTalkerToolRuntime(sessionId, session),
        onTelemetry: (event) => {
          this.broadcast(sessionId, 'telemetry', event);
        },
      });

      await this.handleTalkerCompletion(sessionId, result);
    } catch (error) {
      console.error(`[talker] session ${sessionId} failed:`, error);
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

  private buildTalkerToolRuntime(sessionId: string, session: SessionState) {
    return {
      speak: async ({ text }: { text?: string }) => {
        return this.emitSpokenResponse(sessionId, text?.trim() ?? '');
      },
      avatar_command: async (args: Record<string, unknown>) => {
        await this.bus.publish({
          type: 'AvatarCommand',
          sessionId,
          timestamp: new Date().toISOString(),
          payload: { ...args, priority: 'reactive' },
        });
        this.broadcast(sessionId, 'avatar.command', { ...args, priority: 'reactive' });
        return { ok: true };
      },
      trigger_reasoner: async ({ reason }: { reason?: string }) => {
        await this.bus.publish({
          type: 'TalkerWaitFlag',
          sessionId,
          timestamp: new Date().toISOString(),
          payload: { reason: reason ?? 'Talker requested help' },
        });
        void this.triggerThinker(sessionId, reason ?? 'talker_trigger').catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Thinker invocation failed';
          console.error(`[thinker] background trigger failed for session ${sessionId}:`, error);
          this.broadcast(sessionId, 'error', { message });
        });
        return { triggered: true };
      },
      wait_for_reasoner: async ({ reason }: { reason?: string }) => {
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
    };
  }

  private async handleTalkerCompletion(
    sessionId: string,
    result: { content?: string | null; tool_calls?: Array<{ function: { name: string } }> },
  ): Promise<void> {
    const normalizedContent = result.content?.trim() ?? '';
    const hasSpeakToolCall = Boolean(
      result.tool_calls?.some((toolCall) => toolCall.function.name === 'speak'),
    );
    const looksLikeToolMarkup = /^\[[a-z_]+\s*/i.test(normalizedContent);
    const isNoResponseSentinel = normalizedContent.toLowerCase() === '(no response)';
    const shouldFallbackSpeak =
      normalizedContent.length > 0 && !hasSpeakToolCall && !looksLikeToolMarkup && !isNoResponseSentinel;

    if (shouldFallbackSpeak) {
      await this.emitSpokenResponse(sessionId, normalizedContent);
      this.broadcast(sessionId, 'telemetry', {
        type: 'talker.fallback_speak',
        sessionId,
        textLength: normalizedContent.length,
      });
    }

    if (result.content && !shouldFallbackSpeak) {
      const utterance: Utterance = {
        id: crypto.randomUUID(),
        role: 'system',
        text: result.content,
        timestamp: new Date().toISOString(),
      };
      await this.beliefStore.appendHistory(sessionId, utterance);
    }

    this.broadcast(sessionId, 'talker.output', result);
  }

  private async emitSpokenResponse(sessionId: string, spokenText: string): Promise<{ spoken: boolean; text?: string }> {
    const normalized = this.stripMarkdownForSpeech(spokenText).trim();
    if (!normalized) {
      return { spoken: false };
    }

    const session = this.getRequiredSession(sessionId);
    this.interruptActiveSpeech(sessionId, 'superseded_speech');

    const speechState: ActiveSpeechState = {
      id: crypto.randomUUID(),
      interrupted: false,
      doneEmitted: false,
    };
    session.activeSpeech = speechState;

    const utterance: Utterance = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: normalized,
      timestamp: new Date().toISOString(),
    };
    await this.beliefStore.appendHistory(sessionId, utterance);
    this.broadcast(sessionId, 'speak', { text: normalized });

    this.broadcast(sessionId, 'tts.audio.start', {
      encoding: TTS_ENCODING,
      sampleRateHz: TTS_SAMPLE_RATE_HZ,
      channels: TTS_CHANNELS,
    });

    const audio = await this.ttsProvider.synthesize(normalized, {
      format: 'pcm',
      sampleRate: TTS_SAMPLE_RATE_HZ,
    });
    const reader = audio.getReader();
    speechState.reader = reader;
    let sequence = 0;

    try {
      for (;;) {
        if (speechState.interrupted) {
          break;
        }

        const { done, value } = await reader.read();
        if (done || speechState.interrupted) {
          break;
        }

        this.broadcast(sessionId, 'tts.audio.chunk', {
          seq: sequence,
          encoding: TTS_ENCODING,
          sampleRateHz: TTS_SAMPLE_RATE_HZ,
          channels: TTS_CHANNELS,
          audioBase64: Buffer.from(value).toString('base64'),
        });
        sequence += 1;
      }
    } finally {
      if (session.activeSpeech === speechState) {
        session.activeSpeech = undefined;
      }
    }

    if (!speechState.doneEmitted) {
      speechState.doneEmitted = true;
      this.broadcast(sessionId, 'tts.audio.done', { totalChunks: sequence, interrupted: speechState.interrupted });
    }
    return { spoken: true, text: normalized };
  }

  private interruptActiveSpeech(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session?.activeSpeech) {
      return;
    }

    const speechState = session.activeSpeech;
    if (speechState.interrupted) {
      return;
    }

    speechState.interrupted = true;
    if (!speechState.doneEmitted) {
      speechState.doneEmitted = true;
      this.broadcast(sessionId, 'tts.audio.done', { interrupted: true, reason });
    }

    if (speechState.reader) {
      void speechState.reader.cancel(reason).catch(() => {
        // best-effort cancellation of active stream reader.
      });
    }
  }

  private stripMarkdownForSpeech(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}(#{1,6})\s+/gm, '')
      .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/^>\s?/gm, '')
      .replace(/\|/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
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

    socket.on('message', (rawData) => {
      void this.handleSocketMessage(socket, sessionId, rawData).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Socket message handling failed';
        console.error(`[events] failed to handle websocket message for session ${sessionId}:`, error);
        this.sendSocketMessage(socket, {
          type: 'error',
          sessionId,
          eventId: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          payload: { message },
        });
      });
    });

    socket.on('close', () => {
      session.sockets.delete(socket);
      this.socketAudioBuffers.delete(socket);
      this.cleanupStreamingState(socket);

      const metadata = this.socketClientMetadata.get(socket);
      this.socketClientMetadata.delete(socket);
      if (!metadata) {
        return;
      }

      this.broadcast(sessionId, 'client.left', {
        clientId: metadata.clientId,
        participantId: metadata.participantId,
        connectedClients: this.getIdentifiedClientCount(session),
      });
    });
  }

  private async handleSocketMessage(socket: WebSocket, sessionId: string, rawData: unknown): Promise<void> {
    const rawText = this.decodeSocketMessage(rawData);
    if (!rawText) {
      return;
    }

    let message: ClientWsMessage;
    try {
      message = ClientWsMessageSchema.parse(JSON.parse(rawText));
    } catch {
      this.logClientSocketMessage(sessionId, 'client.invalid', { rawText: this.truncateForLog(rawText, MAX_LOG_PREVIEW_LENGTH) });
      this.sendSocketMessage(socket, {
        type: 'error',
        sessionId,
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: { message: 'Invalid client message payload.' },
      });
      return;
    }

    this.logClientSocketMessage(sessionId, message.type, message.payload ?? null);

    if (message.type === 'client.hello') {
      await this.handleClientHello(socket, sessionId, message.payload);
      return;
    }

    if (message.type === 'client.utterance.final') {
      const metadata = this.socketClientMetadata.get(socket);
      const fallbackSpeakerId = metadata?.participantId ?? metadata?.clientId;
      await this.handleUtterance({
        sessionId,
        text: message.payload.text,
        speakerId: message.payload.speakerId ?? fallbackSpeakerId,
      });
      return;
    }

    if (message.type === 'client.world_state') {
      await this.handleWorldStateUpdate(sessionId, message.payload.state);
      return;
    }

    if (message.type === 'client.thinker.trigger') {
      await this.triggerThinker(sessionId, message.payload.reason ?? 'client_request');
      return;
    }

    if (message.type === 'client.ping') {
      this.sendSocketMessage(socket, {
        type: 'client.pong',
        sessionId,
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {
          sentAt: message.payload?.sentAt,
          receivedAt: new Date().toISOString(),
        },
      });
      return;
    }

    if (message.type === 'client.audio.chunk') {
      if (this.deepgramApiKey) {
        await this.streamAudioChunk(socket, sessionId, message.payload);
      } else {
        this.bufferAudioChunk(socket, message.payload);
      }
      return;
    }

    if (message.type === 'client.audio.commit') {
      if (this.deepgramApiKey) {
        await this.finalizeStreamingAudio(socket, sessionId, message.payload ?? {});
      } else {
        await this.flushBufferedAudioToUtterance(socket, sessionId, message.payload ?? {});
      }
    }
  }

  private bufferAudioChunk(socket: WebSocket, payload: ClientAudioChunkPayload): void {
    let audioState = this.socketAudioBuffers.get(socket);
    if (!audioState) {
      audioState = {
        chunks: [],
        sampleRateHz: payload.sampleRateHz,
        channels: payload.channels,
        bytesBuffered: 0,
        speakerId: payload.speakerId,
      };
      this.socketAudioBuffers.set(socket, audioState);
    }

    audioState.sampleRateHz = payload.sampleRateHz;
    audioState.channels = payload.channels;
    audioState.speakerId = payload.speakerId ?? audioState.speakerId;

    const chunkBuffer = Buffer.from(payload.audioBase64, 'base64');
    if (chunkBuffer.length === 0) {
      return;
    }

    audioState.chunks.push(chunkBuffer);
    audioState.bytesBuffered += chunkBuffer.length;

    if (audioState.bytesBuffered > AriadneOrchestrator.MAX_BUFFERED_AUDIO_BYTES) {
      const removedChunk = audioState.chunks.shift();
      audioState.bytesBuffered = Math.max(0, audioState.bytesBuffered - (removedChunk?.length ?? 0));
    }
  }

  private async flushBufferedAudioToUtterance(
    socket: WebSocket,
    sessionId: string,
    payload: ClientAudioCommitPayload,
  ): Promise<void> {
    const audioState = this.socketAudioBuffers.get(socket);
    if (!audioState || audioState.bytesBuffered === 0) {
      return;
    }

    this.socketAudioBuffers.delete(socket);
    if (!this.transcribeAudio) {
      this.sendSocketMessage(socket, {
        type: 'error',
        sessionId,
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: { message: 'Streaming audio received, but no transcription provider is configured.' },
      });
      return;
    }

    const audioBuffer = Buffer.concat(audioState.chunks);
    const transcript = (await this.transcribeAudio({
      audioBuffer,
      sampleRateHz: audioState.sampleRateHz,
      channels: audioState.channels,
    }))?.trim();

    if (!transcript) {
      return;
    }

    const speakerId = this.resolveSpeakerIdForSocket(socket, payload.speakerId ?? audioState.speakerId);
    this.broadcast(sessionId, 'stt.transcript', {
      speakerId,
      text: transcript,
      reason: payload.reason ?? 'client.audio.commit',
    });

    await this.handleUtterance({
      sessionId,
      text: transcript,
      speakerId,
    });
  }

  private resolveSpeakerIdForSocket(socket: WebSocket, overrideSpeakerId?: string): string | undefined {
    if (overrideSpeakerId) {
      return overrideSpeakerId;
    }

    const metadata = this.socketClientMetadata.get(socket);
    return metadata?.participantId ?? metadata?.clientId;
  }

  private async handleClientHello(
    socket: WebSocket,
    sessionId: string,
    payload: ClientHelloPayload,
  ): Promise<void> {
    const metadata: SocketClientMetadata = {
      clientId: payload.clientId,
      participantId: payload.participantId,
      joinedAt: new Date().toISOString(),
    };
    this.socketClientMetadata.set(socket, metadata);

    if (payload.autoStartSession !== false) {
      await this.ensureSessionReady(sessionId, payload.sessionConfig ?? {});
    }

    const session = this.getRequiredSession(sessionId);
    this.sendSocketMessage(socket, {
      type: 'client.hello.ack',
      sessionId,
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: {
        clientId: payload.clientId,
        participantId: payload.participantId,
        sessionStatus: this.serializeSession(session),
      },
    });

    this.broadcast(sessionId, 'client.joined', {
      clientId: payload.clientId,
      participantId: payload.participantId,
      connectedClients: this.getIdentifiedClientCount(session),
    });
  }

  private decodeSocketMessage(rawData: unknown): string {
    if (typeof rawData === 'string') {
      return rawData;
    }

    if (Buffer.isBuffer(rawData)) {
      return rawData.toString('utf8');
    }

    if (Array.isArray(rawData)) {
      return Buffer.concat(rawData).toString('utf8');
    }

    if (rawData instanceof ArrayBuffer) {
      return Buffer.from(rawData).toString('utf8');
    }

    return '';
  }

  private getIdentifiedClientCount(session: SessionState): number {
    let identifiedClientCount = 0;
    for (const socket of session.sockets) {
      if (this.socketClientMetadata.has(socket)) {
        identifiedClientCount += 1;
      }
    }
    return identifiedClientCount;
  }

  private async ensureSessionReady(sessionId: string, config: Partial<SessionConfig> = {}): Promise<SessionState> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      await this.startSession(sessionId, config);
      return this.getRequiredSession(sessionId);
    }

    if (!session.active) {
      await this.startSession(sessionId, {
        ...session.config,
        ...config,
      });
    }

    return this.getRequiredSession(sessionId);
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

    this.logEventMessage(message, session.sockets.size);

    session.events = [...session.events.slice(-MAX_RECENT_EVENTS), message];
    for (const socket of session.sockets) {
      this.sendSocketMessage(socket, message, 'broadcast');
    }
  }

  private sendSocketMessage(socket: WebSocket, message: WsMessage, context: 'broadcast' | 'direct' = 'direct'): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
      this.logOutboundSocketMessage(message, context);
    }
  }

  private logEventMessage(message: WsMessage, recipients: number): void {
    if (!this.logSystemEvents) {
      return;
    }
    if (!this.shouldLogEventType(message.type)) {
      return;
    }

    const payloadPreview = this.stringifyPayloadForLog(message.payload);
    const logLine = `[events] ${message.type} session=${message.sessionId} recipients=${recipients} payload=${payloadPreview}`;
    console.info(logLine);
    this.writeLogRecord({
      timestamp: message.timestamp,
      channel: 'events.broadcast',
      sessionId: message.sessionId,
      type: message.type,
      eventId: message.eventId,
      recipients,
      payload: message.payload,
    });
  }

  private logOutboundSocketMessage(message: WsMessage, context: 'broadcast' | 'direct'): void {
    if (!this.logSystemEvents || context !== 'direct') {
      return;
    }
    if (!this.shouldLogEventType(message.type)) {
      return;
    }

    const payloadPreview = this.stringifyPayloadForLog(message.payload);
    console.info(
      `[socket:out] ${message.type} session=${message.sessionId} context=${context} payload=${payloadPreview}`,
    );
    this.writeLogRecord({
      timestamp: message.timestamp,
      channel: 'socket.out',
      context,
      sessionId: message.sessionId,
      type: message.type,
      eventId: message.eventId,
      payload: message.payload,
    });
  }

  private logClientSocketMessage(sessionId: string, type: string, payload: unknown): void {
    if (!this.logSystemEvents) {
      return;
    }
    if (!this.shouldLogEventType(type)) {
      return;
    }

    const payloadPreview = this.stringifyPayloadForLog(payload);
    console.info(`[socket:in] ${type} session=${sessionId} payload=${payloadPreview}`);
    this.writeLogRecord({
      timestamp: new Date().toISOString(),
      channel: 'socket.in',
      sessionId,
      type,
      payload,
    });
  }

  private stringifyPayloadForLog(payload: unknown): string {
    try {
      const serialized = JSON.stringify(payload);
      if (!serialized) {
        return 'null';
      }
      if (serialized.length > MAX_LOG_PREVIEW_LENGTH) {
        return `${serialized.slice(0, MAX_LOG_PREVIEW_LENGTH)}...<truncated>`;
      }
      return serialized;
    } catch {
      return '[unserializable]';
    }
  }

  private truncateForLog(value: string, maxLength: number): string {
    return value.length > maxLength ? `${value.slice(0, maxLength)}...<truncated>` : value;
  }

  private shouldLogEventType(type: string): boolean {
    return !AriadneOrchestrator.SUPPRESSED_LOG_EVENT_TYPES.has(type);
  }

  private createSystemEventsLogStream(): WriteStream | undefined {
    if (!this.logSystemEventsToFile) {
      return undefined;
    }

    try {
      const absolutePath = resolve(process.cwd(), this.systemEventsLogFilePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      const stream = createWriteStream(absolutePath, { flags: 'a', encoding: 'utf8' });
      stream.on('error', (error) => {
        console.error('[events] failed to write log file:', error);
      });
      console.info(`[events] file logging enabled: ${absolutePath}`);
      return stream;
    } catch (error) {
      console.error('[events] failed to initialize log file stream:', error);
      return undefined;
    }
  }

  private writeLogRecord(record: Record<string, unknown>): void {
    if (!this.systemEventsLogStream) {
      return;
    }

    try {
      this.systemEventsLogStream.write(`${JSON.stringify(record)}\n`);
    } catch {
      // keep runtime resilient even when file logging fails.
    }
  }

  private parsePositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return fallback;
    }
    return Math.floor(parsed);
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
      connectedClients: this.getIdentifiedClientCount(session),
      interventionMode: session.config.interventionMode,
      thinkerIntervalSec: session.config.thinkerIntervalSec,
      lastThinkerRunAt: session.lastThinkerRunAt,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
    };
  }

  private async streamAudioChunk(
    socket: WebSocket,
    sessionId: string,
    payload: ClientAudioChunkPayload,
  ): Promise<void> {
    let streamingState = this.socketStreamingStates.get(socket);

    if (!streamingState) {
      streamingState = {
        sessionId,
        connectionsBySpeaker: new Map(),
        sampleRateHz: payload.sampleRateHz,
        channels: payload.channels,
        speakerId: payload.speakerId,
        finalizedTranscripts: [],
      };
      this.socketStreamingStates.set(socket, streamingState);
    }

    streamingState.sampleRateHz = payload.sampleRateHz;
    streamingState.channels = payload.channels;
    streamingState.speakerId = payload.speakerId ?? streamingState.speakerId;

    const chunkBuffer = Buffer.from(payload.audioBase64, 'base64');
    if (chunkBuffer.length === 0) {
      return;
    }

    const speakerId = streamingState.speakerId ?? 'unknown';
    let liveConn = streamingState.connectionsBySpeaker.get(speakerId);

    if (!liveConn) {
      liveConn = await this.createDeepgramLiveConnection(sessionId, socket, speakerId, payload.sampleRateHz);
      streamingState.connectionsBySpeaker.set(speakerId, liveConn);
    }

    liveConn.connection.sendMedia(chunkBuffer);
  }

  private async createDeepgramLiveConnection(
    sessionId: string,
    socket: WebSocket,
    speakerId: string,
    sampleRateHz: number,
  ): Promise<DeepgramLiveConnection> {
    const deepgram = new DeepgramClient({ apiKey: this.deepgramApiKey! });
    const connection = await deepgram.listen.v2.connect({
      Authorization: `Token ${this.deepgramApiKey!}`,
      model: 'flux-general-en',
      encoding: 'linear16',
      sample_rate: String(sampleRateHz),
    });

    connection.on('message', (message) => {
      if (message.type === 'TurnInfo' && message.transcript) {
        const streamingState = this.socketStreamingStates.get(socket);
        if (!streamingState) return;

        if (message.event === 'EndOfTurn') {
          if (message.transcript.trim()) {
            streamingState.finalizedTranscripts.push(message.transcript.trim());
          }
        } else if (message.event === 'Update') {
          this.broadcast(sessionId, 'stt.interim', {
            speakerId,
            text: message.transcript,
          });
        }
      }
    });

    connection.on('error', (error) => {
      console.error(`[stt/streaming/${speakerId}] error:`, error);
    });

    connection.on('close', () => {
      console.info(`[stt/streaming/${speakerId}] connection closed.`);
    });

    connection.connect();
    await connection.waitForOpen();

    return { connection, sampleRateHz, channels: 1, interimTranscript: '' };
  }

  private async finalizeStreamingAudio(
    socket: WebSocket,
    sessionId: string,
    payload: ClientAudioCommitPayload,
  ): Promise<void> {
    const streamingState = this.socketStreamingStates.get(socket);
    if (!streamingState) {
      return;
    }

    this.socketStreamingStates.delete(socket);

    for (const [speakerId, liveConn] of streamingState.connectionsBySpeaker.entries()) {
      liveConn.connection.sendCloseStream({ type: 'Finalize' });

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 2000);
      });

      const fullTranscript = streamingState.finalizedTranscripts.join(' ').trim();

      if (!fullTranscript) {
        liveConn.connection.close();
        continue;
      }

      const resolvedSpeakerId = this.resolveSpeakerIdForSocket(socket, payload.speakerId ?? speakerId);

      this.broadcast(sessionId, 'stt.transcript', {
        speakerId: resolvedSpeakerId,
        text: fullTranscript,
        reason: payload.reason ?? 'client.audio.commit',
      });

      await this.handleUtterance({
        sessionId,
        text: fullTranscript,
        speakerId: resolvedSpeakerId,
      });

      liveConn.connection.close();
    }
  }

  private cleanupStreamingState(socket: WebSocket): void {
    const streamingState = this.socketStreamingStates.get(socket);
    if (!streamingState) return;

    for (const [, liveConn] of streamingState.connectionsBySpeaker.entries()) {
      try {
        liveConn.connection.close();
      } catch {
        // best-effort cleanup
      }
    }

    this.socketStreamingStates.delete(socket);
  }
}
