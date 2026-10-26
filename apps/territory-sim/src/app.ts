import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Area, Asset, CargoManifest, Listing, Production, Route, URI, Variety } from '@fctp/protocol';
import { createHost, type FctpServerOptions } from '@fctp/server-base';
import { installSimulationTerritory, simulationExpectedIssuer, type SimulationTerritory } from './territory.js';

export interface CreateSimulationAppOptions {
  origin: string;
  storeFile: string;
  keyFile?: string;
  authorityOrigin: string;
  peerOrigin: string;
  adminSecret: string;
  fetcher?: typeof fetch;
}

export interface SimulationAppIds {
  actor: URI;
  ports: URI[];
  routes: URI[];
  areas: URI[];
  map: URI;
  varieties: { ore: URI; metal: URI; refined: URI; importedMetal: URI };
  assets: URI[];
}

export interface SimulationApp {
  host: Awaited<ReturnType<typeof createHost>>;
  territory: SimulationTerritory;
  ids: SimulationAppIds;
}

const json = (response: ServerResponse, status: number, value: unknown): void => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
};

function safeSecret(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization ?? '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const left = createHash('sha256').update(supplied).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > 16_384) throw new RangeError('request-body-too-large');
    chunks.push(part);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('request-body-must-be-an-object');
  return parsed as Record<string, unknown>;
}

