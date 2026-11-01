import { randomUUID } from 'node:crypto';
import { deriveDiplomaticToken } from '@fctp/auth';
import { FctpClient } from '@fctp/client-sdk';
import type { URI } from '@fctp/protocol';
import type {
  AccountRecord,
  AuthorityRecord,
  ExploreBlockerRecord,
  ExploreCapabilityRecord,
  ExploreCapabilitySnapshot,
  ExploreConnectionRecord,
  ExplorePlaceDetailData,
  ExplorePlaceRecord,
  ExplorePlaceState,
  ExplorePlacesData,
  ExploreResourceRecord,
  ExploreVesselPosition,
  PageResponse,
  ResourceReaderData,
  RoutePlanLeg,
  RoutePlanRecord,
  SourcedObservation
} from '@fctp/client-sdk';
import { withDeadline } from './deadline.js';
import type { ObservationService } from './observations.js';
import { resourceObservationKey } from './resource-observations.js';
import type { ClientApplicationState } from './store.js';

export class ExploreRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export interface ExploreServiceOptions {
  timeoutMs?: number;
}

export interface ExploreService {
  listPlaces(accountId?: string, vesselId?: string): Promise<PageResponse<ExplorePlacesData>>;
  refresh(input: { accountId?: string; vesselId?: string }): Promise<PageResponse<ExplorePlacesData>>;
  placeDetail(placeId: string, accountId?: string, vesselId?: string): Promise<PageResponse<ExplorePlaceDetailData>>;
  refreshPlace(placeId: string, input: { accountId?: string; vesselId?: string }): Promise<PageResponse<ExplorePlaceDetailData>>;
  createRoute(input: { accountId: string; from: string; to: string }): Promise<PageResponse<{ plan: RoutePlanRecord }>>;
  routeDetail(routeId: string, accountId: string | undefined): Promise<PageResponse<{ plan: RoutePlanRecord }>>;
  readResource(resourceId: string, input: { accountId?: string; authorityId?: string }): Promise<PageResponse<ResourceReaderData>>;
  refreshResource(resourceId: string, input: { accountId?: string; authorityId?: string }): Promise<PageResponse<ResourceReaderData>>;
}

const SEP = '\u0000';
const EXPLORE = 'explore';
const DEFAULT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retainedValue<T>(observation: SourcedObservation<T>): T | undefined {
  return observation.state === 'available' || observation.state === 'stale' || observation.state === 'empty' ? observation.value : undefined;
}

interface StoredObservation {
  storedKey: string;
  observation: SourcedObservation<unknown>;
}

interface PlaceLookup {
  record?: ExplorePlaceRecord;
  state: ExplorePlaceState;
  error?: string;
}

function keyParts(storedKey: string): string[] {
  return storedKey.split(SEP);
}

function observationKind(storedKey: string): string | undefined {
  return keyParts(storedKey)[1];
}

function observationId(storedKey: string): string | undefined {
  return keyParts(storedKey)[2];
}

function visitPosition(state: unknown, vesselId: string): Pick<ExploreVesselPosition, 'status' | 'portId'> {
  if (!isRecord(state)) return { status: 'unknown' };
  if (Array.isArray(state.visits)) {
    if (state.visits.length === 0) return { status: 'absent' };
    const matching = state.visits.filter((visit) => isRecord(visit) && visit.vessel === vesselId);
    if (matching.length !== 1) return { status: 'unknown' };
    const visit = matching[0] as Record<string, unknown>;
    if (visit.departed === true) return { status: 'departed' };
    if (visit.departed !== false || typeof visit.port !== 'string') return { status: 'unknown' };
    try {
      const port = new URL(visit.port);
      if (!['http:', 'https:'].includes(port.protocol) || port.username || port.password) return { status: 'unknown' };
    } catch (error) {
      if (error instanceof TypeError) return { status: 'unknown' };
      throw error;
    }
    return { status: 'active', portId: visit.port };
  }
  return { status: state.visit === null ? 'absent' : 'unknown' };
}

