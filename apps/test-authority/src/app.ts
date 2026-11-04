import type { URI } from '@fctp/protocol';
import { createInboundVerifier } from '@fctp/server-base';
import { createAuthority, type Authority } from './bootstrap.js';
import { installHome, type HomeService } from './home.js';
import { installRegistry, type Registry } from './registry.js';
import { installAuthoring, type AuthoringService } from './authoring.js';
import type { ImageObjectStorage } from './image-storage.js';
import { createS3ImageStorage, type S3ImageStorageOptions } from './s3-image-storage.js';

export interface CreateAuthorityAppOptions {
  origin: string;
  storeFile: string;
  keyFile?: string;
  adminSecret: string;
  administrator?: string;
  fetcher?: typeof fetch;
  adoption?: boolean;
  playerNames?: string[];
  administratorNames?: string[];
  vesselNames?: Record<string, string>;
  startingPorts?: URI[];
  accountPasswords?: Record<string, string>;
  homeAccountName?: string;
  registryAccountName?: string;
  serverDisplayName?: string;
  homeDisplayName?: string;
  registryDisplayName?: string;
  imageStorage?: ImageObjectStorage;
  objectStorage?: S3ImageStorageOptions;
}

export interface AuthorityAppIds {
  actor: Record<'registry' | 'home' | 'player', URI>;
  vessel?: URI;
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
  if (options.imageStorage && options.objectStorage) throw new TypeError('Provide either imageStorage or objectStorage, not both');
  const imageStorage = options.imageStorage ?? (options.objectStorage ? createS3ImageStorage(options.objectStorage) : undefined);
  const fetcher = options.fetcher ?? fetch;
  const origin = new URL(options.origin).origin;
  const playerNames = options.playerNames ?? ['player'];
  const vesselAssignments = resolveVesselAssignments(playerNames, options.vesselNames);
  const startingPorts = validateStartingPorts(options.startingPorts);
  const authority = await createAuthority({
    origin: options.origin,
    storeFile: options.storeFile,
    ...(options.keyFile ? { keyFile: options.keyFile } : {}),
    adminSecret: options.adminSecret,
    ...(options.administrator ? { administrator: options.administrator } : {}),
    ...(options.playerNames ? { playerNames: options.playerNames } : {}),
    ...(options.administratorNames ? { administratorNames: options.administratorNames } : {}),
    ...(options.homeAccountName === undefined ? {} : { homeAccountName: options.homeAccountName }),
    ...(options.registryAccountName === undefined ? {} : { registryAccountName: options.registryAccountName }),
    ...(options.serverDisplayName === undefined ? {} : { serverDisplayName: options.serverDisplayName }),
    ...(options.homeDisplayName === undefined ? {} : { homeDisplayName: options.homeDisplayName }),
    ...(options.registryDisplayName === undefined ? {} : { registryDisplayName: options.registryDisplayName }),
    nodeInfo: { name: 'fctp-authority' },
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
  const authoring = installAuthoring(authority, home, origin, imageStorage);
  const vessels = Object.fromEntries(vesselAssignments.map(([name, vesselName]) => [name, {
    id: `${origin}/objects/vessels/${vesselName}`,
    registry: authority.actor('registry').id,
    possessor: authority.players[name]!.id,
    capacity: 100
  }])) as Record<string, import('@fctp/protocol').Vessel>;
  const registry: Registry = installRegistry(authority, {
    fetcher,
    initialVessels: Object.values(vessels),
    startingPorts,
    authenticatePlayer: async (request) => {
      const authorization = request.headers.authorization ?? '';
      return authorization.startsWith('Bearer ') ? home.authenticateNativeToken(authorization.slice(7)) : undefined;
    }
  });
  home.setOwnedVessels((playerActorId) => registry.owned(playerActorId));
  home.setInitialVesselOffer((playerActorId) => registry.initialVesselOffer(playerActorId));
  const savedRegistry = await authority.server.store.read((store) => store.domain.registry as unknown);
  const primaryVessel = playerNames[0] ? vessels[playerNames[0]] : undefined;
  const ids: AuthorityAppIds = {
    actor: {
      registry: authority.actor('registry').id,
      home: authority.actor('home').id,
      player: authority.actor('player').id
    },
    ...(primaryVessel ? { vessel: primaryVessel.id } : {}),
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
      name: authority.serverDisplayName,
      actor: ids.actor,
      ids,
      players: ids.players,
      vessels: ids.vessels,
      endpoints: [
        { method: 'GET', path: '/local/info', authentication: 'none' },
        { method: 'GET', path: '/local/repository/authoring', authentication: 'native Player' },
        { method: 'POST', path: '/local/repository/authoring/assets', authentication: 'native Player' },
        { method: 'POST', path: '/local/repository/authoring/varieties', authentication: 'native Player' },
        { method: 'GET', path: '/local/home/endpoints', authentication: 'none' },
        { method: 'GET', path: '/local/home/accounts', authentication: 'native Home governor' },
        { method: 'GET', path: '/local/home/permissions', authentication: 'authenticated account' },
        { method: 'GET', path: '/local/home/administration', authentication: 'native Player' },
        { method: 'POST', path: '/local/home/administration', authentication: 'native Player' },
        { method: 'GET', path: '/local/registry/permissions', authentication: 'diplomatic Player' },
        { method: 'GET', path: '/local/registry/actions?vessel=<URI>', authentication: 'native Player; owned vessel' },
        { method: 'POST', path: '/local/home/issue', authentication: 'admin' },
        { method: 'POST', path: '/local/home/rotate', authentication: 'admin' },
        { method: 'POST', path: '/local/registry/vessels', authentication: 'native Player' },
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

function resolveVesselAssignments(playerNames: string[], configured: Record<string, string> | undefined): Array<[string, string]> {
  if (configured !== undefined && (typeof configured !== 'object' || configured === null || Array.isArray(configured))) throw new TypeError('Vessel names must be unique and URL safe');
  const assignments: Array<[string, string]> = [];
  for (const [index, name] of playerNames.entries()) {
    const vesselName = configured === undefined ? (index === 0 ? 'demo' : name) : configured[name];
    if (vesselName === undefined) continue;
    if (typeof vesselName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(vesselName)) throw new TypeError('Vessel names must be unique and URL safe');
    assignments.push([name, vesselName]);
  }
  if (new Set(assignments.map(([, vesselName]) => vesselName)).size !== assignments.length) throw new TypeError('Vessel names must be unique and URL safe');
  return assignments;
}

function validateStartingPorts(value: unknown): URI[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('Starting ports must be URIs');
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new TypeError('Starting ports must be URIs');
    let url: URL;
    try { url = new URL(entry); } catch { throw new TypeError('Starting ports must be URIs'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Starting ports must be URIs');
    return entry;
  });
}
