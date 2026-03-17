import { describe, expect, it } from 'vitest';
import type { ChatCompletionParams, ChatCompletionResult, ChatProvider } from '@ariadne/shared-contracts';
import { runThinkerTurn } from './index';

class MockChatProvider implements ChatProvider {
  lastParams: ChatCompletionParams | null = null;
  result: ChatCompletionResult = { content: null, tool_calls: [] };

  async complete(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    this.lastParams = params;
    return this.result;
  }
}

describe('runThinkerTurn', () => {
  it('adds strategic system context', async () => {
    const provider = new MockChatProvider();

    await runThinkerTurn({
      provider,
      sessionId: 'session-1',
      fullHistory: [],
      worldState: null,
      currentBeliefStore: {
        version: 'v1',
        participants: [],
        discussion_state: {
          currentTopic: 'unknown',
          phase: 'discussion',
          openQuestions: [],
        },
        facilitation_plan: [],
        directive_queue: [],
        conversation_summary: '',
        updatedAt: new Date().toISOString(),
      },
    });

    expect(provider.lastParams?.messages[0]?.content).toContain('strategic thinker');
    expect(provider.lastParams?.tools?.map((tool) => tool.function.name)).toContain('write_belief_store');
  });
});
