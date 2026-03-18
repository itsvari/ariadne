import {
  TALKER_TOOLS,
  parseToolArguments,
  type BeliefStore,
  type ChatCompletionResult,
  type ChatMessage,
  type ChatProvider,
  type Directive,
  type InterventionMode,
  type SessionConfig,
  type TalkerRequest,
  type ToolCall,
  type WorldState,
} from '@ariadne/shared-contracts';

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

export interface TalkerToolRuntime {
  speak(args: { text?: string }): Promise<unknown>;
  avatar_command(args: Record<string, unknown>): Promise<unknown>;
  trigger_reasoner(args: { reason?: string }): Promise<unknown>;
  wait_for_reasoner(args: { reason?: string }): Promise<unknown>;
  read_belief_store(): Promise<BeliefStore>;
  dequeue_directive(): Promise<Directive | null>;
}

export interface RunTalkerTurnOptions {
  provider: ChatProvider;
  request: TalkerRequest;
  model?: string;
  toolRuntime?: Partial<TalkerToolRuntime>;
  maxToolSteps?: number;
  onTelemetry?: (event: Record<string, unknown>) => void;
}

export async function runTalkerTurn(
  options: RunTalkerTurnOptions,
): Promise<ChatCompletionResult> {
  const {
    provider,
    request,
    model = process.env.OPENROUTER_MODEL ?? 'openrouter/hunter-alpha',
    toolRuntime,
    maxToolSteps = 4,
    onTelemetry,
  } = options;

  const mode = request.sessionConfig?.interventionMode ?? 'control';
  const messages = buildTalkerMessages(request, request.sessionConfig, mode);

  let currentMessages = [...messages];
  let lastResult: ChatCompletionResult = { content: null };

  for (let step = 0; step < maxToolSteps; step += 1) {
    const startedAt = Date.now();
    const result = await provider.complete({
      messages: currentMessages,
      model,
      tools: TALKER_TOOLS,
      toolChoice: 'auto',
      maxTokens: 32768,
      temperature: 0.7,
      topP: 1,
      reasoningEffort: 'low',
    });

    onTelemetry?.({
      type: 'system.latency',
      sessionId: request.sessionId,
      component: 'talker',
      latencyMs: Date.now() - startedAt,
      model,
      interventionMode: mode,
    });

    lastResult = result;

    if (!result.tool_calls?.length || !toolRuntime) {
      return result;
    }

    currentMessages.push({
      role: 'assistant',
      content: result.content ?? null,
      tool_calls: result.tool_calls,
    });

    let executedAnyTool = false;

    for (const toolCall of result.tool_calls) {
      const toolMessage = await executeTalkerToolCall(toolCall, toolRuntime);
      if (!toolMessage) {
        continue;
      }

      executedAnyTool = true;
      currentMessages.push(toolMessage);

      if (toolCall.function.name === 'speak') {
        onTelemetry?.({
          type: 'facilitator.intervention',
          sessionId: request.sessionId,
          action: 'speak',
          text: parseToolArguments<{ text?: string }>(toolCall.function.arguments).text,
          interventionMode: mode,
        });
      }
    }

    if (!executedAnyTool) {
      return result;
    }
  }

  return lastResult;
}

function buildTalkerMessages(
  request: TalkerRequest,
  sessionConfig: SessionConfig | undefined,
  mode: InterventionMode,
): ChatMessage[] {
  const context: ChatMessage[] = [
    {
      role: 'system',
      content: SYSTEM_PROMPTS[mode],
    },
  ];

  if (request.beliefSnapshot) {
    context.push({
      role: 'system',
      content: `Belief store snapshot: ${JSON.stringify(request.beliefSnapshot)}`,
    });
  }

  if (request.directives?.length) {
    context.push({
      role: 'system',
      content: `Pending directives: ${JSON.stringify(request.directives)}`,
    });
  }

  if (request.worldState) {
    context.push({
      role: 'system',
      content: `World state: ${JSON.stringify(request.worldState)}`,
    });
  }

  if (sessionConfig) {
    context.push({
      role: 'system',
      content: `Session config: ${JSON.stringify(sessionConfig)}`,
    });
  }

  context.push(...request.messages);
  return context;
}

async function executeTalkerToolCall(
  toolCall: ToolCall,
  runtime: Partial<TalkerToolRuntime>,
): Promise<ChatMessage | null> {
  const args = parseToolArguments<Record<string, unknown>>(toolCall.function.arguments);

  switch (toolCall.function.name) {
    case 'speak': {
      if (!runtime.speak) return null;
      const result = await runtime.speak(args as { text?: string });
      return makeToolMessage(toolCall, result ?? { ok: true });
    }
    case 'avatar_command': {
      if (!runtime.avatar_command) return null;
      const result = await runtime.avatar_command(args);
      return makeToolMessage(toolCall, result ?? { ok: true });
    }
    case 'trigger_reasoner': {
      if (!runtime.trigger_reasoner) return null;
      const result = await runtime.trigger_reasoner(args as { reason?: string });
      return makeToolMessage(toolCall, result ?? { ok: true });
    }
    case 'wait_for_reasoner': {
      if (!runtime.wait_for_reasoner) return null;
      const result = await runtime.wait_for_reasoner(args as { reason?: string });
      return makeToolMessage(toolCall, result ?? { ok: true });
    }
    case 'read_belief_store': {
      if (!runtime.read_belief_store) return null;
      const result = await runtime.read_belief_store();
      return makeToolMessage(toolCall, result);
    }
    case 'dequeue_directive': {
      if (!runtime.dequeue_directive) return null;
      const result = await runtime.dequeue_directive();
      return makeToolMessage(toolCall, result ?? { directive: null });
    }
    default:
      return null;
  }
}

function makeToolMessage(toolCall: ToolCall, result: unknown): ChatMessage {
  return {
    role: 'tool',
    name: toolCall.function.name,
    tool_call_id: toolCall.id ?? toolCall.function.name,
    content: JSON.stringify(result),
  };
}

export { TALKER_TOOLS };
export type { BeliefStore, Directive, WorldState };
