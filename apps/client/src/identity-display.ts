import { webFingerSubject } from '@fctp/identity';
import type { FCTPActor } from '@fctp/protocol';

export interface DisplayIdentity {
  id: string;
  name: string;
  handle?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const actorRoles = new Set(['player', 'home', 'registry', 'territory']);

const uriLabel = (uri: string): string => {
  const part = uri.split(/[/#]/).filter(Boolean).at(-1);
  if (!part) return uri;
  try { return decodeURIComponent(part); } catch (error) { if (error instanceof URIError) return part; throw error; }
};

export class IdentityDisplayRegistry {
  readonly #identities = new Map<string, DisplayIdentity>();

  register(value: unknown): void {
    if (!isRecord(value) || typeof value.id !== 'string') return;
    const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : undefined;
    const identity: DisplayIdentity = { id: value.id, name: name ?? '' };
    if (typeof value.role === 'string' && actorRoles.has(value.role)) {
      let actorUrl: URL | undefined;
      try { actorUrl = new URL(value.id); } catch (error) { if (!(error instanceof TypeError)) throw error; }
      const localName = actorUrl?.pathname.split('/').filter(Boolean).at(-1);
      if (localName && !localName.includes('.')) identity.handle = webFingerSubject(value as unknown as FCTPActor);
    }
    if (!identity.name && !identity.handle) return;
    this.#identities.set(identity.id, identity);
  }

  get(id: string): DisplayIdentity | undefined {
    const identity = this.#identities.get(id);
    return identity ? { ...identity } : undefined;
  }

  label(id: string): string {
    const identity = this.#identities.get(id);
    return identity ? identity.name ? `${identity.name}${identity.handle ? ` (${identity.handle})` : ''}` : identity.handle! : uriLabel(id);
  }

  clear(): void {
    this.#identities.clear();
  }
}

export const identityDisplay = new IdentityDisplayRegistry();

const addressKeys = new Set(['id', 'holder', 'creator', 'grantee', 'inbox', 'outbox', 'asset', 'variety', 'tool', 'url', 'port', 'ports', 'route', 'routes', 'territory', 'entryRequest', 'possessor', 'map', 'creations', 'location']);
const ignoredKeys = new Set(['text', 'data', 'proof', 'advanced', 'extension']);

export function technicalAddresses(value: unknown): Array<{ label: string; address: string }> {
  const addresses = new Map<string, { label: string; address: string }>();
  if (Array.isArray(value)) {
    value.forEach((address, index) => {
      if (typeof address === 'string' && URL.canParse(address)) addresses.set(`Reference[${index + 1}]\n${address}`, { label: `Reference[${index + 1}]`, address });
    });
  }
  const visit = (current: unknown, path: string): void => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index + 1}]`));
      return;
    }
    if (!isRecord(current)) return;
    for (const [key, item] of Object.entries(current)) {
      if (ignoredKeys.has(key)) continue;
      const fieldPath = path ? `${path}.${key}` : key;
      if (addressKeys.has(key) || (key === 'orderedItems' || key === 'items') && Array.isArray(item)) {
        const values = Array.isArray(item) ? item : [item];
        values.forEach((address, index) => {
          if (typeof address !== 'string' || !URL.canParse(address)) return;
          const label = values.length > 1 ? `${fieldPath}[${index + 1}]` : fieldPath;
          addresses.set(`${label}\n${address}`, { label, address });
        });
      }
      if (Array.isArray(item) || isRecord(item)) visit(item, fieldPath);
    }
  };
  visit(value, '');
  return [...addresses.values()];
}

export function technicalDetails(addresses: Array<{ label: string; address: string }>, title = 'Technical addresses'): HTMLDetailsElement | undefined {
  if (addresses.length === 0) return undefined;
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `${title} (${addresses.length})`;
  details.append(summary);
  for (const { label, address } of addresses) {
    const item = document.createElement('p');
    const name = document.createElement('span'); name.textContent = `${label}: `;
    const value = document.createElement('code'); value.textContent = address;
    item.append(name, value);
    details.append(item);
  }
  return details;
}
