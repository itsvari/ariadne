import { z } from 'zod';

export const InterventionModeSchema = z.enum(['control', 'light']);
export type InterventionMode = z.infer<typeof InterventionModeSchema>;

export const SessionConfigSchema = z.object({
  interventionMode: InterventionModeSchema.default('control'),
  groupSize: z.number().int().min(1).optional(),
  taskId: z.string().optional(),
  phase: z.string().optional(),
  thinkerIntervalSec: z.number().int().min(15).max(600).default(60),
});
export type SessionConfig = z.infer<typeof SessionConfigSchema>;

export const ToolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function').default('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string().default('{}'),
  }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable().optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ParticipantSchema = z.object({
  id: z.string(),
  speakingFrequency: z.number().min(0).default(0),
  stance: z.string().default('unknown'),
  emotionalTone: z.string().default('neutral'),
  engagementLevel: z.number().min(0).max(1).default(0.5),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const DiscussionStateSchema = z.object({
  currentTopic: z.string().default('unknown'),
  phase: z.string().default('discussion'),
  openQuestions: z.array(z.string()).default([]),
});
export type DiscussionState = z.infer<typeof DiscussionStateSchema>;

export const DirectiveSchema = z.object({
  id: z.string(),
  instruction: z.string(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  createdAt: z.string(),
});
export type Directive = z.infer<typeof DirectiveSchema>;

export const WorldPlayerSchema = z.object({
  id: z.string(),
  location: z.string().optional(),
  activity: z.string().optional(),
  proximity: z.number().optional(),
});
export type WorldPlayer = z.infer<typeof WorldPlayerSchema>;

export const WorldStateSchema = z.object({
  players: z.array(WorldPlayerSchema).default([]),
  location: z.string().default('unknown'),
  activities: z.array(z.string()).default([]),
  updatedAt: z.string().optional(),
});
export type WorldState = z.infer<typeof WorldStateSchema>;

export const BeliefStoreSchema = z.object({
  version: z.literal('v1').default('v1'),
  participants: z.array(ParticipantSchema).default([]),
  discussion_state: DiscussionStateSchema.default({
    currentTopic: 'unknown',
    phase: 'discussion',
    openQuestions: [],
  }),
  facilitation_plan: z.array(z.string()).default([]),
  directive_queue: z.array(DirectiveSchema).default([]),
  conversation_summary: z.string().default(''),
  updatedAt: z.string().default(() => new Date().toISOString()),
});
export type BeliefStore = z.infer<typeof BeliefStoreSchema>;

export const UtteranceSchema = z.object({
  id: z.string().default(() => crypto.randomUUID()),
  role: z.enum(['user', 'assistant', 'system']).default('user'),
  speakerId: z.string().optional(),
  text: z.string(),
  timestamp: z.string().default(() => new Date().toISOString()),
});
export type Utterance = z.infer<typeof UtteranceSchema>;

export const TalkerRequestSchema = z.object({
  sessionId: z.string(),
  messages: z.array(ChatMessageSchema),
  beliefSnapshot: BeliefStoreSchema.optional(),
  directives: z.array(DirectiveSchema).optional(),
  worldState: WorldStateSchema.nullable().optional(),
  sessionConfig: SessionConfigSchema.optional(),
});
export type TalkerRequest = z.infer<typeof TalkerRequestSchema>;

export const TalkerResponseSchema = z.object({
  content: z.string().nullable().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
});
export type TalkerResponse = z.infer<typeof TalkerResponseSchema>;

export const TTSRequestSchema = z.object({
  text: z.string().min(1),
  voiceId: z.string().optional(),
  format: z.enum(['mp3', 'pcm', 'opus']).optional(),
});
export type TTSRequest = z.infer<typeof TTSRequestSchema>;

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const avatarCommandParameters = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      enum: ['gaze', 'gesture', 'expression', 'move_to', 'idle'],
    },
    target: { type: 'string' },
    parameters: { type: 'string' },
    priority: { type: 'string', enum: ['reactive', 'planned'] },
  },
  required: ['command'],
};

