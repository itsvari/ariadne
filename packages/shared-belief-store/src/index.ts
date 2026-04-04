// iovalkey ships without type declarations. the runtime default export is a constructor
// function that creates a valkey (redis-compatible) client instance. ownership: the
// instance is created in the constructor and lives for the lifetime of this class.
// @ts-ignore
import Valkey from 'iovalkey';
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

const DEFAULT_VALKEY_URL = 'valkey://localhost:6379';

export interface SessionArchiveSnapshot {
  archiveId: string;
  sessionId: string;
  archivedAt: string;
  beliefStore: BeliefStore;
  directives: Directive[];
  fulfilledDirectives: Directive[];
  history: Utterance[];
  historySummary: string | null;
  worldState: WorldState | null;
}

export interface SessionArchiveSummary {
  archiveId: string;
  sessionId: string;
  archivedAt: string;
  utteranceCount: number;
  pendingDirectiveCount: number;
  fulfilledDirectiveCount: number;
}

export class SharedBeliefStore {
  private valkey: Valkey;

  constructor(valkeyUrl = process.env.VALKEY_URL ?? DEFAULT_VALKEY_URL) {
    this.valkey = new Valkey(valkeyUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  }

  async healthCheck(): Promise<boolean> {
    await this.ensureConnected();
    return (await this.valkey.ping()) === 'PONG';
  }

  async readBeliefStore(sessionId: string): Promise<BeliefStore> {
    await this.ensureConnected();
    const value = await this.valkey.get(this.beliefKey(sessionId));
    if (!value) {
      return createEmptyBeliefStore();
    }
    return BeliefStoreSchema.parse(JSON.parse(value));
  }

  async writeBeliefStore(sessionId: string, store: BeliefStore): Promise<void> {
    await this.ensureConnected();
    const nextStore = BeliefStoreSchema.parse({
      ...store,
      updatedAt: new Date().toISOString(),
    });
    await this.valkey.set(this.beliefKey(sessionId), JSON.stringify(nextStore));
  }

  async enqueueDirective(sessionId: string, directive: Directive): Promise<void> {
    await this.ensureConnected();
    const parsed = DirectiveSchema.parse(directive);
    await this.valkey.rpush(this.directivesKey(sessionId), JSON.stringify(parsed));
    const store = await this.readBeliefStore(sessionId);
    await this.writeBeliefStore(sessionId, {
      ...store,
      directive_queue: [...store.directive_queue, parsed],
    });
  }

  async dequeueDirective(sessionId: string): Promise<Directive | null> {
    await this.ensureConnected();
    const value = await this.valkey.lpop(this.directivesKey(sessionId));
    if (!value) {
      return null;
    }

    const directive = DirectiveSchema.parse(JSON.parse(value));
    await this.valkey.rpush(this.fulfilledKey(sessionId), JSON.stringify(directive));
    const store = await this.readBeliefStore(sessionId);
    await this.writeBeliefStore(sessionId, {
      ...store,
      directive_queue: store.directive_queue.filter((item) => item.id !== directive.id),
    });
    return directive;
  }

  async getDirectives(sessionId: string): Promise<Directive[]> {
    await this.ensureConnected();
    const entries = await this.valkey.lrange(this.directivesKey(sessionId), 0, -1);
    return entries.map((entry: string) => DirectiveSchema.parse(JSON.parse(entry)));
  }

  async getFulfilledDirectives(sessionId: string): Promise<Directive[]> {
    await this.ensureConnected();
    const entries = await this.valkey.lrange(this.fulfilledKey(sessionId), 0, -1);
    return entries.map((entry: string) => DirectiveSchema.parse(JSON.parse(entry)));
  }

  async appendHistory(sessionId: string, utterance: Utterance): Promise<void> {
    await this.ensureConnected();
    const parsed = UtteranceSchema.parse(utterance);
    await this.valkey.rpush(this.historyKey(sessionId), JSON.stringify(parsed));
  }

  async getHistory(sessionId: string, limit?: number): Promise<Utterance[]> {
    await this.ensureConnected();
    const range =
      typeof limit === 'number'
        ? await this.valkey.lrange(this.historyKey(sessionId), -limit, -1)
        : await this.valkey.lrange(this.historyKey(sessionId), 0, -1);

    return range.map((entry: string) => UtteranceSchema.parse(JSON.parse(entry)));
  }

  async compactHistory(sessionId: string, summary: string): Promise<void> {
    await this.ensureConnected();
    const store = await this.readBeliefStore(sessionId);
    await this.writeBeliefStore(sessionId, {
      ...store,
      conversation_summary: summary,
    });
    await this.valkey.set(this.historySummaryKey(sessionId), summary);
  }

  async setWorldState(sessionId: string, state: WorldState): Promise<void> {
    await this.ensureConnected();
    const parsed = WorldStateSchema.parse({
      ...state,
      updatedAt: state.updatedAt ?? new Date().toISOString(),
    });
    await this.valkey.set(this.worldKey(sessionId), JSON.stringify(parsed));
  }

  async getWorldState(sessionId: string): Promise<WorldState | null> {
    await this.ensureConnected();
    const value = await this.valkey.get(this.worldKey(sessionId));
    return value ? WorldStateSchema.parse(JSON.parse(value)) : null;
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.ensureConnected();
    await this.valkey.del(
      this.beliefKey(sessionId),
      this.directivesKey(sessionId),
      this.fulfilledKey(sessionId),
      this.historyKey(sessionId),
      this.historySummaryKey(sessionId),
      this.worldKey(sessionId),
    );
  }

  async resetSessionForNewRun(sessionId: string): Promise<{ archiveId: string | null }> {
    await this.ensureConnected();

    const archiveId = await this.archiveSession(sessionId);
    await this.clearSession(sessionId);
    await this.writeBeliefStore(sessionId, createEmptyBeliefStore());

    return { archiveId };
  }

  async listSessionArchives(sessionId: string): Promise<SessionArchiveSummary[]> {
    await this.ensureConnected();
    const archiveIds = await this.valkey.lrange(this.archivesBySessionKey(sessionId), 0, -1);
    if (!archiveIds.length) {
      return [];
    }

    const records = await Promise.all(
      archiveIds.map(async (archiveId: string) => {
        const value = await this.valkey.get(this.archiveKey(archiveId));
        if (!value) {
          return null;
        }
        const parsed = this.parseArchive(value);
        return {
          archiveId: parsed.archiveId,
          sessionId: parsed.sessionId,
          archivedAt: parsed.archivedAt,
          utteranceCount: parsed.history.length,
          pendingDirectiveCount: parsed.directives.length,
          fulfilledDirectiveCount: parsed.fulfilledDirectives.length,
        } satisfies SessionArchiveSummary;
      }),
    );

    return records.filter((record): record is SessionArchiveSummary => Boolean(record)).reverse();
  }

  async readSessionArchive(archiveId: string): Promise<SessionArchiveSnapshot | null> {
    await this.ensureConnected();
    const value = await this.valkey.get(this.archiveKey(archiveId));
    if (!value) {
      return null;
    }
    return this.parseArchive(value);
  }

  async disconnect(): Promise<void> {
    await this.valkey.quit();
  }

  private async ensureConnected(): Promise<void> {
    if (this.valkey.status === 'wait') {
      await this.valkey.connect();
    }
  }

  private async archiveSession(sessionId: string): Promise<string | null> {
    const [beliefValue, directivesValue, fulfilledValue, historyValue, historySummary, worldValue] = await Promise.all([
      this.valkey.get(this.beliefKey(sessionId)),
      this.valkey.lrange(this.directivesKey(sessionId), 0, -1),
      this.valkey.lrange(this.fulfilledKey(sessionId), 0, -1),
      this.valkey.lrange(this.historyKey(sessionId), 0, -1),
      this.valkey.get(this.historySummaryKey(sessionId)),
      this.valkey.get(this.worldKey(sessionId)),
    ]);

    const hasData = Boolean(beliefValue)
      || directivesValue.length > 0
      || fulfilledValue.length > 0
      || historyValue.length > 0
      || Boolean(historySummary)
      || Boolean(worldValue);

    if (!hasData) {
      return null;
    }

    const archivedAt = new Date().toISOString();
    const archiveId = `${sessionId}:${archivedAt}:${crypto.randomUUID()}`;

    const snapshot: SessionArchiveSnapshot = {
      archiveId,
      sessionId,
      archivedAt,
      beliefStore: beliefValue
        ? BeliefStoreSchema.parse(JSON.parse(beliefValue))
        : createEmptyBeliefStore(),
      directives: directivesValue.map((entry: string) => DirectiveSchema.parse(JSON.parse(entry))),
      fulfilledDirectives: fulfilledValue.map((entry: string) => DirectiveSchema.parse(JSON.parse(entry))),
      history: historyValue.map((entry: string) => UtteranceSchema.parse(JSON.parse(entry))),
      historySummary: historySummary || null,
      worldState: worldValue ? WorldStateSchema.parse(JSON.parse(worldValue)) : null,
    };

    await this.valkey.multi()
      .set(this.archiveKey(archiveId), JSON.stringify(snapshot))
      .rpush(this.archivesBySessionKey(sessionId), archiveId)
      .exec();

    return archiveId;
  }

  private parseArchive(value: string): SessionArchiveSnapshot {
    const parsed = JSON.parse(value) as SessionArchiveSnapshot;
    return {
      archiveId: String(parsed.archiveId),
      sessionId: String(parsed.sessionId),
      archivedAt: String(parsed.archivedAt),
      beliefStore: BeliefStoreSchema.parse(parsed.beliefStore),
      directives: (parsed.directives ?? []).map((entry) => DirectiveSchema.parse(entry)),
      fulfilledDirectives: (parsed.fulfilledDirectives ?? []).map((entry) => DirectiveSchema.parse(entry)),
      history: (parsed.history ?? []).map((entry) => UtteranceSchema.parse(entry)),
      historySummary: parsed.historySummary ?? null,
      worldState: parsed.worldState ? WorldStateSchema.parse(parsed.worldState) : null,
    };
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

  private archiveKey(archiveId: string): string {
    return `archive:${archiveId}`;
  }

  private archivesBySessionKey(sessionId: string): string {
    return `archives:${sessionId}`;
  }
}
