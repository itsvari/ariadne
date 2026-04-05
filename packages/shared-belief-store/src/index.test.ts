import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { BeliefStore, Directive, Utterance, WorldState } from '@ariadne/shared-contracts';

interface MockValkeyInstance {
  status: string;
  connect: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  rpush: ReturnType<typeof vi.fn>;
  lpop: ReturnType<typeof vi.fn>;
  lrange: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  multi: ReturnType<typeof vi.fn>;
}

function createMockInstance(): MockValkeyInstance {
  return {
    status: 'wait',
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue('PONG'),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    rpush: vi.fn().mockResolvedValue(1),
    lpop: vi.fn().mockResolvedValue(null),
    lrange: vi.fn().mockResolvedValue([]),
    quit: vi.fn().mockResolvedValue(undefined),
    multi: vi.fn().mockReturnThis(),
  };
}

let mockInstance: MockValkeyInstance;

vi.mock('iovalkey', () => {
  const MockValkey = vi.fn().mockImplementation(function (this: MockValkeyInstance, _url: string, _opts: unknown) {
    Object.assign(this, mockInstance);
    return this;
  });
  return { default: MockValkey };
});

async function getMock() {
  const { default: MockValkey } = await import('iovalkey');
  const valkey = MockValkey as unknown as ReturnType<typeof vi.fn>;
  const lastCall = valkey.mock.results[valkey.mock.results.length - 1];
  return lastCall?.value as MockValkeyInstance;
}

function makeBeliefStore(): BeliefStore {
  return {
    version: 'v1',
    participants: [],
    discussion_state: { currentTopic: 'unknown', phase: 'discussion', openQuestions: [] },
    facilitation_plan: [],
    directive_queue: [],
    conversation_summary: '',
    updatedAt: new Date().toISOString(),
  };
}

function makeDirective(id = 'd1'): Directive {
  return {
    id,
    instruction: 'Test directive',
    priority: 'medium',
    createdAt: new Date().toISOString(),
  };
}

function makeUtterance(id = 'u1'): Utterance {
  return {
    id,
    role: 'user',
    text: 'Hello',
    timestamp: new Date().toISOString(),
  };
}

function makeWorldState(): WorldState {
  return {
    players: [],
    location: 'lobby',
    activities: [],
    updatedAt: new Date().toISOString(),
  };
}