export const TALKER_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'speak',
      description: 'Emit speech using the TTS engine for immediate playback.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The exact text Ariadne should say.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'avatar_command',
      description: 'Send a reactive command to the avatar controller.',
      parameters: avatarCommandParameters,
    },
  },
  {
    type: 'function',
    function: {
      name: 'trigger_reasoner',
      description: 'Trigger the strategic thinker for deeper analysis.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for_reasoner',
      description: 'Wait until the thinker finishes and return refreshed context.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_belief_store',
      description: 'Read the latest shared belief store snapshot.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dequeue_directive',
      description: 'Pop the next directive from the queue if one exists.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
];

export const THINKER_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'write_belief_store',
      description: 'Persist the next belief store snapshot.',
      parameters: {
        type: 'object',
        properties: {
          store: { type: 'object' },
        },
        required: ['store'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enqueue_directive',
      description: 'Queue a directive for the talker to execute later.',
      parameters: {
        type: 'object',
        properties: {
          directive: { type: 'object' },
        },
        required: ['directive'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_world_state',
      description: 'Read the latest world state snapshot.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compact_history',
      description: 'Summarize older conversation history into a shorter recap.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'avatar_command',
      description: 'Send a planned avatar command.',
      parameters: avatarCommandParameters,
    },
  },
];

export const WsMessageSchema = z.object({
  type: z.string(),
  sessionId: z.string(),
  eventId: z.string(),
  timestamp: z.string(),
  payload: z.unknown(),
});
export type WsMessage = z.infer<typeof WsMessageSchema>;

export const ClientHelloPayloadSchema = z.object({
  clientId: z.string().min(1),
  participantId: z.preprocess(
    (value) => {
      if (typeof value !== 'string') {
        return value;
      }

      const trimmedParticipantId = value.trim();
      return trimmedParticipantId.length > 0 ? trimmedParticipantId : undefined;
    },
    z.string().min(1).optional(),
  ),
  autoStartSession: z.boolean().default(true),
  sessionConfig: SessionConfigSchema.partial().optional(),
});
export type ClientHelloPayload = z.infer<typeof ClientHelloPayloadSchema>;

export const ClientUtteranceFinalPayloadSchema = z.object({
  text: z.string().min(1),
  speakerId: z.string().optional(),
});
export type ClientUtteranceFinalPayload = z.infer<typeof ClientUtteranceFinalPayloadSchema>;

export const ClientWorldStatePayloadSchema = z.object({
  state: WorldStateSchema,
});
export type ClientWorldStatePayload = z.infer<typeof ClientWorldStatePayloadSchema>;

export const ClientThinkerTriggerPayloadSchema = z.object({
  reason: z.string().optional(),
});
export type ClientThinkerTriggerPayload = z.infer<typeof ClientThinkerTriggerPayloadSchema>;

export const ClientPingPayloadSchema = z.object({
  sentAt: z.string().optional(),
});
export type ClientPingPayload = z.infer<typeof ClientPingPayloadSchema>;

export const ClientAudioChunkPayloadSchema = z.object({
  audioBase64: z.string().min(1),
  sampleRateHz: z.number().int().min(8000).max(48000).default(16000),
  channels: z.number().int().min(1).max(2).default(1),
  sequence: z.number().int().min(0).optional(),
  speakerId: z.string().optional(),
});
export type ClientAudioChunkPayload = z.infer<typeof ClientAudioChunkPayloadSchema>;

export const ClientAudioCommitPayloadSchema = z.object({
  speakerId: z.string().optional(),
  reason: z.string().optional(),
});
export type ClientAudioCommitPayload = z.infer<typeof ClientAudioCommitPayloadSchema>;

export const ClientWsMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('client.hello'),
    payload: ClientHelloPayloadSchema,
  }),
  z.object({
    type: z.literal('client.utterance.final'),
    payload: ClientUtteranceFinalPayloadSchema,
  }),
  z.object({
    type: z.literal('client.world_state'),
    payload: ClientWorldStatePayloadSchema,
  }),
  z.object({
    type: z.literal('client.thinker.trigger'),
    payload: ClientThinkerTriggerPayloadSchema,
  }),
  z.object({
    type: z.literal('client.ping'),
    payload: ClientPingPayloadSchema.optional(),
  }),
  z.object({
    type: z.literal('client.audio.chunk'),
    payload: ClientAudioChunkPayloadSchema,
  }),
  z.object({
    type: z.literal('client.audio.commit'),
    payload: ClientAudioCommitPayloadSchema.optional(),
  }),
]);
export type ClientWsMessage = z.infer<typeof ClientWsMessageSchema>;

export const TelemetryEventSchema = z.object({
  type: z.string(),
  sessionId: z.string(),
  eventId: z.string(),
  utteranceId: z.string().optional(),
  timestamp: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

export interface ChatCompletionParams {
  messages: ChatMessage[];
  model: string;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | string;
}

export interface ChatCompletionResult {
  content?: string | null;
  tool_calls?: ToolCall[];
  raw?: unknown;
}

export interface ChatProvider {
  complete(params: ChatCompletionParams): Promise<ChatCompletionResult>;
}

export interface TTSProvider {
  synthesize(
    text: string,
    options?: { voiceId?: string; format?: string },
  ): Promise<ReadableStream<Uint8Array>>;
}

export function createEmptyBeliefStore(): BeliefStore {
  return BeliefStoreSchema.parse({});
}

export function parseToolArguments<T extends Record<string, unknown>>(raw?: string): T {
  try {
    return JSON.parse(raw ?? '{}') as T;
  } catch {
    return {} as T;
  }
}

export function utteranceToChatMessage(utterance: Utterance): ChatMessage {
  const content = utterance.speakerId
    ? `[${utterance.speakerId}]: ${utterance.text}`
    : utterance.text;

  return {
    role: utterance.role === 'assistant' ? 'assistant' : utterance.role === 'system' ? 'system' : 'user',
    content,
  };
}
