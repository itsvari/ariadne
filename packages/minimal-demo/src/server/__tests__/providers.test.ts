import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatProvider, ChatCompletionParams } from '../contracts/ai';

/**
 * Mock chat provider that returns deterministic results.
 * Used to test use-case orchestration without real API calls.
 */
class MockChatProvider implements ChatProvider {
  public lastParams: ChatCompletionParams | null = null;
  public mockResult = {
    content: null as string | null,
    tool_calls: [] as unknown[],
  };

  async complete(params: ChatCompletionParams) {
    this.lastParams = params;
    return { ...this.mockResult };
  }
}

describe('MockChatProvider', () => {
  let provider: MockChatProvider;

  beforeEach(() => {
    provider = new MockChatProvider();
  });

  it('returns configured mock result', async () => {
    provider.mockResult = {
      content: 'test response',
      tool_calls: [],
    };

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hello' }],
      model: 'test-model',
    });

    expect(result.content).toBe('test response');
    expect(provider.lastParams?.model).toBe('test-model');
  });

  it('captures all completion params', async () => {
    await provider.complete({
      messages: [{ role: 'system', content: 'sys' }],
      model: 'm1',
      tools: [{ type: 'function' }],
      toolChoice: 'auto',
      maxTokens: 1024,
      temperature: 0.5,
    });

    expect(provider.lastParams?.toolChoice).toBe('auto');
    expect(provider.lastParams?.maxTokens).toBe(1024);
    expect(provider.lastParams?.temperature).toBe(0.5);
  });
});

describe('CerebrasChatProvider constructor', () => {
  it('throws if no API key is available', async () => {
    const originalKey = process.env.CEREBRAS_API_KEY;
    delete process.env.CEREBRAS_API_KEY;

    const { CerebrasChatProvider } = await import('../providers/chat/cerebras');

    expect(() => new CerebrasChatProvider()).toThrow(
      'CEREBRAS_API_KEY is not configured',
    );

    if (originalKey) process.env.CEREBRAS_API_KEY = originalKey;
  });
});

export { MockChatProvider };
