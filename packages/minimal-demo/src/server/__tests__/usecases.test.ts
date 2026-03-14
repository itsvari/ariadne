import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatProvider, ChatCompletionParams, ChatCompletionResult } from '../contracts/ai';
import { runTalkerTurn } from '../usecases/talker';

class MockChatProvider implements ChatProvider {
  public lastParams: ChatCompletionParams | null = null;
  public mockResult: ChatCompletionResult = { content: null, tool_calls: [] };

  async complete(params: ChatCompletionParams) {
    this.lastParams = params;
    return { ...this.mockResult };
  }
}

describe('runTalkerTurn', () => {
  let provider: MockChatProvider;

  beforeEach(() => {
    provider = new MockChatProvider();
  });

  it('uses control system prompt by default', async () => {
    provider.mockResult = {
      content: null,
      tool_calls: [
        { function: { name: 'avatar_command', arguments: '{"command":"idle"}' } },
      ],
    };

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    const systemMsg = provider.lastParams?.messages[0];
    expect(systemMsg?.role).toBe('system');
    expect(systemMsg?.content).toContain('WHEN TO RESPOND VS WHEN TO WAIT');
  });

  it('uses heavy system prompt when configured', async () => {
    provider.mockResult = { content: null, tool_calls: [] };

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
        sessionConfig: { interventionMode: 'heavy' },
      },
    });

    const systemMsg = provider.lastParams?.messages[0];
    expect(systemMsg?.content).toContain('HEAVY FACILITATION');
  });

  it('uses light system prompt when configured', async () => {
    provider.mockResult = { content: null, tool_calls: [] };

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hello' }],
        sessionConfig: { interventionMode: 'light' },
      },
    });

    const systemMsg = provider.lastParams?.messages[0];
    expect(systemMsg?.content).toContain('LIGHT FACILITATION');
  });

  it('provides speak and avatar_command tools', async () => {
    provider.mockResult = { content: null, tool_calls: [] };

    await runTalkerTurn({
      provider,
      request: {
        sessionId: 'test-session',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    const toolNames = (provider.lastParams?.tools as { function: { name: string } }[])?.map(
      (t) => t.function.name,
    );
    expect(toolNames).toContain('speak');
    expect(toolNames).toContain('avatar_command');
  });
});
