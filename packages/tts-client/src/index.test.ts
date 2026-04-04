import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DeepgramTTSProvider, synthesizeSpeech } from './index';
import type { TTSProvider } from '@ariadne/shared-contracts';

const MockWebSocketClass = vi.fn().mockImplementation(function (this: Record<string, ReturnType<typeof vi.fn>>) {
  this.on = vi.fn();
  this.send = vi.fn();
  this.close = vi.fn();
  return this;
});

vi.mock('ws', () => ({
  default: vi.fn().mockImplementation(function (this: Record<string, ReturnType<typeof vi.fn>>) {
    this.on = vi.fn();
    this.send = vi.fn();
    this.close = vi.fn();
    return this;
  }),
}));

async function getMockSocket() {
  const wsModule = await import('ws');
  const Ws = wsModule.default as unknown as ReturnType<typeof vi.fn>;
  return Ws.mock.results[Ws.mock.results.length - 1]?.value as Record<string, ReturnType<typeof vi.fn>>;
}

async function getWsCallArgs(index = 0) {
  const wsModule = await import('ws');
  const Ws = wsModule.default as unknown as ReturnType<typeof vi.fn>;
  return Ws.mock.calls[index];
}

describe('DeepgramTTSProvider', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    vi.clearAllMocks();
    MockWebSocketClass.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws when no API key is provided and env var is not set', async () => {
    delete process.env.DEEPGRAM_API_KEY;
    const { DeepgramTTSProvider: Provider } = await import('./index');
    expect(() => new Provider()).toThrow('DEEPGRAM_API_KEY is not configured');
  });

  it('uses the provided API key over env var', async () => {
    process.env.DEEPGRAM_API_KEY = 'env-key';
    const { DeepgramTTSProvider: Provider } = await import('./index');
    expect(() => new Provider('provided-key')).not.toThrow();
  });

  it('falls back to env var when no API key is provided', async () => {
    process.env.DEEPGRAM_API_KEY = 'env-key';
    const { DeepgramTTSProvider: Provider } = await import('./index');
    expect(() => new Provider()).not.toThrow();
  });

  it('creates a ReadableStream on synthesize', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('test-key');

    const stream = await provider.synthesize('Hello world');

    expect(stream).toBeInstanceOf(ReadableStream);
  });

  it('sends Speak and Flush messages when socket opens', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('test-key');

    provider.synthesize('Hello world');

    const socket = await getMockSocket();
    const openHandler = socket.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'open',
    )?.[1];

    expect(openHandler).toBeDefined();
    openHandler();

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'Speak', text: 'Hello world' }),
    );
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'Flush' }),
    );
  });

  it('handles binary message data', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('test-key');

    const stream = await provider.synthesize('Hello');
    const reader = stream.getReader();

    const socket = await getMockSocket();
    const messageHandler = socket.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'message',
    )?.[1];

    expect(messageHandler).toBeDefined();

    const binaryData = Buffer.from([0x00, 0x01, 0x02]);
    messageHandler(binaryData, true);

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(value).toBeInstanceOf(Uint8Array);
    expect(value).toEqual(new Uint8Array([0x00, 0x01, 0x02]));

    reader.releaseLock();
  });

  it('handles ArrayBuffer binary data', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('test-key');

    const stream = await provider.synthesize('Hello');
    const reader = stream.getReader();

    const socket = await getMockSocket();
    const messageHandler = socket.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'message',
    )?.[1];

    const arrayBuffer = new ArrayBuffer(3);
    new Uint8Array(arrayBuffer).set([0x03, 0x04, 0x05]);
    messageHandler(arrayBuffer, true);

    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(value).toBeInstanceOf(Uint8Array);

    reader.releaseLock();
  });

  it('handles Close text message by closing stream', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('test-key');

    const stream = await provider.synthesize('Hello');
    const reader = stream.getReader();

    const socket = await getMockSocket();
    const messageHandler = socket.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'message',
    )?.[1];

    messageHandler(JSON.stringify({ type: 'Close' }), false);

    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it('handles Flushed text message by sending Close', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('test-key');

    provider.synthesize('Hello');

    const socket = await getMockSocket();
    const messageHandler = socket.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'message',
    )?.[1];

    messageHandler(JSON.stringify({ type: 'Flushed' }), false);

    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'Close' }),
    );
  });

  it('handles Error text message', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('test-key');

    const stream = await provider.synthesize('Hello');
    const reader = stream.getReader();

    const socket = await getMockSocket();
    const messageHandler = socket.on.mock.calls.find(
      (call: unknown[]) => call[0] === 'message',
    )?.[1];

    messageHandler(JSON.stringify({ type: 'Error', err_msg: 'Something went wrong' }), false);

    await expect(reader.read()).rejects.toThrow('Something went wrong');
  });

  it('uses default model when voiceId not provided', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('test-key');

    provider.synthesize('Hello');

    const wsCallArgs = await getWsCallArgs();
    expect(wsCallArgs[0]).toContain('model=aura-2-thalia-en');
  });

  it('uses custom model when voiceId is provided', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('test-key');

    provider.synthesize('Hello', { voiceId: 'aura-2-angus-en' });

    const wsCallArgs = await getWsCallArgs();
    expect(wsCallArgs[0]).toContain('model=aura-2-angus-en');
  });

  it('uses default linear16 encoding when format not provided', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('test-key');

    provider.synthesize('Hello');

    const wsCallArgs = await getWsCallArgs();
    expect(wsCallArgs[0]).toContain('encoding=linear16');
  });

  it('uses mulaw encoding when format is mulaw', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('test-key');

    provider.synthesize('Hello', { format: 'mulaw' });

    const wsCallArgs = await getWsCallArgs();
    expect(wsCallArgs[0]).toContain('encoding=mulaw');
  });

  it('uses alaw encoding when format is alaw', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('test-key');

    provider.synthesize('Hello', { format: 'alaw' });

    const wsCallArgs = await getWsCallArgs();
    expect(wsCallArgs[0]).toContain('encoding=alaw');
  });

  it('uses default sample rate of 24000', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('test-key');

    provider.synthesize('Hello');

    const wsCallArgs = await getWsCallArgs();
    expect(wsCallArgs[0]).toContain('sample_rate=24000');
  });

  it('uses custom sample rate when provided', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('test-key');

    provider.synthesize('Hello', { sampleRate: 16000 });

    const wsCallArgs = await getWsCallArgs();
    expect(wsCallArgs[0]).toContain('sample_rate=16000');
  });

  it('includes Authorization header in websocket request', async () => {
    const { DeepgramTTSProvider: Provider } = await import('./index');
    const provider = new Provider('my-secret-key');

    provider.synthesize('Hello');

    const wsCallArgs = await getWsCallArgs();
    expect(wsCallArgs[1].headers.Authorization).toBe('Token my-secret-key');
  });
});

describe('synthesizeSpeech', () => {
  it('calls provider.synthesize with text and options from request', async () => {
    const mockProvider: TTSProvider = {
      synthesize: vi.fn().mockResolvedValue(new ReadableStream()),
    };

    await synthesizeSpeech(mockProvider, {
      text: 'Hello world',
      voiceId: 'voice-1',
      format: 'mp3',
    });

    expect(mockProvider.synthesize).toHaveBeenCalledWith('Hello world', {
      voiceId: 'voice-1',
      format: 'mp3',
    });
  });

  it('passes optional fields as undefined when not provided', async () => {
    const mockProvider: TTSProvider = {
      synthesize: vi.fn().mockResolvedValue(new ReadableStream()),
    };

    await synthesizeSpeech(mockProvider, {
      text: 'Hello',
    });

    expect(mockProvider.synthesize).toHaveBeenCalledWith('Hello', {
      voiceId: undefined,
      format: undefined,
    });
  });
});
