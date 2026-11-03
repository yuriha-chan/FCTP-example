import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { promisify } from 'node:util';
import { createTokenDigest, createTokenRevoke, deriveDiplomaticToken, encodeNativeToken, type HomeLoginResult } from '@fctp/auth';
import { parseHandle } from '@fctp/identity';
import { ResourceClient, ResourceError } from '@fctp/resources';
import type { FCTPActor, TokenDeclaration, URI, Vessel } from '@fctp/protocol';
import type { Authority } from './bootstrap.js';

interface ResourceActor extends FCTPActor, Record<string, unknown> { inbox: URI }
interface UsedResource { id: URI; inbox: URI }
interface AdministrationEntry { authorityId: URI; authorityHandle: string; roles: string[]; permissions: string[]; verifiedAt: string }
interface PlayerState { nativeToken?: string; resources: Record<string, UsedResource>; revisions: Record<string, number>; available?: boolean; administration?: Record<string, AdministrationEntry> }
interface PasswordCredential { salt: string; hash: string }
interface HomeState { players: Record<string, PlayerState>; credentials?: Record<string, PasswordCredential> }
const derivePasswordHash = promisify(scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface HomeOptions {
  playerActorId?: URI;
  fetcher?: typeof fetch;
  resourceClient?: ResourceClient;
  accountPasswords?: Record<string, string>;
}

export interface InitialVesselOffer {
  available: boolean;
  registry: URI;
  capacity: number;
  startingPorts: URI[];
}

export interface HomeService {
  readonly resources: ResourceClient;
  readonly ready: Promise<void>;
  authenticateNativeToken(token: string): Promise<URI | undefined>;
  issueNativeToken(playerActorId?: URI): Promise<string>;
  rotateNativeToken(playerActorId?: URI): Promise<string>;
  revoke(playerActorId: URI, resource: UsedResource): Promise<void>;
  requestDigest(playerActorId: URI, resource: UsedResource): Promise<TokenDeclaration>;
  deriveToken(playerActorId: URI, resourceActorId: URI): Promise<string>;
  getResource<T>(playerActorId: URI, resourceActorId: URI, uri: URI): Promise<T>;
  setOwnedVessels(provider: (playerActorId: URI) => Promise<Vessel[]>): void;
  setInitialVesselOffer(provider: (playerActorId: URI) => Promise<InitialVesselOffer>): void;
}

export function installHome(authority: Authority, options: HomeOptions = {}): HomeService {
  const playerActorId = options.playerActorId ?? authority.actor('player').id;
  const playerActorIds = new Set(options.playerActorId ? [options.playerActorId] : Object.values(authority.players).map((player) => player.id));
  const resources = options.resourceClient ?? new ResourceClient(options.fetcher);
  const fetcher = options.fetcher ?? fetch;
  const playerQueues = new Map<URI, Promise<void>>();
  let ownedVessels: (playerActorId: URI) => Promise<Vessel[]> = async () => [];
  let initialVesselOffer: (playerActorId: URI) => Promise<InitialVesselOffer> = async () => ({ available: false, registry: authority.actor('registry').id, capacity: 100, startingPorts: [] });
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
  const requireAvailable = (player: PlayerState | undefined): void => { if (player?.available === false) throw new Error('account-unavailable'); };
  const readCredential = async (id: URI): Promise<PasswordCredential | undefined> => authority.server.store.read((store) => {
    const credential = (store.domain.home as HomeState | undefined)?.credentials?.[id];
    return credential ? { ...credential } : undefined;
  });
  const provisioning = (async () => {
    const passwords = options.accountPasswords;
    if (!passwords) return;
    const entries = Object.entries(passwords).flatMap(([name, password]) => {
      const id = authority.players[name]?.id;
      return id ? [[id, password] as const] : [];
    });
    if (entries.length === 0) return;
    await authority.server.store.transaction(async (store) => {
      const home = (store.domain.home ??= { players: {} }) as HomeState;
      const credentials = (home.credentials ??= {});
      for (const [id, password] of entries) if (!credentials[id]) credentials[id] = await createPasswordCredential(password);
    });
  })();

  const issue = async (id: URI, rotate: boolean): Promise<string> => {
    requirePlayer(id);
    const current = await readPlayer(id);
    requireAvailable(current);
    if (!current?.nativeToken && rotate) throw new Error('native-token-not-issued');
    if (current?.nativeToken && !rotate) throw new Error('native-token-already-issued');
    const nativeToken = encodeNativeToken(randomBytes(32));
    const player: PlayerState = current ?? { resources: {}, revisions: {} };
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

  const login = async (handle: string, password: string): Promise<HomeLoginResult> => {
    const rejected = (reason: string): HomeLoginResult => ({ status: 'rejected', handle, reason });
    let parsed: ReturnType<typeof parseHandle>;
    try {
      parsed = parseHandle(handle);
    } catch {
      return rejected('invalid-handle');
    }
    if (parsed.kind !== 'account' || parsed.server !== new URL(authority.actor('home').id).host) return rejected('invalid-credentials');
    const id = authority.players[parsed.localName]?.id;
    if (!id || !playerActorIds.has(id)) return rejected('invalid-credentials');
    await provisioning;
    return serializePlayer(id, async () => {
      const credential = await readCredential(id);
      if (!credential || !await matchesPassword(password, credential)) return rejected('invalid-credentials');
      const current = await readPlayer(id);
      if (current?.available === false) return { status: 'unavailable', handle, reason: 'account-unavailable' };
      const nativeToken = current?.nativeToken ?? await issue(id, false);
      return { status: 'signed-in', handle, actorId: id, nativeToken };
    });
  };

  const withResource = async (id: URI, resource: UsedResource): Promise<PlayerState> => {
    const player = await readPlayer(id);
    if (!player) throw new Error('native-token-not-issued');
    player.resources[resource.id] = resource;
    return player;
  };

  const setAvailability = (id: URI, available: boolean): Promise<void> => serializePlayer(id, async () => {
    requirePlayer(id);
    const current = await readPlayer(id);
    const wasAvailable = current?.available !== false;
    const player: PlayerState = current ?? { resources: {}, revisions: {} };
    player.available = available;
    if (available) {
      await authority.server.store.transaction((store) => {
        const home = (store.domain.home ??= { players: {} }) as HomeState;
        home.players[id] = player;
      });
      return;
    }
    delete player.nativeToken;
    const outgoing = wasAvailable
      ? Object.values(player.resources).map((resource) => {
        const revision = (player.revisions[resource.id] ?? 0) + 1;
        player.revisions[resource.id] = revision;
        return { actorId: authority.actor('home').id, recipientActorId: resource.id, inbox: resource.inbox, object: { type: 'TokenRevoke', ...createTokenRevoke(id, revision) }, activityId: nextActivityId() };
      })
      : [];
    await authority.server.commit((domain) => {
      const home = (domain.home ??= { players: {} }) as HomeState;
      home.players[id] = player;
    }, outgoing);
  });

  const service: HomeService = {
    resources,
    ready: provisioning,
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
        requireAvailable(player);
        if (!player.nativeToken) throw new Error('native-token-not-issued');
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
        requireAvailable(player);
        if (!player?.nativeToken) throw new Error('native-token-not-issued');
        return deriveDiplomaticToken(player.nativeToken, resourceActorId);
      });
    },
    getResource<T>(id: URI, resourceActorId: URI, uri: URI): Promise<T> {
      return serializePlayer(id, async () => {
        requirePlayer(id);
        const player = await readPlayer(id);
        requireAvailable(player);
        if (!player?.nativeToken) throw new Error('native-token-not-issued');
        const token = await deriveDiplomaticToken(player.nativeToken, resourceActorId);
        return (await resources.get<T>(uri, { token })).value;
      });
    },
    setOwnedVessels(provider) {
      ownedVessels = provider;
    },
    setInitialVesselOffer(provider) {
      initialVesselOffer = provider;
    }
  };

  const administratorActorId = authority.administratorActorId;
  const isAdministrator = async (request: IncomingMessage): Promise<boolean> => {
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const token = header.slice(7);
    if (administratorActorId === undefined) {
      const callerId = await service.authenticateNativeToken(token);
      return callerId !== undefined && authority.governors.has(callerId);
    }
    if (await service.authenticateNativeToken(token) === administratorActorId) return true;
    const administrator = await readPlayer(administratorActorId);
    if (!administrator || administrator.available === false || !administrator.nativeToken) return false;
    const derived = await deriveDiplomaticToken(administrator.nativeToken, authority.actor('home').id);
    const supplied = Buffer.from(token);
    const expected = Buffer.from(derived);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };

  authority.server.addRoute(async ({ request, response, url }) => {
    if (!url.pathname.startsWith('/local/home/')) return false;
    const sendJson = (status: number, value: unknown): void => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    if (request.method === 'GET' && url.pathname === '/local/home/endpoints') {
      sendJson(200, { endpoints: [
        { method: 'GET', path: '/local/home/vessels', authentication: 'native Player' },
        { method: 'GET', path: '/local/home/permissions', authentication: 'authenticated account' },
        { method: 'GET', path: '/local/home/administration', authentication: 'native Player' },
        { method: 'POST', path: '/local/home/administration', authentication: 'native Player' },
        { method: 'GET', path: '/local/home/accounts', authentication: 'native Home governor' },
        { method: 'POST', path: '/local/home/accounts/availability', authentication: 'native Home governor' },
        { method: 'POST', path: '/local/home/issue', authentication: 'admin' },
        { method: 'POST', path: '/local/home/rotate', authentication: 'admin' },
        { method: 'POST', path: '/local/home/revoke', authentication: 'admin' },
        { method: 'POST', path: '/local/home/digest-request', authentication: 'admin' },
        { method: 'GET', path: '/local/home/proxy?uri=&resourceActor=', authentication: 'native-token' }
      ] });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/local/home/vessels') {
      const header = request.headers.authorization ?? '';
      const callerId = header.startsWith('Bearer ') ? await service.authenticateNativeToken(header.slice(7)) : undefined;
      if (!callerId) { sendJson(401, { error: 'unauthorized' }); return true; }
      try {
        sendJson(200, { actor: callerId, vessels: await ownedVessels(callerId), initialVessel: await initialVesselOffer(callerId) });
      } catch {
        sendJson(500, { error: 'vessel-listing-failed' });
      }
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/local/home/permissions') {
      const header = request.headers.authorization ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!token) { sendJson(401, { error: 'unauthorized' }); return true; }
      let callerId = await service.authenticateNativeToken(token);
      if (callerId === undefined) callerId = await authority.server.authenticateDiplomaticToken(authority.actor('home').id, token);
      if (callerId === undefined) { sendJson(401, { error: 'unauthorized' }); return true; }
      const handle = authority.actor('home').webfinger;
      if (typeof handle !== 'string' || !handle) { sendJson(500, { error: 'actor-handle-unavailable' }); return true; }
      const admin = await isAdministrator(request);
      sendJson(200, { [handle]: admin ? ['admin'] : [] });
      return true;
    }
    if (url.pathname === '/local/home/administration' && (request.method === 'GET' || request.method === 'POST')) {
      const header = request.headers.authorization ?? '';
      const callerId = header.startsWith('Bearer ') ? await service.authenticateNativeToken(header.slice(7)) : undefined;
      if (!callerId) { sendJson(401, { error: 'unauthorized' }); return true; }
      if (request.method === 'GET') {
        const player = await readPlayer(callerId);
        if (!player) { sendJson(401, { error: 'unauthorized' }); return true; }
        sendJson(200, { actor: callerId, entries: Object.values(player.administration ?? {}) });
        return true;
      }
      let body: Record<string, unknown>;
      try {
        body = await readJson(request);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
        sendJson(400, { error: 'invalid-request' });
        return true;
      }
      const authorityId = typeof body.authorityId === 'string' ? body.authorityId : '';
      let target: URL;
      try {
        target = new URL(authorityId);
      } catch {
        sendJson(400, { error: 'invalid-authority' });
        return true;
      }
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) {
        sendJson(400, { error: 'invalid-authority' });
        return true;
      }
      let actorDocument: unknown;
      try {
        const response = await fetcher(target, { headers: { Accept: 'application/ld+json, application/json' }, cache: 'no-store' });
        if (!response.ok) { sendJson(502, { error: 'target-actor-unavailable' }); return true; }
        actorDocument = await response.json();
      } catch {
        sendJson(502, { error: 'target-actor-unavailable' });
        return true;
      }
      if (!isRecord(actorDocument) || actorDocument.id !== authorityId || typeof actorDocument.role !== 'string' || !['home', 'registry', 'territory'].includes(actorDocument.role)) {
        sendJson(400, { error: 'invalid-authority' });
        return true;
      }
      const player = await readPlayer(callerId);
      if (!player?.nativeToken || player.available === false) { sendJson(401, { error: 'unauthorized' }); return true; }
      const role = actorDocument.role;
      const token = role === 'home' ? player.nativeToken : await deriveDiplomaticToken(player.nativeToken, authorityId as URI);
      let permissions: unknown;
      try {
        const response = await fetcher(`${target.origin}/local/${role}/permissions`, {
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          cache: 'no-store'
        });
        if (response.status === 401) { sendJson(403, { error: 'not-administrator' }); return true; }
        if (!response.ok) { sendJson(502, { error: 'target-permissions-unavailable' }); return true; }
        permissions = await response.json();
      } catch {
        sendJson(502, { error: 'target-permissions-unavailable' });
        return true;
      }
      if (!isRecord(permissions)) { sendJson(502, { error: 'invalid-target-permissions' }); return true; }
      const authorized = Object.entries(permissions).find(([, roles]) => Array.isArray(roles) && roles.includes('admin'));
      if (!authorized || typeof authorized[0] !== 'string') { sendJson(403, { error: 'not-administrator' }); return true; }
      if (typeof actorDocument.webfinger === 'string' && actorDocument.webfinger !== authorized[0]) {
        sendJson(502, { error: 'invalid-target-permissions' });
        return true;
      }
      const entry: AdministrationEntry = {
        authorityId: authorityId as URI,
        authorityHandle: authorized[0],
        roles: [role],
        permissions: (authorized[1] as unknown[]).filter((value): value is string => typeof value === 'string'),
        verifiedAt: new Date().toISOString()
      };
      await serializePlayer(callerId, async () => {
        const current = await readPlayer(callerId);
        if (!current) throw new Error('unknown-local-player');
        current.administration = { ...(current.administration ?? {}), [authorityId]: entry };
        await authority.server.store.transaction((store) => {
          const home = (store.domain.home ??= { players: {} }) as HomeState;
          home.players[callerId] = current;
        });
      });
      sendJson(200, { entry });
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/local/home/accounts') {
      if (!await isAdministrator(request)) { sendJson(401, { error: 'unauthorized' }); return true; }
      const host = new URL(authority.actor('home').id).host;
      const states = await authority.server.store.read((store) => (store.domain.home as HomeState | undefined)?.players ?? {});
      const accounts = Object.entries(authority.players).map(([name, player]) => ({ handle: `@${name}@${host}`, actorId: player.id, available: states[player.id]?.available !== false }));
      sendJson(200, { accounts });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/local/home/accounts/availability') {
      const header = request.headers.authorization ?? '';
      const nativeId = header.startsWith('Bearer ') ? await service.authenticateNativeToken(header.slice(7)) : undefined;
      if (!await isAdministrator(request)) { sendJson(401, { error: 'unauthorized' }); return true; }
      const callerId = nativeId ?? administratorActorId;
      let body: Record<string, unknown>;
      try {
        body = await readJson(request);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
        sendJson(400, { error: 'invalid-request' });
        return true;
      }
      if (typeof body.handle !== 'string' || typeof body.available !== 'boolean') { sendJson(400, { error: 'invalid-request' }); return true; }
      let targetId: URI | undefined;
      try {
        const parsed = parseHandle(body.handle);
        if (parsed.kind === 'account' && parsed.server === new URL(authority.actor('home').id).host) targetId = authority.players[parsed.localName]?.id;
      } catch {
        targetId = undefined;
      }
       if (!targetId || !playerActorIds.has(targetId) || (targetId === callerId && !body.available)) { sendJson(400, { error: 'invalid-target' }); return true; }
      await setAvailability(targetId, body.available);
      sendJson(200, { handle: body.handle, actorId: targetId, available: body.available });
      return true;
    }
    if (request.method === 'POST' && url.pathname === '/local/home/login') {
      let body: Record<string, unknown>;
      try {
        body = await readJson(request);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
        sendJson(400, { status: 'rejected', handle: '', reason: 'invalid-request' });
        return true;
      }
      const handle = typeof body.handle === 'string' ? body.handle : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!handle || !password) { sendJson(400, { status: 'rejected', handle, reason: 'invalid-request' }); return true; }
      const result = await login(handle, password);
      sendJson(result.status === 'signed-in' ? 200 : 401, result);
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

async function createPasswordCredential(password: string): Promise<PasswordCredential> {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await derivePasswordHash(password, salt, 64)).toString('hex') };
}

async function matchesPassword(password: string, credential: PasswordCredential): Promise<boolean> {
  const expected = Buffer.from(credential.hash, 'hex');
  const actual = await derivePasswordHash(password, credential.salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function authenticateNativeToken(token: string, authority: Authority, playerActorIds: ReadonlySet<URI>): Promise<URI | undefined> {
  const supplied = Buffer.from(token);
  return authority.server.store.read((state) => {
    const home = state.domain.home as HomeState | undefined;
    for (const playerActorId of playerActorIds) {
      const player = home?.players[playerActorId];
      if (!player || player.available === false) continue;
      const stored = player.nativeToken;
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
