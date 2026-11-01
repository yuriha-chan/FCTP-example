import type { SourcedObservation } from '@fctp/client-sdk';
import type { ClientApplicationState } from './store.js';
import { withDeadline } from './deadline.js';

export interface ObservationRefreshInput<T> {
  key: string;
  source: string;
  load: (signal: AbortSignal) => Promise<T>;
  isEmpty?: (value: T) => boolean;
  timeoutMs?: number;
}

export interface ObservationRetainInput<T> {
  key: string;
  source: string;
  value: T;
  observedAt: string;
  isEmpty?: boolean;
}

export interface ObservationService {
  read(key: string): Promise<readonly SourcedObservation<unknown>[]>;
  readOne(key: string, source: string): Promise<SourcedObservation<unknown>>;
  refresh<T>(input: ObservationRefreshInput<T>): Promise<SourcedObservation<T>>;
  retain<T>(input: ObservationRetainInput<T>): Promise<SourcedObservation<T>>;
}

export interface ObservationServiceOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const KEY_SEPARATOR = '\u0000';

function observationKey(key: string, source: string): string {
  return `${key}${KEY_SEPARATOR}${source}`;
}

function belongsToKey(storedKey: string, key: string): boolean {
  return storedKey === key || storedKey.startsWith(`${key}${KEY_SEPARATOR}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retainedValue(observation: SourcedObservation<unknown>): observation is Extract<SourcedObservation<unknown>, { state: 'available' | 'empty' | 'stale' }> {
  return observation.state === 'available' || observation.state === 'empty' || observation.state === 'stale';
}

export function createObservationService(state: ClientApplicationState, options: ObservationServiceOptions = {}): ObservationService {
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const findOne = async (key: string, source: string): Promise<SourcedObservation<unknown> | undefined> => {
    return state.read((current) => Object.entries(current.observations).find(([storedKey, observation]) => belongsToKey(storedKey, key) && observation.source === source)?.[1]);
  };

  return {
    async read(key) {
      return state.read((current) => Object.entries(current.observations)
        .filter(([storedKey]) => belongsToKey(storedKey, key))
        .map(([, observation]) => observation));
    },
    async readOne(key, source) {
      const retained = await findOne(key, source);
      return retained ?? { state: 'not-retrieved', source };
    },
    async refresh<T>(input: ObservationRefreshInput<T>): Promise<SourcedObservation<T>> {
      const prior = await findOne(input.key, input.source);
      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
      try {
        const value = await withDeadline(timeoutMs, input.load);
        const observation: SourcedObservation<T> = {
          state: input.isEmpty?.(value) ? 'empty' : 'available',
          source: input.source,
          observedAt: new Date().toISOString(),
          value
        };
        await state.transaction((current) => {
          current.observations[observationKey(input.key, input.source)] = observation as SourcedObservation<unknown>;
        });
        return observation;
      } catch (error) {
        const observation: SourcedObservation<T> = prior && retainedValue(prior)
          ? {
              state: 'stale',
              source: input.source,
              observedAt: prior.observedAt,
              value: prior.value as T,
              error: errorMessage(error)
            }
          : { state: 'unavailable', source: input.source, error: errorMessage(error) };
        await state.transaction((current) => {
          current.observations[observationKey(input.key, input.source)] = observation as SourcedObservation<unknown>;
        });
        return observation;
      }
    },
    async retain<T>(input: ObservationRetainInput<T>): Promise<SourcedObservation<T>> {
      const prior = await findOne(input.key, input.source);
      if (prior && 'observedAt' in prior && typeof prior.observedAt === 'string' && prior.observedAt > input.observedAt) {
        return prior as SourcedObservation<T>;
      }
      const observation: SourcedObservation<T> = {
        state: input.isEmpty ? 'empty' : 'available',
        source: input.source,
        observedAt: input.observedAt,
        value: input.value
      };
      await state.transaction((current) => {
        current.observations[observationKey(input.key, input.source)] = observation as SourcedObservation<unknown>;
      });
      return observation;
    }
  };
}
