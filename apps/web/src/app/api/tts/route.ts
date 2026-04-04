import { NextRequest } from 'next/server';
import { TTSRequestSchema } from '@ariadne/shared-contracts';
import { DeepgramTTSProvider, synthesizeSpeech } from '@ariadne/tts-client';

let provider: DeepgramTTSProvider | null = null;

function getTtsContentType(format?: 'mp3' | 'pcm' | 'opus'): string {
  if (format === 'opus') {
    return 'audio/ogg; codecs=opus';
  }
  if (format === 'pcm') {
    return 'audio/L16;rate=24000;channels=1';
  }
  return 'audio/mpeg';
}

function getProvider(): DeepgramTTSProvider {
  if (!provider) {
    provider = new DeepgramTTSProvider();
  }
  return provider;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = TTSRequestSchema.safeParse(body);
    const ttsRequest = parsed.success ? parsed.data : { text: String(body.text ?? '') };
    const stream = await synthesizeSpeech(getProvider(), ttsRequest);

    return new Response(stream, {
      headers: {
        'Content-Type': getTtsContentType(parsed.success ? parsed.data.format : undefined),
      },
    });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: 'Failed to synthesize speech' }), {
      status: 500,
    });
  }
}
