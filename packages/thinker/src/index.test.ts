import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type {
  BeliefStore,
  ChatCompletionParams,
  ChatCompletionResult,
  ChatProvider,
  Directive,
  ToolCall,
  Utterance,
  WorldState,
} from '@ariadne/shared-contracts';
import { runThinkerTurn, startThinkerScheduler, THINKER_TOOLS } from './index';
import type { ThinkerToolRuntime } from './index';

class MockChatProvider implements ChatProvider {
  lastParams: ChatCompletionParams | null = null;
  result: ChatCompletionResult = { content: null, tool_calls: [] };
  callCount = 0;

  async complete(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    this.callCount += 1;
    this.lastParams = params;
    return this.result;
  }
}

function makeToolCall(name: string, args = '{}', id?: string): ToolCall {
  return {
    id: id ?? `call-${name}`,
    type: 'function',
    function: { name, arguments: args },
  };
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

function makeUtterance(text: string, role = 'user', speakerId?: string): Utterance {
  return {
    id: `u-${text}`,
    role: role as 'user' | 'assistant' | 'system',
    text,
    timestamp: new Date().toISOString(),
    ...(speakerId ? { speakerId } : {}),
  };
}

describe('runThinkerTurn', () => {
  it('adds strategic system context', async () => {
    const provider = new MockChatProvider();

    await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
    });

    expect(provider.lastParams?.messages[0]?.content).toContain('strategic thinker');
    expect(provider.lastParams?.tools?.map((tool) => tool.function.name)).toContain('write_belief_store');
  });

  it('maps utterance history to chat messages with speakerId prefix', async () => {
    const provider = new MockChatProvider();

    await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [
        makeUtterance('hello', 'user', 'alice'),
        makeUtterance('hi back', 'user', 'bob'),
      ],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
    });

    const messages = provider.lastParams?.messages ?? [];
    const conversationMessages = messages.slice(3);
    expect(conversationMessages[0]?.content).toBe('[alice]: hello');
    expect(conversationMessages[1]?.content).toBe('[bob]: hi back');
  });

  it('includes belief store and world state in system messages', async () => {
    const provider = new MockChatProvider();
    const worldState: WorldState = { players: [{ id: 'p1', location: 'lobby' }], location: 'lobby', activities: [] };

    await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState,
      currentBeliefStore: makeBeliefStore(),
    });

    const systemMessages = provider.lastParams?.messages.filter((m) => m.role === 'system') ?? [];
    expect(systemMessages.length).toBeGreaterThanOrEqual(3);
    expect(systemMessages[1]?.content).toContain('Current belief store');
    expect(systemMessages[2]?.content).toContain('World state');
    expect(systemMessages[2]?.content).toContain('lobby');
  });

  it('emits thinker.context telemetry', async () => {
    const provider = new MockChatProvider();
    const onTelemetry = vi.fn();
    const beliefStore = makeBeliefStore();
    beliefStore.participants = [{ id: 'u1', speakingFrequency: 1, stance: 'pro', emotionalTone: 'happy', engagementLevel: 0.8 }];

    await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: beliefStore,
      onTelemetry,
    });

    const contextEvents = onTelemetry.mock.calls.filter((call) => (call[0] as Record<string, unknown>).type === 'thinker.context');
    expect(contextEvents).toHaveLength(1);
    expect((contextEvents[0][0] as Record<string, unknown>).beliefParticipants).toBe(1);
  });

  it('emits model.request, system.latency, and model.response telemetry', async () => {
    const provider = new MockChatProvider();
    const onTelemetry = vi.fn();

    await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      onTelemetry,
    });

    const types = onTelemetry.mock.calls.map((call) => (call[0] as Record<string, unknown>).type);
    expect(types).toContain('model.request');
    expect(types).toContain('system.latency');
    expect(types).toContain('model.response');
  });

  it('returns immediately when no tool calls', async () => {
    const provider = new MockChatProvider();
    provider.result = { content: 'Thinking done' };

    const result = await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
    });

    expect(result.completion.content).toBe('Thinking done');
    expect(provider.callCount).toBe(1);
  });

  it('executes write_belief_store tool and updates returned belief store', async () => {
    const provider = new MockChatProvider();
    const newStore = makeBeliefStore();
    newStore.conversation_summary = 'Updated summary';

    provider.result = {
      content: null,
      tool_calls: [makeToolCall('write_belief_store', JSON.stringify({ store: newStore }))],
    };

    const toolRuntime: Partial<ThinkerToolRuntime> = {
      write_belief_store: vi.fn().mockResolvedValue(newStore),
    };

    const result = await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      toolRuntime,
      maxToolSteps: 1,
    });

    expect(toolRuntime.write_belief_store).toHaveBeenCalled();
    expect(result.updatedBeliefStore.conversation_summary).toBe('Updated summary');
  });

  it('executes enqueue_directive tool and collects directives', async () => {
    const provider = new MockChatProvider();
    const directive: Directive = {
      id: 'd1',
      instruction: 'Follow up',
      priority: 'high',
      createdAt: new Date().toISOString(),
    };

    provider.result = {
      content: null,
      tool_calls: [makeToolCall('enqueue_directive', JSON.stringify({ directive }))],
    };

    const toolRuntime: Partial<ThinkerToolRuntime> = {
      enqueue_directive: vi.fn().mockResolvedValue(directive),
    };

    const result = await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      toolRuntime,
      maxToolSteps: 1,
    });

    expect(toolRuntime.enqueue_directive).toHaveBeenCalledWith({ directive });
    expect(result.directives).toContain(directive);
  });

  it('executes read_world_state tool', async () => {
    const provider = new MockChatProvider();
    provider.result = {
      content: null,
      tool_calls: [makeToolCall('read_world_state')],
    };

    const worldState: WorldState = { players: [], location: 'room', activities: [] };
    const toolRuntime: Partial<ThinkerToolRuntime> = {
      read_world_state: vi.fn().mockResolvedValue(worldState),
    };

    await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      toolRuntime,
      maxToolSteps: 1,
    });

    expect(toolRuntime.read_world_state).toHaveBeenCalled();
  });

  it('executes compact_history tool', async () => {
    const provider = new MockChatProvider();
    provider.result = {
      content: null,
      tool_calls: [makeToolCall('compact_history', '{"summary":"Short recap"}')],
    };

    const toolRuntime: Partial<ThinkerToolRuntime> = {
      compact_history: vi.fn().mockResolvedValue({ compacted: true, summary: 'Short recap' }),
    };

    await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      toolRuntime,
      maxToolSteps: 1,
    });

    expect(toolRuntime.compact_history).toHaveBeenCalledWith({ summary: 'Short recap' });
  });

  it('executes avatar_command tool', async () => {
    const provider = new MockChatProvider();
    provider.result = {
      content: null,
      tool_calls: [makeToolCall('avatar_command', '{"command":"idle"}')],
    };

    const toolRuntime: Partial<ThinkerToolRuntime> = {
      avatar_command: vi.fn().mockResolvedValue({ ok: true }),
    };

    await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      toolRuntime,
      maxToolSteps: 1,
    });

    expect(toolRuntime.avatar_command).toHaveBeenCalledWith({ command: 'idle' });
  });

  it('skips tool execution when toolRuntime method is missing', async () => {
    const provider = new MockChatProvider();
    provider.result = {
      content: null,
      tool_calls: [makeToolCall('write_belief_store', '{}')],
    };

    const toolRuntime: Partial<ThinkerToolRuntime> = {};
    const beliefStore = makeBeliefStore();

    const result = await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: beliefStore,
      toolRuntime,
      maxToolSteps: 1,
    });

    expect(provider.callCount).toBe(1);
    expect(result.updatedBeliefStore).toEqual(beliefStore);
  });

  it('respects maxToolSteps limit', async () => {
    const provider = new MockChatProvider();
    provider.result = {
      content: null,
      tool_calls: [makeToolCall('read_world_state')],
    };

    const toolRuntime: Partial<ThinkerToolRuntime> = {
      read_world_state: vi.fn().mockResolvedValue(null),
    };

    await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      toolRuntime,
      maxToolSteps: 2,
    });

    expect(provider.callCount).toBeLessThanOrEqual(2);
  });

  it('uses default model when not specified', async () => {
    const provider = new MockChatProvider();

    await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
    });

    expect(provider.lastParams?.model).toBe('qwen/qwen3.6-plus:free');
  });

  it('passes thinker-specific params to provider', async () => {
    const provider = new MockChatProvider();

    await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
    });

    expect(provider.lastParams?.temperature).toBe(0.4);
    expect(provider.lastParams?.maxTokens).toBe(32768);
    expect(provider.lastParams?.reasoningEffort).toBe('medium');
  });

  it('includes all THINKER_TOOLS in the request', async () => {
    const expectedTools = ['write_belief_store', 'enqueue_directive', 'read_world_state', 'compact_history', 'avatar_command'];
    const toolNames = THINKER_TOOLS.map((t) => t.function.name);
    expect(toolNames).toEqual(expectedTools);
  });
});

