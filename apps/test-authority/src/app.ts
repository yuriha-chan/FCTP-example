import type { URI } from '@fctp/protocol';
import { createInboundVerifier } from '@fctp/server-base';
import { createAuthority, type Authority } from './bootstrap.js';
import { installHome, type HomeService } from './home.js';
import { installRegistry, type Registry } from './registry.js';
import { installAuthoring, type AuthoringService } from './authoring.js';

export interface CreateAuthorityAppOptions {
  origin: string;
  storeFile: string;
  keyFile?: string;
  adminSecret: string;
  fetcher?: typeof fetch;
  adoption?: boolean;
  playerNames?: string[];
  administratorNames?: string[];
  vesselNames?: Record<string, string>;
  accountPasswords?: Record<string, string>;
}

export interface AuthorityAppIds {
  actor: Record<'registry' | 'home' | 'player', URI>;
  vessel: URI;
  players: Record<string, URI>;
  vessels: Record<string, URI>;
}

export interface AuthorityApp {
  authority: Authority;
  home: HomeService;
  registry: Registry;
  authoring: AuthoringService;
  ids: AuthorityAppIds;
}

export async function createAuthorityApp(options: CreateAuthorityAppOptions): Promise<AuthorityApp> {
  const fetcher = options.fetcher ?? fetch;
  const authority = await createAuthority({
    origin: options.origin,
    storeFile: options.storeFile,
    ...(options.keyFile ? { keyFile: options.keyFile } : {}),
    adminSecret: options.adminSecret,
    ...(options.playerNames ? { playerNames: options.playerNames } : {}),
    ...(options.administratorNames ? { administratorNames: options.administratorNames } : {}),
    fetcher,
    verifyInbound: createInboundVerifier({
      fetcher,
       resolveExpectedIssuer: async (_localActorId, senderActorId, activity) => registry.resolveExpectedIssuer(senderActorId, activity.object)
    })
  });
  const home = installHome(authority, {
    fetcher,
    ...(options.accountPasswords ? { accountPasswords: options.accountPasswords } : {})
  });
  await home.ready;
  const authoring = installAuthoring(authority, home, options.origin);
  const playerNames = options.playerNames ?? ['player'];
  const origin = options.origin.replace(/\/$/, '');
  const vesselNames = playerNames.map((name, index) => options.vesselNames?.[name] ?? (index === 0 ? 'demo' : name));
  if (new Set(vesselNames).size !== vesselNames.length || vesselNames.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))) throw new TypeError('Vessel names must be unique and URL safe');
  const vessels = Object.fromEntries(playerNames.map((name, index) => [name, {
    id: `${origin}/objects/vessels/${vesselNames[index]}`,
    registry: authority.actor('registry').id,
    possessor: authority.players[name]!.id,
    capacity: 100
  }])) as Record<string, import('@fctp/protocol').Vessel>;
  const registry: Registry = installRegistry(authority, {
    fetcher,
    initialVessels: Object.values(vessels),
    authenticatePlayer: async (request) => {
      const authorization = request.headers.authorization ?? '';
      return authorization.startsWith('Bearer ') ? home.authenticateNativeToken(authorization.slice(7)) : undefined;
    }
  });
  const savedRegistry = await authority.server.store.read((store) => store.domain.registry as unknown);
  const ids: AuthorityAppIds = {
    actor: {
      registry: authority.actor('registry').id,
      home: authority.actor('home').id,
      player: authority.actor('player').id
    },
    vessel: vessels[playerNames[0]!]!.id,
    players: Object.fromEntries(Object.entries(authority.players).map(([name, player]) => [name, player.id])),
    vessels: Object.fromEntries(Object.entries(vessels).map(([name, vessel]) => [name, vessel.id]))
  };
  for (const [name, actor] of Object.entries(authority.players)) {
    await authority.registerActor(name, { ...actor, creations: `${origin}/objects/players/${encodeURIComponent(name)}/creations` });
  }
  for (const vessel of Object.values(vessels)) {
    const state = await registry.state(vessel.id);
    if (!state.vessel || state.vessel.id !== vessel.id) throw new Error('Registry vessel identity does not match the authority origin');
    await authority.server.store.transaction((store) => { store.objects[vessel.id] = structuredClone(state.vessel); });
    const savedVessels = savedRegistry && typeof savedRegistry === 'object' && 'vessels' in savedRegistry
      ? (savedRegistry as { vessels?: Record<string, unknown> }).vessels
      : undefined;
    const wasSaved = savedVessels ? Object.hasOwn(savedVessels, vessel.id)
      : !!savedRegistry && typeof savedRegistry === 'object' && 'vessel' in savedRegistry && (savedRegistry as { vessel?: { id?: string } }).vessel?.id === vessel.id;
    if (options.adoption !== undefined) await registry.switchAdoption(options.adoption, vessel.id);
    else if (!wasSaved) await registry.switchAdoption(true, vessel.id);
  }
  authority.server.addRoute(async ({ request, response, url }) => {
    if (request.method !== 'GET' || url.pathname !== '/local/info') return false;
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({
      kind: 'authority',
      actor: ids.actor,
      ids,
      players: ids.players,
      vessels: ids.vessels,
      endpoints: [
        { method: 'GET', path: '/local/info', authentication: 'none' },
        { method: 'GET', path: '/local/authoring', authentication: 'native Player' },
        { method: 'POST', path: '/local/authoring/assets', authentication: 'native Player' },
        { method: 'POST', path: '/local/authoring/varieties', authentication: 'native Player' },
        { method: 'GET', path: '/local/home/endpoints', authentication: 'none' },
        { method: 'GET', path: '/local/home/accounts', authentication: 'native Home governor' },
        { method: 'GET', path: '/local/registry/actions?vessel=<URI>', authentication: 'native Player; owned vessel' },
        { method: 'POST', path: '/local/home/issue', authentication: 'admin' },
        { method: 'POST', path: '/local/home/rotate', authentication: 'admin' },
        { method: 'POST', path: '/local/registry/entry', authentication: 'admin' },
        { method: 'POST', path: '/local/registry/departure', authentication: 'admin' },
        { method: 'POST', path: '/local/registry/adoption', authentication: 'admin' },
        { method: 'GET', path: '/local/registry/fleet', authentication: 'admin' }
      ]
    }));
    return true;
  });
  return { authority, home, registry, authoring, ids };
}
