import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { resolveActor } from '@fctp/identity';
import type { CargoManifest, DepartureEvent, DepartureRequest, EntryRequest, ExitEvent, Quantity, URI, Vessel } from '@fctp/protocol';
import { validateModel } from '@fctp/protocol';
import { resolveExitEvidence, type LocalAction, type LocalActionDiscovery } from '@fctp/server-base';
import type { Authority } from './bootstrap.js';

type RegistryEvent = Record<string, unknown> & { id: URI; type: string; vessel: URI; territory: URI };
export interface VesselRegistryState {
  vessel?: Vessel;
  cargo?: CargoManifest;
  adoption: boolean;
  requests: Record<string, Record<string, unknown>>;
  events: RegistryEvent[];
  eventIds: Record<string, true>;
  exitEvidence: string[];
}
interface RegistryCollection { vessels: Record<string, VesselRegistryState>; defaultVessel: URI }

export interface InstallRegistryOptions {
  fetcher?: typeof fetch;
  route?: (territory: URI, port: URI, route: URI) => Promise<{ actor: URI; inbox: URI }>;
  initialCargo?: CargoManifest;
  initialVessel?: Vessel;
  initialVessels?: Vessel[];
  adminAuthorized?: (request: IncomingMessage) => Promise<boolean>;
  authenticatePlayer?: (request: IncomingMessage) => Promise<URI | undefined>;
}

export interface Registry {
  sendEntry(input: { territory: URI; port: URI; route: URI; cargo?: CargoManifest; vessel?: URI }): Promise<EntryRequest>;
  sendDeparture(input: { territory: URI; port: URI; route?: URI; vessel?: URI }): Promise<DepartureRequest>;
  switchAdoption(adoption: boolean, vesselId?: URI): Promise<void>;
  state(vesselId?: URI): Promise<VesselRegistryState>;
  fleet(): Promise<Record<URI, VesselRegistryState>>;
  resolveExpectedIssuer(sender: URI, object: unknown): Promise<URI | undefined>;
}

const eventTypes = ['EntryRejected', 'BerthingEvent', 'CargoOperationEvent', 'DepartureEvent', 'VoyageEvent', 'ExitEvent'];

