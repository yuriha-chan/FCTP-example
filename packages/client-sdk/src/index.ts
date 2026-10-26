import { deriveDiplomaticToken } from '@fctp/auth';
import { resolveActor, resolveWebFinger, type ActorResolution } from '@fctp/identity';
import { ResourceClient, type ResourceRequestOptions } from '@fctp/resources';
import { compareCargo, type CargoManifest, type FCTPActor, type URI } from '@fctp/protocol';

export interface ClientSdkOptions { fetcher?: typeof fetch; resources?: ResourceClient }

export class FctpClient {
  readonly resources: ResourceClient;
  readonly #fetcher: typeof fetch;
  constructor(options: ClientSdkOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
    this.resources = options.resources ?? new ResourceClient(this.#fetcher);
  }

  resolveActor(uri: URI): Promise<ActorResolution> { return resolveActor(uri, this.#fetcher); }
  resolveWebFinger(handle: string): Promise<ActorResolution> { return resolveWebFinger(handle, this.#fetcher); }

  async get<T>(uri: URI, options: ResourceRequestOptions & { nativeToken?: Uint8Array | string; resourceServer?: URI } = {}): Promise<T> {
    const { nativeToken, resourceServer, ...requestOptions } = options;
    if (nativeToken !== undefined && !resourceServer) throw new TypeError('resourceServer Actor ID is required to derive a diplomatic token');
    const token = nativeToken === undefined ? requestOptions.token : await deriveDiplomaticToken(nativeToken, resourceServer!);
    return (await this.resources.get<T>(uri, { ...requestOptions, ...(token ? { token } : {}) })).value;
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
