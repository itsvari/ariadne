import type { WsMessage, SessionConfig, ChatMessage } from '../contracts/ai';
import type { ChatProvider } from '../contracts/ai';
import type { TTSProvider } from '../contracts/ai';
import { runTalkerTurn } from '../usecases/talker';
import { synthesizeSpeech } from '../usecases/tts';
import { telemetry } from '../telemetry/emitter';

export type SendFn = (msg: WsMessage) => void;

export interface EventRouterDeps {
  chatProvider: ChatProvider;
  ttsProvider: TTSProvider;
  sessionConfig: SessionConfig;
  send: SendFn;
}

/**
 * Stateful per-connection event router. Accumulates conversation
 * history and dispatches inbound WS events to the correct use-case.
 */
export class EventRouter {
  private chatProvider: ChatProvider;
  private ttsProvider: TTSProvider;
  private sessionConfig: SessionConfig;
  private send: SendFn;
  private conversationHistory: ChatMessage[] = [];

  constructor(deps: EventRouterDeps) {
    this.chatProvider = deps.chatProvider;
    this.ttsProvider = deps.ttsProvider;
    this.sessionConfig = deps.sessionConfig;
    this.send = deps.send;
  }

  async handleInbound(msg: WsMessage): Promise<void> {
    switch (msg.type) {
      case 'utterance.final':
        return this.handleUtterance(msg);
      case 'talker.turn':
        return this.handleTalkerTurn(msg);
      case 'world_state.update':
        return this.handleWorldStateUpdate(msg);
      default:
        console.warn(`[event-router] unknown inbound type: ${msg.type}`);
    }
  }

  private async handleUtterance(msg: WsMessage): Promise<void> {
    const payload = msg.payload as { speakerId?: string; text?: string };
    const prefix = payload.speakerId ? `[${payload.speakerId}]: ` : '';
    this.conversationHistory.push({
      role: 'user',
      content: `${prefix}${payload.text ?? ''}`,
    });

    return this.invokeTalker(msg.sessionId);
  }

  private async handleTalkerTurn(msg: WsMessage): Promise<void> {
    const payload = msg.payload as { messages?: ChatMessage[] };
    if (payload.messages) {
      this.conversationHistory.push(...payload.messages);
    }
    return this.invokeTalker(msg.sessionId);
  }

  private handleWorldStateUpdate(msg: WsMessage): void {
    telemetry.emit({
      type: 'task.progress',
      sessionId: msg.sessionId,
      eventId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      payload: msg.payload as Record<string, unknown>,
    });
  }

  private async invokeTalker(sessionId: string): Promise<void> {
    const result = await runTalkerTurn({
      provider: this.chatProvider,
      request: {
        sessionId,
        messages: this.conversationHistory,
        sessionConfig: this.sessionConfig,
      },
    });

    this.send(makeOutbound('talker.output', sessionId, result));

    if (result.tool_calls && Array.isArray(result.tool_calls)) {
      for (const tc of result.tool_calls) {
        const fn = (tc as { function?: { name?: string; arguments?: string } }).function;
        if (!fn) continue;
        const args = safeParseJson(fn.arguments);

        if (fn.name === 'speak' && args?.text) {
          await this.streamTTS(sessionId, args.text as string);
        }

        if (fn.name === 'avatar_command') {
          this.send(makeOutbound('avatar.command', sessionId, args));
        }
      }
    }
  }

  private async streamTTS(sessionId: string, text: string): Promise<void> {
    try {
      const stream = await synthesizeSpeech({
        provider: this.ttsProvider,
        request: { text },
        sessionId,
      });

      const reader = stream.getReader();
      let seq = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.send(
          makeOutbound('tts.audio.chunk', sessionId, {
            seq: seq++,
            audioBase64: Buffer.from(value).toString('base64'),
          }),
        );
      }
      this.send(makeOutbound('tts.audio.done', sessionId, { totalChunks: seq }));
    } catch (err) {
      console.error('[event-router] TTS stream error', err);
      this.send(makeOutbound('tts.audio.done', sessionId, { error: true }));
    }
  }
}

function makeOutbound(
  type: string,
  sessionId: string,
  payload: unknown,
): WsMessage {
  return {
    type,
    sessionId,
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    payload,
  };
}

function safeParseJson(raw: string | undefined): Record<string, unknown> | null {
  try {
    return JSON.parse(raw ?? '{}');
  } catch {
    return null;
  }
}
