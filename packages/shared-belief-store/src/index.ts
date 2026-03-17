import Redis from 'ioredis';
import {
  BeliefStoreSchema,
  DirectiveSchema,
  WorldStateSchema,
  UtteranceSchema,
  createEmptyBeliefStore,
  type BeliefStore,
  type Directive,
  type Utterance,
  type WorldState,
} from '@ariadne/shared-contracts';

const DEFAULT_REDIS_URL = 'redis://localhost:6379';

export class SharedBeliefStore {
  private redis: Redis;

  constructor(redisUrl = process.env.REDIS_URL ?? DEFAULT_REDIS_URL) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  }

  async healthCheck(): Promise<boolean> {
    await this.ensureConnected();
    return (await this.redis.ping()) === 'PONG';
  }

  async readBeliefStore(sessionId: string): Promise<BeliefStore> {
    await this.ensureConnected();
    const raw = await this.redis.get(this.beliefKey(sessionId));
    if (!raw) {
      return createEmptyBeliefStore();
    }
    return BeliefStoreSchema.parse(JSON.parse(raw));
  }

  async writeBeliefStore(sessionId: string, store: BeliefStore): Promise<void> {
    await this.ensureConnected();
    const nextStore = BeliefStoreSchema.parse({
      ...store,
      updatedAt: new Date().toISOString(),
    });
    await this.redis.set(this.beliefKey(sessionId), JSON.stringify(nextStore));
  }

  async enqueueDirective(sessionId: string, directive: Directive): Promise<void> {
    await this.ensureConnected();
    const parsed = DirectiveSchema.parse(directive);
    await this.redis.rpush(this.directivesKey(sessionId), JSON.stringify(parsed));
    const store = await this.readBeliefStore(sessionId);
    await this.writeBeliefStore(sessionId, {
      ...store,
      directive_queue: [...store.directive_queue, parsed],
    });
  }

  async dequeueDirective(sessionId: string): Promise<Directive | null> {
    await this.ensureConnected();
    const raw = await this.redis.lpop(this.directivesKey(sessionId));
    if (!raw) {
      return null;
    }

    const directive = DirectiveSchema.parse(JSON.parse(raw));
    await this.redis.rpush(this.fulfilledKey(sessionId), JSON.stringify(directive));
    const store = await this.readBeliefStore(sessionId);
    await this.writeBeliefStore(sessionId, {
      ...store,
      directive_queue: store.directive_queue.filter((item) => item.id !== directive.id),
    });
    return directive;
  }

  async getDirectives(sessionId: string): Promise<Directive[]> {
    await this.ensureConnected();
    const raw = await this.redis.lrange(this.directivesKey(sessionId), 0, -1);
    return raw.map((entry) => DirectiveSchema.parse(JSON.parse(entry)));
  }

  async getFulfilledDirectives(sessionId: string): Promise<Directive[]> {
    await this.ensureConnected();
    const raw = await this.redis.lrange(this.fulfilledKey(sessionId), 0, -1);
    return raw.map((entry) => DirectiveSchema.parse(JSON.parse(entry)));
  }

  async appendHistory(sessionId: string, utterance: Utterance): Promise<void> {
    await this.ensureConnected();
    const parsed = UtteranceSchema.parse(utterance);
    await this.redis.rpush(this.historyKey(sessionId), JSON.stringify(parsed));
  }

  async getHistory(sessionId: string, limit?: number): Promise<Utterance[]> {
    await this.ensureConnected();
    const range =
      typeof limit === 'number'
        ? await this.redis.lrange(this.historyKey(sessionId), -limit, -1)
        : await this.redis.lrange(this.historyKey(sessionId), 0, -1);

    return range.map((entry) => UtteranceSchema.parse(JSON.parse(entry)));
  }

  async compactHistory(sessionId: string, summary: string): Promise<void> {
    await this.ensureConnected();
    const store = await this.readBeliefStore(sessionId);
    await this.writeBeliefStore(sessionId, {
      ...store,
      conversation_summary: summary,
    });
    await this.redis.set(this.historySummaryKey(sessionId), summary);
    await this.redis.ltrim(this.historyKey(sessionId), -20, -1);
  }

  async setWorldState(sessionId: string, state: WorldState): Promise<void> {
    await this.ensureConnected();
    const parsed = WorldStateSchema.parse({
      ...state,
      updatedAt: state.updatedAt ?? new Date().toISOString(),
    });
    await this.redis.set(this.worldKey(sessionId), JSON.stringify(parsed));
  }

  async getWorldState(sessionId: string): Promise<WorldState | null> {
    await this.ensureConnected();
    const raw = await this.redis.get(this.worldKey(sessionId));
    return raw ? WorldStateSchema.parse(JSON.parse(raw)) : null;
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.ensureConnected();
    await this.redis.del(
      this.beliefKey(sessionId),
      this.directivesKey(sessionId),
      this.fulfilledKey(sessionId),
      this.historyKey(sessionId),
      this.historySummaryKey(sessionId),
      this.worldKey(sessionId),
    );
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }

  private async ensureConnected(): Promise<void> {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
  }

  private beliefKey(sessionId: string): string {
    return `belief:${sessionId}`;
  }

  private directivesKey(sessionId: string): string {
    return `directives:${sessionId}`;
  }

  private fulfilledKey(sessionId: string): string {
    return `directives:${sessionId}:fulfilled`;
  }

  private historyKey(sessionId: string): string {
    return `history:${sessionId}`;
  }

  private historySummaryKey(sessionId: string): string {
    return `history:${sessionId}:summary`;
  }

  private worldKey(sessionId: string): string {
    return `world:${sessionId}`;
  }
}
