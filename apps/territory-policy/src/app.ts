import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { URI, Variety } from '@fctp/protocol';
import { createHost, type Host } from '@fctp/server-base';
import { ActionDiscoveryError, discoverPolicyActions } from './actions.js';
import { territoryAProduction, type Policy } from './domain.js';
import { expectedIssuer, installPolicyTerritory, type PolicyTerritoryLedger } from './territory.js';

const asciiFormat = 'https://fctp.example/formats/ascii';
const bodyLimit = 16 * 1024;

export interface CreatePolicyAppOptions {
  origin: string;
  storeFile: string;
  keyFile?: string;
  authorityOrigin: string;
  additionalAuthorityOrigins?: string[];
  playerNames?: string[];
  peerOrigin: string;
  adminSecret: string;
  fetcher?: typeof fetch;
}

export interface PolicyAppIds {
  actor: URI;
  ports: URI[];
  routes: URI[];
  areas: URI[];
  map: URI;
  varieties: { ore: URI; metal: URI };
  assets: URI[];
}

export async function createPolicyApp(options: CreatePolicyAppOptions) {
  const origin = new URL(options.origin).origin;
  const authorityOrigins = canonicalAuthorityOrigins(options.authorityOrigin, options.additionalAuthorityOrigins);
  const playerNames = canonicalPlayerNames(options.playerNames);
  const peerOrigin = new URL(options.peerOrigin).origin;
  const actorId = `${origin}/actors/territory`;
  const ids: PolicyAppIds = {
    actor: actorId,
    ports: [`${origin}/objects/ports/east`, `${origin}/objects/ports/west`],
    routes: [`${origin}/objects/routes/approach`, `${origin}/objects/routes/coastal`],
    areas: [`${origin}/objects/areas/island`],
    map: `${origin}/objects/maps/territory`,
    varieties: { ore: `${origin}/objects/varieties/ore`, metal: `${origin}/objects/varieties/metal` },
    assets: [`${origin}/objects/assets/ore`, `${origin}/objects/assets/metal`]
  };
  const enrollments = authorityOrigins.flatMap((authority) => playerNames.map((name) => ({ home: `${authority}/actors/home` as URI, player: `${authority}/actors/${name}` as URI })));
  const homeByPlayer = new Map(enrollments.map(({ home, player }) => [player, home]));
  const playerIds = [...homeByPlayer.keys()];
  const playerId = `${authorityOrigins[0]!}/actors/player` as URI;
  const registryIds = authorityOrigins.map((authority) => `${authority}/actors/registry` as URI);
  const routes = ids.routes.map((id, index) => ({
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
    id, type: 'Route', name: index === 0 ? 'Island Approach' : 'Coastal Passage',
    from: index === 0 ? `${origin}/objects/boundaries/west` : ids.ports[0],
    to: index === 0 ? ids.ports[0] : ids.ports[1]
  }));
  const portDocuments = ids.ports.map((id, index) => ({
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
    id, type: 'Port', name: index === 0 ? 'East Haven' : 'West Haven', territory: actorId,
    area: ids.areas[0], resources: { area: ids.areas[0], listings: `${id}/listings` }
  }));
  const ore: Variety = {
    ...structuredClone(territoryAProduction.ore), id: ids.varieties.ore, holder: actorId, asset: ids.assets[0]!,
    production: [{ type: 'mine', duration: 0, yield: [{ probability: 1, count: 1, data: {} }] }]
  };
  const metal: Variety = {
    ...structuredClone(territoryAProduction.metal), id: ids.varieties.metal, holder: actorId, asset: ids.assets[1]!,
    production: [{ type: 'manufacture', ingredients: [{ variety: ore.id, count: 2, data: {} }], duration: 0, yield: [{ probability: 1, count: 1, data: {} }] }]
  };
  const policy: Policy = {
    miningPermitted: true, miningQuota: 20, oreReserve: 100, manufacturePermits: ['ore-to-metal'],
    recipes: [{ id: 'ore-to-metal', ingredients: { [ore.id]: 2 }, output: metal.id, outputCount: 1 }],
    warehouseLimits: {}, portLimits: {}, decisions: {}
  };
  const digestIssuer = async (localActor: URI, sender: URI, activity: { object: unknown; to?: unknown }): Promise<URI | undefined> => {
    const object = activity.object;
    if (object && typeof object === 'object' && ('tokenDigest' in object || 'tokenRevoke' in object)) {
      const declaredPlayer = typeof (object as Record<string, unknown>).actor === 'string' ? (object as Record<string, unknown>).actor as string : undefined;
      if (!declaredPlayer || !Array.isArray(activity.to) || !activity.to.includes(actorId)) return undefined;
      const enrolledHome = homeByPlayer.get(declaredPlayer);
      return enrolledHome && enrolledHome === sender ? enrolledHome : undefined;
    }
    if (localActor !== actorId || !territory) return undefined;
    const ledger = await territory.ledger;
    return expectedIssuer(object, ledger.visits);
  };
  const host = await createHost({
    origin, storeFile: options.storeFile, ...(options.keyFile ? { keyFile: options.keyFile } : {}),
    actors: [{ name: 'territory', role: 'territory' }],
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    resolveExpectedIssuer: digestIssuer,
    authorizeAdmin: (request) => matchesSecret(request, options.adminSecret),
    authorizeResource: async (_request, _actor, resourceId, player) => {
      const ledger = await territory.ledger;
      return { allowed: ledger.admission.publicPorts.some((port) => resourceId === port || resourceId.startsWith(`${port}/`)), ...(player && playerIds.includes(player) ? { player } : {}) };
    }
  });
  const mutableActor = host.actor('territory');
  Object.assign(mutableActor, {
    capabilities: ['Core', 'Creative Assets', 'Territory Topology', 'Territory Resources', 'Vessel Federation', 'Remote Client Access'],
    resources: { ports: `${origin}/objects/policy/ports`, routes: `${origin}/objects/policy/routes`, areas: ids.areas, map: ids.map },
    varieties: [ore.id, metal.id], assets: ids.assets
  });
  await host.server.registerActor({ actor: mutableActor });
  for (const { home, player } of enrollments) await host.server.enrollPlayer(player, home);
  const territory = installPolicyTerritory(host, {
    name: 'territory', portIds: ids.ports, routeIds: ids.routes,
    commodities: [{ variety: ore, mass: 2 }, { variety: metal, mass: 1 }], initialPolicy: policy,
    registryAcceptance: registryIds, territoryAcceptance: [`${peerOrigin}/actors/territory`], publicPorts: [ids.ports[0]!],
    ...(options.fetcher ? { fetcher: options.fetcher } : {})
  });

  await publishResources(host, ids, mutableActor, portDocuments, routes, ore, metal, actorId, playerId, (await territory.ledger).admission.publicPorts);
  host.server.addRoute(({ request, response, url }) => {
    if (request.method !== 'GET' || url.pathname !== '/objects/maps/territory/ascii') return false;
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate' });
    response.end('  ^  \n /|\\ \n  |  \n~ Haven ~');
    return true;
  });
  host.server.addRoute(({ request, response, url }) => {
    if (request.method !== 'GET' || !url.pathname.startsWith('/objects/assets/') || !url.pathname.endsWith('/text')) return false;
    const slug = url.pathname.split('/').at(-2);
    if (slug !== 'ore' && slug !== 'metal') return false;
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=0, must-revalidate' });
    response.end(`${slug === 'ore' ? ore.name : metal.name}: ${slug === 'ore' ? 'raw island mineral' : 'refined trade metal'}`);
    return true;
  });
  host.server.addRoute(async ({ request, response, url, base }) => {
    if (!url.pathname.startsWith('/local/')) return false;
    const send = (status: number, value: unknown): void => { response.writeHead(status, { 'Content-Type': 'application/json', ...(url.pathname === '/local/actions' ? { 'Cache-Control': 'no-store' } : {}) }); response.end(JSON.stringify(value)); };
    if (url.pathname === '/local/info' && request.method === 'GET') {
      send(200, { kind: 'policy', actor: actorId, ids, endpoints: ['/local/info', '/local/state', '/local/actions', '/local/mine', '/local/manufacture', '/local/transfer', '/local/load', '/local/unload', '/local/admin/policy', '/local/admin/admission'], production: { mining: { input: null, output: ore.id }, recipes: [{ id: 'ore-to-metal', input: ore.id, output: metal.id }] } });
      return true;
    }
    if (url.pathname === '/local/actions' && request.method === 'GET') {
      try {
        const player = await authenticatedPlayer(request, host, actorId, playerIds);
        if (!player) { send(401, { error: 'unauthorized' }); return true; }
        const vessel = url.searchParams.get('vessel');
        if (!vessel || !URL.canParse(vessel)) { send(400, { error: 'invalid-vessel' }); return true; }
        send(200, await discoverPolicyActions({ actor: actorId, player, vessel, ids, origin, fetcher: options.fetcher ?? fetch, territory }));
      } catch (error) {
        if (!(error instanceof ActionDiscoveryError)) throw error;
        send(error.status, { error: error.message });
      }
      return true;
    }
    if (url.pathname === '/local/state' && request.method === 'GET') {
      const player = await authenticatedPlayer(request, host, actorId, playerIds);
      if (!player && !await base.checkAdmin(request, mutableActor)) { send(401, { error: 'unauthorized' }); return true; }
      const ledger = await territory.ledger;
      send(200, { state: ledger.state, admission: ledger.admission, decisions: ledger.decisions });
      return true;
    }
    const adminRoute = url.pathname === '/local/admin/policy' || url.pathname === '/local/admin/admission';
    if (adminRoute && request.method === 'POST') {
      if (!hasBearer(request)) { send(401, { error: 'unauthorized' }); return true; }
      if (!await base.checkAdmin(request, mutableActor)) { send(401, { error: 'unauthorized' }); return true; }
      const input = await readJson(request);
      if (url.pathname.endsWith('/policy')) {
        if (!validPolicy(input, ids)) { send(400, { error: 'invalid-input' }); return true; }
        const result = await territory.updatePolicy(input as unknown as Policy, 'administrator');
        send(result.success ? 200 : 400, result); return true;
      }
      if (!validAdmission(input, ids)) { send(400, { error: 'invalid-input' }); return true; }
      await territory.updateAdmissionPolicy(input as Partial<PolicyTerritoryLedger['admission']>);
      await publishResources(host, ids, mutableActor, portDocuments, routes, ore, metal, actorId, playerId, (await territory.ledger).admission.publicPorts);
      send(200, { admission: (await territory.ledger).admission }); return true;
    }
    const operation = ['/local/mine', '/local/manufacture', '/local/transfer', '/local/load', '/local/unload'].includes(url.pathname);
    if (operation && request.method === 'POST') {
      const player = await authenticatedPlayer(request, host, actorId, playerIds);
      if (!player) { send(401, { error: 'unauthorized' }); return true; }
      const input = await readJson(request);
      if (!Number.isSafeInteger(input.count) || (input.count as number) < 1) { send(400, { error: 'invalid-input' }); return true; }
      if (url.pathname === '/local/mine') {
        if (input.variety !== undefined && input.variety !== ore.id) { send(400, { error: 'invalid-input' }); return true; }
        const result = await territory.mine(ore.id, input.count as number, player); send(result.success ? 200 : 409, result); return true;
      }
      if (url.pathname === '/local/manufacture') {
        if (input.recipe !== 'ore-to-metal') { send(400, { error: 'invalid-input' }); return true; }
        const result = await territory.manufacture(input.recipe, input.count as number, player); send(result.success ? 200 : 409, result); return true;
      }
      if (url.pathname === '/local/transfer') {
        if (!isVariety(input.variety, ids) || !['to-port', 'to-warehouse'].includes(String(input.direction))) { send(400, { error: 'invalid-input' }); return true; }
        const result = input.direction === 'to-port' ? await territory.transferWarehouseToPort(input.variety, input.count as number, player) : await territory.transferPortToWarehouse(input.variety, input.count as number, player);
        send(result.success ? 200 : 409, result); return true;
      }
      if (typeof input.vessel !== 'string' || !isVariety(input.variety, ids) || !possessesActiveVisit((await territory.ledger), input.vessel, player)) { send(403, { error: 'forbidden' }); return true; }
      const result = url.pathname.endsWith('/load') ? await territory.load(input.vessel, input.variety, input.count as number, player) : await territory.unload(input.vessel, input.variety, input.count as number, player);
      send(result.success ? 200 : 409, result); return true;
    }
    send(404, { error: 'not-found' });
    return true;
  });
  return { host, territory, ids };
}