describe('startThinkerScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the callback at the specified interval', () => {
    const callback = vi.fn();
    const controls = startThinkerScheduler(1000, callback);

    expect(callback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(2);

    controls.stop();
  });

  it('stops the interval when stop is called', () => {
    const callback = vi.fn();
    const controls = startThinkerScheduler(1000, callback);

    vi.advanceTimersByTime(1000);
    controls.stop();
    vi.advanceTimersByTime(2000);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('reschedules to a new interval', () => {
    const callback = vi.fn();
    const controls = startThinkerScheduler(1000, callback);

    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);

    controls.reschedule(500);

    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(500);
    expect(callback).toHaveBeenCalledTimes(3);

    controls.stop();
  });

  it('handles async callback errors without crashing', async () => {
    const callback = vi.fn().mockRejectedValue(new Error('async error'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const controls = startThinkerScheduler(100, callback);

    vi.advanceTimersByTime(100);

    await vi.advanceTimersByTimeAsync(0);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('callback failed'),
    );

    consoleErrorSpy.mockRestore();
    controls.stop();
  });
});

describe('getLastUserMessageSnippet', () => {
  it('omits last user message section when no user messages exist', async () => {
    const provider = new MockChatProvider();

    await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [
        makeUtterance('Hello', 'assistant', 'alice'),
      ],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
    });

    const messages = provider.lastParams?.messages ?? [];
    const systemMessages = messages.filter((m) => m.role === 'system');
    const contextMessage = systemMessages.find((m) => m.content?.includes('Last user message'));
    expect(contextMessage).toBeUndefined();
  });

  it('truncates long user messages with ellipsis in telemetry', async () => {
    const provider = new MockChatProvider();
    const onTelemetry = vi.fn();
    const longText = 'a'.repeat(300);

    await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [
        makeUtterance(longText, 'user', 'alice'),
      ],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      onTelemetry,
    });

    const requestEvents = onTelemetry.mock.calls.filter(
      (call) => (call[0] as Record<string, unknown>).type === 'model.request',
    );
    expect(requestEvents).toHaveLength(1);
    const lastUserMessage = (requestEvents[0][0] as Record<string, unknown>).lastUserMessage as string;
    expect(lastUserMessage).toContain('<truncated>');
  });
});

