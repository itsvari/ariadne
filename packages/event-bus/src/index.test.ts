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
});