async function publishResources(host: Host, ids: PolicyAppIds, actor: Record<string, unknown>, ports: Record<string, unknown>[], routes: Record<string, unknown>[], ore: Variety, metal: Variety, actorId: URI, playerId: URI, publicPorts: URI[]): Promise<void> {
  const context = ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'];
  const boundaries = [`${new URL(actorId).origin}/objects/boundaries/west`, `${new URL(actorId).origin}/objects/boundaries/east`];
  const varieties = [ore, metal];
  const publicPortsId = `${new URL(actorId).origin}/objects/policy/public-ports`;
  host.server.registerResource(publicPortsId, { '@context': context, id: publicPortsId, type: 'PublicPorts', territory: actorId, publicPorts });
  const area = { '@context': context, id: ids.areas[0]!, type: 'Area', name: 'Haven Island', territory: actorId, boundaries: boundaries.map((id) => ({ id })) };
  host.server.registerResource(ids.areas[0]!, area);
  for (const [index, id] of boundaries.entries()) host.server.registerResource(id, { '@context': context, id, type: 'Boundary', name: `Coast ${index + 1}`, territory: actorId, coordinates: [index * 10, 0] });
  for (const route of routes) host.server.registerResource(String(route.id), route);
  ports.forEach((port, index) => {
    const id = String(port.id);
    const listingId = `${id}/listings/item-${index + 1}`;
    host.server.registerResource(listingId, { '@context': context, id: listingId, type: 'Listing', port: id, seller: actorId, offered: { entries: [{ variety: varieties[index]!.id, count: 1, data: {} }] }, description: 'Local exchange listing' }, { public: publicPorts.includes(id), actorId });
    host.server.registerResource(`${id}/listings`, { '@context': context, id: `${id}/listings`, type: 'Collection', totalItems: 1, items: [{ id: listingId }] }, { public: publicPorts.includes(id), actorId });
    host.server.registerResource(id, { ...port, listings: `${id}/listings` }, { public: publicPorts.includes(id), actorId });
  });
  host.server.registerResource(`${new URL(actorId).origin}/objects/policy/ports`, { '@context': context, id: `${new URL(actorId).origin}/objects/policy/ports`, type: 'Collection', totalItems: ports.length, items: ports.map(({ id }) => ({ id })) });
  host.server.registerResource(`${new URL(actorId).origin}/objects/policy/routes`, { '@context': context, id: `${new URL(actorId).origin}/objects/policy/routes`, type: 'Collection', totalItems: routes.length, items: routes.map(({ id }) => ({ id })) });
  const ascii = `${new URL(actorId).origin}/objects/maps/territory/ascii`;
  host.server.registerResource(ids.map, { '@context': context, id: ids.map, type: 'MapDescriptor', representations: [{ format: asciiFormat, resources: [{ role: 'map', url: ascii, mediaType: 'text/plain; charset=utf-8' }] }] });
  for (const variety of varieties) {
    host.server.registerResource(String(variety.id), { '@context': context, ...variety });
    const slug = String(variety.id).split('/').at(-1)!;
    const assetId = `${new URL(actorId).origin}/objects/assets/${slug}`;
    host.server.registerResource(assetId, { '@context': context, id: assetId, type: 'Asset', name: String(variety.name), creator: [playerId], holder: actorId, media: [{ url: `${assetId}/text`, mediaType: 'text/plain; charset=utf-8' }] });
  }
  actor.resources = { ports: `${new URL(actorId).origin}/objects/policy/ports`, routes: `${new URL(actorId).origin}/objects/policy/routes`, areas: [area], map: ids.map };
  await host.server.registerActor({ actor: actor as never });
}

