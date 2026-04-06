import type { BeliefStore, Directive, ToolCall } from '@ariadne/shared-contracts';

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  speakerId?: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
}

export interface SystemEvent {
  id: string;
  timestamp: string;
  type: string;
  details: string;
}

export interface DashboardSessionStatus {
  sessionId: string;
  active: boolean;
  talkerStatus: 'idle' | 'active' | 'waiting';
  thinkerStatus: 'idle' | 'running' | 'scheduled';
  connectedClients: number;
  interventionMode: 'control' | 'light';
  thinkerIntervalSec: number;
  lastThinkerRunAt: string | null;
  startedAt: string;
  lastActivityAt: string;
}

export interface DirectiveResponse {
  pending: Directive[];
  fulfilled: Directive[];
}

export interface SessionEvent {
  type: string;
  sessionId: string;
  timestamp: string;
  payload: unknown;
}

export interface DashboardState {
  beliefStore: BeliefStore | null;
  directives: DirectiveResponse;
  status: DashboardSessionStatus | null;
}

// agent activity feed — discriminated union for thinker/talker visibility

export interface TalkerOutputActivity {
  kind: 'talker-output';
  id: string;
  timestamp: string;
  spokenText?: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; args: string }>;
}

export interface ThinkerCompleteActivity {
  kind: 'thinker-complete';
  id: string;
  timestamp: string;
  reason: string;
  directiveCount: number;
  reasoning?: string;
  toolCalls?: Array<{ name: string; args: string }>;
}

export interface ToolCallActivity {
  kind: 'tool-call';
  id: string;
  timestamp: string;
  agent: 'talker' | 'thinker';
  name: string;
  args: string;
}

export interface TelemetryActivity {
  kind: 'telemetry';
  id: string;
  timestamp: string;
  type: string;
  summary: string;
}

export type AgentActivityEntry =
  | TalkerOutputActivity
  | ThinkerCompleteActivity
  | ToolCallActivity
  | TelemetryActivity;
