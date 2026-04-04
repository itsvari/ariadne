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
    model = process.env.OPENROUTER_MODEL ?? 'qwen/qwen3.6-plus:free',
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

  onTelemetry?.({
    type: 'thinker.context',
    sessionId,
    fullHistoryCount: fullHistory.length,
    hasWorldState: Boolean(worldState),
    beliefParticipants: currentBeliefStore.participants.length,
    pendingDirectiveCount: currentBeliefStore.directive_queue.length,
  });

  let lastBeliefStore = currentBeliefStore;
  const directives: Directive[] = [];
  let completion: ChatCompletionResult = { content: null };

  for (let step = 0; step < maxToolSteps; step += 1) {
    onTelemetry?.({
      type: 'model.request',
      sessionId,
      component: 'thinker',
      step,
      model,
      messageCount: messages.length,
      tools: THINKER_TOOLS.map((tool) => tool.function.name),
      lastUserMessage: getLastUserMessageSnippet(messages),
    });

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

    onTelemetry?.({
      type: 'model.response',
      sessionId,
      component: 'thinker',
      step,
      model,
      hasToolCalls: Boolean(completion.tool_calls?.length),
      toolCalls: completion.tool_calls?.map((toolCall) => toolCall.function.name) ?? [],
      contentLength: completion.content?.length ?? 0,
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
      const decodedStore = decodeBeliefStoreArgument(args.store, lastBeliefStore);
      const result = await runtime.write_belief_store({
        store: decodedStore,
      });
      return makeToolMessage(toolCall, result);
    }
    case 'enqueue_directive': {
      if (!runtime.enqueue_directive) return null;
      const directive = decodeDirectiveArgument(args.directive);
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

function decodeBeliefStoreArgument(rawStore: unknown, fallback: BeliefStore): BeliefStore {
  const rawValue = parseMaybeJson(rawStore);
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    return fallback;
  }

  const nowIso = new Date().toISOString();
  const source = rawValue as Record<string, unknown>;

  const normalizedParticipants = Array.isArray(source.participants)
    ? source.participants
        .map((entry, index) => normalizeParticipant(entry, index))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : fallback.participants;

  const normalizedDirectives = Array.isArray(source.directive_queue)
    ? source.directive_queue
        .map((entry, index) => normalizeDirective(entry, index, nowIso))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : fallback.directive_queue;

  const discussionState = normalizeDiscussionState(source.discussion_state, fallback);

  const normalizedCandidate: Record<string, unknown> = {
    ...fallback,
    ...source,
    participants: normalizedParticipants,
    discussion_state: discussionState,
    facilitation_plan: Array.isArray(source.facilitation_plan)
      ? source.facilitation_plan.map((entry) => String(entry))
      : fallback.facilitation_plan,
    directive_queue: normalizedDirectives,
    conversation_summary:
      typeof source.conversation_summary === 'string'
        ? source.conversation_summary
        : fallback.conversation_summary,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : nowIso,
  };

  const parsed = BeliefStoreSchema.safeParse(normalizedCandidate);
  if (parsed.success) {
    return parsed.data;
  }

  console.warn('[thinker] write_belief_store received invalid payload; using last valid belief store.', {
    issues: parsed.error.issues,
  });
  return fallback;
}

function decodeDirectiveArgument(rawDirective: unknown): Directive {
  const nowIso = new Date().toISOString();
  const defaultDirective: Directive = {
    id: crypto.randomUUID(),
    instruction: 'Follow up with the group.',
    priority: 'medium',
    createdAt: nowIso,
  };

  const parsedRawDirective = parseMaybeJson(rawDirective);

  if (typeof parsedRawDirective === 'string') {
    const instruction = parsedRawDirective.trim();
    if (!instruction) {
      return defaultDirective;
    }
    return {
      ...defaultDirective,
      instruction,
    };
  }

  if (!parsedRawDirective || typeof parsedRawDirective !== 'object' || Array.isArray(parsedRawDirective)) {
    return defaultDirective;
  }

  const candidate = parsedRawDirective as Record<string, unknown>;
  const normalizedCandidate: Record<string, unknown> = {
    id: typeof candidate.id === 'string' ? candidate.id : defaultDirective.id,
    instruction:
      typeof candidate.instruction === 'string' && candidate.instruction.trim().length > 0
        ? candidate.instruction
        : defaultDirective.instruction,
    priority:
      candidate.priority === 'low' || candidate.priority === 'medium' || candidate.priority === 'high'
        ? candidate.priority
        : defaultDirective.priority,
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : defaultDirective.createdAt,
  };

  const parsed = DirectiveSchema.safeParse(normalizedCandidate);
  if (parsed.success) {
    return parsed.data;
  }

  console.warn('[thinker] enqueue_directive received invalid payload; using default directive.', {
    issues: parsed.error.issues,
  });
  return defaultDirective;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeParticipant(entry: unknown, index: number): Record<string, unknown> | null {
  const parsedEntry = parseMaybeJson(entry);

  if (typeof parsedEntry === 'string') {
    const speakerId = parsedEntry.trim();
    if (!speakerId) {
      return null;
    }
    return {
      id: speakerId,
      stance: 'unknown',
      emotionalTone: 'neutral',
      engagementLevel: 0.5,
      speakingFrequency: 0,
    };
  }

  if (!parsedEntry || typeof parsedEntry !== 'object' || Array.isArray(parsedEntry)) {
    return null;
  }

  const candidate = parsedEntry as Record<string, unknown>;
  const rawId = candidate.id;
  const participantId = typeof rawId === 'string'
    ? rawId
    : typeof rawId === 'number'
      ? String(rawId)
      : `participant_${index + 1}`;

  return {
    ...candidate,
    id: participantId,
  };
}

function normalizeDirective(entry: unknown, index: number, nowIso: string): Record<string, unknown> | null {
  const parsedEntry = parseMaybeJson(entry);

  if (typeof parsedEntry === 'string') {
    const instruction = parsedEntry.trim();
    if (!instruction) {
      return null;
    }
    return {
      id: `directive_${index + 1}_${Date.now()}`,
      instruction,
      priority: 'medium',
      createdAt: nowIso,
    };
  }

  if (!parsedEntry || typeof parsedEntry !== 'object' || Array.isArray(parsedEntry)) {
    return null;
  }

  const candidate = parsedEntry as Record<string, unknown>;
  return {
    ...candidate,
    id: typeof candidate.id === 'string' ? candidate.id : `directive_${index + 1}_${Date.now()}`,
    instruction: typeof candidate.instruction === 'string' ? candidate.instruction : 'Follow up with the group.',
    priority:
      candidate.priority === 'low' || candidate.priority === 'medium' || candidate.priority === 'high'
        ? candidate.priority
        : 'medium',
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : nowIso,
  };
}

function normalizeDiscussionState(
  value: unknown,
  fallback: BeliefStore,
): Record<string, unknown> {
  const parsedValue = parseMaybeJson(value);

  if (typeof parsedValue === 'string') {
    return {
      currentTopic: parsedValue,
      phase: fallback.discussion_state.phase,
      openQuestions: fallback.discussion_state.openQuestions,
    };
  }

  if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
    return fallback.discussion_state;
  }

  const candidate = parsedValue as Record<string, unknown>;
  return {
    currentTopic:
      typeof candidate.currentTopic === 'string'
        ? candidate.currentTopic
        : fallback.discussion_state.currentTopic,
    phase: typeof candidate.phase === 'string' ? candidate.phase : fallback.discussion_state.phase,
    openQuestions: Array.isArray(candidate.openQuestions)
      ? candidate.openQuestions.map((entry) => String(entry))
      : fallback.discussion_state.openQuestions,
  };
}

function getLastUserMessageSnippet(messages: ChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user' || typeof message.content !== 'string') {
      continue;
    }

    const trimmed = message.content.trim();
    return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...<truncated>` : trimmed;
  }

  return null;
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
  const runCallbackSafely = (): void => {
    Promise.resolve(callback()).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[thinker.scheduler] callback failed: ${message}`);
    });
  };

  let currentInterval = intervalMs;
  let timer = setInterval(runCallbackSafely, currentInterval);

  return {
    stop() {
      clearInterval(timer);
    },
    reschedule(nextIntervalMs: number) {
      currentInterval = nextIntervalMs;
      clearInterval(timer);
      timer = setInterval(runCallbackSafely, currentInterval);
    },
  };
}

export { THINKER_TOOLS };