export async function createSimulationApp(options: CreateSimulationAppOptions): Promise<SimulationApp> {
  const origin = new URL(options.origin).origin;
  const authority = new URL(options.authorityOrigin).origin;
  const peer = new URL(options.peerOrigin).origin;
  const actorId = `${origin}/actors/territory` as URI;
  const homeId = `${authority}/actors/home` as URI;
  const playerId = `${authority}/actors/player` as URI;
  const registryId = `${authority}/actors/registry` as URI;
  const areas: Area[] = [
    { id: `${origin}/objects/areas/harbor`, name: 'Harbor District', territory: actorId },
    { id: `${origin}/objects/areas/highlands`, name: 'Ore Highlands', territory: actorId },
  ];
  const mainPort = `${origin}/objects/ports/main` as URI;
  const portArea = areas[0]!.id;
  const ports = `${origin}/objects/collections/ports` as URI;
  const routes = `${origin}/objects/collections/routes` as URI;
  const listings = `${origin}/objects/collections/listings/main` as URI;
  const portIds = [mainPort];
  const routeIds = [`${origin}/objects/routes/approach` as URI];
  const routeId = `${origin}/objects/routes/approach` as URI;
  const map = `${origin}/objects/maps/territory` as URI;
  const ids: SimulationAppIds = {
    actor: actorId, ports: portIds, routes: routeIds, areas: areas.map((area) => area.id), map,
    varieties: {
      ore: `${origin}/objects/varieties/ore`, metal: `${origin}/objects/varieties/metal`,
      refined: `${origin}/objects/varieties/refined`, importedMetal: `${peer}/objects/varieties/metal`,
    },
     assets: [`${origin}/objects/assets/ore`, `${origin}/objects/assets/metal`, `${origin}/objects/assets/refined`],
  };
  const resourceAuth: NonNullable<FctpServerOptions['authorizeResource']> = async (_request, _actor, _resourceId, player) => ({
    allowed: player === playerId,
    ...(player ? { player } : {}),
  });
  const hostRef: { current?: Awaited<ReturnType<typeof createHost>> } = {};
  const host = await createHost({
    origin, storeFile: options.storeFile, ...(options.keyFile ? { keyFile: options.keyFile } : {}),
    actors: [{ name: 'territory', role: 'territory' }],
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    authorizeAdmin: async (request) => safeSecret(request, options.adminSecret),
    authorizeResource: resourceAuth,
    resolveExpectedIssuer: async (_local, sender, activity) => {
      if (activity.object && typeof activity.object === 'object' && ('tokenDigest' in activity.object || 'tokenRevoke' in activity.object)) {
        const declaration = activity.object as Record<string, unknown>;
        const declaredPlayer = typeof declaration.actor === 'string' ? declaration.actor : undefined;
        const recipient = Array.isArray(activity.to) && activity.to.includes(actorId);
        if (!declaredPlayer || !recipient) return undefined;
        return await hostRef.current!.server.store.read((state) => state.enrollments[declaredPlayer] === sender && sender === homeId ? homeId : undefined);
      }
      const object = activity.object as Record<string, unknown>;
      let knownRegistry: URI | undefined;
      if (object?.type === 'DepartureRequest' && typeof object.vessel === 'string') {
         knownRegistry = await hostRef.current!.server.store.read((state) => {
          const territoryState = state.domain.simulationTerritory as { visits?: Record<string, { vessel: URI; registry: URI; exited: boolean }> } | undefined;
          return Object.values(territoryState?.visits ?? {}).find((visit) => visit.vessel === object.vessel && !visit.exited)?.registry;
        });
      }
      return simulationExpectedIssuer(sender, object, knownRegistry);
    },
    configure: (_server, actors) => {
      Object.assign(actors.territory!, { name: 'Simulation Territory', resources: { ports, routes, areas, map }, varieties: [ids.varieties.ore, ids.varieties.metal, ids.varieties.refined], assets: ids.assets, capabilities: ['Territory Topology', 'Territory Resources', 'Vessel Federation', 'Remote Client Access'] });
    },
  });
  hostRef.current = host;
  await host.server.enrollPlayer(playerId, homeId);
  const territory = installSimulationTerritory(host, {
    port: mainPort, route: routeId,
    config: {
      commodities: { ore: ids.varieties.ore, nativeMetal: ids.varieties.metal, importedMetal: ids.varieties.importedMetal, refinedProduct: ids.varieties.refined },
      commodityMasses: { [ids.varieties.ore]: 1, [ids.varieties.metal]: 2, [ids.varieties.importedMetal]: 2, [ids.varieties.refined]: 3 },
      depositAmount: 100, miningCapacity: 10, miningEnabled: true, manufacturingSlots: 2, manufacturingTime: 2, portCapacity: 200, berthCapacity: 1,
    },
    acceptedRegistries: [registryId], acceptedTerritories: [`${peer}/actors/territory`],
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });

  const variety = (id: URI, name: string, mass: number, asset?: URI, production?: Production[]): Variety => ({ id, name, holder: actorId, mass, version: '1', ...(asset ? { asset } : {}), ...(production ? { production } : {}) });
  const asset = (id: URI, name: string): Asset => ({ id, name, creator: [playerId], holder: actorId, media: [{ url: `${origin}/objects/text/${name}`, mediaType: 'text/plain' }] });
  const productionOre: Production = { type: 'mine', duration: 1, location: [areas[1]!], yield: [{ probability: 1, count: 1, data: {} }] };
  const nativeProduction: Production = { type: 'manufacture', duration: 2, ingredients: [{ variety: ids.varieties.ore, count: 1, data: {} }], yield: [{ probability: 1, count: 1, data: {} }] };
  const importedProduction: Production = { type: 'manufacture', duration: 2, ingredients: [{ variety: ids.varieties.importedMetal, count: 1, data: {} }], yield: [{ probability: 1, count: 1, data: {} }] };
  const oreAsset = asset(ids.assets[0]!, 'ore');
  const metalAsset = asset(ids.assets[1]!, 'metal');
  const refinedAsset = asset(ids.assets[2]!, 'refined');
  const localAssets = [oreAsset, metalAsset, refinedAsset];
  const localVarieties = [variety(ids.varieties.ore, 'Ore', 1, oreAsset.id, [productionOre]), variety(ids.varieties.metal, 'Metal', 2, metalAsset.id, [nativeProduction]), variety(ids.varieties.refined, 'Refined Metal', 3, refinedAsset.id, [importedProduction])];
  const port = { id: mainPort, name: 'Simulation Harbor', territory: actorId, area: portArea, listings };
  const boundary = { id: `${origin}/objects/boundaries/east`, name: 'Eastern Boundary', territory: actorId };
  const route: Route = { id: routeId, from: boundary.id, to: mainPort, distance: 12 };
  const listing: Listing = { id: `${origin}/objects/listings/metal`, port: mainPort, seller: actorId, offered: { entries: [{ variety: ids.varieties.metal, count: 5, data: {} }] }, description: 'Locally produced metal' };
  host.server.registerResource(ports, { '@context': 'https://www.w3.org/ns/activitystreams', id: ports, type: 'Collection', totalItems: 1, orderedItems: [port] });
  host.server.registerResource(routes, { '@context': 'https://www.w3.org/ns/activitystreams', id: routes, type: 'Collection', totalItems: 1, orderedItems: [route] });
  host.server.registerResource(listings, { '@context': 'https://www.w3.org/ns/activitystreams', id: listings, type: 'Collection', totalItems: 1, orderedItems: [listing] });
  for (const item of [...areas, boundary, port, route, listing, ...localAssets, ...localVarieties]) host.server.registerResource(item.id, item);
  host.server.registerResource(map, { id: map, representations: [{ format: 'https://fctp.example/formats/ascii', resources: [{ role: 'map', url: `${origin}/objects/maps/territory/ascii`, mediaType: 'text/plain; charset=utf-8' }] }] }, { public: false, actorId });

  host.server.addRoute(async ({ request, response, url }) => {
    const textResource = url.pathname.startsWith('/objects/text/') || url.pathname === '/objects/maps/territory/ascii';
    if (textResource && request.method === 'GET') {
      const tokenHeader = request.headers.authorization ?? '';
      const resourcePlayer = tokenHeader.startsWith('Bearer ') ? await host.server.authenticateDiplomaticToken(actorId, tokenHeader.slice(7)) : undefined;
      if (!resourcePlayer) { json(response, 401, { error: 'unauthorized' }); return true; }
      const enrolled = await host.server.store.read((state) => state.enrollments[resourcePlayer] === homeId);
      if (!enrolled) { json(response, 403, { error: 'forbidden' }); return true; }
      const content = url.pathname === '/objects/maps/territory/ascii' ? '~~~~~\n~H..~\n~..M~\n~~~~~' : `${url.pathname.split('/').at(-1)} production asset`;
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' });
      response.end(content);
      return true;
    }
    if (!url.pathname.startsWith('/local/')) return false;
    if (url.pathname === '/local/info' && request.method === 'GET') {
      json(response, 200, { kind: 'simulation', actor: actorId, ids, endpoints: ['/local/state', '/local/mine', '/local/manufacture', '/local/load', '/local/unload', '/local/admin/facilities', '/local/admin/tick'], production: { ore: ids.varieties.ore, metal: ids.varieties.metal, refined: ids.varieties.refined, importedMetal: ids.varieties.importedMetal } });
      return true;
    }
    const admin = url.pathname === '/local/admin/facilities' || url.pathname === '/local/admin/tick';
    const auth = request.headers.authorization ?? '';
    const player = auth.startsWith('Bearer ') ? await host.server.authenticateDiplomaticToken(actorId, auth.slice(7)) : undefined;
    const isPlayer = Boolean(player && await host.server.store.read((state) => state.enrollments[player] === homeId));
    const isAdmin = await safeSecret(request, options.adminSecret);
    const playerOperation = ['/local/mine', '/local/manufacture', '/local/load', '/local/unload'].includes(url.pathname);
    if (admin ? !isAdmin : playerOperation ? !isPlayer : !isPlayer && !isAdmin) {
      const status = isPlayer || isAdmin ? 403 : 401;
      json(response, status, { error: status === 403 ? 'forbidden' : 'unauthorized' });
      return true;
    }
    if (url.pathname === '/local/state' && request.method === 'GET') { json(response, 200, await territory.state()); return true; }
    if (url.pathname === '/local/admin/tick' && request.method === 'POST') { json(response, 200, await territory.tick()); return true; }
    if (request.method !== 'POST') { json(response, 404, { error: 'not-found' }); return true; }
    const input = await body(request);
      if (url.pathname === '/local/mine' && Number.isSafeInteger(input.count) && (input.duration === undefined || Number.isSafeInteger(input.duration))) json(response, 200, { job: await territory.mine(input.count as number, input.duration as number | undefined) });
      else if (url.pathname === '/local/manufacture' && Number.isSafeInteger(input.count) && (input.recipe === 'native' || input.recipe === 'imported')) json(response, 200, { job: await territory.manufacture(input.recipe === 'native' ? 'native' : 'imported', input.count as number) });
      else if (url.pathname === '/local/admin/facilities' && isAdmin && validFacilities(input)) { await territory.configureFacilities(input); json(response, 200, { ok: true }); }
      else if ((url.pathname === '/local/load' || url.pathname === '/local/unload') && typeof input.entryRequest === 'string' && validManifest(input.cargo) && Number.isSafeInteger(input.duration)) {
        const state = await territory.state();
        if (!isPlayer || state.visits[input.entryRequest]?.possessor !== player) { json(response, 403, { error: 'forbidden' }); return true; }
        const cargo = input.cargo.entries.map((item) => {
          if ('id' in item && typeof item.id === 'string') return { id: item.id, commodity: item.variety, count: 1, quantityKind: 'Item' as const, data: item.data };
          if (typeof item.count !== 'number') throw new TypeError('invalid-cargo-count');
          return { commodity: item.variety, count: item.count, quantityKind: 'Stack' as const, data: item.data };
        });
        json(response, 200, { job: await territory.handle(input.entryRequest as URI, url.pathname.endsWith('/load') ? 'load' : 'unload', cargo, input.duration as number) });
      } else json(response, 400, { error: 'invalid-operation-input' });
    return true;
  });
  return { host, territory, ids };
}

