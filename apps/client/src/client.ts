import { deriveDiplomaticToken } from '@fctp/auth';
import { checkExitEvidenceBinding, checkExpectedIssuer, createLocalDocumentLoader, verifyKeyAttribution, verifyProofCryptography, withDocuments, type ActorResolution } from '@fctp/identity';
import { FctpClient } from '@fctp/client-sdk';
import { ResourceError, selectMapRepresentation, type ResourceRequestOptions } from '@fctp/resources';
import type { CargoManifest, ExitEvent, FCTPActor, MapDescriptor, URI } from '@fctp/protocol';

export const asciiMapFormat = 'https://fctp.example/formats/ascii';
export const sdk = new FctpClient();

export interface ClientConfig { origins: { authority: string; policy: string; simulation: string }; actors?: Record<string, string> }

export interface BrowserLocalAction {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  request?: { method: 'GET' | 'POST'; href: string; body?: Record<string, unknown> };
  effect: string;
}

export interface BrowserLocalActionDiscovery {
  kind: 'registry' | 'policy' | 'simulation';
  actor: string;
  player: string;
  vessel: string;
  observedAt: string;
  state: Record<string, unknown>;
  actions: BrowserLocalAction[];
  notes: string[];
}

export const fallbackConfig: ClientConfig = {
  origins: { authority: 'http://127.0.0.1:4100', policy: 'http://127.0.0.1:4101', simulation: 'http://127.0.0.1:4102' }
};

export async function loadConfig(): Promise<ClientConfig> {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) return fallbackConfig;
  const value = await response.json() as { origins?: ClientConfig['origins'] };
  if (!value.origins || !['authority', 'policy', 'simulation'].every((key) => typeof value.origins?.[key as keyof ClientConfig['origins']] === 'string')) return fallbackConfig;
  return { origins: value.origins, ...(value && 'actors' in value ? { actors: (value as { actors: Record<string, string> }).actors } : {}) };
}

export async function resolveInput(value: string): Promise<ActorResolution> {
  return value.startsWith('@') || value.includes('@') && !URL.canParse(value)
    ? sdk.resolveWebFinger(value)
    : sdk.resolveActor(value as URI);
}

export async function resolveReference<T extends Record<string, unknown>>(value: unknown, resourceActor?: string, options: ResourceRequestOptions & { nativeToken?: string } = {}): Promise<T> {
  if (typeof value === 'string') return sdk.get<T>(value as URI, { ...options, ...(resourceActor ? { resourceServer: resourceActor as URI } : {}) });
  if (isRecord(value) && typeof value.id === 'string' && Object.keys(value).length === 1) {
    return sdk.get<T>(value.id as URI, { ...options, ...(resourceActor ? { resourceServer: resourceActor as URI } : {}) });
  }
  if (isRecord(value)) return value as T;
  throw new TypeError('Resource reference must be an object or URI');
}

export async function readCollection<T extends Record<string, unknown>>(uri: string, actorId: string, nativeToken?: string): Promise<T[]> {
  const result: T[] = [];
  const token = nativeToken ? await deriveDiplomaticToken(nativeToken, actorId as URI) : undefined;
  for await (const item of sdk.resources.collection<unknown>(uri as URI, token ? { token } : {})) {
    result.push(await resolveReference<T>(item, actorId, nativeToken ? { nativeToken } : {}));
  }
  return result;
}

export async function territoryResources(actor: FCTPActor & Record<string, unknown>, nativeToken?: string): Promise<{ ports: Record<string, unknown>[]; routes: Record<string, unknown>[]; areas: Record<string, unknown>[] }> {
  const resources = actor.resources as Record<string, unknown> | undefined;
  if (!resources) throw new TypeError('Actor does not publish Territory resources');
  const [ports, routes] = await Promise.all([
    readCollection(String(resources.ports), actor.id, nativeToken),
    readCollection(String(resources.routes), actor.id, nativeToken)
  ]);
  const areaRefs = Array.isArray(resources.areas) ? resources.areas : [];
  const areas = await Promise.all(areaRefs.map((area) => resolveReference<Record<string, unknown>>(area, actor.id, nativeToken ? { nativeToken } : {})));
  return { ports, routes, areas };
}

export async function portListings(port: Record<string, unknown>, actorId: string, nativeToken?: string): Promise<Record<string, unknown>[]> {
  if (typeof port.listings !== 'string') return [];
  return readCollection<Record<string, unknown>>(port.listings, actorId, nativeToken);
}

