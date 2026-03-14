import type { TelemetryEvent } from '../contracts/ai';

type Listener = (event: TelemetryEvent) => void;

/**
 * Lightweight, process-wide event emitter for structured telemetry.
 * Listeners can persist events to any sink (console, file, DB).
 */
class TelemetryEmitter {
  private listeners: Listener[] = [];

  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(event: TelemetryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[telemetry] listener error', err);
      }
    }
  }
}

export const telemetry = new TelemetryEmitter();