export function createExploreService(
  state: ClientApplicationState,
  fetcher: typeof fetch,
  observations: ObservationService,
  options: ExploreServiceOptions = {}
): ExploreService {
  const scoped = (accountId?: string, vesselId?: string): ExploreService => createScopedExploreService(state, fetcher, observations, options, accountId, vesselId);
  return {
    listPlaces: (accountId, vesselId) => scoped(accountId, vesselId).listPlaces(accountId, vesselId),
    refresh: (input) => scoped(input.accountId, input.vesselId).refresh(input),
    placeDetail: (id, accountId, vesselId) => scoped(accountId, vesselId).placeDetail(id, accountId, vesselId),
    refreshPlace: (id, input) => scoped(input.accountId, input.vesselId).refreshPlace(id, input),
    createRoute: (input) => scoped(input.accountId).createRoute(input),
    routeDetail: (id, accountId) => scoped(accountId).routeDetail(id, accountId),
    readResource: (id, input) => scoped(input.accountId).readResource(id, input),
    refreshResource: (id, input) => scoped(input.accountId).refreshResource(id, input)
  };
}

function createScopedExploreService(
  state: ClientApplicationState,
  fetcher: typeof fetch,
  observations: ObservationService,
  options: ExploreServiceOptions,
  scopeAccountId?: string,
  scopeVesselId?: string
): ExploreService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const visitedAuthorities = new Set<string>();
  const call = <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => withDeadline(timeoutMs, operation);
  const prefix = scopeAccountId === undefined ? EXPLORE : `explore-account:${scopeAccountId}`;
  const exploreKey = (kind: string, ...parts: string[]): string => [prefix, kind, ...parts].join(SEP);
  const visible = (key: string): boolean => key.startsWith(`${EXPLORE}${SEP}`) || key.startsWith(`${prefix}${SEP}`);

  const exploreEntries = async (): Promise<StoredObservation[]> => state.read((current) => Object.entries(current.observations)
    .filter(([storedKey]) => {
      if (!visible(storedKey)) return false;
      if (observationKind(storedKey) !== 'capabilities') return true;
      const parts = keyParts(storedKey);
      return scopeAccountId !== undefined && scopeVesselId !== undefined && parts[2] === scopeAccountId && parts[3] === scopeVesselId;
    })
    .map(([storedKey, observation]) => ({ storedKey, observation })));

  const retainValue = async <T>(key: string, source: string, value: T): Promise<void> => {
    await observations.refresh<T>({ key, source, load: async () => value });
  };

  const retainFailure = async (key: string, source: string, error: unknown): Promise<void> => {
    await observations.refresh({ key, source, load: async (): Promise<never> => { throw error; } });
  };

  const readPublicFirst = async (uri: string, signal: AbortSignal, authorityId?: string): Promise<unknown> => {
    const account = scopeAccountId === undefined ? undefined : await state.read((current) => current.accounts[scopeAccountId]);
    const sdk = new FctpClient({ fetcher: (input, init) => fetcher(input, { ...init, signal }) });
    return sdk.getPublicFirst(uri as URI, {
      ...(account?.login.status === 'signed-in' ? { nativeToken: account.login.nativeToken } : {}),
      ...(authorityId === undefined ? {} : { resourceServer: authorityId as URI })
    });
  };

  const readCollection = async (uri: string, authorityId: string): Promise<unknown[]> => {
    const items: unknown[] = [];
    const visited = new Set<string>();
    let next: string | undefined = uri;
    while (next !== undefined) {
      if (visited.has(next)) throw new TypeError('Collection pagination loop');
      visited.add(next);
      const target: string = next;
      const page: unknown = await call((signal) => readPublicFirst(target, signal, authorityId));
      if (!isRecord(page)) throw new Error('Collection page is not an object');
      const entries: unknown = page.orderedItems ?? page.items ?? [];
      if (!Array.isArray(entries)) throw new Error('Collection items are not an array');
      items.push(...entries);
      const nextReference: unknown = page.next;
      next = typeof nextReference === 'string'
        ? nextReference
        : isRecord(nextReference) && typeof nextReference.id === 'string' ? nextReference.id : undefined;
    }
    return items;
  };

  const resolveItem = async (item: unknown, authorityId: string): Promise<{ id?: string; value?: Record<string, unknown>; error?: string }> => {
    if (isRecord(item) && typeof item.id === 'string' && Object.keys(item).length > 1) return { id: item.id, value: item };
    const id = typeof item === 'string' ? item : isRecord(item) && typeof item.id === 'string' ? item.id : undefined;
    if (!id) return { error: 'Collection item is not an identifiable reference' };
    try {
      const value = await call((signal) => readPublicFirst(id, signal, authorityId));
      if (!isRecord(value)) throw new Error('Resource is not an object');
      return { id, value };
    } catch (error) {
      return { id, error: errorMessage(error) };
    }
  };

  const placeFromPort = (id: string, value: Record<string, unknown>, authorityId: string): ExplorePlaceRecord => {
    const resources = isRecord(value.resources) ? value.resources : {};
    const listings = typeof value.listings === 'string' ? value.listings : typeof resources.listings === 'string' ? resources.listings : undefined;
    const area = typeof value.area === 'string' ? value.area : undefined;
    const territory = typeof value.territory === 'string' ? value.territory : undefined;
    return {
      id,
      type: typeof value.type === 'string' ? value.type : 'Port',
      authorityId,
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(territory === undefined ? {} : { territoryId: territory }),
      ...(area === undefined ? {} : { areaId: area }),
      ...(listings === undefined ? {} : { listingsId: listings })
    };
  };

  const connectionFromRoute = (id: string, value: Record<string, unknown>, authorityId: string): ExploreConnectionRecord => {
    const from = typeof value.from === 'string' ? value.from : '';
    const to = typeof value.to === 'string' ? value.to : '';
    return {
      id,
      type: 'Route',
      from,
      to,
      territoryId: typeof value.territory === 'string' ? value.territory : authorityId,
      authorityId,
      ...(typeof value.name === 'string' ? { name: value.name } : {})
    };
  };

  const resourceFrom = (id: string, value: Record<string, unknown>, authorityId: string, defaultType = 'Resource'): ExploreResourceRecord => {
    const boundaries = Array.isArray(value.boundaries)
      ? value.boundaries.flatMap((entry) => {
          if (typeof entry === 'string') return [entry];
          if (isRecord(entry) && typeof entry.id === 'string') return [entry.id];
          return [];
        })
      : [];
    return {
      id,
      type: typeof value.type === 'string' ? value.type : defaultType,
      authorityId,
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(typeof value.territory === 'string' ? { territoryId: value.territory } : {}),
      ...(boundaries.length === 0 ? {} : { boundaries })
    };
  };

  const refreshResource = async (id: string, authorityId: string, source: string, defaultType = 'Resource'): Promise<ExploreResourceRecord | undefined> => {
    try {
      const value = await call((signal) => readPublicFirst(id, signal, authorityId));
      if (!isRecord(value)) throw new Error('Resource is not an object');
      const record = resourceFrom(id, value, authorityId, defaultType);
      await retainValue(exploreKey('resource', id), source, record);
      if (record.type === 'Port' || record.type === 'Boundary' || record.type === 'Area') {
        await retainValue(exploreKey('place', id), source, placeFromPort(id, value, authorityId));
      }
      if (record.territoryId !== undefined && record.territoryId !== authorityId) {
        const linked = record.territoryId;
        const account = scopeAccountId === undefined ? undefined : await state.read((current) => current.accounts[scopeAccountId]);
        await refreshAuthority({ actorId: linked, server: new URL(linked).host, roles: ['territory'] }, account, scopeVesselId);
      }
      return record;
    } catch (error) {
      await retainFailure(exploreKey('resource', id), source, error);
      return undefined;
    }
  };

  const refreshListings = async (uri: string, authorityId: string, source: string): Promise<void> => {
    try {
      const items = await readCollection(uri, authorityId);
      for (const item of items) {
        const resolved = await resolveItem(item, authorityId);
        if (resolved.id === undefined || resolved.value === undefined) continue;
        await retainValue(exploreKey('resource', resolved.id), source, resourceFrom(resolved.id, resolved.value, authorityId, 'Listing'));
      }
    } catch (error) {
      await retainFailure(exploreKey('listings', uri), source, error);
    }
  };

  const refreshCapabilities = async (authority: AuthorityRecord, account: AccountRecord | undefined, vesselId: string | undefined): Promise<void> => {
    if (!account || account.login.status !== 'signed-in' || !vesselId) return;
    const endpoint = new URL('/local/actions', new URL(authority.actorId).origin);
    endpoint.searchParams.set('vessel', vesselId);
    const capabilityKey = exploreKey('capabilities', account.id, vesselId, authority.actorId);
    try {
      const infoUri = new URL('/local/info', authority.actorId).href;
      const info = await call((signal) => readPublicFirst(infoUri, signal, authority.actorId));
      if (!isRecord(info) || !['policy', 'simulation'].includes(String(info.kind)) || !Array.isArray(info.endpoints) || !info.endpoints.includes('/local/actions')) {
        throw new TypeError('No supported actions service is advertised');
      }
      const token = await deriveDiplomaticToken(account.login.nativeToken, authority.actorId);
      const snapshot = await call(async (signal): Promise<ExploreCapabilitySnapshot> => {
        const response = await fetcher(endpoint.href, {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
          cache: 'no-store',
          signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload: unknown = await response.json();
        if (!isRecord(payload) || !Array.isArray(payload.actions)) throw new Error('Action discovery response is malformed');
        const actions: ExploreCapabilityRecord[] = payload.actions.flatMap((action) => {
          if (!isRecord(action) || typeof action.id !== 'string' || typeof action.label !== 'string') return [];
          const requestValue = isRecord(action.request) ? action.request : undefined;
          const method = requestValue?.method;
          const request: ExploreCapabilityRecord['request'] = requestValue !== undefined && typeof requestValue.href === 'string' && (method === 'GET' || method === 'POST')
            ? {
                method,
                href: requestValue.href,
                ...(isRecord(requestValue.body) ? { body: requestValue.body } : {})
              }
            : undefined;
          return [{
            id: action.id,
            label: action.label,
            available: action.available === true,
            ...(typeof action.reason === 'string' ? { reason: action.reason } : {}),
            ...(request === undefined ? {} : { request }),
            effect: typeof action.effect === 'string' ? action.effect : ''
          }];
        });
        return {
          territoryId: authority.actorId,
          authorityId: authority.actorId,
          accountId: account.id,
          vesselId,
          observedAt: new Date().toISOString(),
          ...(isRecord(payload.state) ? { state: payload.state } : {}),
          actions
        };
      });
      await retainValue(capabilityKey, endpoint.href, snapshot);
      if (snapshot.state !== undefined) {
        await retainValue(`position:${account.id}:${vesselId}`, endpoint.href, { vessel: vesselId, authorityId: authority.actorId, state: snapshot.state });
      }
    } catch (error) {
      await retainFailure(capabilityKey, endpoint.href, error);
    }
  };

  const refreshAuthority = async (authority: AuthorityRecord, account: AccountRecord | undefined, vesselId: string | undefined): Promise<void> => {
    if (visitedAuthorities.has(authority.actorId)) return;
    visitedAuthorities.add(authority.actorId);
    const source = authority.actorId;
    let actor: Record<string, unknown>;
    try {
      const loaded = await call((signal) => readPublicFirst(authority.actorId, signal, authority.actorId));
      if (!isRecord(loaded) || loaded.id !== authority.actorId || loaded.role !== 'territory') throw new Error('Linked Actor is not the advertised Territory');
      actor = loaded;
    } catch (error) {
      await retainFailure(exploreKey('authority', authority.actorId), source, error);
      return;
    }
    try {
      const resources = isRecord(actor.resources) ? actor.resources : {};
      const portsUri = typeof resources.ports === 'string' ? resources.ports : undefined;
      const routesUri = typeof resources.routes === 'string' ? resources.routes : undefined;
      if (portsUri === undefined || routesUri === undefined) throw new Error('Territory Actor does not advertise ports and routes');
      const known = new Set<string>();
      const endpointIds = new Set<string>();

      for (const item of await readCollection(portsUri, authority.actorId)) {
        const resolved = await resolveItem(item, authority.actorId);
        if (resolved.id === undefined) continue;
        known.add(resolved.id);
        if (resolved.value === undefined) {
          await retainFailure(exploreKey('place', resolved.id), source, new Error(resolved.error ?? 'Port retrieval failed'));
          continue;
        }
        const record = placeFromPort(resolved.id, resolved.value, authority.actorId);
        await retainValue(exploreKey('place', resolved.id), source, record);
        if (record.listingsId !== undefined) await refreshListings(record.listingsId, authority.actorId, source);
      }

      for (const item of await readCollection(routesUri, authority.actorId)) {
        const resolved = await resolveItem(item, authority.actorId);
        if (resolved.id === undefined) continue;
        if (resolved.value === undefined) {
          await retainFailure(exploreKey('connection', resolved.id), source, new Error(resolved.error ?? 'Route retrieval failed'));
          continue;
        }
        const record = connectionFromRoute(resolved.id, resolved.value, authority.actorId);
        await retainValue(exploreKey('connection', resolved.id), source, record);
        if (record.from) endpointIds.add(record.from);
        if (record.to) endpointIds.add(record.to);
      }

      const areaReferences = Array.isArray(resources.areas) ? resources.areas : [];
      for (const reference of areaReferences) {
        const resolved = await resolveItem(reference, authority.actorId);
        if (resolved.id === undefined) continue;
        known.add(resolved.id);
        if (resolved.value === undefined) {
          await retainFailure(exploreKey('resource', resolved.id), source, new Error(resolved.error ?? 'Area retrieval failed'));
          continue;
        }
        const record = resourceFrom(resolved.id, resolved.value, authority.actorId, 'Area');
        await retainValue(exploreKey('resource', resolved.id), source, record);
        for (const boundary of record.boundaries ?? []) {
          known.add(boundary);
          await refreshResource(boundary, authority.actorId, source, 'Boundary');
        }
      }

      if (typeof resources.map === 'string') {
        known.add(resources.map);
        await refreshResource(resources.map, authority.actorId, source, 'MapDescriptor');
      }

      for (const endpointId of endpointIds) {
        if (known.has(endpointId)) continue;
        known.add(endpointId);
        await refreshResource(endpointId, authority.actorId, source);
      }

      await retainValue(exploreKey('authority', authority.actorId), source, {
        actorId: authority.actorId,
        places: [...known].length,
        observedAt: new Date().toISOString()
      });
      await refreshCapabilities(authority, account, vesselId);
    } catch (error) {
      await retainFailure(exploreKey('authority', authority.actorId), source, error);
    }
  };

  const readPlaceLookup = async (): Promise<Map<string, PlaceLookup>> => {
    const lookup = new Map<string, PlaceLookup>();
    for (const { storedKey, observation } of await exploreEntries()) {
      if (observationKind(storedKey) !== 'place') continue;
      const id = observationId(storedKey);
      if (id === undefined) continue;
      const value = retainedValue(observation);
      lookup.set(id, {
        ...(isRecord(value) ? { record: value as unknown as ExplorePlaceRecord } : {}),
        state: observation.state,
        ...(observation.state === 'available' || observation.state === 'empty'
          ? {}
          : 'error' in observation && typeof observation.error === 'string' ? { error: observation.error } : {})
      });
    }
    return lookup;
  };

  const readConnections = async (): Promise<ExploreConnectionRecord[]> => {
    const records = new Map<string, ExploreConnectionRecord>();
    for (const { storedKey, observation } of await exploreEntries()) {
      if (observationKind(storedKey) !== 'connection') continue;
      const value = retainedValue(observation);
      if (!isRecord(value)) continue;
      const record = value as unknown as ExploreConnectionRecord;
      records.set(record.id, record);
    }
    return [...records.values()];
  };

  const readResourceRecords = async (): Promise<ExploreResourceRecord[]> => {
    const records = new Map<string, ExploreResourceRecord>();
    for (const { storedKey, observation } of await exploreEntries()) {
      if (observationKind(storedKey) !== 'resource') continue;
      const value = retainedValue(observation);
      if (!isRecord(value)) continue;
      const record = value as unknown as ExploreResourceRecord;
      records.set(record.id, record);
    }
    return [...records.values()];
  };

  const readCapabilitySnapshots = async (): Promise<Map<string, ExploreCapabilitySnapshot>> => {
    const snapshots = new Map<string, ExploreCapabilitySnapshot>();
    for (const { storedKey, observation } of await exploreEntries()) {
      if (observationKind(storedKey) !== 'capabilities') continue;
      const value = retainedValue(observation);
      if (!isRecord(value)) continue;
      const snapshot = value as unknown as ExploreCapabilitySnapshot;
      if (scopeAccountId === undefined || scopeVesselId === undefined || snapshot.accountId !== scopeAccountId || snapshot.vesselId !== scopeVesselId) continue;
      snapshots.set(snapshot.territoryId, snapshot);
    }
    return snapshots;
  };

  const readPositions = async (): Promise<ExploreVesselPosition[]> => {
    if (scopeAccountId === undefined || scopeVesselId === undefined) return [];
    const positions: ExploreVesselPosition[] = [];
    for (const { storedKey, observation } of await exploreEntries()) {
      if (observationKind(storedKey) !== 'capabilities') continue;
      const authorityId = keyParts(storedKey)[4];
      if (authorityId === undefined) continue;
      const value = retainedValue(observation);
      if (value !== undefined && (!isRecord(value) || value.accountId !== scopeAccountId
        || value.vesselId !== scopeVesselId || value.authorityId !== authorityId)) continue;
      positions.push({
        accountId: scopeAccountId,
        vesselId: scopeVesselId,
        authorityId,
        source: observation.source,
        state: observation.state,
        ...('observedAt' in observation && observation.observedAt !== undefined ? { observedAt: observation.observedAt } : {}),
        ...('error' in observation && observation.error !== undefined ? { error: observation.error } : {}),
        ...visitPosition(isRecord(value) ? value.state : undefined, scopeVesselId)
      });
    }
    return positions;
  };

  const blockersFrom = (entries: readonly StoredObservation[]): ExploreBlockerRecord[] => {
    const blockers: ExploreBlockerRecord[] = [];
    for (const { storedKey, observation } of entries) {
      if (observation.state !== 'unavailable' && observation.state !== 'stale') continue;
      if (!('error' in observation) || typeof observation.error !== 'string') continue;
      const id = observationId(storedKey) ?? observationKind(storedKey) ?? 'unknown';
      blockers.push({ id, source: observation.source, message: observation.error, state: observation.state });
    }
    return blockers;
  };

  const publicObservations = async (accountId: string | undefined, vesselId: string | undefined): Promise<Record<string, SourcedObservation<unknown>>> => {
    const stored = await state.read((current) => current.observations);
    const result: Record<string, SourcedObservation<unknown>> = {};
    for (const [storedKey, observation] of Object.entries(stored)) {
      if (visible(storedKey)) {
        if (observationKind(storedKey) === 'capabilities') {
          const parts = keyParts(storedKey);
          if (accountId === undefined || vesselId === undefined || parts[2] !== accountId || parts[3] !== vesselId) continue;
        }
        result[storedKey] = observation;
        continue;
      }
      if (accountId === undefined || vesselId === undefined) continue;
      const positionKey = `position:${accountId}:${vesselId}`;
      if (storedKey === positionKey || storedKey.startsWith(`${positionKey}${SEP}`)) result[storedKey] = observation;
    }
    return result;
  };

  const listData = async (): Promise<ExplorePlacesData> => {
    const entries = await exploreEntries();
    const places = new Map<string, ExplorePlaceRecord>();
    for (const { storedKey, observation } of entries) {
      if (observationKind(storedKey) !== 'place') continue;
      const value = retainedValue(observation);
      if (!isRecord(value)) continue;
      const record = value as unknown as ExplorePlaceRecord;
      places.set(record.id, record);
    }
    const resources = await readResourceRecords();
    const snapshots = await readCapabilitySnapshots();
    return {
      places: [...places.values()],
      connections: await readConnections(),
      areas: resources.filter((resource) => resource.type === 'Area'),
      maps: resources.filter((resource) => resource.type === 'MapDescriptor'),
      listings: resources.filter((resource) => resource.type === 'Listing'),
      capabilities: [...snapshots.values()].flatMap((snapshot) => snapshot.actions),
      blockers: blockersFrom(entries),
      positions: await readPositions()
    };
  };

  const placesPage = async (accountId: string | undefined, vesselId: string | undefined): Promise<PageResponse<ExplorePlacesData>> => ({
    context: { ...(accountId === undefined ? {} : { accountId }), ...(vesselId === undefined ? {} : { vesselId }) },
    data: await listData(),
    observations: await publicObservations(accountId, vesselId),
    actions: []
  });

  const enrichConnection = (connection: ExploreConnectionRecord, lookup: Map<string, PlaceLookup>): ExploreConnectionRecord => {
    const endpoint = (id: string) => {
      const match = lookup.get(id);
      return {
        id,
        state: match?.state ?? 'not-retrieved' as ExplorePlaceState,
        ...(match?.record?.name === undefined ? {} : { name: match.record.name }),
        ...(match?.error === undefined ? {} : { error: match.error })
      };
    };
    return { ...connection, endpoints: [endpoint(connection.from), endpoint(connection.to)] };
  };

  const placeData = async (placeId: string): Promise<ExplorePlaceDetailData> => {
    const entries = await exploreEntries();
    const lookup = await readPlaceLookup();
    const record = lookup.get(placeId)?.record;
    if (record === undefined) throw new ExploreRequestError(404, 'place-not-found');
    const connections = (await readConnections())
      .filter((connection) => connection.from === placeId || connection.to === placeId)
      .map((connection) => enrichConnection(connection, lookup));
    const onward = new Map<string, ExplorePlaceRecord>();
    const blockers: ExploreBlockerRecord[] = [];
    for (const connection of connections) {
      for (const endpoint of connection.endpoints ?? []) {
        if (endpoint.state !== 'available' && endpoint.state !== 'empty') {
          blockers.push({
            id: endpoint.id,
            source: connection.authorityId,
            message: `${endpoint.id} is ${endpoint.state}${endpoint.error === undefined ? '' : `: ${endpoint.error}`}`,
            state: endpoint.state
          });
        }
      }
      const otherId = connection.from === placeId ? connection.to : connection.from;
      const other = lookup.get(otherId)?.record ?? { id: otherId, type: 'Place', authorityId: connection.authorityId };
      onward.set(other.id, other);
    }
    const resources = (await readResourceRecords()).filter((resource) => resource.authorityId === record.authorityId);
    const snapshot = (await readCapabilitySnapshots()).get(record.authorityId);
    return {
      place: record,
      onward: [...onward.values()],
      connections,
      areas: resources.filter((resource) => resource.type === 'Area'),
      maps: resources.filter((resource) => resource.type === 'MapDescriptor'),
      listings: resources.filter((resource) => resource.type === 'Listing'),
      capabilities: snapshot?.actions ?? [],
      blockers: [...blockers, ...blockersFrom(entries.filter(({ storedKey }) => observationKind(storedKey) === 'resource'))],
      positions: await readPositions()
    };
  };

  const placePage = async (placeId: string, accountId: string | undefined, vesselId: string | undefined): Promise<PageResponse<ExplorePlaceDetailData>> => ({
    context: { placeId, ...(accountId === undefined ? {} : { accountId }), ...(vesselId === undefined ? {} : { vesselId }) },
    data: await placeData(placeId),
    observations: await publicObservations(accountId, vesselId),
    actions: []
  });

  const findPath = (connections: readonly ExploreConnectionRecord[], from: string, to: string): ExploreConnectionRecord[] | undefined => {
    const adjacency = new Map<string, ExploreConnectionRecord[]>();
    for (const connection of connections) {
      if (!connection.from || !connection.to) continue;
      const edges = adjacency.get(connection.from) ?? [];
      edges.push(connection);
      adjacency.set(connection.from, edges);
    }
    const queue: Array<{ id: string; path: ExploreConnectionRecord[] }> = [{ id: from, path: [] }];
    const visited = new Set<string>([from]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.id === to) return current.path;
      for (const edge of adjacency.get(current.id) ?? []) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        queue.push({ id: edge.to, path: [...current.path, edge] });
      }
    }
    return undefined;
  };

  const resourceKey = (resourceId: string, accountId: string | undefined): { key: string; source: string; storedKey: string } =>
    resourceObservationKey(accountId, resourceId);

  const mediaUrls = (value: unknown): string[] => {
    if (!isRecord(value) || !Array.isArray(value.media)) return [];
    return value.media.flatMap((entry) => isRecord(entry) && typeof entry.url === 'string' ? [entry.url] : []);
  };

  const mediaObservations = async (value: unknown, accountId: string | undefined): Promise<Record<string, SourcedObservation<unknown>>> => {
    const observationsByKey: Record<string, SourcedObservation<unknown>> = {};
    for (const url of mediaUrls(value)) {
      const { key, source, storedKey } = resourceKey(url, accountId);
      observationsByKey[storedKey] = await observations.readOne(key, source);
    }
    return observationsByKey;
  };

  const resourcePage = async (resourceId: string, accountId: string | undefined, authorityId: string | undefined, observation: SourcedObservation<unknown>, storedKey: string): Promise<PageResponse<ResourceReaderData>> => {
    const value = retainedValue(observation);
    return {
      context: { resourceId, ...(accountId === undefined ? {} : { accountId }) },
      data: {
        resourceId,
        ...(authorityId === undefined ? {} : { authorityId }),
        ...(value === undefined ? {} : { value })
      },
      observations: { [storedKey]: observation, ...await mediaObservations(value, accountId) },
      actions: []
    };
  };

  const readAccount = async (accountId: string | undefined): Promise<AccountRecord | undefined> =>
    accountId === undefined ? undefined : state.read((current) => current.accounts[accountId]);

  return {
    async listPlaces(accountId, vesselId) {
      return placesPage(accountId, vesselId);
    },
    async refresh(input) {
      const account = await readAccount(input.accountId);
      const authorities = await state.read((current) => Object.values(current.authorities).filter((authority) => authority.roles.includes('territory')));
      await Promise.all(authorities.map((authority) => refreshAuthority(authority, account, input.vesselId)));
      return placesPage(input.accountId, input.vesselId);
    },
    async placeDetail(placeId, accountId, vesselId) {
      return placePage(placeId, accountId, vesselId);
    },
    async refreshPlace(placeId, input) {
      const lookup = await readPlaceLookup();
      const authorityId = lookup.get(placeId)?.record?.authorityId;
      if (authorityId === undefined) throw new ExploreRequestError(404, 'place-not-found');
      const authority = await state.read((current) => current.authorities[authorityId]);
      if (authority === undefined) throw new ExploreRequestError(404, 'place-not-found');
      await refreshAuthority(authority, await readAccount(input.accountId), input.vesselId);
      return placePage(placeId, input.accountId, input.vesselId);
    },
    async createRoute(input) {
      if (!await state.read((current) => current.accounts[input.accountId])) throw new ExploreRequestError(404, 'account-not-found');
      const lookup = await readPlaceLookup();
      const connections = await readConnections();
      const known = new Set<string>(lookup.keys());
      for (const resource of await readResourceRecords()) known.add(resource.id);
      for (const connection of connections) {
        known.add(connection.from);
        known.add(connection.to);
      }
      if (!known.has(input.from) || !known.has(input.to)) throw new ExploreRequestError(400, 'unknown-place');
      const path = findPath(connections, input.from, input.to);
      if (path === undefined) throw new ExploreRequestError(400, 'no-directed-route');
      const legs: RoutePlanLeg[] = path.map((connection) => ({
        routeId: connection.id,
        from: connection.from,
        to: connection.to,
        territoryId: connection.territoryId
      }));
      const blockers: ExploreBlockerRecord[] = [];
      for (const connection of path) {
        for (const endpointId of [connection.from, connection.to]) {
          const match = lookup.get(endpointId);
          if (match?.record !== undefined) continue;
          const state: ExplorePlaceState = match?.state ?? 'not-retrieved';
          blockers.push({
            id: endpointId,
            source: connection.authorityId,
            message: `${endpointId} is ${state}${match?.error === undefined ? '' : `: ${match.error}`}`,
            state
          });
        }
      }
      const plan: RoutePlanRecord = {
        id: `route-plan:${randomUUID()}`,
        accountId: input.accountId,
        from: input.from,
        to: input.to,
        legs,
        blockers,
        createdAt: new Date().toISOString()
      };
      await state.transaction((current) => {
        current.routePlans[plan.id] = plan as unknown as Record<string, unknown>;
      });
      return {
        context: { accountId: input.accountId },
        data: { plan },
        observations: {},
        actions: []
      };
    },
    async routeDetail(routeId, accountId) {
      if (accountId === undefined) throw new ExploreRequestError(400, 'account-id-required');
      const stored = await state.read((current) => current.routePlans[routeId]);
      if (!isRecord(stored) || stored.accountId !== accountId) throw new ExploreRequestError(404, 'route-not-found');
      const plan = stored as unknown as RoutePlanRecord;
      return {
        context: { routeId, accountId },
        data: { plan },
        observations: {},
        actions: []
      };
    },
    async readResource(resourceId, input) {
      const { key, source, storedKey } = resourceKey(resourceId, input.accountId);
      const observation = await observations.readOne(key, source);
      return resourcePage(resourceId, input.accountId, input.authorityId, observation, storedKey);
    },
    async refreshResource(resourceId, input) {
      const { key, source, storedKey } = resourceKey(resourceId, input.accountId);
      const observation = await observations.refresh<unknown>({
        key,
        source,
        timeoutMs,
        load: async (signal) => {
          return readPublicFirst(resourceId, signal, input.authorityId);
        }
      });
      const value = retainedValue(observation);
      if (isRecord(value)) {
        for (const url of mediaUrls(value)) {
          const mediaKey = resourceKey(url, input.accountId);
          await observations.refresh<unknown>({
            key: mediaKey.key,
            source: mediaKey.source,
            timeoutMs,
            load: (signal) => readPublicFirst(url, signal, input.authorityId)
          });
        }
      }
      return resourcePage(resourceId, input.accountId, input.authorityId, observation, storedKey);
    }
  };
}