describe('SharedBeliefStore', () => {
  beforeEach(() => {
    vi.resetModules();
    mockInstance = createMockInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createStore() {
    const { SharedBeliefStore } = await import('./index');
    return new SharedBeliefStore();
  }

  it('creates a valkey client with lazyConnect', async () => {
    const { default: MockValkey } = await import('iovalkey');
    await createStore();

    expect(MockValkey).toHaveBeenCalledWith('valkey://localhost:6379', expect.objectContaining({
      lazyConnect: true,
    }));
  });

  it('uses default valkey URL when not provided', async () => {
    const { default: MockValkey } = await import('iovalkey');
    await createStore();

    expect(MockValkey).toHaveBeenCalledWith('valkey://localhost:6379', expect.any(Object));
  });

  it('healthCheck returns true on successful ping', async () => {
    const store = await createStore();
    const mock = await getMock();
    mock.ping.mockResolvedValue('PONG');

    const result = await store.healthCheck();

    expect(result).toBe(true);
    expect(mock.connect).toHaveBeenCalled();
    expect(mock.ping).toHaveBeenCalled();
  });

  it('healthCheck returns false when ping fails', async () => {
    const store = await createStore();
    const mock = await getMock();
    mock.ping.mockResolvedValue('ERR');

    const result = await store.healthCheck();

    expect(result).toBe(false);
  });

  it('readBeliefStore returns empty store when key is missing', async () => {
    const store = await createStore();
    const mock = await getMock();
    mock.get.mockResolvedValue(null);

    const result = await store.readBeliefStore('session-1');

    expect(result.version).toBe('v1');
    expect(result.participants).toEqual([]);
  });

  it('readBeliefStore parses stored belief store', async () => {
    const store = await createStore();
    const mock = await getMock();
    const storedStore = makeBeliefStore();
    storedStore.participants = [{ id: 'user-1', speakingFrequency: 0, stance: 'neutral', emotionalTone: 'calm', engagementLevel: 0.5 }];
    mock.get.mockResolvedValue(JSON.stringify(storedStore));

    const result = await store.readBeliefStore('session-1');

    expect(result.participants).toHaveLength(1);
    expect(result.participants[0].id).toBe('user-1');
  });

  it('writeBeliefStore updates the timestamp and stores the data', async () => {
    const store = await createStore();
    const mock = await getMock();
    const beliefStore = makeBeliefStore();

    await store.writeBeliefStore('session-1', beliefStore);

    expect(mock.set).toHaveBeenCalledWith(
      'belief:session-1',
      expect.stringContaining('"version":"v1"'),
    );
  });

  it('enqueueDirective pushes to directives list and updates belief store', async () => {
    const store = await createStore();
    const mock = await getMock();
    mock.get.mockResolvedValue(JSON.stringify(makeBeliefStore()));
    const directive = makeDirective();

    await store.enqueueDirective('session-1', directive);

    expect(mock.rpush).toHaveBeenCalledWith(
      'directives:session-1',
      expect.stringContaining(directive.id),
    );
  });

  it('dequeueDirective returns null when queue is empty', async () => {
    const store = await createStore();
    const mock = await getMock();
    mock.lpop.mockResolvedValue(null);

    const result = await store.dequeueDirective('session-1');

    expect(result).toBeNull();
  });

  it('dequeueDirective returns and moves directive to fulfilled list', async () => {
    const store = await createStore();
    const mock = await getMock();
    const directive = makeDirective();
    mock.lpop.mockResolvedValue(JSON.stringify(directive));
    mock.get.mockResolvedValue(JSON.stringify({
      ...makeBeliefStore(),
      directive_queue: [directive],
    }));

    const result = await store.dequeueDirective('session-1');

    expect(result).not.toBeNull();
    expect(result?.id).toBe(directive.id);
    expect(mock.rpush).toHaveBeenCalledWith(
      'directives:session-1:fulfilled',
      expect.stringContaining(directive.id),
    );
  });

  it('getDirectives returns all directives', async () => {
    const store = await createStore();
    const mock = await getMock();
    const directives = [makeDirective('d1'), makeDirective('d2')];
    mock.lrange.mockResolvedValue(directives.map((d) => JSON.stringify(d)));

    const result = await store.getDirectives('session-1');

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('d1');
    expect(result[1].id).toBe('d2');
  });

  it('getFulfilledDirectives returns fulfilled directives', async () => {
    const store = await createStore();
    const mock = await getMock();
    const directives = [makeDirective('f1')];
    mock.lrange.mockResolvedValue(directives.map((d) => JSON.stringify(d)));

    const result = await store.getFulfilledDirectives('session-1');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('f1');
  });

  it('appendHistory pushes utterance to history list', async () => {
    const store = await createStore();
    const mock = await getMock();
    const utterance = makeUtterance();

    await store.appendHistory('session-1', utterance);

    expect(mock.rpush).toHaveBeenCalledWith(
      'history:session-1',
      expect.stringContaining(utterance.id),
    );
  });

  it('getHistory returns all history when no limit', async () => {
    const store = await createStore();
    const mock = await getMock();
    const utterances = [makeUtterance('u1'), makeUtterance('u2')];
    mock.lrange.mockResolvedValue(utterances.map((u) => JSON.stringify(u)));

    const result = await store.getHistory('session-1');

    expect(result).toHaveLength(2);
    expect(mock.lrange).toHaveBeenCalledWith('history:session-1', 0, -1);
  });

  it('getHistory respects limit parameter', async () => {
    const store = await createStore();
    const mock = await getMock();
    mock.lrange.mockResolvedValue([JSON.stringify(makeUtterance('u3'))]);

    await store.getHistory('session-1', 1);

    expect(mock.lrange).toHaveBeenCalledWith('history:session-1', -1, -1);
  });

  it('compactHistory updates belief store and sets summary key', async () => {
    const store = await createStore();
    const mock = await getMock();
    mock.get.mockResolvedValue(JSON.stringify(makeBeliefStore()));

    await store.compactHistory('session-1', 'New summary');

    expect(mock.set).toHaveBeenCalledWith(
      'history:session-1:summary',
      'New summary',
    );
  });

  it('setWorldState stores world state with updated timestamp', async () => {
    const store = await createStore();
    const mock = await getMock();
    const worldState = makeWorldState();

    await store.setWorldState('session-1', worldState);

    expect(mock.set).toHaveBeenCalledWith(
      'world:session-1',
      expect.stringContaining('"location":"lobby"'),
    );
  });

  it('getWorldState returns null when key is missing', async () => {
    const store = await createStore();
    const mock = await getMock();
    mock.get.mockResolvedValue(null);

    const result = await store.getWorldState('session-1');

    expect(result).toBeNull();
  });

  it('getWorldState returns parsed world state', async () => {
    const store = await createStore();
    const mock = await getMock();
    const worldState = makeWorldState();
    mock.get.mockResolvedValue(JSON.stringify(worldState));

    const result = await store.getWorldState('session-1');

    expect(result).not.toBeNull();
    expect(result?.location).toBe('lobby');
  });

  it('clearSession deletes all session keys', async () => {
    const store = await createStore();
    const mock = await getMock();

    await store.clearSession('session-1');

    expect(mock.del).toHaveBeenCalledWith(
      'belief:session-1',
      'directives:session-1',
      'directives:session-1:fulfilled',
      'history:session-1',
      'history:session-1:summary',
      'world:session-1',
    );
  });

  it('resetSessionForNewRun archives and clears session', async () => {
    const store = await createStore();
    const mock = await getMock();
    mock.get.mockResolvedValue(JSON.stringify(makeBeliefStore()));
    const multiMock = {
      set: vi.fn().mockReturnThis(),
      rpush: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue(undefined),
    };
    mock.multi.mockReturnValue(multiMock);

    const result = await store.resetSessionForNewRun('session-1');

    expect(result.archiveId).toBeDefined();
    expect(mock.set).toHaveBeenCalledWith(
      'belief:session-1',
      expect.stringContaining('"version":"v1"'),
    );
  });

  it('resetSessionForNewRun returns null archiveId when no data exists', async () => {
    const store = await createStore();
    const mock = await getMock();
    mock.get.mockResolvedValue(null);
    mock.lrange.mockResolvedValue([]);

    const result = await store.resetSessionForNewRun('session-1');

    expect(result.archiveId).toBeNull();
  });

  it('listSessionArchives returns empty array when no archives exist', async () => {
    const store = await createStore();
    const mock = await getMock();
    mock.lrange.mockResolvedValue([]);

    const result = await store.listSessionArchives('session-1');

    expect(result).toEqual([]);
  });

  it('readSessionArchive returns null when archive not found', async () => {
    const store = await createStore();
    const mock = await getMock();
    mock.get.mockResolvedValue(null);

    const result = await store.readSessionArchive('archive-1');

    expect(result).toBeNull();
  });

  it('disconnect calls quit on valkey client', async () => {
    const store = await createStore();
    const mock = await getMock();

    await store.disconnect();

    expect(mock.quit).toHaveBeenCalled();
  });
});