export function installRegistry(authority: Authority, options: InstallRegistryOptions = {}): Registry {
  const fetcher = options.fetcher ?? fetch;
  const registryId = authority.actor('registry').id;
  const base = registryId.replace(/\/actors\/registry$/, '');
  const defaultVessel = options.initialVessel ?? options.initialVessels?.[0] ?? {
    id: `${base}/objects/vessels/demo`, registry: registryId,
    possessor: authority.actor('player').id, capacity: 100
  } as Vessel;
  const vessels = [...(options.initialVessels ?? [])];
  if (!vessels.some((vessel) => vessel.id === defaultVessel.id)) vessels.unshift(defaultVessel);
  const initial: RegistryCollection = { vessels: Object.fromEntries(vessels.map((vessel) => [vessel.id, emptyVessel(vessel, options.initialCargo ?? { entries: [] })])), defaultVessel: defaultVessel.id };
  const readCollection = async (): Promise<RegistryCollection> => authority.server.store.read((store) => migrate(store.domain.registry, initial));
  const state = async (vesselId?: URI): Promise<VesselRegistryState> => {
    const data = await readCollection();
    const id = vesselId ?? data.defaultVessel;
    const selected = data.vessels[id];
    if (!selected) throw new Error(`Unknown Registry vessel: ${id}`);
    return structuredClone(selected);
  };
  const fleet = async (): Promise<Record<URI, VesselRegistryState>> => structuredClone((await readCollection()).vessels);

  const resolveExpectedIssuer = async (sender: URI, object: unknown): Promise<URI | undefined> => {
    if (!object || typeof object !== 'object') return undefined;
    const event = object as Record<string, unknown>;
    const collection = await readCollection();
    const vesselId = typeof event.vessel === 'string' ? event.vessel : undefined;
    const exact = event.type === 'EntryRejected' && typeof event.request === 'string'
      ? Object.values(collection.vessels).find((v) => v.requests[event.request as string])
      : vesselId ? collection.vessels[vesselId] : undefined;
    if (!exact) return undefined;
    const issued = requestForEvent(exact, event);
    return issued && event.territory === sender ? sender : undefined;
  };

  const acceptEvent = async (context: { senderActor: URI; verification: { cryptographic: { verified: boolean }; attribution: { attributed: boolean }; expectedIssuer: { matches: boolean } } }, raw: unknown): Promise<void> => {
    if (!raw || typeof raw !== 'object' || !eventTypes.includes(String((raw as Record<string, unknown>).type))) return;
    const event = raw as RegistryEvent;
    const model = event.type as 'EntryRejected' | 'BerthingEvent' | 'CargoOperationEvent' | 'DepartureEvent' | 'VoyageEvent' | 'ExitEvent';
    const validation = validateModel(event, model);
    if (!validation.success || !context.verification.cryptographic.verified || !context.verification.attribution.attributed || !context.verification.expectedIssuer.matches) return;
    const vesselId = typeof event.vessel === 'string' ? event.vessel : undefined;
    const current = await readCollection();
    const selected = model === 'EntryRejected' ? Object.values(current.vessels).find((v) => requestForEvent(v, event)) : vesselId ? current.vessels[vesselId] : undefined;
    if (!selected) return;
    const issued = requestForEvent(selected, event);
    if (!issued || event.territory !== context.senderActor) return;
    if (model === 'EntryRejected' && (issued.type !== 'EntryRequest' || (issued as EntryRequest).destination.territory !== event.territory)) return;
    if (model === 'BerthingEvent' && (event.request !== issued.id || issued.type !== 'EntryRequest')) return;
    if (model === 'DepartureEvent' && (event.request !== issued.id || issued.type !== 'DepartureRequest')) return;
    if (model === 'ExitEvent') {
      const evidence = event as ExitEvent;
      const entry = selected.requests[evidence.entryRequest] as EntryRequest | undefined;
      if (entry?.type !== 'EntryRequest' || entry.destination.territory !== context.senderActor || entry.vessel.id !== evidence.vessel) return;
      if (evidence.departureEvent) {
        const response = await fetcher(evidence.departureEvent);
        if (!response.ok) return;
        const departure = await response.json() as DepartureEvent;
        const departureRequest = selected.requests[departure.request] as DepartureRequest | undefined;
        if (departureRequest?.type !== 'DepartureRequest' || departure.vessel !== evidence.vessel || departure.territory !== context.senderActor || departureRequest.vessel !== evidence.vessel || departureRequest.territory !== context.senderActor) return;
      }
      const result = await resolveExitEvidence(evidence.id, { vessel: entry.vessel.id, registry: entry.vessel.registry }, { fetcher: async (input, init) => String(input) === evidence.id ? Response.json(evidence) : fetcher(input, init) });
      if (!result.verification.cryptographic.verified || !result.verification.attribution.attributed || !result.verification.expectedIssuer.matches || !result.binding.bound) return;
    }
    await authority.server.store.transaction((store) => {
      const data = migrate(store.domain.registry, initial);
      const target = data.vessels[selected.vessel!.id];
      if (!target || target.eventIds[event.id]) return;
      const updatedCargo = event.type === 'CargoOperationEvent' && target.adoption && target.cargo
        ? applyCargoDelta(target.cargo, event.cargo as CargoManifest, event.operation as 'load' | 'unload') : undefined;
      if (event.type === 'CargoOperationEvent' && target.adoption && target.cargo && !updatedCargo) return;
      target.eventIds[event.id] = true;
      target.events.push(structuredClone(event));
      if (event.type === 'ExitEvent') { store.objects[event.id] = structuredClone(event); target.exitEvidence.push(event.id); }
      if (updatedCargo) target.cargo = updatedCargo;
      store.domain.registry = data;
    });
  };
  for (const type of eventTypes) authority.server.on(registryId, type, async (context, object) => acceptEvent(context, object));

  authority.server.addRoute(async ({ request, response, url }) => {
    if (!url.pathname.startsWith('/local/registry')) return false;
    const send = (status: number, value?: unknown): void => { response.writeHead(status, { 'Cache-Control': 'no-store', ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) }); response.end(value === undefined ? undefined : JSON.stringify(value)); };
    if (request.method === 'GET' && url.pathname === '/local/registry/fleet') {
      if (!await admin(request)) { send(403); return true; }
      send(200, await fleet()); return true;
    }
    if (request.method === 'GET' && url.pathname === '/local/registry/state') {
      const vessel = url.searchParams.get('vessel') ?? undefined;
      const access = await playerAccess(request, vessel);
      if (!access.allowed) { send(access.status); return true; }
      try { send(200, await state(vessel ?? access.vessel)); } catch { send(404); }
      return true;
    }
    if (request.method === 'GET' && url.pathname === '/local/registry/actions') {
      const vessel = url.searchParams.get('vessel') ?? undefined;
      const possessor = options.authenticatePlayer ? await options.authenticatePlayer(request) : undefined;
      if (!possessor) { send(401); return true; }
      if (!vessel) { send(400); return true; }
      const data = await readCollection();
      const selected = data.vessels[vessel];
      if (!selected) { send(404); return true; }
      if (selected.vessel?.possessor !== possessor) { send(403); return true; }
      send(200, discoverActions(authority, vessel, selected));
      return true;
    }
    if (request.method === 'POST' && ['/local/registry/entry', '/local/registry/departure', '/local/registry/adoption'].includes(url.pathname)) {
      const body = await readJson(request);
      const vessel = typeof body.vessel === 'string' ? body.vessel : undefined;
      const access = await playerAccess(request, vessel);
      if (!access.allowed) { send(access.status); return true; }
      if (url.pathname.endsWith('/adoption')) {
        if (typeof body.adoption !== 'boolean') { send(400); return true; }
        await switchAdoption(body.adoption, vessel ?? access.vessel); send(200); return true;
      }
      if (typeof body.territory !== 'string' || typeof body.port !== 'string' || (url.pathname.endsWith('/entry') && typeof body.route !== 'string')) { send(400); return true; }
      try {
        const result = url.pathname.endsWith('/entry')
          ? await sendEntry({ territory: body.territory, port: body.port, route: body.route as URI, ...(body.cargo ? { cargo: body.cargo as CargoManifest } : {}), ...(vessel ?? access.vessel ? { vessel: vessel ?? access.vessel } : {}) })
          : await sendDeparture({ territory: body.territory, port: body.port, ...(typeof body.route === 'string' ? { route: body.route } : {}), ...(vessel ?? access.vessel ? { vessel: vessel ?? access.vessel } : {}) });
        send(202, result);
      } catch (error) { if (error instanceof Error && error.message.startsWith('Unknown Registry vessel:')) send(404); else throw error; }
      return true;
    }
    send(404); return true;
  });

  async function admin(request: IncomingMessage): Promise<boolean> { return options.adminAuthorized ? options.adminAuthorized(request) : authority.server.checkAdmin(request, authority.actor('registry')); }
  async function playerAccess(request: IncomingMessage, vesselId?: URI): Promise<{ allowed: boolean; status: number; vessel?: URI }> {
    if (await admin(request)) return { allowed: true, status: 200 };
    const possessor = options.authenticatePlayer ? await options.authenticatePlayer(request) : undefined;
    if (!possessor) return { allowed: false, status: 403 };
    const data = await readCollection();
    const id = vesselId ?? (data.vessels[data.defaultVessel]?.vessel?.possessor === possessor ? data.defaultVessel : undefined);
    if (!id || !data.vessels[id]) return { allowed: false, status: 404 };
    if (data.vessels[id]!.vessel?.possessor !== possessor) return { allowed: false, status: 403 };
    return { allowed: true, status: 200, vessel: id };
  }

  const sendEntry = async (input: { territory: URI; port: URI; route: URI; cargo?: CargoManifest; vessel?: URI }): Promise<EntryRequest> => {
    const current = await state(input.vessel);
    if (!current.vessel) throw new Error('Registry vessel is not configured');
    const destination = await resolveTerritory(input.territory, input.port, input.route, options, fetcher);
    const request: EntryRequest = { id: `${base}/objects/entry-requests/${randomUUID()}`, type: 'EntryRequest', vessel: current.vessel, cargo: structuredClone(input.cargo ?? current.cargo ?? { entries: [] }), journey: { events: current.events.map((event) => event.id), ...(current.exitEvidence.at(-1) ? { exitEvidence: current.exitEvidence.at(-1)! } : {}) }, destination: { territory: input.territory, port: input.port, route: input.route } };
    await authority.server.commit((domain) => { const data = migrate(domain.registry, initial); const target = data.vessels[current.vessel!.id]; if (!target) throw new Error(`Unknown Registry vessel: ${current.vessel!.id}`); target.requests[request.id] = structuredClone(request); domain.registry = data; }, [{ actorId: registryId, recipientActorId: destination.actor, inbox: destination.inbox, object: request, activityId: `${request.id}/activity` }]);
    return request;
  };
  const sendDeparture = async (input: { territory: URI; port: URI; route?: URI; vessel?: URI }): Promise<DepartureRequest> => {
    const current = await state(input.vessel);
    if (!current.vessel) throw new Error('Registry vessel is not configured');
    const destination = await resolveTerritory(input.territory, input.port, input.route ?? '', options, fetcher);
    const departure: DepartureRequest = { id: `${base}/objects/departure-requests/${randomUUID()}`, type: 'DepartureRequest', vessel: current.vessel.id, territory: input.territory, port: input.port, ...(input.route ? { route: input.route } : {}) };
    await authority.server.commit((domain) => { const data = migrate(domain.registry, initial); const target = data.vessels[current.vessel!.id]; if (!target) throw new Error(`Unknown Registry vessel: ${current.vessel!.id}`); target.requests[departure.id] = structuredClone(departure); domain.registry = data; }, [{ actorId: registryId, recipientActorId: destination.actor, inbox: destination.inbox, object: departure, activityId: `${departure.id}/activity` }]);
    return departure;
  };
  const switchAdoption = async (adoption: boolean, vesselId?: URI): Promise<void> => authority.server.store.transaction((store) => { const data = migrate(store.domain.registry, initial); const id = vesselId ?? data.defaultVessel; const target = data.vessels[id]; if (!target) throw new Error(`Unknown Registry vessel: ${id}`); target.adoption = adoption; store.domain.registry = data; });
  return { sendEntry, sendDeparture, switchAdoption, state, fleet, resolveExpectedIssuer };
}

