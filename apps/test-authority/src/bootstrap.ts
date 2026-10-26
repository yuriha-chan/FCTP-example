import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FCTPActor } from '@fctp/protocol';
import type { GeneratedActorKey } from '@fctp/identity';
import { createHost, FctpServer, type ActivityHandler, type FctpServerOptions } from '@fctp/server-base';

export type AuthorityRole = 'registry' | 'home' | 'player';
export type AuthorityActors = Record<AuthorityRole, FCTPActor & Record<string, unknown>>;

export interface CreateAuthorityOptions {
  origin: string;
  storeFile: string;
  keyFile?: string;
  adminSecret?: string;
  fetcher?: typeof fetch;
  verifyInbound?: FctpServerOptions['verifyInbound'];
  authorizeResource?: FctpServerOptions['authorizeResource'];
  onInbound?: (server: FctpServer, actors: AuthorityActors) => void;
  inboxHandlers?: Partial<Record<AuthorityRole, Record<string, ActivityHandler>>>;
}

export interface Authority {
  readonly server: FctpServer;
  readonly actors: AuthorityActors;
  readonly keys: Readonly<Record<AuthorityRole, GeneratedActorKey>>;
  actor(role: AuthorityRole): AuthorityActors[AuthorityRole];
  key(role: AuthorityRole): GeneratedActorKey;
  registerActor(role: AuthorityRole, actor: FCTPActor & Record<string, unknown>): Promise<void>;
  listen(port?: number, host?: string): Promise<{ port: number; close: () => Promise<void> }>;
  startWorkers(intervalMs?: number): void;
  stopWorkers(): Promise<void>;
  close(): Promise<void>;
}

const roles: AuthorityRole[] = ['registry', 'home', 'player'];

export async function createAuthority(options: CreateAuthorityOptions): Promise<Authority> {
  const host = await createHost({
    origin: options.origin,
    storeFile: options.storeFile,
    ...(options.keyFile ? { keyFile: options.keyFile } : {}),
    actors: roles.map((role) => ({ name: role, role })),
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.verifyInbound ? { verifyInbound: options.verifyInbound } : {}),
    ...(options.authorizeResource ? { authorizeResource: options.authorizeResource } : {}),
    authorizeAdmin: options.adminSecret === undefined ? async () => false : async (request) => matchesSecret(request, options.adminSecret!),
    ...(options.inboxHandlers ? { inboxHandlers: options.inboxHandlers } : {}),
    configure: (server, actors) => {
      options.onInbound?.(server, actors as AuthorityActors);
    }
  });
  const actors = host.actors as AuthorityActors;
  return {
    server: host.server,
    actors,
    keys: host.keys as Readonly<Record<AuthorityRole, GeneratedActorKey>>,
    actor: (role) => actors[role],
    key: (role) => host.key(role),
    registerActor: async (role, actor) => {
      if (actor.role !== role) throw new TypeError(`Actor role must be ${role}`);
      if (actor.id !== host.key(role).keyPair.controller || !actor.publicKeys.includes(host.key(role).keyPair.id)) throw new TypeError('Actor identity and public key must match the persisted authority key');
      actors[role] = actor;
      await host.server.registerActor({ actor });
    },
    listen: (port = 0, address = '127.0.0.1') => host.listen(port, address),
    startWorkers: (intervalMs = 1000) => host.startWorkers(intervalMs),
    stopWorkers: () => host.stopWorkers(),
    close: () => host.close()
  };
}

async function matchesSecret(request: IncomingMessage, expected: string): Promise<boolean> {
  const authorization = request.headers.authorization ?? '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const left = createHash('sha256').update(provided).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}
