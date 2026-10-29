import { deriveDiplomaticToken, type HomeLoginRequest, type HomeLoginResult } from '@fctp/auth';
import { parseHandle, resolveActor, resolveWebFinger, type ActorResolution } from '@fctp/identity';
import { ResourceClient, resourceError, type ResourceRequestOptions } from '@fctp/resources';
import { compareCargo, type CargoManifest, type FCTPActor, type URI } from '@fctp/protocol';
export { actionIsComplete, observationIsCurrent, toPublicAccount } from './application.js';
export type { AccountRecord, AccountScopedRequest, ActionDescriptor, ActionEvidence, ActionRecord, AuthorityRecord, AuthorityRole, ExploreBlockerRecord, ExploreCapabilityRecord, ExploreCapabilitySnapshot, ExploreConnectionRecord, ExploreEndpointRecord, ExplorePlaceDetailData, ExplorePlaceRecord, ExplorePlaceState, ExplorePlacesData, ExploreResourceRecord, LoginState, LogisticsRegistryObservation, LogisticsTerritoryObservation, LogisticsVesselData, LogisticsVesselIdentity, PageContext, PageResponse, ProductionAuthorityRecord, ProductionData, ProductionJob, ProductionJobProgress, ProductionOperation, ProductionOperationInput, ProductionOperationKind, PublicAccountRecord, ResourceReaderData, RoutePlanLeg, RoutePlanRecord, ServerRecord, SourcedObservation } from './application.js';

export interface ClientSdkOptions { fetcher?: typeof fetch; resources?: ResourceClient }

export interface AccountResolution {
  handle: string;
  actorId: URI;
  actor: FCTPActor;
  homeServer: string;
  homeOrigin: string;
  homeAuthority: URI;
}

export interface AuthorityResolution {
  handle: string;
  actorId: URI;
  actor: FCTPActor;
  server: string;
  roles: string[];
}