describe('decodeBeliefStoreArgument', () => {
  it('falls back when store value is non-object', async () => {
    const provider = new MockChatProvider();
    const originalStore = makeBeliefStore();
    originalStore.conversation_summary = 'original summary';

    provider.result = {
      content: null,
      tool_calls: [makeToolCall('write_belief_store', JSON.stringify({ store: 42 }))],
    };

    const result = await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: originalStore,
      toolRuntime: {
        write_belief_store: vi.fn().mockImplementation(({ store }) => store),
      },
      maxToolSteps: 1,
    });

    expect(result.updatedBeliefStore.conversation_summary).toBe('original summary');
    expect(result.updatedBeliefStore.version).toBe('v1');
  });

  it('normalizes participants from string entries', async () => {
    const provider = new MockChatProvider();
    const storeWithStrings = makeBeliefStore();
    storeWithStrings.participants = [
      { id: 'alice', speakingFrequency: 0, stance: 'unknown', emotionalTone: 'neutral', engagementLevel: 0.5 },
      { id: 'bob', speakingFrequency: 0, stance: 'unknown', emotionalTone: 'neutral', engagementLevel: 0.5 },
    ];

    provider.result = {
      content: null,
      tool_calls: [makeToolCall('write_belief_store', JSON.stringify({ store: storeWithStrings }))],
    };

    const result = await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      toolRuntime: {
        write_belief_store: vi.fn().mockImplementation(({ store }) => store),
      },
      maxToolSteps: 1,
    });

    expect(result.updatedBeliefStore.participants).toHaveLength(2);
    expect(result.updatedBeliefStore.participants[0].id).toBe('alice');
  });

  it('normalizes discussion state from string topic', async () => {
    const provider = new MockChatProvider();
    const storeWithStringTopic = makeBeliefStore();
    storeWithStringTopic.discussion_state = 'new topic' as unknown as typeof storeWithStringTopic.discussion_state;

    provider.result = {
      content: null,
      tool_calls: [makeToolCall('write_belief_store', JSON.stringify({ store: storeWithStringTopic }))],
    };

    const result = await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      toolRuntime: {
        write_belief_store: vi.fn().mockImplementation(({ store }) => store),
      },
      maxToolSteps: 1,
    });

    expect(result.updatedBeliefStore.discussion_state.currentTopic).toBe('new topic');
  });
});

