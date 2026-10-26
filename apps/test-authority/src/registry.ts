import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { resolveActor } from '@fctp/identity';
import { validateModel, type CargoManifest, type DepartureEvent, type DepartureRequest, type EntryRequest, type ExitEvent, type Quantity, type URI } from '@fctp/protocol';
import { resolveExitEvidence } from '@fctp/server-base';
import type { Authority } from './bootstrap.js';

type RegistryEvent = Record<string, unknown> & { id: URI; type: string; vessel: URI; territory: URI };
interface RegistryState {
  vessel?: Record<string, unknown>;
  cargo?: CargoManifest;
  adoption: boolean;
  requests: Record<string, Record<string, unknown>>;
  events: RegistryEvent[];
  eventIds: Record<string, true>;
  exitEvidence: string[];
}

export interface InstallRegistryOptions {
  fetcher?: typeof fetch;
  route?: (territory: URI, port: URI, route: URI) => Promise<{ actor: URI; inbox: URI }>;
  initialCargo?: CargoManifest;
  initialVessel?: EntryRequest['vessel'];
  adminAuthorized?: (request: IncomingMessage) => Promise<boolean>;
}

export interface Registry {
  sendEntry(input: { territory: URI; port: URI; route: URI; cargo?: CargoManifest }): Promise<EntryRequest>;
  sendDeparture(input: { territory: URI; port: URI; route?: URI }): Promise<DepartureRequest>;
  switchAdoption(adoption: boolean): Promise<void>;
  state(): Promise<RegistryState>;
  resolveExpectedIssuer(sender: URI, object: unknown): Promise<URI | undefined>;
}

const eventTypes = ['EntryRejected', 'BerthingEvent', 'CargoOperationEvent', 'DepartureEvent', 'VoyageEvent', 'ExitEvent'];

