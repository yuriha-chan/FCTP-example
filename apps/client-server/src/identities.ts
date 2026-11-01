import type { ActorIdentityRecord } from '@fctp/client-sdk';
import { reverseDiscoverWebFinger, type ReverseDiscoveryResult } from '@fctp/identity';
import { withDeadline } from './deadline.js';
import { boundedFetcher } from './errors.js';
import type { ClientApplicationState } from './store.js';

export interface IdentityService {
  read(): Promise<ActorIdentityRecord[]>;
  resolve(actorIds: readonly string[]): Promise<ActorIdentityRecord[]>;
}

export interface IdentityServiceOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publishedName(result: ReverseDiscoveryResult): string | undefined {
  const name = result.actor.name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function byActorId(left: ActorIdentityRecord, right: ActorIdentityRecord): number {
  if (left.actorId < right.actorId) return -1;
  if (left.actorId > right.actorId) return 1;
  return 0;
}

export function createIdentityService(
  state: ClientApplicationState,
  fetcher: typeof fetch,
  options: IdentityServiceOptions = {}
): IdentityService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const upstream = boundedFetcher(fetcher);

  const resolveActor = async (actorId: string): Promise<ActorIdentityRecord> => {
    const prior = await state.read((current) => current.identities[actorId]);
    try {
      const result = await withDeadline(timeoutMs, (signal) => reverseDiscoverWebFinger(actorId, (input, init) => upstream(input, { ...init, signal })));
      const observedAt = new Date().toISOString();
      const name = publishedName(result);
      if (result.verified) {
        return {
          actorId,
          source: actorId,
          state: 'available',
          verified: true,
          handle: result.handle,
          ...(name === undefined ? {} : { name }),
          observedAt
        };
      }
      return {
        actorId,
        source: actorId,
        state: 'empty',
        verified: false,
        reason: result.error,
        ...(name === undefined ? {} : { name }),
        observedAt
      };
    } catch (error) {
      const message = errorMessage(error);
      return prior === undefined || prior.state === 'unavailable'
        ? { actorId, source: actorId, state: 'unavailable', verified: false, error: message }
        : { ...prior, state: 'stale', error: message };
    }
  };

  return {
    async read() {
      return state.read((current) => Object.values(current.identities).sort(byActorId));
    },
    async resolve(actorIds) {
      const unique = [...new Set(actorIds)];
      const records = await Promise.all(unique.map(resolveActor));
      await state.transaction((current) => {
        for (const record of records) current.identities[record.actorId] = record;
      });
      return records;
    }
  };
}