export class FctpClient {
  readonly resources: ResourceClient;
  readonly #fetcher: typeof fetch;
  constructor(options: ClientSdkOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
    this.resources = options.resources ?? new ResourceClient(this.#fetcher);
  }

  resolveActor(uri: URI): Promise<ActorResolution> { return resolveActor(uri, this.#fetcher); }
  resolveWebFinger(handle: string, origin?: string): Promise<ActorResolution> { return resolveWebFinger(handle, this.#fetcher, origin); }

  async resolveAccount(handle: string, options: { homeOrigin?: string } = {}): Promise<AccountResolution> {
    const parsed = parseHandle(handle);
    if (parsed.kind !== 'account') throw new TypeError('Expected an account handle');
    const origin = new URL(options.homeOrigin ?? `https://${parsed.server}`).origin;
    const resolved = await resolveWebFinger(parsed.handle, this.#fetcher, origin);
    if (resolved.actor.role !== 'player') throw new Error('Account handle did not resolve to a Player Actor');
    const response = await this.#fetcher(new URL('/local/info', origin), { method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`Home discovery failed: HTTP ${response.status}`);
    const info: unknown = await response.json();
    const advertised = isRecord(info) && isRecord(info.actor) ? info.actor.home : undefined;
    if (typeof advertised !== 'string') throw new Error('Home discovery did not advertise an Actor');
    const home = await resolveActor(advertised as URI, this.#fetcher);
    if (home.actor.role !== 'home') throw new Error('Advertised Home Actor does not publish the Home role');
    return { handle: parsed.handle, actorId: resolved.actor.id, actor: resolved.actor, homeServer: parsed.server, homeOrigin: origin, homeAuthority: home.actor.id };
  }

  async resolveAuthority(handle: string, options: { origin?: string } = {}): Promise<AuthorityResolution> {
    const parsed = parseHandle(handle);
    if (parsed.kind !== 'authority') throw new TypeError('Expected an authority handle');
    const resolved = await resolveWebFinger(parsed.handle, this.#fetcher, options.origin);
    const role = resolved.actor.role;
    if (typeof role !== 'string' || role === 'player') throw new Error('Authority handle did not resolve to an authority Actor');
    return { handle: parsed.handle, actorId: resolved.actor.id, actor: resolved.actor, server: parsed.server, roles: [role] };
  }

  async get<T>(uri: URI, options: ResourceRequestOptions & { nativeToken?: Uint8Array | string; resourceServer?: URI } = {}): Promise<T> {
    const { nativeToken, resourceServer, ...requestOptions } = options;
    if (nativeToken !== undefined && !resourceServer) throw new TypeError('resourceServer Actor ID is required to derive a diplomatic token');
    const token = nativeToken === undefined ? requestOptions.token : await deriveDiplomaticToken(nativeToken, resourceServer!);
    return (await this.resources.get<T>(uri, { ...requestOptions, ...(token ? { token } : {}) })).value;
  }

  async resolveReference<T extends Record<string, unknown>>(value: unknown, resourceServer?: URI, options: { nativeToken?: string; accept?: string } = {}): Promise<T> {
    let reference: URI | undefined;
    if (typeof value === 'string') {
      reference = value;
    } else if (isRecord(value)) {
      if (typeof value.id === 'string' && Object.keys(value).length === 1) reference = value.id;
      else return value as T;
    }
    if (reference === undefined) throw new TypeError('Resource reference must be an object or URI');
    return this.getPublicFirst<T>(reference, {
      ...(resourceServer ? { resourceServer } : {}),
      ...(options.nativeToken !== undefined ? { nativeToken: options.nativeToken } : {}),
      ...(options.accept !== undefined ? { accept: options.accept } : {})
    });
  }

  async login(request: HomeLoginRequest, homeOrigin: string): Promise<HomeLoginResult> {
    const response = await this.#fetcher(new URL('/local/home/login', homeOrigin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
      cache: 'no-store'
    });
    if (response.status >= 500) throw new Error(`Home login failed: HTTP ${response.status}`);
    const result: unknown = await response.json();
    if (!isHomeLoginResult(result)) throw new Error(`Home login failed: HTTP ${response.status}`);
    if (result.status === 'signed-in' && !response.ok) throw new Error(`Home login failed: HTTP ${response.status}`);
    return result;
  }

  async getPublicFirst<T>(uri: URI, options: { nativeToken?: string; resourceServer?: URI; accept?: string; resolveAudience?: () => Promise<URI | undefined>; responseType?: 'text' } = {}): Promise<T> {
    const accept = options.accept ?? 'application/ld+json, application/json';
    const response = await this.#requestResource(uri, accept);
    if (response.ok) return decodeResource<T>(response, options.responseType);
    if (response.status !== 401 && response.status !== 403) throw resourceError(response.status);
    if (!options.nativeToken) throw resourceError(response.status);
    const audience = options.resourceServer || await options.resolveAudience?.();
    if (audience === undefined) throw new TypeError('resourceServer Actor ID is required to derive a diplomatic token');
    const token = await deriveDiplomaticToken(options.nativeToken, audience);
    const authenticated = await this.#requestResource(uri, accept, token);
    if (!authenticated.ok) throw resourceError(authenticated.status);
    return decodeResource<T>(authenticated, options.responseType);
  }

  async #requestResource(uri: URI, accept: string, token?: string): Promise<Response> {
    const headers = new Headers({ Accept: accept });
    if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
    return this.#fetcher(uri, { method: 'GET', headers, cache: 'no-store' });
  }

  async readCollection<T extends Record<string, unknown>>(uri: URI, resourceServer: URI, nativeToken?: string): Promise<T[]> {
    const result: T[] = [];
    const visited = new Set<string>();
    let pageUri: URI | undefined = uri;
    while (pageUri !== undefined) {
      if (visited.has(pageUri)) throw new Error(`Collection pagination loop at ${pageUri}`);
      visited.add(pageUri);
      const page: unknown = await this.getPublicFirst<unknown>(pageUri, { ...(nativeToken === undefined ? {} : { nativeToken }), resourceServer });
      if (!isRecord(page)) throw new TypeError('Collection page must be an object');
      const items = page.orderedItems ?? page.items ?? [];
      if (!Array.isArray(items)) throw new TypeError('Collection items must be an array');
      for (const item of items) result.push(await this.#resolveCollectionItem<T>(item, resourceServer, nativeToken));
      const next = page.next;
      pageUri = typeof next === 'string' ? next as URI : isRecord(next) && typeof next.id === 'string' ? next.id as URI : undefined;
    }
    return result;
  }

  async #resolveCollectionItem<T extends Record<string, unknown>>(value: unknown, resourceServer: URI, nativeToken?: string): Promise<T> {
    return this.resolveReference<T>(value, resourceServer, nativeToken === undefined ? {} : { nativeToken });
  }

  async getActorResource<T>(actor: FCTPActor & { resources?: Record<string, unknown> }, resourceName: string, options: ResourceRequestOptions & { nativeToken?: Uint8Array | string } = {}): Promise<T> {
    const uri = actor.resources?.[resourceName];
    if (typeof uri !== 'string') throw new TypeError(`Actor does not publish resource ${resourceName}`);
    return this.get<T>(uri, { ...options, resourceServer: actor.id });
  }

  compareManifests(registry: CargoManifest, territory: CargoManifest): ReturnType<typeof compareCargo> {
    return compareCargo(registry, territory);
  }
}

export function createFctpClient(options: ClientSdkOptions = {}): FctpClient { return new FctpClient(options); }

export function resourceAudience(uri: string, explicitActor: string, provenance: ReadonlyMap<string, string | ReadonlySet<string>>, knownActorIds: Iterable<string>): string {
  if (explicitActor) return explicitActor;
  const known = provenance.get(uri);
  if (known instanceof Set) {
    if (known.size === 1) return [...known][0]!;
    if (known.size > 1) throw new Error('Multiple Actors link to this resource. Open the resource from a specific Actor or use the advanced Actor override.');
  } else if (typeof known === 'string') return known;
  let origin: string;
  try { origin = new URL(uri).origin; } catch { throw new TypeError('Enter a valid resource URL'); }
  const candidates = [...knownActorIds].filter((actor) => {
    try { return new URL(actor).origin === origin; } catch { return false; }
  });
  const unique = [...new Set(candidates)];
  if (unique.length === 1) return unique[0]!;
  throw new Error(unique.length > 1 ? 'The serving Actor is ambiguous for this server. Resolve an Actor that links to this resource first.' : 'The serving server could not be identified from known Actor links. Resolve an Actor that links to this resource first.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHomeLoginResult(value: unknown): value is HomeLoginResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (typeof result.handle !== 'string') return false;
  if (result.status === 'signed-in') {
    return typeof result.actorId === 'string' && typeof result.nativeToken === 'string'
      && (result.expiresAt === undefined || typeof result.expiresAt === 'string');
  }
  if (result.status === 'rejected' || result.status === 'unavailable') return typeof result.reason === 'string';
  return false;
}

async function decodeResource<T>(response: Response, responseType?: 'text'): Promise<T> {
  if (responseType === 'text') return await response.text() as T;
  const contentType = response.headers.get('Content-Type') ?? '';
  return /^text\//i.test(contentType) ? await response.text() as T : await response.json() as T;
}
