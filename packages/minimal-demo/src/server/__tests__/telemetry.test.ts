import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { telemetry } from '../telemetry/emitter';
import { sessionStore } from '../telemetry/session-store';
import type { TelemetryEvent } from '../contracts/ai';

describe('TelemetryEmitter', () => {
  it('delivers events to subscribers', () => {
    const received: TelemetryEvent[] = [];
    const unsub = telemetry.subscribe((e) => received.push(e));

    const event: TelemetryEvent = {
      type: 'system.latency',
      sessionId: 's1',
      eventId: 'e1',
      timestamp: new Date().toISOString(),
      payload: { latencyMs: 42 },
    };
    telemetry.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ latencyMs: 42 });

    unsub();
  });

  it('supports unsubscribe', () => {
    const received: TelemetryEvent[] = [];
    const unsub = telemetry.subscribe((e) => received.push(e));
    unsub();

    telemetry.emit({
      type: 'test',
      sessionId: 's1',
      eventId: 'e2',
      timestamp: new Date().toISOString(),
      payload: {},
    });

    expect(received).toHaveLength(0);
  });

  it('tolerates listener errors', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unsub = telemetry.subscribe(() => {
      throw new Error('boom');
    });

    expect(() =>
      telemetry.emit({
        type: 'test',
        sessionId: 's1',
        eventId: 'e3',
        timestamp: new Date().toISOString(),
        payload: {},
      }),
    ).not.toThrow();

    unsub();
    spy.mockRestore();
  });
});

describe('SessionStore', () => {
  it('accumulates events per session', () => {
    telemetry.emit({
      type: 'facilitator.intervention',
      sessionId: 'store-test',
      eventId: 'e1',
      timestamp: new Date().toISOString(),
      payload: { action: 'speak' },
    });

    telemetry.emit({
      type: 'system.latency',
      sessionId: 'store-test',
      eventId: 'e2',
      timestamp: new Date().toISOString(),
      payload: { latencyMs: 100 },
    });

    const events = sessionStore.getEvents('store-test');
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array for unknown session', () => {
    expect(sessionStore.getEvents('nonexistent')).toEqual([]);
  });

  it('lists session ids', () => {
    telemetry.emit({
      type: 'test',
      sessionId: 'list-test',
      eventId: 'e1',
      timestamp: new Date().toISOString(),
      payload: {},
    });

    expect(sessionStore.getSessionIds()).toContain('list-test');
  });
});
