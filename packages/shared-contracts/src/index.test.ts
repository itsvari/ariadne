import { describe, expect, it } from 'vitest';
import {
  BeliefStoreSchema,
  InterventionModeSchema,
  SessionConfigSchema,
  TalkerRequestSchema,
  TTSRequestSchema,
  WsMessageSchema,
} from './index';

describe('shared contracts', () => {
  it('accepts valid intervention modes', () => {
    expect(InterventionModeSchema.parse('control')).toBe('control');
    expect(InterventionModeSchema.parse('light')).toBe('light');
    expect(InterventionModeSchema.parse('heavy')).toBe('heavy');
  });

  it('parses session config defaults', () => {
    const config = SessionConfigSchema.parse({ interventionMode: 'light' });
    expect(config.thinkerIntervalSec).toBe(60);
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
});
