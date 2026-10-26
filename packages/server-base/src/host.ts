import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLocalDocumentLoader, generateActorKey, importActorKey, signJsonLd, type DocumentLoader, type GeneratedActorKey, type JsonDocument } from '@fctp/identity';
import type { FCTPActor } from '@fctp/protocol';
import type { Activity } from '@fctp/federation';
import { FctpServer, type ActivityHandler, type FctpServerOptions } from './server.js';
import { createInboundVerifier } from './verification.js';

export interface HostActorDescriptor {
  name: string;
  role: string;
  document?: FCTPActor & Record<string, unknown>;
}

export interface HostWorkerError {
  phase: 'inbox' | 'outbox';
  error: unknown;
  occurredAt: string;
}

export interface CreateHostOptions {
  origin: string;
  storeFile: string;
  keyFile?: string;
  actors: HostActorDescriptor[];
  fetcher?: typeof fetch;
  resolveExpectedIssuer?: Parameters<typeof createInboundVerifier>[0]['resolveExpectedIssuer'];
  verifyInbound?: FctpServerOptions['verifyInbound'];
  authorizeAdmin?: FctpServerOptions['authorizeAdmin'];
  authorizeResource?: FctpServerOptions['authorizeResource'];
  onWorkerError?: (failure: HostWorkerError) => void;
  inboxHandlers?: Partial<Record<string, Record<string, ActivityHandler>>>;
  configure?: (server: FctpServer, actors: Readonly<Record<string, FCTPActor & Record<string, unknown>>>, keys: Readonly<Record<string, GeneratedActorKey>>) => void;
}

export interface Host {
  readonly server: FctpServer;
  readonly actors: Record<string, FCTPActor & Record<string, unknown>>;
  readonly keys: Readonly<Record<string, GeneratedActorKey>>;
  readonly loader: DocumentLoader;
  readonly workerErrors: readonly HostWorkerError[];
  actor(name: string): FCTPActor & Record<string, unknown>;
  key(name: string): GeneratedActorKey;
  sign(actorName: string, activity: Activity): Promise<Activity>;
  signObject(name: string, document: JsonDocument): Promise<JsonDocument>;
  listen(port?: number, host?: string): Promise<{ port: number; close: () => Promise<void> }>;
  startWorkers(intervalMs?: number): void;
  stopWorkers(): Promise<void>;
  close(): Promise<void>;
}