export async function readText(uri: string, nativeToken: string, actorId: string): Promise<string> {
  const token = await deriveDiplomaticToken(nativeToken, actorId as URI);
  const response = await fetch(uri, { headers: { Accept: 'text/plain', Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!response.ok) throw new ResourceError(response.status, response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not-found' : 'http-error');
  return response.text();
}

export async function getAuthenticated<T>(uri: string, actorId: string, nativeToken: string, route: 'direct' | 'proxy', config: ClientConfig): Promise<T> {
  if (route === 'direct') return sdk.get<T>(uri as URI, { nativeToken, resourceServer: actorId as URI, cache: false });
  const response = await fetch(`${config.origins.authority}/local/home/proxy?${new URLSearchParams({ uri, resourceActor: actorId })}`, {
    headers: { Authorization: `Bearer ${nativeToken}`, Accept: 'application/ld+json, application/json' }, cache: 'no-store'
  });
  if (!response.ok) throw new ResourceError(response.status, response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not-found' : 'http-error');
  return response.json() as Promise<T>;
}

export async function mapText(descriptor: MapDescriptor, actorId: string, nativeToken: string): Promise<{ format: string; text: string }> {
  const representation = selectMapRepresentation(descriptor, new Set([asciiMapFormat as URI]));
  const token = await deriveDiplomaticToken(nativeToken, actorId as URI);
  const resources = await Promise.all(representation.resources.map(async (resource) => {
    const response = await fetch(resource.url, { headers: { Authorization: `Bearer ${token}`, Accept: resource.mediaType }, cache: 'no-store' });
    if (!response.ok) throw new ResourceError(response.status, response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not-found' : 'http-error');
    return `${resource.role}\n${await response.text()}`;
  }));
  return { format: representation.format, text: resources.join('\n\n') };
}

export async function verifyExit(uri: string, expectedVessel: string, expectedRegistry: string, registryRequests: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const get = async <T>(resourceUri: string): Promise<T> => {
    const response = await fetcher(resourceUri, { headers: { Accept: 'application/ld+json, application/json' }, cache: 'no-store' });
    if (!response.ok) throw new ResourceError(response.status, response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not-found' : 'http-error');
    return response.json() as Promise<T>;
  };
  const exit = await get<ExitEvent>(uri);
  const territoryActor = await get<FCTPActor>(exit.territory);
  const territory = { actor: territoryActor };
  const keyUris = territoryActor.publicKeys;
  const proof = exit.proof;
  const keyUri = proof.verificationMethod;
  if (!keyUris.includes(keyUri)) throw new Error('Exit proof verification method is not listed by the issuing Territory Actor');
  const keyDocument = await get<Record<string, unknown>>(keyUri);
  const keyDocumentUrl = keyUri.split('#')[0]!;
  const allowed = withDocuments(createLocalDocumentLoader(), new Map([[keyUri, keyDocument], [keyDocumentUrl, keyDocument]]));
  const crypto = await verifyProofCryptography(exit as unknown as Record<string, unknown>, allowed);
  const attribution = await verifyKeyAttribution(exit as unknown as Record<string, unknown>, territory.actor, allowed);
  const request = registryRequests[exit.entryRequest];
  const requestEntry = isRecord(request) && request.type === 'EntryRequest' ? request : undefined;
  const requestVessel = requestEntry && isRecord(requestEntry.vessel) ? requestEntry.vessel : undefined;
  const requestDestination = requestEntry && isRecord(requestEntry.destination) ? requestEntry.destination : undefined;
  const exactRequest = requestEntry?.id === exit.entryRequest;
  const contextMatches = requestVessel?.id === expectedVessel && requestVessel.registry === expectedRegistry;
  const destinationTerritory = typeof requestDestination?.territory === 'string' ? requestDestination.territory : undefined;
  const expectedIssuer = destinationTerritory
    ? checkExpectedIssuer(territoryActor.id as URI, destinationTerritory as URI)
    : { status: 'unknown', reason: 'EntryRequest destination territory is unavailable' };
  const checkedBinding = checkExitEvidenceBinding(exit, {
    vessel: expectedVessel as URI,
    entryRequest: (requestEntry?.id ?? exit.entryRequest) as URI,
    ...(destinationTerritory ? { territory: destinationTerritory as URI } : {})
  });
  const binding = {
    ...checkedBinding,
    requestExists: Boolean(requestEntry),
    exactRequest,
    expectedVesselMatches: requestVessel?.id === expectedVessel,
    registryMatches: requestVessel?.registry === expectedRegistry,
    destinationTerritoryMatches: destinationTerritory === exit.territory,
    bound: checkedBinding.bound && Boolean(requestEntry) && exactRequest && contextMatches && destinationTerritory === exit.territory
  };
  return {
    exit: { id: exit.id, territory: exit.territory, vessel: exit.vessel, entryRequest: exit.entryRequest, cargo: exit.cargo },
    proofCryptography: crypto.verified ? 'verified' : 'failed',
    keyAttribution: attribution.attributed ? 'attributed' : `not attributed: ${attribution.reason ?? 'unknown'}`,
    expectedIssuer: 'status' in expectedIssuer ? expectedIssuer : expectedIssuer.matches ? 'verified' : 'failed',
    binding,
    registryDeclaredCargo: undefined,
    difference: undefined
  };
}

export function cargoManifest(value: unknown): CargoManifest {
  if (!isRecord(value) || !Array.isArray(value.entries)) throw new TypeError('Cargo must be a CargoManifest with entries');
  return value as unknown as CargoManifest;
}

export async function localRequest<T>(origin: string, path: string, options: { method?: 'GET' | 'POST'; body?: unknown; token?: string; fetcher?: typeof fetch } = {}): Promise<T> {
  const response = await (options.fetcher ?? fetch)(`${origin}${path}`, {
    method: options.method ?? 'GET',
    headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), cache: 'no-store'
  });
  if (!response.ok) throw new ResourceError(response.status, response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not-found' : 'http-error');
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function configuredOrigin(url: string, config: ClientConfig): string {
  const target = new URL(url);
  const origins = Object.values(config.origins).map((origin) => new URL(origin).origin);
  if (!origins.includes(target.origin)) throw new TypeError(`Request origin is not configured: ${target.origin}`);
  return target.origin;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