function discoverActions(authority: Authority, vessel: URI, selected: VesselRegistryState): LocalActionDiscovery {
  const events = selected.events;
  const exits = new Set(events.filter((event) => event.type === 'ExitEvent').map((event) => (event as ExitEvent).entryRequest));
  const latestBerth = [...events].reverse().find((event) => event.type === 'BerthingEvent' && typeof event.request === 'string' && selected.requests[event.request]?.type === 'EntryRequest' && (selected.requests[event.request] as EntryRequest).vessel.id === vessel) as (RegistryEvent & { request: URI; port: URI }) | undefined;
  const berth = latestBerth && !exits.has(latestBerth.request) ? latestBerth : undefined;
  const entry = berth ? selected.requests[berth.request] as EntryRequest : undefined;
  const requestOrder = Object.keys(selected.requests);
  const entryOrder = berth ? requestOrder.indexOf(berth.request) : -1;
  const departure = berth && entry && entryOrder >= 0 ? requestOrder.slice(entryOrder + 1).map((id) => selected.requests[id]).filter((request): request is DepartureRequest => request?.type === 'DepartureRequest' && request.territory === berth.territory && request.port === berth.port && (request.route === undefined || request.route === entry.destination.route)).at(-1) : undefined;
  const departureEvent = departure && events.find((event) => event.type === 'DepartureEvent' && event.request === departure.id) as (RegistryEvent & { id: URI }) | undefined;
  const exited = !!latestBerth && exits.has(latestBerth.request);
  const pendingRequests = Object.values(selected.requests).filter((request) => {
    if (request.type === 'EntryRequest') return !events.some((event) => (event.type === 'BerthingEvent' || event.type === 'EntryRejected') && event.request === request.id);
    if (request.type === 'DepartureRequest') return !events.some((event) => event.type === 'DepartureEvent' && event.request === request.id);
    return false;
  });
  const actions: LocalAction[] = [
    {
      id: 'departure', label: 'Request departure from recorded berth', available: !!berth && !departure,
      ...(!berth ? { reason: 'No current non-exited Registry-recorded berth is available.' } : departure ? { reason: departureEvent ? 'DepartureEvent is recorded; awaiting ExitEvent evidence.' : 'A departure request for this exact recorded visit is pending.' } : {}),
      ...(berth && entry ? { request: { method: 'POST' as const, href: `${authority.actor('registry').id.replace(/\/actors\/registry$/, '')}/local/registry/departure`, body: { vessel, territory: berth.territory, port: berth.port, route: entry.destination.route } } } : {}),
      effect: 'Issues a Registry departure request; it does not itself establish departure.'
    },
    ...([false, true] as const).map((adoption): LocalAction => ({ id: `adoption-${adoption ? 'on' : 'off'}`, label: `${adoption ? 'Enable' : 'Disable'} adoption`, available: selected.adoption !== adoption, ...(selected.adoption === adoption ? { reason: 'This option matches the recorded adoption setting.' } : {}), request: { method: 'POST', href: `${authority.actor('registry').id.replace(/\/actors\/registry$/, '')}/local/registry/adoption`, body: { vessel, adoption } }, effect: `Changes Registry adoption to ${adoption}.` }))
  ];
  return {
    kind: 'registry', actor: authority.actor('registry').id, player: selected.vessel!.possessor, vessel, observedAt: new Date().toISOString(),
    state: { source: 'Registry-recorded observations', cargo: structuredClone(selected.cargo), adoption: selected.adoption, location: berth ? { status: departureEvent ? 'departed-awaiting-exit' : 'berthed', territory: berth.territory, port: berth.port, entryRequest: berth.request } : { status: exited ? 'exited' : 'no-recorded-active-berth', ...(latestBerth ? { territory: latestBerth.territory, port: latestBerth.port, entryRequest: latestBerth.request } : {}) }, pendingRequests, latestExitEvidence: selected.exitEvidence.at(-1) ?? null },
    actions, notes: ['Location and lifecycle reflect only events recorded by this Registry; ExitEvent evidence does not establish entry elsewhere.']
  };
}

