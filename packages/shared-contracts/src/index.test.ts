import { describe, expect, it } from 'vitest';
import {
  BeliefStoreSchema,
  ChatMessageSchema,
  ClientAudioChunkPayloadSchema,
  ClientAudioCommitPayloadSchema,
  ClientHelloPayloadSchema,
  ClientPingPayloadSchema,
  ClientThinkerTriggerPayloadSchema,
  ClientUtteranceFinalPayloadSchema,
  ClientWorldStatePayloadSchema,
  ClientWsMessageSchema,
  DirectiveSchema,
  DiscussionStateSchema,
  InterventionModeSchema,
  ParticipantSchema,
  SessionConfigSchema,
  TalkerRequestSchema,
  TalkerResponseSchema,
  TelemetryEventSchema,
  ToolCallSchema,
  TTSRequestSchema,
  UtteranceSchema,
  WorldPlayerSchema,
  WorldStateSchema,
  WsMessageSchema,
  createEmptyBeliefStore,
  parseToolArguments,
  utteranceToChatMessage,
} from './index';

describe('shared contracts', () => {
  it('accepts valid intervention modes', () => {
    expect(InterventionModeSchema.parse('control')).toBe('control');
    expect(InterventionModeSchema.parse('light')).toBe('light');
  });

  it('rejects invalid intervention modes', () => {
    expect(() => InterventionModeSchema.parse('invalid')).toThrow();
    expect(() => InterventionModeSchema.parse('')).toThrow();
  });

  it('parses session config defaults', () => {
    const config = SessionConfigSchema.parse({ interventionMode: 'light' });
    expect(config.thinkerIntervalSec).toBe(60);
  });

  it('rejects thinker interval below minimum', () => {
    expect(() => SessionConfigSchema.parse({ interventionMode: 'control', thinkerIntervalSec: 5 })).toThrow();
  });

  it('rejects thinker interval above maximum', () => {
    expect(() => SessionConfigSchema.parse({ interventionMode: 'control', thinkerIntervalSec: 9999 })).toThrow();
  });

  it('builds an empty belief store', () => {
    const store = BeliefStoreSchema.parse({});
    expect(store.participants).toEqual([]);
    expect(store.discussion_state.phase).toBe('discussion');
  });

  it('parses talker requests', () => {
    const request = TalkerRequestSchema.parse({
      sessionId: 'session-1',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(request.sessionId).toBe('session-1');
  });

  it('validates tts requests', () => {
    expect(TTSRequestSchema.parse({ text: 'Hello' }).text).toBe('Hello');
  });

  it('rejects tts requests with empty text', () => {
    expect(() => TTSRequestSchema.parse({ text: '' })).toThrow();
  });

  it('parses websocket messages', () => {
    const message = WsMessageSchema.parse({
      type: 'session.status',
      sessionId: 's1',
      eventId: 'e1',
      timestamp: new Date().toISOString(),
      payload: { active: true },
    });
    expect(message.type).toBe('session.status');
  });

  it('normalises empty participant ids in client hello payloads', () => {
    const payload = ClientHelloPayloadSchema.parse({
      clientId: 'quest-client',
      participantId: '   ',
      autoStartSession: true,
      sessionConfig: {
        interventionMode: 'control',
        thinkerIntervalSec: 60,
      },
    });

    expect(payload.participantId).toBeUndefined();
  });

  it('parses tool calls with defaults', () => {
    const toolCall = ToolCallSchema.parse({
      function: { name: 'speak', arguments: '{"text":"hello"}' },
    });
    expect(toolCall.type).toBe('function');
    expect(toolCall.function.arguments).toBe('{"text":"hello"}');
  });

  it('parses tool calls with optional id', () => {
    const toolCall = ToolCallSchema.parse({
      id: 'call-1',
      function: { name: 'speak' },
    });
    expect(toolCall.id).toBe('call-1');
    expect(toolCall.function.arguments).toBe('{}');
  });

  it('parses chat messages', () => {
    const message = ChatMessageSchema.parse({
      role: 'assistant',
      content: 'Hello there',
      tool_calls: [{ function: { name: 'speak', arguments: '{}' } }],
    });
    expect(message.role).toBe('assistant');
    expect(message.tool_calls).toHaveLength(1);
  });

  it('parses participant schema', () => {
    const participant = ParticipantSchema.parse({ id: 'user-1' });
    expect(participant.id).toBe('user-1');
    expect(participant.stance).toBe('unknown');
    expect(participant.engagementLevel).toBe(0.5);
  });

  it('parses discussion state schema', () => {
    const state = DiscussionStateSchema.parse({});
    expect(state.currentTopic).toBe('unknown');
    expect(state.phase).toBe('discussion');
    expect(state.openQuestions).toEqual([]);
  });

  it('parses directive schema', () => {
    const directive = DirectiveSchema.parse({
      id: 'd1',
      instruction: 'Do something',
      createdAt: new Date().toISOString(),
    });
    expect(directive.priority).toBe('medium');
  });

  it('parses world player schema', () => {
    const player = WorldPlayerSchema.parse({ id: 'p1', location: 'lobby' });
    expect(player.id).toBe('p1');
    expect(player.location).toBe('lobby');
  });

  it('parses world state schema', () => {
    const state = WorldStateSchema.parse({});
    expect(state.players).toEqual([]);
    expect(state.location).toBe('unknown');
  });

  it('parses utterance schema with defaults', () => {
    const utterance = UtteranceSchema.parse({ text: 'hello' });
    expect(utterance.role).toBe('user');
    expect(utterance.id).toBeDefined();
    expect(utterance.timestamp).toBeDefined();
  });

  it('parses talker response schema', () => {
    const response = TalkerResponseSchema.parse({ content: 'Hello' });
    expect(response.content).toBe('Hello');
  });

  it('parses client utterance final payload', () => {
    const payload = ClientUtteranceFinalPayloadSchema.parse({ text: 'hello world' });
    expect(payload.text).toBe('hello world');
  });

  it('parses client world state payload', () => {
    const payload = ClientWorldStatePayloadSchema.parse({
      state: { players: [], location: 'room', activities: [] },
    });
    expect(payload.state.location).toBe('room');
  });

  it('parses client thinker trigger payload', () => {
    const payload = ClientThinkerTriggerPayloadSchema.parse({ reason: 'user asked' });
    expect(payload.reason).toBe('user asked');
  });

  it('parses client ping payload', () => {
    const payload = ClientPingPayloadSchema.parse({});
    expect(payload.sentAt).toBeUndefined();
  });

  it('parses client audio chunk payload', () => {
    const payload = ClientAudioChunkPayloadSchema.parse({ audioBase64: 'base64data' });
    expect(payload.sampleRateHz).toBe(16000);
    expect(payload.channels).toBe(1);
  });

  it('parses client audio commit payload', () => {
    const payload = ClientAudioCommitPayloadSchema.parse({ reason: 'silence' });
    expect(payload.reason).toBe('silence');
  });

  it('parses telemetry event schema', () => {
    const event = TelemetryEventSchema.parse({
      type: 'model.request',
      sessionId: 's1',
      eventId: 'e1',
      timestamp: new Date().toISOString(),
      payload: { model: 'gpt-4' },
    });
    expect(event.type).toBe('model.request');
  });

  describe('ClientWsMessageSchema discriminated union', () => {
    it('parses client.hello messages', () => {
      const msg = ClientWsMessageSchema.parse({
        type: 'client.hello',
        payload: { clientId: 'c1' },
      });
      expect(msg.type).toBe('client.hello');
      if (msg.type === 'client.hello') {
        expect(msg.payload.clientId).toBe('c1');
      }
    });

    it('parses client.utterance.final messages', () => {
      const msg = ClientWsMessageSchema.parse({
        type: 'client.utterance.final',
        payload: { text: 'hello' },
      });
      expect(msg.type).toBe('client.utterance.final');
      if (msg.type === 'client.utterance.final') {
        expect(msg.payload.text).toBe('hello');
      }
    });

    it('parses client.world_state messages', () => {
      const msg = ClientWsMessageSchema.parse({
        type: 'client.world_state',
        payload: { state: { players: [], location: 'x', activities: [] } },
      });
      expect(msg.type).toBe('client.world_state');
    });

    it('parses client.thinker.trigger messages', () => {
      const msg = ClientWsMessageSchema.parse({
        type: 'client.thinker.trigger',
        payload: { reason: 'test' },
      });
      expect(msg.type).toBe('client.thinker.trigger');
    });

    it('parses client.ping messages', () => {
      const msg = ClientWsMessageSchema.parse({
        type: 'client.ping',
      });
      expect(msg.type).toBe('client.ping');
    });

    it('parses client.audio.chunk messages', () => {
      const msg = ClientWsMessageSchema.parse({
        type: 'client.audio.chunk',
        payload: { audioBase64: 'data' },
      });
      expect(msg.type).toBe('client.audio.chunk');
    });

    it('parses client.audio.commit messages', () => {
      const msg = ClientWsMessageSchema.parse({
        type: 'client.audio.commit',
      });
      expect(msg.type).toBe('client.audio.commit');
    });
  });

  describe('createEmptyBeliefStore', () => {
    it('returns a valid empty belief store', () => {
      const store = createEmptyBeliefStore();
      expect(store.version).toBe('v1');
      expect(store.participants).toEqual([]);
      expect(store.directive_queue).toEqual([]);
      expect(store.facilitation_plan).toEqual([]);
      expect(store.conversation_summary).toBe('');
      expect(store.updatedAt).toBeDefined();
    });
  });

  describe('parseToolArguments', () => {
    it('parses valid JSON arguments', () => {
      const args = parseToolArguments<{ text: string }>('{"text":"hello"}');
      expect(args.text).toBe('hello');
    });

    it('returns empty object for undefined input', () => {
      const args = parseToolArguments();
      expect(args).toEqual({});
    });

    it('returns empty object for empty string', () => {
      const args = parseToolArguments('');
      expect(args).toEqual({});
    });

    it('returns empty object for invalid JSON', () => {
      const args = parseToolArguments('{invalid json}');
      expect(args).toEqual({});
    });
  });

  describe('utteranceToChatMessage', () => {
    it('prefixes speakerId for user messages', () => {
      const message = utteranceToChatMessage({
        id: 'u1',
        role: 'user',
        speakerId: 'alice',
        text: 'hello',
        timestamp: new Date().toISOString(),
      });
      expect(message.role).toBe('user');
      expect(message.content).toBe('[alice]: hello');
    });

    it('does not prefix when speakerId is missing', () => {
      const message = utteranceToChatMessage({
        id: 'u1',
        role: 'user',
        text: 'hello',
        timestamp: new Date().toISOString(),
      });
      expect(message.content).toBe('hello');
    });

    it('maps assistant role correctly', () => {
      const message = utteranceToChatMessage({
        id: 'u1',
        role: 'assistant',
        text: 'response',
        timestamp: new Date().toISOString(),
      });
      expect(message.role).toBe('assistant');
    });

    it('maps system role correctly', () => {
      const message = utteranceToChatMessage({
        id: 'u1',
        role: 'system',
        text: 'instruction',
        timestamp: new Date().toISOString(),
      });
      expect(message.role).toBe('system');
    });
  });
});
