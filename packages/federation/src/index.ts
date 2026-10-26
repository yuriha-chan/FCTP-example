import type { URI } from '@fctp/protocol';

export type ActivityType = 'Create' | 'Update' | 'Delete' | 'Follow' | 'Undo' | 'Accept' | 'Reject';
export interface Activity<T = unknown> extends Record<string, unknown> {
  '@context': string[];
  id: URI;
  type: ActivityType;
  actor: URI;
  object: T;
  to: URI[];
  published: string;
}
export interface ParsedActivity<T = unknown> { activity: Activity<T>; object: T; actor: URI; activityId: URI; objectId?: URI }

export function createActivity<T>(input: {
  id: URI; type?: ActivityType; actor: URI; object: T; to: URI | URI[]; published?: string;
}): Activity<T> {
  return {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
    id: input.id,
    type: input.type ?? 'Create',
    actor: input.actor,
    object: structuredClone(input.object),
    to: Array.isArray(input.to) ? [...input.to] : [input.to],
    published: input.published ?? new Date().toISOString()
  };
}

export function parseActivity<T = unknown>(value: unknown): ParsedActivity<T> {
  if (!isRecord(value) || !isRecord(value.object) && typeof value.object !== 'string' || typeof value.id !== 'string' || typeof value.actor !== 'string') {
    throw new TypeError('Invalid ActivityStreams Activity envelope');
  }
  if (!['Create', 'Update', 'Delete', 'Follow', 'Undo', 'Accept', 'Reject'].includes(String(value.type))) throw new TypeError('Unsupported ActivityStreams activity type');
  if (!Array.isArray(value.to) || !value.to.every((target) => typeof target === 'string')) throw new TypeError('Activity must have recipient Actor URI(s) in to');
  const object = value.object as T;
  const objectId = isRecord(object) && typeof object.id === 'string' ? object.id : undefined;
  return { activity: value as Activity<T>, object, actor: value.actor, activityId: value.id, ...(objectId ? { objectId } : {}) };
}

export function inferActivityType(object: unknown): ActivityType {
  if (isRecord(object) && typeof object.type === 'string' && ['EntryRequest', 'EntryRejected', 'BerthingEvent', 'CargoOperationEvent', 'DepartureRequest', 'DepartureEvent', 'VoyageEvent', 'ExitEvent', 'TokenDigest', 'TokenRevoke'].includes(object.type)) return 'Create';
  return 'Create';
}

export async function deliverActivity(activity: Activity, inbox: URI, fetcher: typeof fetch = fetch): Promise<{ status: number; accepted: boolean }> {
  const response = await fetcher(inbox, {
    method: 'POST',
    headers: { 'Content-Type': 'application/activity+json', Accept: 'application/activity+json' },
    body: JSON.stringify(activity)
  });
  return { status: response.status, accepted: response.status === 202 };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
