import type { TelemetryEvent } from '../contracts/ai';
import { telemetry } from './emitter';

/**
 * In-memory store that accumulates telemetry events per session.
 * Intended for dev / small-scale experiments; swap for a durable
 * sink (e.g. SQLite, Postgres) in production.
 */
class SessionStore {
  private sessions = new Map<string, TelemetryEvent[]>();

  constructor() {
    telemetry.subscribe((event) => {
      const list = this.sessions.get(event.sessionId) ?? [];
      list.push(event);
      this.sessions.set(event.sessionId, list);
    });
  }

  getEvents(sessionId: string): TelemetryEvent[] {
    return this.sessions.get(sessionId) ?? [];
  }

  getSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export const sessionStore = new SessionStore();
