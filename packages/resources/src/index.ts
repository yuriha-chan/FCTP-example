import type { FCTPActor, MapDescriptor, MapRepresentation, URI } from '@fctp/protocol';

export type ResourceFailure = 'unauthorized' | 'forbidden' | 'not-found' | 'not-acceptable' | 'http-error';
export class ResourceError extends Error {
  constructor(readonly status: number, readonly code: ResourceFailure, message = `Resource request failed: HTTP ${status}`) { super(message); }
}

interface CachedResource { body: unknown; etag?: string }
export interface ResourceRequestOptions { token?: string; accept?: string; signal?: AbortSignal; cache?: boolean }
export interface ResourceResult<T> { value: T; etag?: string; notModified: boolean }

export class ResourceClient {
  readonly #cache = new Map<string, CachedResource>();
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async get<T>(uri: URI, options: ResourceRequestOptions = {}): Promise<ResourceResult<T>> {
    const cacheKey = `${uri}\u0000${options.token ?? ''}\u0000${options.accept ?? 'application/ld+json, application/json'}`;
    const cached = options.cache === false ? undefined : this.#cache.get(cacheKey);
    const headers = new Headers({ Accept: options.accept ?? 'application/ld+json, application/json' });
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
    if (cached?.etag) headers.set('If-None-Match', cached.etag);
    const response = await this.fetcher(uri, { method: 'GET', headers, ...(options.signal ? { signal: options.signal } : {}), cache: 'no-store' });
    if (response.status === 304 && cached) return { value: structuredClone(cached.body) as T, ...(cached.etag ? { etag: cached.etag } : {}), notModified: true };
    if (!response.ok) throw resourceError(response.status);
    const body = await response.json() as T;
    const etag = response.headers.get('ETag') ?? undefined;
    const cacheControl = response.headers.get('Cache-Control') ?? '';
    if (options.cache !== false && !/no-store/i.test(cacheControl)) this.#cache.set(cacheKey, { body: structuredClone(body), ...(etag ? { etag } : {}) });
    return { value: body, ...(etag ? { etag } : {}), notModified: false };
  }

  async *collection<T>(uri: URI, options: ResourceRequestOptions = {}): AsyncGenerator<T> {
    const visited = new Set<string>();
    let pageUri: URI | undefined = uri;
    while (pageUri) {
      if (visited.has(pageUri)) throw new Error(`Collection pagination loop at ${pageUri}`);
      visited.add(pageUri);
      const result = await this.get<CollectionDocument<T>>(pageUri, options);
      const value: CollectionDocument<T> = result.value;
      const items = value.orderedItems ?? value.items ?? [];
      for (const item of items) yield item;
      const next: CollectionDocument<T>['next'] = value.next;
      pageUri = typeof next === 'string' ? next : next?.id;
    }
  }

  clearCache(): void { this.#cache.clear(); }
}

export interface CollectionDocument<T> { id?: URI; type?: string; totalItems?: number; items?: T[]; orderedItems?: T[]; next?: URI | { id: URI } }

function resourceError(status: number): ResourceError {
  if (status === 401) return new ResourceError(status, 'unauthorized');
  if (status === 403) return new ResourceError(status, 'forbidden');
  if (status === 404) return new ResourceError(status, 'not-found');
  if (status === 406) return new ResourceError(status, 'not-acceptable');
  return new ResourceError(status, 'http-error');
}

export function territoryResourceUris(actor: FCTPActor & { resources?: { ports: URI; routes: URI; map?: URI } }): { ports: URI; routes: URI; map?: URI } {
  if (!actor.resources) throw new TypeError('Actor does not expose Territory resources');
  return { ports: actor.resources.ports, routes: actor.resources.routes, ...(actor.resources.map ? { map: actor.resources.map } : {}) };
}

export function selectMapRepresentation(descriptor: MapDescriptor, supportedFormats: ReadonlySet<URI>): MapRepresentation {
  const representation = descriptor.representations.find((candidate) => supportedFormats.has(candidate.format));
  if (!representation) throw new ResourceError(406, 'not-acceptable', 'No supported map representation');
  return representation;
}

export async function fetchMapRepresentation<T>(client: ResourceClient, descriptor: MapDescriptor, formats: ReadonlySet<URI>, options: ResourceRequestOptions = {}): Promise<{ representation: MapRepresentation; resources: Array<{ role: string; value: T }> }> {
  const representation = selectMapRepresentation(descriptor, formats);
  const resources = await Promise.all(representation.resources.map(async (resource) => ({
    role: resource.role,
    value: (await client.get<T>(resource.url, { ...options, accept: resource.mediaType })).value
  })));
  return { representation, resources };
}
