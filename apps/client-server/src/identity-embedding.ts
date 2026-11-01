import type { ActorIdentityRecord } from '@fctp/client-sdk';
import type { IdentityService } from './identities.js';

const actorReferenceKeys = new Set([
  'actor', 'actorId', 'assignee', 'attributedTo', 'authorities', 'authorityId',
  'creator', 'grantee', 'holder', 'homeAuthority', 'possessor', 'recipient',
  'registry', 'sender', 'targetId', 'territoryId'
]);

const actorRoles = new Set(['home', 'player', 'registry', 'territory']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

function collectReferences(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectReferences(entry, found);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.id === 'string' && typeof value.role === 'string' && actorRoles.has(value.role) && isHttpUrl(value.id)) {
    found.add(value.id);
  }
  for (const [key, entry] of Object.entries(value)) {
    if (actorReferenceKeys.has(key)) {
      const values = Array.isArray(entry) ? entry : [entry];
      for (const candidate of values) {
        if (typeof candidate === 'string' && isHttpUrl(candidate)) found.add(candidate);
      }
    }
    if (Array.isArray(entry) || isRecord(entry)) collectReferences(entry, found);
  }
}

export function actorReferences(value: unknown): string[] {
  const found = new Set<string>();
  collectReferences(value, found);
  return [...found];
}

function byActorId(left: ActorIdentityRecord, right: ActorIdentityRecord): number {
  if (left.actorId < right.actorId) return -1;
  if (left.actorId > right.actorId) return 1;
  return 0;
}

export async function embedIdentities(
  body: unknown,
  identities: IdentityService,
  options: { resolve: boolean }
): Promise<unknown> {
  if (!isRecord(body)) return body;
  const references = actorReferences(body);
  if (references.length === 0) return body;

  const referenced = new Set(references);
  const retained = (await identities.read()).filter((record) => referenced.has(record.actorId));
  if (!options.resolve) return { ...body, identities: retained };

  const available = new Set(retained.filter((record) => record.state === 'available').map((record) => record.actorId));
  const unresolved = references.filter((actorId) => !available.has(actorId));
  if (unresolved.length === 0) return { ...body, identities: retained };

  const resolved = await identities.resolve(unresolved);
  const records = new Map(retained.map((record) => [record.actorId, record]));
  for (const record of resolved) records.set(record.actorId, record);
  return { ...body, identities: [...records.values()].sort(byActorId) };
}
