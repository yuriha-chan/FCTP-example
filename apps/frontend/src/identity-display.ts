export interface DisplayIdentity {
  id: string;
  verified: boolean;
  name?: string;
  handle?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const uriLabel = (uri: string): string => {
  const part = uri.split(/[/#]/).filter(Boolean).at(-1);
  if (!part) return uri;
  try { return decodeURIComponent(part); } catch (error) { if (error instanceof URIError) return part; throw error; }
};

export class IdentityDisplayRegistry {
  readonly #identities = new Map<string, DisplayIdentity>();

  registerRecords(records: unknown): void {
    if (!Array.isArray(records)) return;
    for (const record of records) {
      if (!isRecord(record) || typeof record.actorId !== 'string') continue;
      const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : undefined;
      const handle = record.verified === true && typeof record.handle === 'string' && record.handle.trim()
        ? record.handle.trim()
        : undefined;
      this.#identities.set(record.actorId, {
        id: record.actorId,
        verified: record.verified === true,
        ...(name === undefined ? {} : { name }),
        ...(handle === undefined ? {} : { handle })
      });
    }
  }

  get(id: string): DisplayIdentity | undefined {
    const identity = this.#identities.get(id);
    return identity ? { ...identity } : undefined;
  }

  handle(id: string): string | undefined {
    return this.#identities.get(id)?.handle;
  }

  label(id: string): string {
    const identity = this.#identities.get(id);
    if (identity) {
      if (identity.handle) return identity.name ? `${identity.name} (${identity.handle})` : identity.handle;
      return identity.name ?? 'Unknown Actor';
    }
    return uriLabel(id);
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
