import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createTokenDigest, createTokenRevoke, deriveDiplomaticToken, encodeNativeToken } from '@fctp/auth';
import { ResourceClient, ResourceError } from '@fctp/resources';
import type { FCTPActor, TokenDeclaration, URI } from '@fctp/protocol';
import type { Authority } from './bootstrap.js';

interface ResourceActor extends FCTPActor, Record<string, unknown> { inbox: URI }
interface UsedResource { id: URI; inbox: URI }
interface PlayerState { nativeToken: string; resources: Record<string, UsedResource>; revisions: Record<string, number> }
interface HomeState { players: Record<string, PlayerState> }

export interface HomeOptions {
  playerActorId?: URI;
  fetcher?: typeof fetch;
  resourceClient?: ResourceClient;
}

export interface HomeService {
  readonly resources: ResourceClient;
  authenticateNativeToken(token: string): Promise<URI | undefined>;
  issueNativeToken(playerActorId?: URI): Promise<string>;
  rotateNativeToken(playerActorId?: URI): Promise<string>;
  revoke(playerActorId: URI, resource: UsedResource): Promise<void>;
  requestDigest(playerActorId: URI, resource: UsedResource): Promise<TokenDeclaration>;
  deriveToken(playerActorId: URI, resourceActorId: URI): Promise<string>;
  getResource<T>(playerActorId: URI, resourceActorId: URI, uri: URI): Promise<T>;
}

