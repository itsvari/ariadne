import type { WorldState } from '@ariadne/shared-contracts';

export interface EventEnvelope<TType extends string, TPayload> {
  type: TType;
  sessionId: string;
  timestamp: string;
  payload: TPayload;
}

export type UtteranceFinalEvent = EventEnvelope<
  'UtteranceFinal',
  { utteranceId: string; speakerId?: string; text: string }
>;

export type UtteranceChunkEvent = EventEnvelope<
  'UtteranceChunk',
  { speakerId?: string; text: string }
>;

export type WorldStateUpdateEvent = EventEnvelope<'WorldStateUpdate', WorldState>;
export type ReasonerCompleteEvent = EventEnvelope<
  'ReasonerComplete',
  { reason: string; directiveCount: number }
>;
export type TalkerWaitFlagEvent = EventEnvelope<'TalkerWaitFlag', { reason: string }>;
export type AvatarCommandEvent = EventEnvelope<
  'AvatarCommand',
  Record<string, unknown>
>;

export type EndOfTurnEvent = EventEnvelope<
  'EndOfTurn',
  { speakerId: string; text: string; turnIndex: number }
>;

export type EventBusEvent =
  | UtteranceFinalEvent
  | UtteranceChunkEvent
  | EndOfTurnEvent
  | WorldStateUpdateEvent
  | ReasonerCompleteEvent
  | TalkerWaitFlagEvent
  | AvatarCommandEvent;

export type EventType = EventBusEvent['type'];
export type EventHandler<T extends EventBusEvent = EventBusEvent> = (event: T) => void | Promise<void>;

export class EventBus {
  private listeners = new Map<EventType, Set<EventHandler>>();

  subscribe<T extends EventBusEvent>(
    eventType: T['type'],
    handler: EventHandler<T>,
  ): () => void {
    const list = this.listeners.get(eventType) ?? new Set<EventHandler>();
    list.add(handler as EventHandler);
    this.listeners.set(eventType, list);

    return () => {
      const current = this.listeners.get(eventType);
      current?.delete(handler as EventHandler);
      if (current && current.size === 0) {
        this.listeners.delete(eventType);
      }
    };
  }

  async publish<T extends EventBusEvent>(event: T): Promise<void> {
    const handlers = Array.from(this.listeners.get(event.type) ?? []);
    await Promise.all(handlers.map((handler) => handler(event)));
  }

  requestResponse<T extends EventBusEvent['type']>(
    eventType: T,
    timeoutMs = 5000,
  ): Promise<Extract<EventBusEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for ${eventType}`));
      }, timeoutMs);

      const unsubscribe = this.subscribe(eventType, (event) => {
        clearTimeout(timer);
        unsubscribe();
        resolve(event as Extract<EventBusEvent, { type: T }>);
      });
    });
  }
}