export async function createHost(options: CreateHostOptions): Promise<Host> {
  const origin = new URL(options.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash) throw new TypeError('origin must be an HTTP(S) origin');
  if (options.actors.length === 0 || new Set(options.actors.map(({ name }) => name)).size !== options.actors.length) throw new TypeError('Actor names must be non-empty and unique');
  if (options.actors.some(({ name, role }) => !name || !role || name.includes('/'))) throw new TypeError('Actor names and roles must be non-empty; names cannot contain slashes');
  const base = origin.origin;
  const descriptors = options.actors;
  const keyFile = options.keyFile ?? `${options.storeFile}.keys`;
  const persisted = await loadOrCreateKeys(keyFile, base, descriptors);
  const keys = Object.fromEntries(descriptors.map(({ name }) => [name, { keyPair: persisted[name]!.keyPair, publicKey: structuredClone(persisted[name]!.publicDocument) }])) as Record<string, GeneratedActorKey>;
  const actors = Object.fromEntries(descriptors.map(({ name, role, document }) => {
    const id = `${base}/actors/${name}`;
    return [name, document ? structuredClone(document) : {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'], id, type: 'Service', role,
      inbox: `${id}/inbox`, outbox: `${id}/outbox`, publicKeys: [keys[name]!.keyPair.id]
    }];
  })) as Record<string, FCTPActor & Record<string, unknown>>;
  for (const { name } of descriptors) {
    if (actors[name]!.id !== keys[name]!.keyPair.controller || !Array.isArray(actors[name]!.publicKeys) || !actors[name]!.publicKeys.includes(keys[name]!.keyPair.id)) throw new TypeError(`Actor ${name} must identify and publish its persisted key`);
  }
  const loader = createLocalDocumentLoader(new Map(Object.values(keys).map(({ keyPair, publicKey }) => [keyPair.id, publicKey])));
  const server = new FctpServer({
    storeFile: options.storeFile,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
    verifyInbound: options.verifyInbound ?? createInboundVerifier({ ...(options.fetcher ? { fetcher: options.fetcher } : {}), loader, resolveExpectedIssuer: options.resolveExpectedIssuer ?? (async () => undefined) }),
    ...(options.authorizeResource ? { authorizeResource: options.authorizeResource } : {}),
    authorizeAdmin: options.authorizeAdmin ?? (async () => false),
    signActivity: async (actorId, activity) => {
      const name = descriptors.find(({ name: candidate }) => actors[candidate]!.id === actorId)?.name;
      if (!name) throw new Error(`Unknown local Actor: ${actorId}`);
      return signJsonLd(activity as unknown as JsonDocument, keys[name]!.keyPair, loader) as Promise<Activity>;
    }
  });
  for (const { name } of descriptors) {
    for (const [type, handler] of Object.entries(options.inboxHandlers?.[name] ?? {})) server.on(actors[name]!.id, type, handler);
  }
  server.addRoute(({ request, response, url }) => {
    const match = /^\/keys\/([^/]+)$/.exec(url.pathname);
    if (!match || request.method !== 'GET') return false;
    const key = keys[decodeURIComponent(match[1]!)];
    if (!key) return false;
    response.writeHead(200, { 'Content-Type': 'application/ld+json' });
    response.end(JSON.stringify(key.publicKey));
    return true;
  });
  options.configure?.(server, actors, keys);
  await server.open();
  for (const { name } of descriptors) await server.registerActor({ actor: actors[name]! });

  let listening: Awaited<ReturnType<FctpServer['listen']>> | undefined;
  let workerTimer: NodeJS.Timeout | undefined;
  let workerRun: Promise<void> = Promise.resolve();
  const workerErrors: HostWorkerError[] = [];
  const report = (phase: HostWorkerError['phase'], error: unknown): void => {
    const failure = { phase, error, occurredAt: new Date().toISOString() };
    workerErrors.push(failure);
    try { options.onWorkerError?.(failure); } catch (callbackError) {
      workerErrors.push({ phase, error: callbackError, occurredAt: new Date().toISOString() });
    }
  };
  const run = async (): Promise<void> => {
    for (const phase of ['inbox', 'outbox'] as const) {
      try {
        if (phase === 'inbox') await server.processInbox();
        else await server.processOutbox();
      } catch (error) { report(phase, error); }
    }
  };
  const scheduleRun = (): Promise<void> => {
    workerRun = workerRun.then(run, run);
    return workerRun;
  };
  return {
    server, actors, keys, loader, workerErrors,
    actor: (name) => { const actor = actors[name]; if (!actor) throw new TypeError(`Unknown Actor: ${name}`); return actor; },
    key: (name) => { const key = keys[name]; if (!key) throw new TypeError(`Unknown Actor: ${name}`); return key; },
    sign: (name, activity) => { const key = keys[name]; if (!key) throw new TypeError(`Unknown Actor: ${name}`); return signJsonLd(activity as unknown as JsonDocument, key.keyPair, loader) as Promise<Activity>; },
    signObject: (name, document) => { const key = keys[name]; if (!key) throw new TypeError(`Unknown Actor: ${name}`); return signJsonLd(document, key.keyPair, loader); },
    listen: async (port = 0, host = '127.0.0.1') => {
      if (listening) throw new Error('Host is already listening');
      listening = await server.listen(port, host);
      return listening;
    },
    startWorkers: (intervalMs = 1000) => {
      if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError('intervalMs must be a positive integer');
      if (workerTimer) throw new Error('Host workers are already running');
      workerTimer = setInterval(() => { void scheduleRun(); }, intervalMs);
      void scheduleRun();
    },
    stopWorkers: async () => { if (workerTimer) clearInterval(workerTimer); workerTimer = undefined; await workerRun; },
    close: async () => { await (async () => { if (workerTimer) clearInterval(workerTimer); workerTimer = undefined; await workerRun; if (listening) await listening.close(); listening = undefined; })(); }
  };
}

async function loadOrCreateKeys(keyFile: string, origin: string, actors: HostActorDescriptor[]): Promise<Record<string, { keyPair: GeneratedActorKey['keyPair']; publicDocument: JsonDocument }>> {
  try {
    const stored = JSON.parse(await readFile(keyFile, 'utf8')) as Record<string, JsonDocument>;
    await chmod(keyFile, 0o600);
    return Object.fromEntries(await Promise.all(actors.map(async ({ name }) => {
      const document = stored[name];
      const expectedController = `${origin}/actors/${name}`;
      if (!document || document.controller !== expectedController || typeof document.id !== 'string' || !document.id.startsWith(`${origin}/keys/${name}#`)) throw new TypeError(`Invalid persisted ${name} key`);
      const keyPair = await importActorKey(document);
      return [name, { keyPair, publicDocument: await keyPair.export({ publicKey: true, includeContext: true }) }];
    })));
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error && error.code === 'ENOENT')) throw error;
  }
  const generated: Record<string, { keyPair: GeneratedActorKey['keyPair']; publicDocument: JsonDocument; privateDocument: JsonDocument }> = Object.fromEntries(await Promise.all(actors.map(async ({ name }) => {
    const id = `${origin}/actors/${name}`;
    const key = await generateActorKey(id, `${origin}/keys/${name}#key-1`);
    return [name, { keyPair: key.keyPair, publicDocument: key.publicKey, privateDocument: await key.keyPair.export({ publicKey: true, secretKey: true, includeContext: true }) }];
  })));
  await mkdir(dirname(keyFile), { recursive: true });
  await writeFile(keyFile, JSON.stringify(Object.fromEntries(Object.entries(generated).map(([name, value]) => [name, value.privateDocument]))), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(keyFile, 0o600);
  return Object.fromEntries(Object.entries(generated).map(([name, value]) => [name, { keyPair: value.keyPair, publicDocument: value.publicDocument }]));
}
