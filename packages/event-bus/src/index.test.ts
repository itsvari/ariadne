import { describe, expect, it } from 'vitest';
import { EventBus } from './index';

describe('EventBus', () => {
  it('publishes to subscribers', async () => {
    const bus = new EventBus();
    const received: string[] = [];

    bus.subscribe('UtteranceFinal', (event) => {
      received.push((event.payload as { text: string }).text);
    });

    await bus.publish({
      type: 'UtteranceFinal',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: { utteranceId: 'u1', text: 'hello' },
    });

    expect(received).toEqual(['hello']);
  });

  it('waits for a response event', async () => {
    const bus = new EventBus();
    const pending = bus.requestResponse('ReasonerComplete', 1000);

    await bus.publish({
      type: 'ReasonerComplete',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: { reason: 'manual', directiveCount: 1 },
    });

    const result = await pending;
    expect(result.payload.directiveCount).toBe(1);
  });

  it('unsubscribes handlers correctly', async () => {
    const bus = new EventBus();
    const received: string[] = [];

    const unsubscribe = bus.subscribe('UtteranceFinal', (event) => {
      received.push((event.payload as { text: string }).text);
    });

    await bus.publish({
      type: 'UtteranceFinal',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: { utteranceId: 'u1', text: 'before' },
    });

    unsubscribe();

    await bus.publish({
      type: 'UtteranceFinal',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: { utteranceId: 'u2', text: 'after' },
    });

    expect(received).toEqual(['before']);
  });

  it('cleans up listeners map when last handler is unsubscribed', async () => {
    const bus = new EventBus();

    const unsubscribe = bus.subscribe('UtteranceChunk', () => {});
    unsubscribe();

    await bus.publish({
      type: 'UtteranceChunk',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: { text: 'ignored' },
    });
  });

  it('supports multiple subscribers on the same event type', async () => {
    const bus = new EventBus();
    const received: string[] = [];

    bus.subscribe('UtteranceFinal', (event) => {
      received.push(`handler1:${(event.payload as { text: string }).text}`);
    });
    bus.subscribe('UtteranceFinal', (event) => {
      received.push(`handler2:${(event.payload as { text: string }).text}`);
    });

    await bus.publish({
      type: 'UtteranceFinal',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: { utteranceId: 'u1', text: 'hello' },
    });

    expect(received).toContain('handler1:hello');
    expect(received).toContain('handler2:hello');
    expect(received).toHaveLength(2);
  });

  it('runs async handlers in parallel', async () => {
    const bus = new EventBus();
    const order: number[] = [];

    bus.subscribe('UtteranceFinal', async () => {
      order.push(1);
    });
    bus.subscribe('UtteranceFinal', async () => {
      order.push(2);
    });

    await bus.publish({
      type: 'UtteranceFinal',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: { utteranceId: 'u1', text: 'test' },
    });

    expect(order).toContain(1);
    expect(order).toContain(2);
  });

  it('rejects requestResponse on timeout', async () => {
    const bus = new EventBus();
    const pending = bus.requestResponse('ReasonerComplete', 50);

    await expect(pending).rejects.toThrow('Timed out waiting for ReasonerComplete');
  });

  it('cleans up subscription after requestResponse resolves', async () => {
    const bus = new EventBus();

    const pending = bus.requestResponse('ReasonerComplete', 1000);

    await bus.publish({
      type: 'ReasonerComplete',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: { reason: 'test', directiveCount: 0 },
    });

    await pending;

    const secondPromise = bus.requestResponse('ReasonerComplete', 50);
    await expect(secondPromise).rejects.toThrow('Timed out waiting for ReasonerComplete');
  });

  it('publishes events with no subscribers without error', async () => {
    const bus = new EventBus();

    await bus.publish({
      type: 'AvatarCommand',
      sessionId: 's1',
      timestamp: new Date().toISOString(),
      payload: { command: 'idle' },
    });
  });
});
