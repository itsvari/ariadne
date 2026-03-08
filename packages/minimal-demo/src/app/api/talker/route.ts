import { NextResponse } from 'next/server';
import Cerebras from '@cerebras/cerebras_cloud_sdk';

const missingApiKeyMessage = 'CEREBRAS_API_KEY is not configured for the talker route.';
const paymentRequiredMessage = 'Cerebras rejected the request because this API key does not currently have inference quota or billing enabled for chat completions. Visit the Cerebras billing or quota page to verify account access.';

interface TalkerCompletionMessage {
  content?: string | null;
  tool_calls?: unknown;
}

interface TalkerCompletionResponse {
  choices?: Array<{
    message?: TalkerCompletionMessage;
  }>;
}

const cerebras = new Cerebras({
  apiKey: process.env['CEREBRAS_API_KEY'] || 'build-time-dummy-key',
});

export async function POST(request: Request) {
  try {
    if (!process.env.CEREBRAS_API_KEY) {
      return NextResponse.json({ error: missingApiKeyMessage }, { status: 500 });
    }

    const { messages } = await request.json();

    const response = await cerebras.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are Ariadne, a concise discussion facilitator in a VR world. You must NEVER output markdown formatting. Use the "speak" tool to emit speech to the TTS engine and the "avatar_command" tool to control your VR avatar. When responding to user questions or facilitating discussion, you generally always use your "speak" tool. Note: User messages may be prefixed with [Speaker ID]: if multiple people are speaking. Use this to distinguish between different users.\n\nYou have access to the entire conversation history. Use this context to determine if a thought is complete. If the latest user message is obviously an incomplete sentence, cut off mid-word, or if the user is trailing off, use the "avatar_command" with "idle" to wait for them to finish. If the message forms a complete thought or naturally invites a response, engage using the "speak" tool. Do not be overly eager to jump in on incomplete fragments, but do not leave dead air if a response is warranted.'
        },
        ...messages,
      ],
      model: 'gpt-oss-120b',
      max_completion_tokens: 32768,
      temperature: 1,
      top_p: 1,
      reasoning_effort: 'low',
      tools: [
        {
          type: 'function',
          function: {
            name: 'speak',
            description: 'Emit speech using the TTS engine. Always use this to speak.',
            parameters: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'The text to speak out loud.' },
              },
              required: ['text'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'avatar_command',
            description: 'Send a command to the Virtual Reality Avatar Controller. Use "idle" if you want to wait without speaking.',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string', enum: ['gaze', 'gesture', 'expression', 'move_to', 'idle'] },
                target: { type: 'string' },
                parameters: { type: 'string' },
              },
              required: ['command'],
            },
          },
        },
      ],
      tool_choice: 'auto',
    });

    const talkerResponse = response as TalkerCompletionResponse;
    const assistantMessage = talkerResponse.choices?.[0]?.message;

    if (!assistantMessage) {
      return NextResponse.json({ error: 'Cerebras returned no assistant message.' }, { status: 502 });
    }

    return NextResponse.json(assistantMessage);
  } catch (error: unknown) {
    console.error(error);

    const upstreamStatus = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
      ? error.status
      : 500;
    const upstreamCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
    const upstreamType = typeof error === 'object' && error !== null && 'type' in error && typeof error.type === 'string'
      ? error.type
      : undefined;

    const errorMessage = upstreamStatus === 402
      ? paymentRequiredMessage
      : error instanceof Error
        ? error.message
        : 'Internal Server Error';

    return NextResponse.json(
      {
        error: errorMessage,
        provider: 'cerebras',
        upstreamStatus,
        upstreamCode,
        upstreamType,
      },
      { status: upstreamStatus }
    );
  }
}
