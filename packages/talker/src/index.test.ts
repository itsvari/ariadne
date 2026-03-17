import { describe, expect, it } from 'vitest';
import type { ChatCompletionParams, ChatCompletionResult, ChatProvider } from '@ariadne/shared-contracts';
import { runTalkerTurn } from './index';

class MockChatProvider implements ChatProvider {
  lastParams: ChatCompletionParams | null = null;
  result: ChatCompletionResult = { content: null, tool_calls: [] };

  async complete(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    this.lastParams = params;
    return this.result;
  }
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

    expect(provider.lastParams?.messages[0]?.content).toContain('Stay out of the way');
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
});