type ValidCargoManifest = CargoManifest & {
  entries: Array<
    | { variety: URI; data: Record<string, unknown>; id: string }
    | { variety: URI; data: Record<string, unknown>; count: number }
  >;
}

function validManifest(value: unknown): value is ValidCargoManifest {
  if (typeof value !== 'object' || value === null || !('entries' in value) || !Array.isArray(value.entries)) return false;
  return value.entries.every((entry) => typeof entry === 'object' && entry !== null && typeof entry.variety === 'string' &&
    typeof entry.data === 'object' && entry.data !== null && !Array.isArray(entry.data) &&
    ('id' in entry ? typeof entry.id === 'string' : Number.isSafeInteger(entry.count) && Number(entry.count) > 0));
}

function validFacilities(value: Record<string, unknown>): value is Parameters<SimulationTerritory['configureFacilities']>[0] {
  const section = (name: string, fields: Record<string, (value: unknown) => boolean>): boolean => {
    if (!(name in value)) return true;
    const config = value[name];
    return typeof config === 'object' && config !== null && !Array.isArray(config) && Object.entries(fields).every(([key, check]) => key in config && check((config as Record<string, unknown>)[key]));
  };
  const positive = (candidate: unknown): boolean => Number.isSafeInteger(candidate) && Number(candidate) > 0;
  const nonnegative = (candidate: unknown): boolean => Number.isSafeInteger(candidate) && Number(candidate) >= 0;
  return section('mining', { enabled: (candidate) => typeof candidate === 'boolean', capacity: positive }) &&
    section('manufacturing', { slots: positive, time: positive }) && section('port', { capacity: nonnegative, berths: nonnegative });
}
