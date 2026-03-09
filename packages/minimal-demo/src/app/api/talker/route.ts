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
          content: `You are Ariadne, a concise discussion facilitator in a VR world.
NEVER output markdown formatting.
User messages may be prefixed with [Speaker ID]: if multiple people are speaking. Use this to distinguish users.

TOOL USAGE RULES:
- "speak": Use this to emit speech and respond to users.
- "avatar_command": Use this to control your VR avatar. Specifically, send the "idle" command to WAIT, LISTEN, and stay out of the way without speaking.

WHEN TO RESPOND VS WHEN TO WAIT (IDLE) - EXTREMELY IMPORTANT:
You must be patient and NOT overly eager to respond. Default to waiting (idle) rather than speaking.

1. INCOMPLETE THOUGHTS & FRAGMENTS: If the latest message is an incomplete sentence, cuts off mid-word, trails off, or is very short (e.g., "so...", "I think...", "but"), you MUST wait. Call "avatar_command" with {"command": "idle"}. Do not attempt to finish their sentence.
2. HUMAN-TO-HUMAN CONVERSATION: If multiple users are talking to each other, stay out of the way. Use "idle" continuously so they can converse, unless they explicitly ask you a question.
3. YIELD THE FLOOR: Even after a complete thought, if there is another speaker in the room who might want to reply first, default to "idle".
4. WHEN TO SPEAK: ONLY use the "speak" tool if a user asks you a direct question, explicitly asks for your input, or if there is a definitive, clear halt in the entire conversation where your facilitation is absolutely required.`
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
            description: 'Send a command to the Virtual Reality Avatar Controller. Use the "idle" command when you need to wait, listen, or intentionally not respond.',
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
