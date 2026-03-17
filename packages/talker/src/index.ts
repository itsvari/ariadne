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
Stay out of the way unless the group directly asks for your help.
Use tools instead of narrating actions.
Prefer idle avatar behavior over speaking unless intervention is clearly helpful.`,
  light: `You are Ariadne, a light-touch facilitator in a VR world.
Speak only when asked directly or when participation is clearly imbalanced.
Use tools instead of narrating actions.
When unsure, remain patient and listen.`,
  heavy: `You are Ariadne, an active facilitator in a VR world.
You guide the discussion toward progress, summarize key points, and invite quieter participants in.
Use tools instead of narrating actions.
Be concise, timely, and socially aware.`,
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