function emptyVessel(vessel: Vessel, cargo: CargoManifest): VesselRegistryState { return { vessel: structuredClone(vessel), cargo: structuredClone(cargo), adoption: false, requests: {}, events: [], eventIds: {}, exitEvidence: [] }; }
function migrate(value: unknown, initial: RegistryCollection): RegistryCollection {
  if (!value) return structuredClone(initial);
  const data = value as Partial<RegistryCollection> & Partial<VesselRegistryState>;
  if (data.vessels && data.defaultVessel) return structuredClone(data as RegistryCollection);
  if (data.vessel?.id) {
    const migrated = emptyVessel(data.vessel as Vessel, data.cargo ?? { entries: [] });
    Object.assign(migrated, { adoption: data.adoption ?? false, requests: data.requests ?? {}, events: data.events ?? [], eventIds: data.eventIds ?? {}, exitEvidence: data.exitEvidence ?? [] });
    const collection = structuredClone(initial);
    collection.vessels[data.vessel.id] = migrated;
    collection.defaultVessel = data.vessel.id;
    return collection;
  }
  return structuredClone(initial);
}
function requestForEvent(data: VesselRegistryState, event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (event.type === 'EntryRejected') { const request = typeof event.request === 'string' ? data.requests[event.request] : undefined; return request?.type === 'EntryRequest' && (request as EntryRequest).destination.territory === event.territory ? request : undefined; }
  if (event.type === 'BerthingEvent' || event.type === 'ExitEvent') { const id = event.type === 'ExitEvent' ? event.entryRequest : event.request; const entry = typeof id === 'string' ? data.requests[id] : undefined; return entry?.type === 'EntryRequest' && (entry as EntryRequest).destination.territory === event.territory && (entry as EntryRequest).vessel.id === event.vessel ? entry : undefined; }
  if (event.type === 'DepartureEvent') { const departure = typeof event.request === 'string' ? data.requests[event.request] : undefined; return departure?.type === 'DepartureRequest' && (departure as DepartureRequest).territory === event.territory && (departure as DepartureRequest).vessel === event.vessel ? departure : undefined; }
  const requests = Object.values(data.requests).filter((item) => item.type === 'EntryRequest' && (item as EntryRequest).vessel.id === event.vessel && (item as EntryRequest).destination.territory === event.territory);
  return requests.at(-1);
}
function applyCargoDelta(manifest: CargoManifest, delta: CargoManifest, operation: 'load' | 'unload'): CargoManifest | undefined {
  const entries = structuredClone(manifest.entries);
  for (const quantity of delta.entries) {
    const index = entries.findIndex((item) => quantityKey(item) === quantityKey(quantity));
    const quantityStack = isStack(quantity); const existingStack = index >= 0 && isStack(entries[index]!);
    if (operation === 'load') { if (index < 0) entries.push(structuredClone(quantity)); else if (quantityStack && existingStack) entries[index] = { ...entries[index], count: (entries[index] as { count: number }).count + quantity.count } as Quantity; else return undefined; }
    else { if (index < 0) return undefined; const existing = entries[index]!; if (quantityStack && existingStack) { const count = (existing as { count: number }).count; if (quantity.count > count) return undefined; if (quantity.count === count) entries.splice(index, 1); else entries[index] = { ...existing, count: count - quantity.count } as Quantity; } else if (!quantityStack && !existingStack) entries.splice(index, 1); else return undefined; }
  }
  return { entries };
}
function quantityKey(quantity: Quantity): string { return isStack(quantity) ? JSON.stringify(['stack', quantity.variety, stableJson(quantity.data)]) : JSON.stringify(['item', quantity.id]); }
function isStack(quantity: Quantity): quantity is Extract<Quantity, { count: number }> { return typeof (quantity as { count?: unknown }).count === 'number'; }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`; return JSON.stringify(value); }
async function resolveTerritory(territory: URI, port: URI, route: URI, options: InstallRegistryOptions, fetcher: typeof fetch): Promise<{ actor: URI; inbox: URI }> { if (options.route) return options.route(territory, port, route); const { actor } = await resolveActor(territory, fetcher); if (typeof actor.inbox !== 'string') throw new Error('Territory Actor has no inbox'); return { actor: territory, inbox: actor.inbox }; }
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
