import {
  THINKER_TOOLS,
  BeliefStoreSchema,
  DirectiveSchema,
  parseToolArguments,
  type BeliefStore,
  type ChatCompletionResult,
  type ChatMessage,
  type ChatProvider,
  type Directive,
  type ToolCall,
  type Utterance,
  type WorldState,
} from '@ariadne/shared-contracts';

const THINKER_SYSTEM_PROMPT = `You are Ariadne's strategic thinker.
Analyze the full conversation, maintain the shared belief store, and queue crisp directives for the talker.
Always prefer structured tool calls over freeform narration.
Update the belief store every run, even if the update is small.`;

export interface ThinkerToolRuntime {
  write_belief_store(args: { store?: BeliefStore }): Promise<BeliefStore>;
  enqueue_directive(args: { directive?: Directive }): Promise<Directive | null>;
  read_world_state(): Promise<WorldState | null>;
  compact_history(args: { summary?: string }): Promise<{ compacted: boolean; summary: string }>;
  avatar_command(args: Record<string, unknown>): Promise<unknown>;
}

export interface RunThinkerTurnOptions {
  provider: ChatProvider;
  sessionId: string;
  fullHistory: Utterance[];
  worldState: WorldState | null;
  currentBeliefStore: BeliefStore;
  model?: string;
  toolRuntime?: Partial<ThinkerToolRuntime>;
  maxToolSteps?: number;
  onTelemetry?: (event: Record<string, unknown>) => void;
}

export interface ThinkerTurnResult {
  updatedBeliefStore: BeliefStore;
  directives: Directive[];
  completion: ChatCompletionResult;
}

export interface ThinkerSchedulerControls {
  stop(): void;
  reschedule(intervalMs: number): void;
}

export async function runThinkerTurn(
  options: RunThinkerTurnOptions,
): Promise<ThinkerTurnResult> {
  const {
    provider,
    sessionId,
    fullHistory,
    worldState,
    currentBeliefStore,
    model = process.env.OPENROUTER_MODEL ?? 'openrouter/hunter-alpha',
    toolRuntime,
    maxToolSteps = 4,
    onTelemetry,
  } = options;

  const conversation = fullHistory.map<ChatMessage>((entry) => ({
    role: entry.role === 'assistant' ? 'assistant' : entry.role === 'system' ? 'system' : 'user',
    content: entry.speakerId ? `[${entry.speakerId}]: ${entry.text}` : entry.text,
  }));

  let messages: ChatMessage[] = [
    { role: 'system', content: THINKER_SYSTEM_PROMPT },
    {
      role: 'system',
      content: `Current belief store: ${JSON.stringify(currentBeliefStore)}`,
    },
    {
      role: 'system',
      content: `World state: ${JSON.stringify(worldState)}`,
    },
    ...conversation,
  ];

  let lastBeliefStore = currentBeliefStore;
  const directives: Directive[] = [];
  let completion: ChatCompletionResult = { content: null };

  for (let step = 0; step < maxToolSteps; step += 1) {
    const startedAt = Date.now();
    completion = await provider.complete({
      messages,
      model,
      tools: THINKER_TOOLS,
      toolChoice: 'auto',
      maxTokens: 32768,
      temperature: 0.4,
      topP: 1,
      reasoningEffort: 'medium',
    });

    onTelemetry?.({
      type: 'system.latency',
      sessionId,
      component: 'thinker',
      latencyMs: Date.now() - startedAt,
      model,
    });

    if (!completion.tool_calls?.length || !toolRuntime) {
      break;
    }

    messages.push({
      role: 'assistant',
      content: completion.content ?? null,
      tool_calls: completion.tool_calls,
    });

    let executed = false;

    for (const toolCall of completion.tool_calls) {
      const toolMessage = await executeThinkerToolCall(toolCall, toolRuntime, directives, lastBeliefStore);
      if (!toolMessage) {
        continue;
      }

      executed = true;
      if (toolCall.function.name === 'write_belief_store') {
        lastBeliefStore = BeliefStoreSchema.parse(JSON.parse(toolMessage.content ?? '{}'));
      }
      messages.push(toolMessage);
    }

    if (!executed) {
      break;
    }
  }

  return {
    updatedBeliefStore: lastBeliefStore,
    directives,
    completion,
  };
}

async function executeThinkerToolCall(
  toolCall: ToolCall,
  runtime: Partial<ThinkerToolRuntime>,
  directives: Directive[],
  lastBeliefStore: BeliefStore,
): Promise<ChatMessage | null> {
  const args = parseToolArguments<Record<string, unknown>>(toolCall.function.arguments);

  switch (toolCall.function.name) {
    case 'write_belief_store': {
      if (!runtime.write_belief_store) return null;
      const result = await runtime.write_belief_store({
        store: BeliefStoreSchema.parse(args.store ?? lastBeliefStore),
      });
      return makeToolMessage(toolCall, result);
    }
    case 'enqueue_directive': {
      if (!runtime.enqueue_directive) return null;
      const directive = DirectiveSchema.parse(
        args.directive ?? {
          id: crypto.randomUUID(),
          instruction: 'Follow up with the group.',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        },
      );
      const result = await runtime.enqueue_directive({ directive });
      if (result) {
        directives.push(result);
      }
      return makeToolMessage(toolCall, result ?? { queued: false });
    }
    case 'read_world_state': {
      if (!runtime.read_world_state) return null;
      const result = await runtime.read_world_state();
      return makeToolMessage(toolCall, result ?? { worldState: null });
    }
    case 'compact_history': {
      if (!runtime.compact_history) return null;
      const result = await runtime.compact_history({ summary: String(args.summary ?? '') });
      return makeToolMessage(toolCall, result);
    }
    case 'avatar_command': {
      if (!runtime.avatar_command) return null;
      const result = await runtime.avatar_command(args);
      return makeToolMessage(toolCall, result ?? { ok: true });
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

export function startThinkerScheduler(
  intervalMs: number,
  callback: () => void | Promise<void>,
): ThinkerSchedulerControls {
  let currentInterval = intervalMs;
  let timer = setInterval(() => {
    void callback();
  }, currentInterval);

  return {
    stop() {
      clearInterval(timer);
    },
    reschedule(nextIntervalMs: number) {
      currentInterval = nextIntervalMs;
      clearInterval(timer);
      timer = setInterval(() => {
        void callback();
      }, currentInterval);
    },
  };
}

export { THINKER_TOOLS };