export function installRegistry(authority: Authority, options: InstallRegistryOptions = {}): Registry {
  const fetcher = options.fetcher ?? fetch;
  const registryId = authority.actor('registry').id;
  const base = authority.actor('registry').id.replace(/\/actors\/registry$/, '');
  const initialVessel = options.initialVessel ?? {
    id: `${base}/objects/vessels/demo`, registry: registryId,
    possessor: authority.actor('player').id, capacity: 100
  };
  const initialCargo = options.initialCargo ?? { entries: [] };
  const initial: RegistryState = { vessel: initialVessel, cargo: initialCargo, adoption: false, requests: {}, events: [], eventIds: {}, exitEvidence: [] };

  const state = async (): Promise<RegistryState> => authority.server.store.read((store) => {
    const registry = store.domain.registry as RegistryState | undefined;
    return structuredClone(registry ?? initial);
  });

  const resolveExpectedIssuer = async (sender: URI, object: unknown): Promise<URI | undefined> => {
    if (!object || typeof object !== 'object') return undefined;
    const event = object as Record<string, unknown>;
    if (event.type === 'EntryRejected' && typeof event.request === 'string') {
      const request = (await state()).requests[event.request];
      return request?.type === 'EntryRequest' && (request as EntryRequest).destination.territory === sender && event.territory === sender ? sender : undefined;
    }
    if (typeof event.territory === 'string' && eventTypes.includes(String(event.type))) {
      const data = await state();
      const issued = requestForEvent(data, event);
      return issued && event.territory === sender ? sender : undefined;
    }
    return undefined;
  };

  const acceptEvent = async (context: { senderActor: URI; verification: { cryptographic: { verified: boolean }; attribution: { attributed: boolean }; expectedIssuer: { matches: boolean } } }, raw: unknown): Promise<void> => {
    if (!raw || typeof raw !== 'object' || !eventTypes.includes(String((raw as Record<string, unknown>).type))) return;
    const event = raw as RegistryEvent;
    const model = event.type as 'EntryRejected' | 'BerthingEvent' | 'CargoOperationEvent' | 'DepartureEvent' | 'VoyageEvent' | 'ExitEvent';
    const validation = validateModel<RegistryEvent>(event, model);
    if (!validation.success || !context.verification.cryptographic.verified || !context.verification.attribution.attributed || !context.verification.expectedIssuer.matches) return;
    const current = await state();
    const request = model === 'EntryRejected'
      ? current.requests[String((event as Record<string, unknown>).request)]
      : requestForEvent(current, event);
    if (!request || event.territory !== context.senderActor) return;
    if (model === 'EntryRejected') {
      if (request.type !== 'EntryRequest' || (request as EntryRequest).destination.territory !== event.territory) return;
    } else if (event.vessel !== current.vessel?.id) return;
    if (model === 'BerthingEvent' && ((event as Record<string, unknown>).request !== request?.id || request?.type !== 'EntryRequest')) return;
    if (model === 'DepartureEvent' && ((event as unknown as DepartureEvent).request !== request?.id || request?.type !== 'DepartureRequest')) return;
    if (model === 'ExitEvent') {
      const evidence = event as unknown as ExitEvent;
      const entry = current.requests[evidence.entryRequest] as EntryRequest | undefined;
      if (entry?.type !== 'EntryRequest' || entry.destination.territory !== context.senderActor || entry.vessel.id !== evidence.vessel) return;
      if (evidence.departureEvent) {
        const departureEvent = await fetcher(evidence.departureEvent);
        if (!departureEvent.ok) return;
        const departure = await departureEvent.json() as DepartureEvent;
        const departureRequest = current.requests[departure.request] as DepartureRequest | undefined;
        if (departureRequest?.type !== 'DepartureRequest' || departure.vessel !== evidence.vessel || departure.territory !== context.senderActor || departureRequest.vessel !== evidence.vessel || departureRequest.territory !== context.senderActor) return;
      }
      const result = await resolveExitEvidence(evidence.id, { vessel: entry.vessel.id, registry: entry.vessel.registry }, { fetcher: async (input, init) => String(input) === evidence.id ? Response.json(evidence) : fetcher(input, init) });
       if (!result.verification.cryptographic.verified || !result.verification.attribution.attributed || !result.verification.expectedIssuer.matches || !result.binding.bound) return;
    }
    await authority.server.store.transaction((store) => {
       const data = (store.domain.registry as RegistryState | undefined) ?? structuredClone(initial);
       if (data.eventIds[event.id]) return;
       const updatedCargo = event.type === 'CargoOperationEvent' && data.adoption && data.cargo
         ? applyCargoDelta(data.cargo, event.cargo as CargoManifest, event.operation as 'load' | 'unload')
         : undefined;
       if (event.type === 'CargoOperationEvent' && data.adoption && data.cargo && !updatedCargo) return;
       data.eventIds[event.id] = true;
      data.events.push(structuredClone(event));
      if (event.type === 'ExitEvent') {
        store.objects[event.id] = structuredClone(event);
        data.exitEvidence.push(event.id);
      }
       if (updatedCargo) data.cargo = updatedCargo;
      store.domain.registry = data;
    });
  };

  for (const type of eventTypes) authority.server.on(registryId, type, async (context, object) => acceptEvent(context, object));

  authority.server.addRoute(async ({ request, response, url, base: server }) => {
    if (!url.pathname.startsWith('/local/registry')) return false;
    if (request.method === 'POST' && (url.pathname === '/local/registry/entry' || url.pathname === '/local/registry/departure')) {
      if (!await server.checkAdmin(request, authority.actor('registry'))) { response.writeHead(403).end(); return true; }
      const body = await readJson(request);
      if (typeof body.territory !== 'string' || typeof body.port !== 'string' || (url.pathname.endsWith('/entry') && typeof body.route !== 'string')) { response.writeHead(400).end(); return true; }
      const result = url.pathname.endsWith('/entry')
        ? await sendEntry({ territory: body.territory, port: body.port, route: body.route as URI, ...(body.cargo ? { cargo: body.cargo as CargoManifest } : {}) })
        : await sendDeparture({ territory: body.territory, port: body.port, ...(typeof body.route === 'string' ? { route: body.route } : {}) });
      response.writeHead(202, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result)); return true;
    }
    if (request.method === 'GET' && url.pathname === '/local/registry/state') {
      if (!await server.checkAdmin(request, authority.actor('registry'))) { response.writeHead(403).end(); return true; }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(await state())); return true;
    }
    if (request.method === 'POST' && url.pathname === '/local/registry/adoption') {
      if (!await server.checkAdmin(request, authority.actor('registry'))) { response.writeHead(403).end(); return true; }
      const body = await readJson(request);
      if (typeof body.adoption !== 'boolean') { response.writeHead(400).end(); return true; }
      await server.store.transaction((store) => { const data = (store.domain.registry as RegistryState | undefined) ?? structuredClone(initial); data.adoption = body.adoption as boolean; store.domain.registry = data; });
      response.writeHead(200).end(); return true;
    }
    response.writeHead(404).end(); return true;
  });

  const sendEntry = async (input: { territory: URI; port: URI; route: URI; cargo?: CargoManifest }): Promise<EntryRequest> => {
    const current = await state();
    if (!current.vessel) throw new Error('Registry vessel is not configured');
    const destination = await resolveTerritory(input.territory, input.port, input.route, options, fetcher);
    const request: EntryRequest = { id: `${base}/objects/entry-requests/${randomUUID()}`, type: 'EntryRequest', vessel: current.vessel as EntryRequest['vessel'], cargo: structuredClone(input.cargo ?? current.cargo ?? initialCargo), journey: { events: current.events.map((event) => event.id), ...(current.exitEvidence.at(-1) ? { exitEvidence: current.exitEvidence.at(-1)! } : {}) }, destination: { territory: input.territory, port: input.port, route: input.route } };
    await authority.server.commit((domain) => { const data = (domain.registry as RegistryState | undefined) ?? structuredClone(initial); data.requests[request.id] = structuredClone(request); domain.registry = data; }, [{ actorId: registryId, recipientActorId: destination.actor, inbox: destination.inbox, object: request, activityId: `${request.id}/activity` }]);
    return request;
  };

  const sendDeparture = async (input: { territory: URI; port: URI; route?: URI }): Promise<DepartureRequest> => {
    const current = await state();
    if (!current.vessel) throw new Error('Registry vessel is not configured');
    const destination = await resolveTerritory(input.territory, input.port, input.route ?? '', options, fetcher);
    const departure: DepartureRequest = { id: `${base}/objects/departure-requests/${randomUUID()}`, type: 'DepartureRequest', vessel: current.vessel.id as URI, territory: input.territory, port: input.port, ...(input.route ? { route: input.route } : {}) };
    await authority.server.commit((domain) => { const data = (domain.registry as RegistryState | undefined) ?? structuredClone(initial); data.requests[departure.id] = structuredClone(departure); domain.registry = data; }, [{ actorId: registryId, recipientActorId: destination.actor, inbox: destination.inbox, object: departure, activityId: `${departure.id}/activity` }]);
    return departure;
  };

  return {
    sendEntry, sendDeparture,
    switchAdoption: async (adoption) => authority.server.store.transaction((store) => { const data = (store.domain.registry as RegistryState | undefined) ?? structuredClone(initial); data.adoption = adoption; store.domain.registry = data; }),
    state, resolveExpectedIssuer
  };
}

