import { describe, it, expect } from 'vitest';
import {
  TalkerRequest,
  TalkerResponse,
  TTSRequest,
  WsMessage,
  SessionConfig,
  InterventionMode,
} from '../contracts/ai';

describe('InterventionMode', () => {
  it('accepts valid modes', () => {
    expect(InterventionMode.parse('control')).toBe('control');
    expect(InterventionMode.parse('light')).toBe('light');
    expect(InterventionMode.parse('heavy')).toBe('heavy');
  });

  it('rejects invalid modes', () => {
    expect(() => InterventionMode.parse('extreme')).toThrow();
  });
});

describe('SessionConfig', () => {
  it('parses a full config', () => {
    const cfg = SessionConfig.parse({
      interventionMode: 'light',
      groupSize: 3,
      taskId: 'escape-room-1',
      phase: 'collaboration',
    });
    expect(cfg.interventionMode).toBe('light');
    expect(cfg.groupSize).toBe(3);
  });

  it('requires interventionMode', () => {
    expect(() => SessionConfig.parse({})).toThrow();
  });
});

describe('TalkerRequest', () => {
  it('parses minimal request', () => {
    const req = TalkerRequest.parse({
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(req.sessionId).toBe('sess-1');
    expect(req.messages).toHaveLength(1);
  });

  it('parses request with sessionConfig', () => {
    const req = TalkerRequest.parse({
      sessionId: 'sess-2',
      messages: [],
      sessionConfig: { interventionMode: 'heavy' },
    });
    expect(req.sessionConfig?.interventionMode).toBe('heavy');
  });

  it('rejects missing sessionId', () => {
    expect(() =>
      TalkerRequest.parse({ messages: [{ role: 'user', content: 'hi' }] }),
    ).toThrow();
  });
});

describe('TalkerResponse', () => {
  it('parses content-only response', () => {
    const res = TalkerResponse.parse({ content: 'hello' });
    expect(res.content).toBe('hello');
  });

  it('parses null content with tool_calls', () => {
    const res = TalkerResponse.parse({
      content: null,
      tool_calls: [{ function: { name: 'speak', arguments: '{"text":"hi"}' } }],
    });
    expect(res.content).toBeNull();
    expect(res.tool_calls).toBeDefined();
  });
});

describe('TTSRequest', () => {
  it('parses valid request', () => {
    const req = TTSRequest.parse({ text: 'Hello world' });
    expect(req.text).toBe('Hello world');
  });

  it('rejects empty text', () => {
    expect(() => TTSRequest.parse({ text: '' })).toThrow();
  });

  it('accepts optional format', () => {
    const req = TTSRequest.parse({ text: 'hi', format: 'opus' });
    expect(req.format).toBe('opus');
  });
});

describe('WsMessage', () => {
  it('parses valid message', () => {
    const msg = WsMessage.parse({
      type: 'utterance.final',
      sessionId: 's1',
      eventId: 'e1',
      timestamp: '2026-01-01T00:00:00Z',
      payload: { text: 'hello' },
    });
    expect(msg.type).toBe('utterance.final');
  });
});
