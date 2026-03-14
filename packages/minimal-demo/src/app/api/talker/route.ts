import { NextResponse } from 'next/server';
import { TalkerRequest } from '@/server/contracts/ai';
import { CerebrasChatProvider } from '@/server/providers/chat/cerebras';
import { runTalkerTurn } from '@/server/usecases/talker';

let provider: CerebrasChatProvider | null = null;

function getProvider(): CerebrasChatProvider {
  if (!provider) {
    provider = new CerebrasChatProvider();
  }
  return provider;
}

export async function POST(request: Request) {
  try {
    if (!process.env.CEREBRAS_API_KEY) {
      return NextResponse.json(
        { error: 'CEREBRAS_API_KEY is not configured for the talker route.' },
        { status: 500 },
      );
    }

    const body = await request.json();

    // Support both the new contract shape and the legacy {messages} shape
    const parsed = TalkerRequest.safeParse(body);
    const talkerReq = parsed.success
      ? parsed.data
      : {
          sessionId: (body.sessionId as string) ?? 'default',
          messages: body.messages ?? [],
          worldState: body.worldState,
          beliefSnapshot: body.beliefSnapshot,
          directives: body.directives,
          sessionConfig: body.sessionConfig,
        };

    const result = await runTalkerTurn({
      provider: getProvider(),
      request: talkerReq,
    });

    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error(error);

    const upstreamStatus =
      typeof error === 'object' &&
      error !== null &&
      'status' in error &&
      typeof error.status === 'number'
        ? error.status
        : 500;

    const errorMessage =
      upstreamStatus === 402
        ? 'Cerebras rejected the request — no inference quota or billing enabled.'
        : error instanceof Error
          ? error.message
          : 'Internal Server Error';

    return NextResponse.json({ error: errorMessage }, { status: upstreamStatus });
  }
}
