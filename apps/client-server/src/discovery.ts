import { createFctpClient, type AuthorityRecord, type AuthorityRole, type ServerRecord } from '@fctp/client-sdk';
import { parseHandle } from '@fctp/identity';
import type { FCTPActor } from '@fctp/protocol';
import { boundedFetcher } from './errors.js';
import type { ClientApplicationState } from './store.js';

export interface DiscoveryInput {
  origin?: string;
  handle?: string;
}

export interface DiscoveryResult {
  servers: ServerRecord[];
  authorities: AuthorityRecord[];
}

export interface DiscoveryService {
  list(): Promise<DiscoveryResult>;
  discover(input: DiscoveryInput): Promise<DiscoveryResult>;
  remember(actor: FCTPActor, server: string, origin: string): Promise<void>;
}

const authorityRoles = new Set<AuthorityRole>(['home', 'territory', 'registry', 'asset-server']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Enter a valid HTTP(S) server origin');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('Server origin must use HTTP or HTTPS');
  return url;
}

function actorIds(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!isRecord(value)) return [];
  return Object.values(value).filter((entry): entry is string => typeof entry === 'string');
}

function advertisedActors(info: unknown): string[] {
  if (!isRecord(info)) return [];
  const ids = isRecord(info.ids) ? info.ids : {};
  return [...new Set([...actorIds(info.actor), ...actorIds(ids.actor)])];
}

function actorHandle(actor: Record<string, unknown>): string | undefined {
  if (typeof actor.handle !== 'string') return undefined;
  try {
    const parsed = parseHandle(actor.handle);
    return parsed.kind === 'authority' ? parsed.handle : undefined;
  } catch {
    return undefined;
  }
}

function roleOf(actor: Record<string, unknown>): AuthorityRole | undefined {
  const role = actor.role;
  return typeof role === 'string' && authorityRoles.has(role as AuthorityRole) ? role as AuthorityRole : undefined;
}

export function createDiscoveryService(state: ClientApplicationState, fetcher: typeof fetch): DiscoveryService {
  const upstream = boundedFetcher(fetcher);
  const sdk = createFctpClient({ fetcher: upstream });

  const list = async (): Promise<DiscoveryResult> => state.read((current) => ({
    servers: Object.values(current.servers),
    authorities: Object.values(current.authorities)
  }));

  const retain = async (server: ServerRecord, authorities: readonly AuthorityRecord[]): Promise<DiscoveryResult> => {
    await state.transaction((current) => {
      const prior = current.servers[server.server];
      current.servers[server.server] = {
        ...server,
        authorities: [...new Set([...(prior?.authorities ?? []), ...server.authorities])]
      };
      for (const authority of authorities) current.authorities[authority.actorId] = authority;
    });
    return list();
  };

  const discoverOrigin = async (value: string): Promise<DiscoveryResult> => {
    const origin = normalizeOrigin(value);
    const response = await upstream(new URL('/local/info', origin.origin), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`Discovery failed: HTTP ${response.status}`);
    const info: unknown = await response.json();
    const discovered = await Promise.all(advertisedActors(info).map(async (actorId) => {
      const actorResponse = await upstream(actorId, {
        method: 'GET',
        headers: { Accept: 'application/activity+json, application/ld+json' },
        cache: 'no-store'
      });
      if (!actorResponse.ok) throw new Error(`Actor discovery failed: HTTP ${actorResponse.status}`);
      const actor: unknown = await actorResponse.json();
      return isRecord(actor) ? actor : {};
    }));
    const authorities: AuthorityRecord[] = [];
    for (const actor of discovered) {
      const role = roleOf(actor);
      const actorId = actor.id;
      if (!role || typeof actorId !== 'string') continue;
      const handle = actorHandle(actor);
      authorities.push({ ...(handle ? { handle } : {}), ...(typeof actor.name === 'string' ? { name: actor.name } : {}), actorId, server: new URL(actorId).host, roles: [role] });
    }
    const server: ServerRecord = {
      server: origin.host,
      origin: origin.origin,
      authorities: authorities.map((authority) => authority.actorId)
    };
    return retain(server, authorities);
  };

  const retainedOrigin = async (server: string): Promise<string | undefined> => state.read((current) => {
    for (const record of Object.values(current.servers)) {
      try {
        if (new URL(record.origin).host === server) return record.origin;
      } catch {
        continue;
      }
    }
    return undefined;
  });

  const discoverHandle = async (value: string): Promise<DiscoveryResult> => {
    const parsed = parseHandle(value);
    if (parsed.kind === 'account') {
      const resolution = await sdk.resolveAccount(value);
      const role = roleOf(resolution.homeActor);
      const handle = actorHandle(resolution.homeActor);
      const authorities: AuthorityRecord[] = role === undefined ? [] : [{
        ...(handle ? { handle } : {}),
        actorId: resolution.homeAuthority,
        server: resolution.homeServer,
        roles: [role]
      }];
      const server: ServerRecord = {
        server: resolution.homeServer,
        origin: resolution.homeOrigin,
        authorities: authorities.map((authority) => authority.actorId)
      };
      return retain(server, authorities);
    }
    const origin = await retainedOrigin(parsed.server);
    const resolution = await sdk.resolveAuthority(value, origin === undefined ? {} : { origin });
    const role = roleOf(resolution.actor as unknown as Record<string, unknown>);
    const roles = role === undefined ? resolution.roles.filter((entry): entry is AuthorityRole => authorityRoles.has(entry as AuthorityRole)) : [role];
    if (roles.length === 0) throw new Error('Resolved Actor does not publish an authority role');
    const authorities: AuthorityRecord[] = [{
      handle: value,
      actorId: resolution.actorId,
      server: resolution.server,
      roles
    }];
    const server: ServerRecord = {
      server: parsed.server,
      origin: origin ?? new URL(resolution.actorId).origin,
      authorities: [resolution.actorId]
    };
    return retain(server, authorities);
  };

  const remember = async (actor: FCTPActor, server: string, origin: string): Promise<void> => {
    const role = roleOf(actor);
    if (role === undefined) return;
    const normalized = normalizeOrigin(origin);
    const handle = actorHandle(actor);
    const name = typeof actor.name === 'string' && actor.name.length > 0 ? actor.name : undefined;
    const authority: AuthorityRecord = {
      ...(handle ? { handle } : {}),
      ...(name ? { name } : {}),
      actorId: actor.id,
      server,
      roles: [role]
    };
    const record: ServerRecord = { server, origin: normalized.origin, authorities: [actor.id] };
    await retain(record, [authority]);
  };

  return {
    list,
    remember,
    async discover(input) {
      const origin = typeof input.origin === 'string' ? input.origin.trim() : '';
      const handle = typeof input.handle === 'string' ? input.handle.trim() : '';
      if (Boolean(origin) === Boolean(handle)) throw new TypeError('Provide exactly one server origin or authority handle');
      return origin ? discoverOrigin(origin) : discoverHandle(handle);
    }
  };
}
