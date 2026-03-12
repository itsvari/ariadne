import { NextRequest } from 'next/server';
import { TTSRequest } from '@/server/contracts/ai';
import { InworldTTSProvider } from '@/server/providers/tts/inworld';
import { synthesizeSpeech } from '@/server/usecases/tts';

let provider: InworldTTSProvider | null = null;

function getProvider(): InworldTTSProvider {
  if (!provider) {
    provider = new InworldTTSProvider();
  }
  return provider;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = TTSRequest.safeParse(body);
    const ttsReq = parsed.success ? parsed.data : { text: body.text ?? '' };

    const stream = await synthesizeSpeech({
      provider: getProvider(),
      request: ttsReq,
      sessionId: body.sessionId,
    });

    return new Response(stream, {
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  } catch (error) {
    console.error(error);
    return new Response(
      JSON.stringify({ error: 'Failed to initialize TTS stream' }),
      { status: 500 },
    );
  }
}
