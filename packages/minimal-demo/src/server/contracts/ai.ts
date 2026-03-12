import { z } from 'zod';

// ---------------------------------------------------------------------------
// Experiment / Session
// ---------------------------------------------------------------------------

export const InterventionMode = z.enum(['control', 'light', 'heavy']);
export type InterventionMode = z.infer<typeof InterventionMode>;

export const SessionConfig = z.object({
  interventionMode: InterventionMode,
  groupSize: z.number().int().min(1).optional(),
  taskId: z.string().optional(),
  phase: z.string().optional(),
});
export type SessionConfig = z.infer<typeof SessionConfig>;

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

export const ChatMessage = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().nullable().optional(),
  tool_calls: z.unknown().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

// ---------------------------------------------------------------------------
// Talker
// ---------------------------------------------------------------------------

export const TalkerRequest = z.object({
  sessionId: z.string(),
  messages: z.array(ChatMessage),
  worldState: z.unknown().optional(),
  beliefSnapshot: z.unknown().optional(),
  directives: z.array(z.string()).optional(),
  sessionConfig: SessionConfig.optional(),
});
export type TalkerRequest = z.infer<typeof TalkerRequest>;

export const TalkerResponse = z.object({
  content: z.string().nullable().optional(),
  tool_calls: z.unknown().optional(),
});
export type TalkerResponse = z.infer<typeof TalkerResponse>;

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

export const TTSRequest = z.object({
  text: z.string().min(1),
  voiceId: z.string().optional(),
  format: z.enum(['mp3', 'pcm', 'opus']).optional(),
});
export type TTSRequest = z.infer<typeof TTSRequest>;

// ---------------------------------------------------------------------------
// WebSocket event protocol (Unity <-> Gateway)
// ---------------------------------------------------------------------------

export const WsInboundType = z.enum([
  'utterance.final',
  'world_state.update',
  'talker.turn',
]);

export const WsOutboundType = z.enum([
  'talker.output',
  'tts.audio.chunk',
  'tts.audio.done',
  'avatar.command',
]);

export const TelemetryEventType = z.enum([
  'facilitator.intervention',
  'conversation.metrics',
  'system.latency',
  'task.progress',
]);

export const WsMessage = z.object({
  type: z.string(),
  sessionId: z.string(),
  eventId: z.string(),
  timestamp: z.string(),
  payload: z.unknown(),
});
export type WsMessage = z.infer<typeof WsMessage>;

// ---------------------------------------------------------------------------
// Provider interfaces
// ---------------------------------------------------------------------------

export interface ChatCompletionParams {
  messages: ChatMessage[];
  model: string;
  tools?: unknown[];
  toolChoice?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: string;
}

export interface ChatCompletionResult {
  content?: string | null;
  tool_calls?: unknown;
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

// ---------------------------------------------------------------------------
// Telemetry event payload
// ---------------------------------------------------------------------------

export interface TelemetryEvent {
  type: string;
  sessionId: string;
  eventId: string;
  utteranceId?: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