function requestForEvent(data: RegistryState, event: Record<string, unknown>): Record<string, unknown> | undefined {
  if (event.type === 'BerthingEvent' || event.type === 'ExitEvent') {
    const id = event.type === 'ExitEvent' ? event.entryRequest : event.request;
    const entry = typeof id === 'string' ? data.requests[id] : undefined;
    return entry?.type === 'EntryRequest' && (entry as EntryRequest).destination.territory === event.territory && (entry as EntryRequest).vessel.id === event.vessel ? entry : undefined;
  }
  if (event.type === 'DepartureEvent') {
    const departure = typeof event.request === 'string' ? data.requests[event.request] : undefined;
    return departure?.type === 'DepartureRequest' && departure.territory === event.territory && departure.vessel === event.vessel ? departure : undefined;
  }
  const entries = Object.values(data.requests).filter((item) => item.type === 'EntryRequest' && (item as EntryRequest).vessel.id === event.vessel);
  const latest = entries.at(-1);
  return latest && (latest as EntryRequest).destination.territory === event.territory ? latest : undefined;
}

function applyCargoDelta(manifest: CargoManifest, delta: CargoManifest, operation: 'load' | 'unload'): CargoManifest | undefined {
  const entries = structuredClone(manifest.entries);
  for (const quantity of delta.entries) {
    const index = entries.findIndex((item) => quantityKey(item) === quantityKey(quantity));
    const quantityStack = isStack(quantity);
    const existingStack = index >= 0 && isStack(entries[index]!);
    if (operation === 'load') {
      if (index < 0) entries.push(structuredClone(quantity));
      else if (quantityStack && existingStack) entries[index] = { ...entries[index], count: (entries[index] as { count: number }).count + quantity.count } as Quantity;
      else return undefined;
    } else {
      if (index < 0) return undefined;
      const existing = entries[index]!;
      if (quantityStack && existingStack) {
        const currentCount = (existing as { count: number }).count;
        if (quantity.count > currentCount) return undefined;
        if (quantity.count === currentCount) entries.splice(index, 1);
        else entries[index] = { ...existing, count: currentCount - quantity.count } as Quantity;
      } else if (!quantityStack && !existingStack) entries.splice(index, 1);
      else return undefined;
    }
  }
  return { entries };
}

function quantityKey(quantity: Quantity): string {
  return isStack(quantity) ? JSON.stringify(['stack', quantity.variety, stableJson(quantity.data)]) : JSON.stringify(['item', quantity.id]);
}

function isStack(quantity: Quantity): quantity is Extract<Quantity, { count: number }> {
  return typeof (quantity as { count?: unknown }).count === 'number';
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function resolveTerritory(territory: URI, port: URI, route: URI, options: InstallRegistryOptions, fetcher: typeof fetch): Promise<{ actor: URI; inbox: URI }> {
  if (options.route) return options.route(territory, port, route);
  const { actor } = await resolveActor(territory, fetcher);
  if (typeof actor.inbox !== 'string') throw new Error('Territory Actor has no inbox');
  return { actor: territory, inbox: actor.inbox };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
