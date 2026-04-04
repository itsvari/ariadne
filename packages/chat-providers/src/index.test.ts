import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const createMock = vi.fn();

vi.mock('@cerebras/cerebras_cloud_sdk', () => {
  const Cerebras = class {
    chat = {
      completions: {
        create: createMock,
      },
    };
  };
  return { default: Cerebras };
});

vi.mock('openai', () => {
  const OpenAI = class {
    chat = {
      completions: {
        create: createMock,
      },
    };
  };
  return { default: OpenAI };
});

describe('CerebrasChatProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    createMock.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when no API key is provided and env var is not set', async () => {
    delete process.env.CEREBRAS_API_KEY;
    const { CerebrasChatProvider } = await import('./index');
    expect(() => new CerebrasChatProvider()).toThrow('CEREBRAS_API_KEY is not configured');
  });

  it('uses the provided API key over env var', async () => {
    process.env.CEREBRAS_API_KEY = 'env-key';
    const { CerebrasChatProvider } = await import('./index');
    expect(() => new CerebrasChatProvider('provided-key')).not.toThrow();
  });

  it('falls back to env var when no API key is provided', async () => {
    process.env.CEREBRAS_API_KEY = 'env-key';
    const { CerebrasChatProvider } = await import('./index');
    expect(() => new CerebrasChatProvider()).not.toThrow();
  });

  it('sends a complete request and parses the response', async () => {
    createMock.mockResolvedValue({
      choices: [{
        message: {
          content: 'Hello from Cerebras',
          tool_calls: [],
        },
      }],
    });

    const { CerebrasChatProvider } = await import('./index');
    const provider = new CerebrasChatProvider('test-key');

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'llama-3.1-8b',
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: 'user', content: 'hi' }],
        model: 'llama-3.1-8b',
      }),
    );
    expect(result.content).toBe('Hello from Cerebras');
    expect(result.tool_calls).toEqual([]);
  });

  it('maps optional parameters correctly', async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
    });

    const { CerebrasChatProvider } = await import('./index');
    const provider = new CerebrasChatProvider('test-key');

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'llama-3.1-8b',
      tools: [{ type: 'function', function: { name: 'test', description: '', parameters: {} } }],
      toolChoice: 'auto',
      maxTokens: 100,
      temperature: 0.5,
      topP: 0.9,
      reasoningEffort: 'low',
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [{ type: 'function', function: { name: 'test', description: '', parameters: {} } }],
        tool_choice: 'auto',
        max_completion_tokens: 100,
        temperature: 0.5,
        top_p: 0.9,
        reasoning_effort: 'low',
      }),
    );
  });

  it('throws when Cerebras returns no assistant message', async () => {
    createMock.mockResolvedValue({ choices: [] });

    const { CerebrasChatProvider } = await import('./index');
    const provider = new CerebrasChatProvider('test-key');

    await expect(provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'llama-3.1-8b',
    })).rejects.toThrow('Cerebras returned no assistant message');
  });

  it('returns tool_calls when present', async () => {
    createMock.mockResolvedValue({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'speak', arguments: '{"text":"hello"}' },
          }],
        },
      }],
    });

    const { CerebrasChatProvider } = await import('./index');
    const provider = new CerebrasChatProvider('test-key');

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'llama-3.1-8b',
    });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls?.[0]?.function.name).toBe('speak');
  });
});

describe('OpenRouterChatProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    createMock.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when no API key is provided and env var is not set', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { OpenRouterChatProvider } = await import('./index');
    expect(() => new OpenRouterChatProvider()).toThrow('OPENROUTER_API_KEY is not configured');
  });

  it('uses the provided API key over env var', async () => {
    process.env.OPENROUTER_API_KEY = 'env-key';
    const { OpenRouterChatProvider } = await import('./index');
    expect(() => new OpenRouterChatProvider('provided-key')).not.toThrow();
  });

  it('falls back to env var when no API key is provided', async () => {
    process.env.OPENROUTER_API_KEY = 'env-key';
    const { OpenRouterChatProvider } = await import('./index');
    expect(() => new OpenRouterChatProvider()).not.toThrow();
  });

  it('uses default base URL when not provided', async () => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    const { OpenRouterChatProvider } = await import('./index');
    expect(() => new OpenRouterChatProvider()).not.toThrow();
  });

  it('sends a complete request and parses the response', async () => {
    createMock.mockResolvedValue({
      choices: [{
        message: {
          content: 'Hello from OpenRouter',
          tool_calls: [],
        },
      }],
    });

    const { OpenRouterChatProvider } = await import('./index');
    const provider = new OpenRouterChatProvider('test-key');

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'openai/gpt-4',
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'openai/gpt-4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(result.content).toBe('Hello from OpenRouter');
  });

  it('handles array content by joining text items', async () => {
    createMock.mockResolvedValue({
      choices: [{
        message: {
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'World' },
          ],
        },
      }],
    });

    const { OpenRouterChatProvider } = await import('./index');
    const provider = new OpenRouterChatProvider('test-key');

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'openai/gpt-4',
    });

    expect(result.content).toBe('Hello World');
  });

  it('maps optional parameters', async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: 'ok' } }],
    });

    const { OpenRouterChatProvider } = await import('./index');
    const provider = new OpenRouterChatProvider('test-key');

    await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'openai/gpt-4',
      tools: [{ type: 'function', function: { name: 'test', description: '', parameters: {} } }],
      toolChoice: 'auto',
      maxTokens: 200,
      temperature: 0.8,
      topP: 0.95,
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [{ type: 'function', function: { name: 'test', description: '', parameters: {} } }],
        tool_choice: 'auto',
        max_tokens: 200,
        temperature: 0.8,
        top_p: 0.95,
      }),
    );
  });

  it('throws when OpenRouter returns no assistant message', async () => {
    createMock.mockResolvedValue({ choices: [] });

    const { OpenRouterChatProvider } = await import('./index');
    const provider = new OpenRouterChatProvider('test-key');

    await expect(provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'openai/gpt-4',
    })).rejects.toThrow('OpenRouter returned no assistant message');
  });

  it('returns tool_calls when present', async () => {
    createMock.mockResolvedValue({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'write_belief_store', arguments: '{}' },
          }],
        },
      }],
    });

    const { OpenRouterChatProvider } = await import('./index');
    const provider = new OpenRouterChatProvider('test-key');

    const result = await provider.complete({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'openai/gpt-4',
    });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls?.[0]?.function.name).toBe('write_belief_store');
  });
});
