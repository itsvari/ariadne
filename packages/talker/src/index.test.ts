import { describe, expect, it, vi } from 'vitest';
import type {
  BeliefStore,
  ChatCompletionParams,
  ChatCompletionResult,
  ChatMessage,
  ChatProvider,
  Directive,
  ToolCall,
  WorldState,
} from '@ariadne/shared-contracts';
import { runTalkerTurn, TALKER_TOOLS } from './index';
import type { TalkerToolRuntime } from './index';

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

describe('runTalkerTurn', () => {
  it('prepends the control system prompt by default', async () => {
    const provider = new MockChatProvider();

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(provider.lastParams?.messages[0]?.content).toContain('stay out of the way');
  });

  it('exposes the talker toolset', async () => {
    const provider = new MockChatProvider();

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    const toolNames = provider.lastParams?.tools?.map((tool) => tool.function.name) ?? [];
    expect(toolNames).toContain('speak');
    expect(toolNames).toContain('wait_for_reasoner');
  });

  it('uses the light system prompt when intervention mode is light', async () => {
    const provider = new MockChatProvider();

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
        sessionConfig: { interventionMode: 'light', thinkerIntervalSec: 60 },
      },
    });

    expect(provider.lastParams?.messages[0]?.content).toContain('LIGHT FACILITATION');
  });

  it('includes belief store snapshot in messages when provided', async () => {
    const provider = new MockChatProvider();
    const snapshot = makeBeliefStore();
    snapshot.participants = [{ id: 'user-1', speakingFrequency: 0, stance: 'neutral', emotionalTone: 'calm', engagementLevel: 0.5 }];

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
        beliefSnapshot: snapshot,
      },
    });

    const systemMessages = provider.lastParams?.messages.filter((m) => m.role === 'system') ?? [];
    const beliefMessage = systemMessages.find((m) => m.content?.includes('Belief store snapshot'));
    expect(beliefMessage).toBeDefined();
    expect(beliefMessage?.content).toContain('user-1');
  });

  it('includes directives in messages when provided', async () => {
    const provider = new MockChatProvider();
    const directives: Directive[] = [
      { id: 'd1', instruction: 'Ask about progress', priority: 'high', createdAt: new Date().toISOString() },
    ];

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
        directives,
      },
    });

    const allMessages = provider.lastParams?.messages ?? [];
    const directiveMessage = allMessages.find((m) => m.content?.includes('Ask about progress'));
    expect(directiveMessage).toBeDefined();
  });

  it('includes world state in messages when provided', async () => {
    const provider = new MockChatProvider();
    const worldState: WorldState = { players: [], location: 'lobby', activities: [], updatedAt: new Date().toISOString() };

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
        worldState,
      },
    });

    const systemMessages = provider.lastParams?.messages.filter((m) => m.role === 'system') ?? [];
    const worldMessage = systemMessages.find((m) => m.content?.includes('World state'));
    expect(worldMessage).toBeDefined();
    expect(worldMessage?.content).toContain('lobby');
  });

  it('returns immediately when no tool calls are present', async () => {
    const provider = new MockChatProvider();
    provider.result = { content: 'Hello there' };

    const result = await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(result.content).toBe('Hello there');
    expect(provider.callCount).toBe(1);
  });

  it('executes tool calls when toolRuntime is provided', async () => {
    const provider = new MockChatProvider();
    provider.result = {
      content: null,
      tool_calls: [makeToolCall('speak', '{"text":"Hello"}')],
    };

    const toolRuntime: Partial<TalkerToolRuntime> = {
      speak: vi.fn().mockResolvedValue({ played: true }),
    };

    const result = await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
      toolRuntime,
    });

    expect(toolRuntime.speak).toHaveBeenCalledWith({ text: 'Hello' });
    expect(result.tool_calls).toHaveLength(1);
  });

  it('stops on terminal tool (speak)', async () => {
    const provider = new MockChatProvider();
    provider.result = {
      content: null,
      tool_calls: [makeToolCall('speak', '{"text":"Hi"}')],
    };

    const toolRuntime: Partial<TalkerToolRuntime> = {
      speak: vi.fn().mockResolvedValue({ ok: true }),
    };

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
      toolRuntime,
    });

    expect(provider.callCount).toBe(1);
  });

  it('stops on terminal tool (avatar_command)', async () => {
    const provider = new MockChatProvider();
    provider.result = {
      content: null,
      tool_calls: [makeToolCall('avatar_command', '{"command":"idle"}')],
    };

    const toolRuntime: Partial<TalkerToolRuntime> = {
      avatar_command: vi.fn().mockResolvedValue({ ok: true }),
    };

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
      toolRuntime,
    });

    expect(provider.callCount).toBe(1);
  });

  it('continues tool loop for non-terminal tools', async () => {
    const provider = new MockChatProvider();

    provider.result = {
      content: null,
      tool_calls: [makeToolCall('read_belief_store')],
    };

    const toolRuntime: Partial<TalkerToolRuntime> = {
      read_belief_store: vi.fn().mockResolvedValue(makeBeliefStore()),
    };

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
      toolRuntime,
    });

    expect(provider.callCount).toBeGreaterThan(1);
  });

  it('respects maxToolSteps limit', async () => {
    const provider = new MockChatProvider();

    provider.result = {
      content: null,
      tool_calls: [makeToolCall('read_belief_store')],
    };

    const toolRuntime: Partial<TalkerToolRuntime> = {
      read_belief_store: vi.fn().mockResolvedValue(makeBeliefStore()),
    };

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
      toolRuntime,
      maxToolSteps: 2,
    });

    expect(provider.callCount).toBeLessThanOrEqual(2);
  });

  it('emits telemetry events', async () => {
    const provider = new MockChatProvider();
    provider.result = { content: 'response' };
    const onTelemetry = vi.fn();

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
      onTelemetry,
    });

    const telemetryTypes = onTelemetry.mock.calls.map((call) => (call[0] as Record<string, unknown>).type);
    expect(telemetryTypes).toContain('model.request');
    expect(telemetryTypes).toContain('system.latency');
    expect(telemetryTypes).toContain('model.response');
  });

  it('emits facilitator.intervention telemetry when speak tool is used', async () => {
    const provider = new MockChatProvider();
    provider.result = {
      content: null,
      tool_calls: [makeToolCall('speak', '{"text":"Hello world"}')],
    };

    const onTelemetry = vi.fn();
    const toolRuntime: Partial<TalkerToolRuntime> = {
      speak: vi.fn().mockResolvedValue({ ok: true }),
    };

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
      toolRuntime,
      onTelemetry,
    });

    const interventionEvents = onTelemetry.mock.calls.filter(
      (call) => (call[0] as Record<string, unknown>).type === 'facilitator.intervention',
    );
    expect(interventionEvents).toHaveLength(1);
    expect(interventionEvents[0][0].text).toBe('Hello world');
  });

  it('passes temperature and maxTokens to provider', async () => {
    const provider = new MockChatProvider();

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(provider.lastParams?.temperature).toBe(0.7);
    expect(provider.lastParams?.maxTokens).toBe(32768);
    expect(provider.lastParams?.toolChoice).toBe('auto');
  });

  it('uses default model when not specified', async () => {
    const provider = new MockChatProvider();

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(provider.lastParams?.model).toBe('qwen/qwen3.6-plus:free');
  });

  it('includes all TALKER_TOOLS in the request', async () => {
    const expectedTools = ['speak', 'avatar_command', 'trigger_reasoner', 'wait_for_reasoner', 'read_belief_store', 'dequeue_directive'];
    const toolNames = TALKER_TOOLS.map((t) => t.function.name);
    expect(toolNames).toEqual(expectedTools);
  });

  it('skips tool execution when toolRuntime method is missing', async () => {
    const provider = new MockChatProvider();
    provider.result = {
      content: null,
      tool_calls: [makeToolCall('trigger_reasoner', '{"reason":"test"}')],
    };

    const toolRuntime: Partial<TalkerToolRuntime> = {};

    const result = await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
      toolRuntime,
    });

    expect(provider.callCount).toBe(1);
    expect(result.tool_calls).toHaveLength(1);
  });

  it('handles multiple tool calls in a single response', async () => {
    const provider = new MockChatProvider();
    provider.result = {
      content: null,
      tool_calls: [
        makeToolCall('read_belief_store'),
        makeToolCall('dequeue_directive'),
      ],
    };

    const toolRuntime: Partial<TalkerToolRuntime> = {
      read_belief_store: vi.fn().mockResolvedValue(makeBeliefStore()),
      dequeue_directive: vi.fn().mockResolvedValue(null),
    };

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
      toolRuntime,
      maxToolSteps: 1,
    });

    expect(toolRuntime.read_belief_store).toHaveBeenCalled();
    expect(toolRuntime.dequeue_directive).toHaveBeenCalled();
  });

  it('appends tool results to messages for subsequent turns', async () => {
    const provider = new MockChatProvider();

    provider.result = {
      content: null,
      tool_calls: [makeToolCall('read_belief_store')],
    };

    const toolRuntime: Partial<TalkerToolRuntime> = {
      read_belief_store: vi.fn().mockResolvedValue(makeBeliefStore()),
    };

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
      toolRuntime,
      maxToolSteps: 2,
    });

    const secondCallMessages = provider.lastParams?.messages as ChatMessage[] | undefined;
    const toolMessages = secondCallMessages?.filter((m) => m.role === 'tool') ?? [];
    expect(toolMessages.length).toBeGreaterThan(0);
    expect(toolMessages[0].name).toBe('read_belief_store');
  });
});