function canonicalAuthorityOrigins(primary: string, additional: string[] | undefined): string[] {
  if (additional !== undefined && !Array.isArray(additional)) throw new TypeError('Invalid authority origins');
  return [...new Set([primary, ...(additional ?? [])].map((value) => {
    if (typeof value !== 'string') throw new TypeError('Invalid authority origin');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new TypeError('Invalid authority origin');
    return url.origin;
  }))];
}
function canonicalPlayerNames(names: string[] | undefined): string[] {
  if (names === undefined) return ['player'];
  if (!Array.isArray(names) || names.length === 0 || !names.includes('player') || names.some((name) => typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name) || name.includes('.')) || new Set(names).size !== names.length) throw new TypeError('Invalid player names');
  return [...names];
}
function isVariety(value: unknown, ids: PolicyAppIds): value is URI { return value === ids.varieties.ore || value === ids.varieties.metal; }
function possessesActiveVisit(ledger: PolicyTerritoryLedger, vessel: string, player: string): boolean {
  const visit = ledger.visits[vessel];
  return !!visit && !visit.departed && visit.possessor === player;
}

function hasBearer(request: IncomingMessage): boolean { return (request.headers.authorization ?? '').startsWith('Bearer '); }
async function matchesSecret(request: IncomingMessage, expected: string): Promise<boolean> {
  const provided = (request.headers.authorization ?? '').startsWith('Bearer ') ? request.headers.authorization!.slice(7) : '';
  return timingSafeEqual(createHash('sha256').update(provided).digest(), createHash('sha256').update(expected).digest());
}
async function authenticatedPlayer(request: IncomingMessage, host: Host, actorId: URI, playerIds: URI[]): Promise<URI | undefined> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  const player = await host.server.authenticateDiplomaticToken(actorId, header.slice(7));
  return player && playerIds.includes(player) ? player : undefined;
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const data = Buffer.from(chunk); size += data.length; if (size > bodyLimit) throw new RangeError('request-body-too-large'); chunks.push(data); }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('invalid-input');
  return parsed as Record<string, unknown>;
}
function validAdmission(value: Record<string, unknown>, ids: PolicyAppIds): boolean {
  return Object.entries(value).every(([key, item]) => {
    if (key === 'mismatchPolicy') return ['declared', 'evidence', 'reject'].includes(String(item));
    return ['registryAcceptance', 'territoryAcceptance', 'publicPorts'].includes(key) && Array.isArray(item) &&
      item.every((entry) => typeof entry === 'string' && URL.canParse(entry) && (key !== 'publicPorts' || ids.ports.includes(entry)));
  });
}
function validPolicy(value: Record<string, unknown>, ids: PolicyAppIds): boolean {
  const count = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0;
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  const variety = (item: string): boolean => item === ids.varieties.ore || item === ids.varieties.metal;
  const absoluteUri = (item: unknown): item is string => {
    if (typeof item !== 'string' || !URL.canParse(item)) return false;
    const uri = new URL(item);
    return (uri.protocol === 'http:' || uri.protocol === 'https:') && !uri.username && !uri.password;
  };
  const varietyPortPolicy = (item: unknown): boolean => item === undefined ||
    (record(item) && Object.entries(item).every(([key, decision]) => absoluteUri(key) && (decision === 'allow' || decision === 'deny')));
  const limits = (item: unknown): boolean => record(item) && Object.entries(item).every(([key, amount]) => variety(key) && count(amount));
  if (!Array.isArray(value.recipes)) return false;
  const recipes = value.recipes;
  const recipeIds = new Set<string>();
  if (!recipes.every((entry) => {
    if (!record(entry) || typeof entry.id !== 'string' || !entry.id || recipeIds.has(entry.id) || typeof entry.output !== 'string' || !variety(entry.output) || !count(entry.outputCount) || entry.outputCount === 0 || !record(entry.ingredients)) return false;
    recipeIds.add(entry.id);
    return Object.entries(entry.ingredients).every(([key, amount]) => variety(key) && count(amount) && amount > 0);
  })) return false;
  return typeof value.miningPermitted === 'boolean' && count(value.miningQuota) && count(value.oreReserve) &&
    Array.isArray(value.manufacturePermits) && value.manufacturePermits.every((entry) => typeof entry === 'string' && recipeIds.has(entry)) &&
    limits(value.warehouseLimits) && limits(value.portLimits) && record(value.decisions) &&
    Object.values(value.decisions).every((decision) => decision === 'allow' || decision === 'deny') &&
    varietyPortPolicy(value.varietyPortPolicy);
}
