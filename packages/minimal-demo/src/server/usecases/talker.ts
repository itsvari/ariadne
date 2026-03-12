import type {
  ChatProvider,
  ChatCompletionResult,
  InterventionMode,
  TalkerRequest,
  ChatMessage,
} from '../contracts/ai';
import { telemetry } from '../telemetry/emitter';

// ---------------------------------------------------------------------------
// Tool definitions available to the Talker
// ---------------------------------------------------------------------------

const SPEAK_TOOL = {
  type: 'function' as const,
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
};

const AVATAR_COMMAND_TOOL = {
  type: 'function' as const,
  function: {
    name: 'avatar_command',
    description:
      'Send a command to the VR Avatar Controller. Use "idle" to wait/listen.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['gaze', 'gesture', 'expression', 'move_to', 'idle'],
        },
        target: { type: 'string' },
        parameters: { type: 'string' },
      },
      required: ['command'],
    },
  },
};

// ---------------------------------------------------------------------------
// System prompts per intervention mode
// ---------------------------------------------------------------------------

const SYSTEM_PROMPTS: Record<InterventionMode, string> = {
  control: `You are Ariadne, a concise discussion facilitator in a VR world.
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
4. WHEN TO SPEAK: ONLY use the "speak" tool if a user asks you a direct question, explicitly asks for your input, or if there is a definitive, clear halt in the entire conversation where your facilitation is absolutely required.`,

  light: `You are Ariadne, a concise discussion facilitator in a VR world.
NEVER output markdown formatting.
User messages may be prefixed with [Speaker ID]: if multiple people are speaking. Use this to distinguish users.

TOOL USAGE RULES:
- "speak": Use this to emit speech and respond to users.
- "avatar_command": Use this to control your VR avatar. Specifically, send the "idle" command to WAIT, LISTEN, and stay out of the way without speaking.

BEHAVIOUR - LIGHT FACILITATION:
Default to waiting (idle). You may intervene in two cases:
1. A user directly asks you a question or for your input.
2. You notice a significant participation imbalance — one speaker is dominating while others have not spoken for a long time. In that case you may gently invite quieter participants to share their thoughts.

In ALL other situations, call "avatar_command" with {"command": "idle"} and let the humans converse.`,

  heavy: `You are Ariadne, an active discussion facilitator in a VR world.
NEVER output markdown formatting.
User messages may be prefixed with [Speaker ID]: if multiple people are speaking. Use this to distinguish users.

TOOL USAGE RULES:
- "speak": Use this to emit speech and respond to users.
- "avatar_command": Use this to control your VR avatar. Use the "idle" command only when you have nothing to add right now.

BEHAVIOUR - HEAVY FACILITATION:
Actively guide the group toward productive collaboration:
- Recap key points and summarise progress regularly.
- Redirect off-topic threads back to the task.
- Encourage balanced participation — call on quieter members by name/speaker-id.
- Suggest next steps when the group stalls.
- You still respect turn-taking: do not interrupt mid-sentence, but step in whenever there is a brief pause and facilitation would help.`,
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export interface RunTalkerTurnOpts {
  provider: ChatProvider;
  request: TalkerRequest;
  model?: string;
}

export async function runTalkerTurn(
  opts: RunTalkerTurnOpts,
): Promise<ChatCompletionResult> {
  const { provider, request, model = 'gpt-oss-120b' } = opts;
  const mode: InterventionMode =
    request.sessionConfig?.interventionMode ?? 'control';

  const systemMessage: ChatMessage = {
    role: 'system',
    content: SYSTEM_PROMPTS[mode],
  };

  const contextMessages: ChatMessage[] = [systemMessage, ...request.messages];

  const startMs = Date.now();

  const result = await provider.complete({
    messages: contextMessages,
    model,
    tools: [SPEAK_TOOL, AVATAR_COMMAND_TOOL],
    toolChoice: 'auto',
    maxTokens: 32768,
    temperature: 1,
    topP: 1,
    reasoningEffort: 'low',
  });

  const latencyMs = Date.now() - startMs;

  telemetry.emit({
    type: 'system.latency',
    sessionId: request.sessionId,
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    payload: { component: 'talker', latencyMs, model, interventionMode: mode },
  });

  if (result.tool_calls) {
    emitInterventionTelemetry(request.sessionId, mode, result.tool_calls);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Telemetry helpers
// ---------------------------------------------------------------------------

function emitInterventionTelemetry(
  sessionId: string,
  mode: InterventionMode,
  toolCalls: unknown,
): void {
  if (!Array.isArray(toolCalls)) return;
  for (const tc of toolCalls) {
    const fn = (tc as { function?: { name?: string; arguments?: string } }).function;
    if (fn?.name === 'speak') {
      telemetry.emit({
        type: 'facilitator.intervention',
        sessionId,
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        payload: {
          interventionMode: mode,
          action: 'speak',
          text: tryParseArg(fn.arguments, 'text'),
        },
      });
    }
  }
}

function tryParseArg(raw: string | undefined, key: string): unknown {
  try {
    return JSON.parse(raw ?? '{}')[key];
  } catch {
    return undefined;
  }
}
