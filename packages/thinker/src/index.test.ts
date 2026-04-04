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
