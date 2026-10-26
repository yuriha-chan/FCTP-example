import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface DurableOutboxItem {
  id: string;
  actorId: string;
  inbox: string;
  activity: Record<string, unknown>;
  payload: string;
  attempts: number;
  nextAttemptAt: number;
}
export interface DurableInboxItem {
  localActorId: string;
  activityId: string;
  objectId?: string;
  activity: Record<string, unknown>;
  sender: string;
  receivedAt: string;
  attempts?: number;
  nextAttemptAt?: number;
  diagnostic?: string;
}
export interface RejectedInboxDeclaration {
  localActorId: string;
  activityId: string;
  objectId?: string;
  activity: Record<string, unknown>;
  sender: string;
  receivedAt: string;
  reason: string;
}
export interface StoreState {
  actors: Record<string, Record<string, unknown>>;
  remoteActors: Record<string, { actor: Record<string, unknown>; inbox: string }>;
  objects: Record<string, unknown>;
  inboxActivityHashes: Record<string, string>;
  inboxObjectHashes: Record<string, string>;
  inboxQueue: DurableInboxItem[];
  inboxRejected: RejectedInboxDeclaration[];
  outbox: DurableOutboxItem[];
  outboxArchive: Array<{ actorId: string; activity: Record<string, unknown> }>;
  credentials: Record<string, unknown>;
  enrollments: Record<string, string>;
  domain: Record<string, unknown>;
}

export function emptyStoreState(): StoreState {
  return { actors: {}, remoteActors: {}, objects: {}, inboxActivityHashes: {}, inboxObjectHashes: {}, inboxQueue: [], inboxRejected: [], outbox: [], outboxArchive: [], credentials: {}, enrollments: {}, domain: {} };
}

export class JsonSnapshotStore {
  #state: StoreState = emptyStoreState();
  #tail: Promise<void> = Promise.resolve();
  readonly #file: string;

  constructor(file: string) { this.#file = file; }

  async open(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    try {
      this.#state = { ...emptyStoreState(), ...JSON.parse(await readFile(this.#file, 'utf8')) as Partial<StoreState> };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.#persist(this.#state);
    }
  }

  async read<T>(reader: (state: Readonly<StoreState>) => T): Promise<T> {
    await this.#tail;
    return reader(structuredClone(this.#state));
  }

  async transaction<T>(operation: (draft: StoreState) => T | Promise<T>): Promise<T> {
    let resolveTail: () => void = () => undefined;
    const next = new Promise<void>((resolve) => { resolveTail = resolve; });
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    try {
      const draft = structuredClone(this.#state);
      const result = await operation(draft);
      await this.#persist(draft);
      this.#state = draft;
      return result;
    } finally {
      resolveTail();
    }
  }

  async #persist(state: StoreState): Promise<void> {
    const temporary = join(dirname(this.#file), `.${Date.now()}-${Math.random().toString(16).slice(2)}.snapshot`);
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, this.#file);
  }
}
