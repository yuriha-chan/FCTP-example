import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FCTPActor } from '@fctp/protocol';
import type { GeneratedActorKey } from '@fctp/identity';
import { createHost, FctpServer, type ActivityHandler, type FctpServerOptions } from '@fctp/server-base';

export type AuthorityRole = 'registry' | 'home' | 'player';
export type AuthorityActors = Record<AuthorityRole, FCTPActor & Record<string, unknown>> & Record<string, FCTPActor & Record<string, unknown>>;

export interface CreateAuthorityOptions {
  origin: string;
  storeFile: string;
  keyFile?: string;
  adminSecret?: string;
  playerNames?: string[];
  administratorNames?: string[];
  fetcher?: typeof fetch;
  verifyInbound?: FctpServerOptions['verifyInbound'];
  authorizeResource?: FctpServerOptions['authorizeResource'];
  nodeInfo?: { name: string };
  onInbound?: (server: FctpServer, actors: AuthorityActors) => void;
  inboxHandlers?: Partial<Record<AuthorityRole, Record<string, ActivityHandler>>>;
}

export interface Authority {
  readonly server: FctpServer;
  readonly actors: AuthorityActors;
  readonly keys: Readonly<Record<string, GeneratedActorKey>>;
  readonly players: Readonly<Record<string, FCTPActor & Record<string, unknown>>>;
  readonly governors: ReadonlySet<string>;
  readonly primaryPlayerName: string;
  actor(role: AuthorityRole): AuthorityActors[AuthorityRole];
  key(role: AuthorityRole): GeneratedActorKey;
  registerActor(name: string, actor: FCTPActor & Record<string, unknown>): Promise<void>;
  listen(port?: number, host?: string): Promise<{ port: number; close: () => Promise<void> }>;
  startWorkers(intervalMs?: number): void;
  stopWorkers(): Promise<void>;
  close(): Promise<void>;
}

const roles: AuthorityRole[] = ['registry', 'home', 'player'];

export async function createAuthority(options: CreateAuthorityOptions): Promise<Authority> {
  const playerNames = options.playerNames ?? ['player'];
  if (playerNames.length === 0 || new Set(playerNames).size !== playerNames.length || playerNames.some((name) => !/^[^.]+$/.test(name))) throw new TypeError('Player names must be non-empty, unique, and contain no dots');
  const administratorNames = options.administratorNames ?? [];
  if (new Set(administratorNames).size !== administratorNames.length || administratorNames.some((name) => !/^[^.]+$/.test(name))) throw new TypeError('Administrator names must be unique and contain no dots');
  if (administratorNames.some((name) => playerNames.includes(name))) throw new TypeError('Player and administrator names must be distinct and unique');
  const primaryPlayerName = playerNames[0]!;
  const accountNames = [...playerNames, ...administratorNames];
  const playerRoles = new Set(accountNames);
  const descriptors = [...roles.slice(0, 2).map((name) => ({ name, role: name })), ...accountNames.map((name) => ({ name, role: 'player' }))];
  const host = await createHost({
    origin: options.origin,
    storeFile: options.storeFile,
    ...(options.keyFile ? { keyFile: options.keyFile } : {}),
    actors: descriptors,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    ...(options.verifyInbound ? { verifyInbound: options.verifyInbound } : {}),
    ...(options.authorizeResource ? { authorizeResource: options.authorizeResource } : {}),
    ...(options.nodeInfo ? { nodeInfo: options.nodeInfo } : {}),
    authorizeAdmin: options.adminSecret === undefined ? async () => false : async (request) => matchesSecret(request, options.adminSecret!),
    ...(options.inboxHandlers ? { inboxHandlers: options.inboxHandlers } : {}),
    configure: (server, actors) => {
      options.onInbound?.(server, actors as AuthorityActors);
    }
  });
  const actors = host.actors as AuthorityActors;
  const players = Object.fromEntries(accountNames.map((name) => [name, actors[name]!])) as Record<string, FCTPActor & Record<string, unknown>>;
  const governors = new Set(administratorNames.map((name) => actors[name]!.id));
  return {
    server: host.server,
    actors,
    keys: host.keys,
    players,
    governors,
    primaryPlayerName,
    actor: (role) => role === 'player' ? actors[primaryPlayerName]! : actors[role],
    key: (role) => host.key(role),
    registerActor: async (name, actor) => {
      const key = host.keys[name];
      if (!key || (playerRoles.has(name) ? actor.role !== 'player' : actor.role !== name)) throw new TypeError(`Actor role must be ${playerRoles.has(name) ? 'player' : name}`);
      if (actor.id !== key.keyPair.controller || !actor.publicKeys.includes(key.keyPair.id)) throw new TypeError('Actor identity and public key must match the persisted authority key');
      actors[name] = actor;
      await host.server.registerActor({ actor });
      if (playerRoles.has(name)) players[name] = actor;
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
