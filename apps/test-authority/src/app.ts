import type { URI } from '@fctp/protocol';
import { createInboundVerifier } from '@fctp/server-base';
import { createAuthority, type Authority } from './bootstrap.js';
import { installHome, type HomeService } from './home.js';
import { installRegistry, type Registry } from './registry.js';

export interface CreateAuthorityAppOptions {
  origin: string;
  storeFile: string;
  keyFile?: string;
  adminSecret: string;
  fetcher?: typeof fetch;
  adoption?: boolean;
}

export interface AuthorityAppIds {
  actor: Record<'registry' | 'home' | 'player', URI>;
  vessel: URI;
}

export interface AuthorityApp {
  authority: Authority;
  home: HomeService;
  registry: Registry;
  ids: AuthorityAppIds;
}

export async function createAuthorityApp(options: CreateAuthorityAppOptions): Promise<AuthorityApp> {
  const fetcher = options.fetcher ?? fetch;
  const authority = await createAuthority({
    origin: options.origin,
    storeFile: options.storeFile,
    ...(options.keyFile ? { keyFile: options.keyFile } : {}),
    adminSecret: options.adminSecret,
    fetcher,
    verifyInbound: createInboundVerifier({
      fetcher,
       resolveExpectedIssuer: async (_localActorId, senderActorId, activity) => registry.resolveExpectedIssuer(senderActorId, activity.object)
    })
  });
  const home = installHome(authority, { fetcher });
  const registry: Registry = installRegistry(authority, { fetcher });
  const hasRegistryState = await authority.server.store.read((store) => store.domain.registry !== undefined);
  const ids: AuthorityAppIds = {
    actor: {
      registry: authority.actor('registry').id,
      home: authority.actor('home').id,
      player: authority.actor('player').id
    },
    vessel: `${options.origin.replace(/\/$/, '')}/objects/vessels/demo`
  };
  const vessel = (await registry.state()).vessel;
  if (!vessel || vessel.id !== ids.vessel) throw new Error('Registry demo vessel identity does not match the authority origin');
  await authority.server.store.transaction((store) => { store.objects[ids.vessel] = structuredClone(vessel); });
  if (options.adoption !== undefined) await registry.switchAdoption(options.adoption);
  else if (!hasRegistryState) await registry.switchAdoption(true);
  authority.server.addRoute(async ({ request, response, url }) => {
    if (request.method !== 'GET' || url.pathname !== '/local/info') return false;
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({
      kind: 'authority',
      actor: ids.actor,
      ids,
      endpoints: [
        { method: 'GET', path: '/local/info', authentication: 'none' },
        { method: 'GET', path: '/local/home/endpoints', authentication: 'none' },
        { method: 'POST', path: '/local/home/issue', authentication: 'admin' },
        { method: 'POST', path: '/local/home/rotate', authentication: 'admin' },
        { method: 'POST', path: '/local/registry/entry', authentication: 'admin' },
        { method: 'POST', path: '/local/registry/departure', authentication: 'admin' },
        { method: 'POST', path: '/local/registry/adoption', authentication: 'admin' }
      ]
    }));
    return true;
  });
  return { authority, home, registry, ids };
}
