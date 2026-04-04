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

export interface SessionStatusView {
  sessionId: string;
  active: boolean;
  talkerStatus: 'idle' | 'active' | 'waiting';
  thinkerStatus: 'idle' | 'running' | 'scheduled';
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
  status: SessionStatusView | null;
}