describe('decodeDirectiveArgument', () => {
  it('creates directive from string instruction', async () => {
    const provider = new MockChatProvider();
    provider.result = {
      content: null,
      tool_calls: [makeToolCall('enqueue_directive', JSON.stringify({ directive: 'Follow up now' }))],
    };

    const result = await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      toolRuntime: {
        enqueue_directive: vi.fn().mockResolvedValue({
          id: 'd1',
          instruction: 'Follow up now',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        }),
      },
      maxToolSteps: 1,
    });

    expect(result.directives).toHaveLength(1);
    expect(result.directives[0].instruction).toBe('Follow up now');
  });

  it('uses default directive for empty string', async () => {
    const provider = new MockChatProvider();
    provider.result = {
      content: null,
      tool_calls: [makeToolCall('enqueue_directive', JSON.stringify({ directive: '   ' }))],
    };

    const result = await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      toolRuntime: {
        enqueue_directive: vi.fn().mockResolvedValue({
          id: 'd1',
          instruction: 'Follow up with the group.',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        }),
      },
      maxToolSteps: 1,
    });

    expect(result.directives[0].instruction).toBe('Follow up with the group.');
  });

  it('normalizes directive priority', async () => {
    const provider = new MockChatProvider();
    provider.result = {
      content: null,
      tool_calls: [makeToolCall('enqueue_directive', JSON.stringify({
        directive: { instruction: 'test', priority: 'invalid' },
      }))],
    };

    const result = await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      toolRuntime: {
        enqueue_directive: vi.fn().mockResolvedValue({
          id: 'd1',
          instruction: 'test',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        }),
      },
      maxToolSteps: 1,
    });

    expect(result.directives[0].priority).toBe('medium');
  });
});

describe('normalizeParticipant', () => {
  it('handles participant with number id', async () => {
    const provider = new MockChatProvider();
    const store = makeBeliefStore();
    store.participants = [
      { id: 42, speakingFrequency: 0, stance: 'unknown', emotionalTone: 'neutral', engagementLevel: 0.5 } as unknown as typeof store.participants[number],
    ];

    provider.result = {
      content: null,
      tool_calls: [makeToolCall('write_belief_store', JSON.stringify({ store }))],
    };

    const result = await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      toolRuntime: {
        write_belief_store: vi.fn().mockImplementation(({ store: s }) => s),
      },
      maxToolSteps: 1,
    });

    expect(result.updatedBeliefStore.participants[0].id).toBe('42');
  });

  it('filters out participants with empty string id', async () => {
    const provider = new MockChatProvider();
    const store = makeBeliefStore();
    store.participants = [{ id: '  ', speakingFrequency: 0, stance: '', emotionalTone: '', engagementLevel: 0 }] as unknown as typeof store.participants;

    provider.result = {
      content: null,
      tool_calls: [makeToolCall('write_belief_store', JSON.stringify({ store }))],
    };

    const result = await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: makeBeliefStore(),
      toolRuntime: {
        write_belief_store: vi.fn().mockImplementation(({ store: s }) => s),
      },
      maxToolSteps: 1,
    });

    expect(result.updatedBeliefStore.participants).toHaveLength(0);
  });
});