export function installHome(authority: Authority, options: HomeOptions = {}): HomeService {
  const playerActorId = options.playerActorId ?? authority.actor('player').id;
  const playerActorIds = new Set(options.playerActorId ? [options.playerActorId] : Object.values(authority.players).map((player) => player.id));
  const resources = options.resourceClient ?? new ResourceClient(options.fetcher);
  const fetcher = options.fetcher ?? fetch;
  const playerQueues = new Map<URI, Promise<void>>();
  const serializePlayer = <T>(id: URI, operation: () => Promise<T>): Promise<T> => {
    const previous = playerQueues.get(id) ?? Promise.resolve();
    const result = previous.then(operation);
    playerQueues.set(id, result.then(() => undefined, () => undefined));
    return result;
  };
  const readPlayer = async (id: URI): Promise<PlayerState | undefined> => authority.server.store.read((store) => {
    const home = store.domain.home as HomeState | undefined;
    const player = home?.players[id];
    return player ? structuredClone(player) : undefined;
  });
  const nextActivityId = (): URI => `${authority.actor('home').id}/activities/${randomBytes(16).toString('hex')}`;
  const requirePlayer = (id: URI): void => { if (!playerActorIds.has(id)) throw new Error('unknown-local-player'); };

  const issue = async (id: URI, rotate: boolean): Promise<string> => {
    requirePlayer(id);
    const current = await readPlayer(id);
    if (!current && rotate) throw new Error('native-token-not-issued');
    if (current && !rotate) throw new Error('native-token-already-issued');
    const nativeToken = encodeNativeToken(randomBytes(32));
    const player: PlayerState = current ?? { nativeToken, resources: {}, revisions: {} };
    player.nativeToken = nativeToken;
    if (current) {
      const outgoing = await Promise.all(Object.values(player.resources).map(async (resource) => {
        const revision = (player.revisions[resource.id] ?? 0) + 1;
        player.revisions[resource.id] = revision;
        const diplomaticToken = await deriveDiplomaticToken(nativeToken, resource.id);
        return { actorId: authority.actor('home').id, recipientActorId: resource.id, inbox: resource.inbox, object: { type: 'TokenDigest', ...(await createTokenDigest(id, revision, diplomaticToken)) }, activityId: nextActivityId() };
      }));
      await authority.server.commit((domain) => {
        const home = (domain.home ??= { players: {} }) as HomeState;
        home.players[id] = player;
      }, outgoing);
    } else {
      await authority.server.store.transaction((store) => {
        const home = (store.domain.home ??= { players: {} }) as HomeState;
        home.players[id] = player;
      });
    }
    return nativeToken;
  };

  const withResource = async (id: URI, resource: UsedResource): Promise<PlayerState> => {
    const player = await readPlayer(id);
    if (!player) throw new Error('native-token-not-issued');
    player.resources[resource.id] = resource;
    return player;
  };

  const service: HomeService = {
    resources,
    authenticateNativeToken: (token) => authenticateNativeToken(token, authority, playerActorIds),
    issueNativeToken: (id = playerActorId) => serializePlayer(id, () => issue(id, false)),
    rotateNativeToken: (id = playerActorId) => serializePlayer(id, () => issue(id, true)),
    revoke(id, resource) {
      return serializePlayer(id, async () => {
        requirePlayer(id);
        const player = await withResource(id, resource);
        const revision = (player.revisions[resource.id] ?? 0) + 1;
        player.revisions[resource.id] = revision;
        await authority.server.commit((domain) => {
          const home = (domain.home ??= { players: {} }) as HomeState;
          home.players[id] = player;
        }, [{ actorId: authority.actor('home').id, recipientActorId: resource.id, inbox: resource.inbox, object: { type: 'TokenRevoke', ...createTokenRevoke(id, revision) }, activityId: nextActivityId() }]);
      });
    },
    requestDigest(id, resource) {
      return serializePlayer(id, async () => {
        requirePlayer(id);
        const player = await withResource(id, resource);
        const revision = (player.revisions[resource.id] ?? 0) + 1;
        const diplomaticToken = await deriveDiplomaticToken(player.nativeToken, resource.id);
        const declaration = await createTokenDigest(id, revision, diplomaticToken);
        player.revisions[resource.id] = revision;
        await authority.server.commit((domain) => {
          const home = (domain.home ??= { players: {} }) as HomeState;
          home.players[id] = player;
        }, [{ actorId: authority.actor('home').id, recipientActorId: resource.id, inbox: resource.inbox, object: { type: 'TokenDigest', ...declaration }, activityId: nextActivityId() }]);
        return declaration;
      });
    },
    deriveToken(id, resourceActorId) {
      return serializePlayer(id, async () => {
        requirePlayer(id);
        const player = await readPlayer(id);
        if (!player) throw new Error('native-token-not-issued');
        return deriveDiplomaticToken(player.nativeToken, resourceActorId);
      });
    },
    getResource<T>(id: URI, resourceActorId: URI, uri: URI): Promise<T> {
      return serializePlayer(id, async () => {
        requirePlayer(id);
        const player = await readPlayer(id);
        if (!player) throw new Error('native-token-not-issued');
        const token = await deriveDiplomaticToken(player.nativeToken, resourceActorId);
        return (await resources.get<T>(uri, { token })).value;
      });
    }
  };

  authority.server.addRoute(async ({ request, response, url }) => {
    if (!url.pathname.startsWith('/local/home/')) return false;
    const sendJson = (status: number, value: unknown): void => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (request.method === 'GET' && url.pathname === '/local/home/endpoints') {
      sendJson(200, { endpoints: [
        { method: 'POST', path: '/local/home/issue', authentication: 'admin' },
        { method: 'POST', path: '/local/home/rotate', authentication: 'admin' },
        { method: 'POST', path: '/local/home/revoke', authentication: 'admin' },
        { method: 'POST', path: '/local/home/digest-request', authentication: 'admin' },
        { method: 'GET', path: '/local/home/proxy?uri=&resourceActor=', authentication: 'native-token' }
      ] });
      return true;
    }
    if (url.pathname === '/local/home/proxy' && request.method === 'GET') {
      const header = request.headers.authorization ?? '';
      const playerId = header.startsWith('Bearer ') ? await service.authenticateNativeToken(header.slice(7)) : undefined;
      if (!playerId) { sendJson(401, { error: 'unauthorized' }); return true; }
      const uri = url.searchParams.get('uri');
      const resourceActorId = url.searchParams.get('resourceActor');
      if (!uri || !resourceActorId) { sendJson(400, { error: 'uri-and-resourceActor-required' }); return true; }
      try {
        const value = await service.getResource(playerId, resourceActorId, uri);
        sendJson(200, value);
      } catch (error) {
        if (!(error instanceof ResourceError)) throw error;
        sendJson(error.status, { error: error.code });
      }
      return true;
    }
    const admin = await authority.server.checkAdmin(request, authority.actor('home'));
    if (!admin) { sendJson(401, { error: 'administrator-authorization-failed' }); return true; }
    if (!['/local/home/issue', '/local/home/rotate', '/local/home/revoke', '/local/home/digest-request'].includes(url.pathname) || request.method !== 'POST') return false;
    const body = await readJson(request);
    const id = typeof body.actor === 'string' ? body.actor : playerActorId;
    try {
      requirePlayer(id);
      if (url.pathname === '/local/home/issue' || url.pathname === '/local/home/rotate') {
        const token = url.pathname.endsWith('/issue') ? await service.issueNativeToken(id) : await service.rotateNativeToken(id);
        sendJson(200, { actor: id, nativeToken: token });
      } else {
        const resource = await resolveResourceActor(String(body.resourceActor ?? ''), fetcher);
        if (url.pathname.endsWith('/revoke')) await service.revoke(id, resource);
        else await service.requestDigest(id, resource);
        sendJson(202, { status: 'queued' });
      }
    } catch (error) {
      sendJson(400, { error: error instanceof Error ? error.message : 'request-failed' });
    }
    return true;
  });

  return service;
}

async function authenticateNativeToken(token: string, authority: Authority, playerActorIds: ReadonlySet<URI>): Promise<URI | undefined> {
  const supplied = Buffer.from(token);
  return authority.server.store.read((state) => {
    const home = state.domain.home as HomeState | undefined;
    for (const playerActorId of playerActorIds) {
      const stored = home?.players[playerActorId]?.nativeToken;
      if (!stored) continue;
      const expected = Buffer.from(stored);
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return playerActorId;
    }
    return undefined;
  });
}

async function resolveResourceActor(id: string, fetcher: typeof fetch): Promise<UsedResource> {
  const response = await fetcher(id, { headers: { Accept: 'application/activity+json, application/ld+json' } });
  if (!response.ok) throw new Error('resource-actor-unavailable');
  const actor = await response.json() as ResourceActor;
  if (actor.id !== id || typeof actor.inbox !== 'string') throw new Error('invalid-resource-actor');
  return { id, inbox: actor.inbox };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('request-body-must-be-object');
  return parsed as Record<string, unknown>;
}
