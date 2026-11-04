import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WEBFINGER_CONTEXT, createLocalDocumentLoader, generateActorKey, importActorKey, parseWebFingerAddress, resolveHomeAuthority, signJsonLd, type DocumentLoader, type GeneratedActorKey, type JsonDocument } from '@fctp/identity';
import { validateModel, type FCTPActor, type TokenDeclaration, type URI } from '@fctp/protocol';
import type { Activity } from '@fctp/federation';
import { FctpServer, type ActivityHandler, type FctpServerOptions } from './server.js';
import { createInboundVerifier } from './verification.js';
import { readNodeInfo } from './nodeinfo.js';
import { SIGNED_REQUEST_HEADER } from './signed-request.js';

export interface HostActorDescriptor {
  name: string;
  role: string;
  accountName?: string;
  displayName?: string;
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
  nodeInfo?: { name: string };
  homeAccountName?: string;
  serverDisplayName?: string;
  onWorkerError?: (failure: HostWorkerError) => void;
  inboxHandlers?: Partial<Record<string, Record<string, ActivityHandler>>>;
  configure?: (server: FctpServer, actors: Readonly<Record<string, FCTPActor & Record<string, unknown>>>, keys: Readonly<Record<string, GeneratedActorKey>>) => void;
}

export interface Host {
  readonly server: FctpServer;
  readonly serverDisplayName: string;
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
  const configuredServerDisplayName = options.serverDisplayName?.trim();
  if (options.serverDisplayName !== undefined && !configuredServerDisplayName) throw new TypeError('Server display name must be non-empty');
  const serverDisplayName = configuredServerDisplayName ?? origin.host;
  const base = origin.origin;
  const descriptors = options.actors;
  const homeDescriptor = descriptors.find(({ role }) => role === 'home');
  const hostedHomeAccountName = homeDescriptor === undefined ? undefined : options.homeAccountName;
  for (const { accountName, displayName } of descriptors) {
    if (accountName !== undefined && !accountName.trim()) throw new TypeError('Actor account name must be non-empty');
    if (displayName !== undefined && !displayName.trim()) throw new TypeError('Actor display name must be non-empty');
  }
  const keyFile = options.keyFile ?? `${options.storeFile}.keys`;
  const persisted = await loadOrCreateKeys(keyFile, base, descriptors);
  const keys = Object.fromEntries(descriptors.map(({ name }) => [name, { keyPair: persisted[name]!.keyPair, publicKey: structuredClone(persisted[name]!.publicDocument) }])) as Record<string, GeneratedActorKey>;
  const actors = Object.fromEntries(descriptors.map(({ name, role, accountName, displayName, document }) => {
    const id = `${base}/actors/${name}`;
    const trimmedAccountName = accountName?.trim();
    const webfinger = trimmedAccountName !== undefined
      ? `${trimmedAccountName}@${origin.host}`
      : role === 'home' && hostedHomeAccountName !== undefined
        ? `${hostedHomeAccountName}@${origin.host}`
        : role === 'player' ? `${name}@${origin.host}` : `${name}.${role}@${origin.host}`;
    const trimmedDisplayName = displayName?.trim();
    const defaultDisplayName = role === 'home'
      ? `${serverDisplayName} Home`
      : role === 'registry'
        ? `${serverDisplayName} Registry`
        : role === 'territory' ? `${serverDisplayName} Territory` : undefined;
    const actor: Record<string, unknown> = document ? structuredClone(document) : {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'], id, type: 'Service', role,
      inbox: `${id}/inbox`, outbox: `${id}/outbox`, publicKeys: [keys[name]!.keyPair.id]
    };
    if (!('webfinger' in actor)) actor.webfinger = webfinger;
    if (trimmedDisplayName !== undefined) actor.name = trimmedDisplayName;
    else if (defaultDisplayName !== undefined && !('name' in actor)) actor.name = defaultDisplayName;
    actor['@context'] = withWebFingerContext(actor['@context']);
    return [name, actor];
  })) as Record<string, FCTPActor & Record<string, unknown>>;
  const homeHandle = homeDescriptor === undefined ? undefined : actors[homeDescriptor.name]?.webfinger;
  const advertisedHomeAccountName = homeAccountHandleName(homeHandle);
  for (const { name } of descriptors) {
    if (actors[name]!.id !== keys[name]!.keyPair.controller || !Array.isArray(actors[name]!.publicKeys) || !actors[name]!.publicKeys.includes(keys[name]!.keyPair.id)) throw new TypeError(`Actor ${name} must identify and publish its persisted key`);
  }
  const loader = createLocalDocumentLoader(new Map(Object.values(keys).map(({ keyPair, publicKey }) => [keyPair.id, publicKey])));
  const fetcher = options.fetcher ?? fetch;
  const fetchTokenDeclaration: NonNullable<FctpServerOptions['fetchTokenDeclaration']> = async (accountId, resourceServerId) => {
    const name = descriptors.find(({ name: candidate }) => actors[candidate]!.id === resourceServerId)?.name;
    const key = name === undefined ? undefined : keys[name];
    if (key === undefined) return undefined;
    const discoveryFetcher: typeof fetch = (input, init) => fetcher(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000)
    });
    let home: Awaited<ReturnType<typeof resolveHomeAuthority>>;
    try {
      home = await resolveHomeAuthority(accountId, discoveryFetcher);
    } catch {
      return undefined;
    }
    const target = new URL('/local/home/token-digest', new URL(home.actor.id).origin);
    target.searchParams.set('actor', accountId);
    const signed = await signJsonLd({
      '@context': ['https://www.w3.org/ns/activitystreams'],
      id: `${resourceServerId.replace(/\/$/, '')}/requests/${randomUUID()}`,
      type: 'TokenDigestRequest',
      actor: resourceServerId,
      object: accountId,
      target: target.href,
      published: new Date().toISOString()
    }, key.keyPair, loader);
    let response: Response;
    try {
      response = await fetcher(target, {
        method: 'GET',
        headers: { Accept: 'application/json', [SIGNED_REQUEST_HEADER]: Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url') },
        cache: 'no-store',
        signal: AbortSignal.timeout(5_000)
      });
    } catch {
      return undefined;
    }
    if (!response.ok) return undefined;
    let payload: unknown;
    try {
      payload = await response.json() as unknown;
    } catch {
      return undefined;
    }
    if (!isRecord(payload)) return undefined;
    const type = 'tokenDigest' in payload ? 'TokenDigest' : 'tokenRevoke' in payload ? 'TokenRevoke' : undefined;
    if (type === undefined) return undefined;
    const validation = validateModel<TokenDeclaration>(payload, type);
    if (!validation.success || validation.data.actor !== accountId) return undefined;
    return { declaration: validation.data, homeActorId: home.actor.id as URI };
  };
  const server = new FctpServer({
    storeFile: options.storeFile,
    origin: base,
    fetcher,
    verifyInbound: options.verifyInbound ?? createInboundVerifier({ fetcher, loader, resolveExpectedIssuer: options.resolveExpectedIssuer ?? (async () => undefined) }),
    ...(options.authorizeResource ? { authorizeResource: options.authorizeResource } : {}),
    authorizeAdmin: options.authorizeAdmin ?? (async () => false),
    fetchTokenDeclaration,
    ...(options.nodeInfo ? { nodeInfo: readNodeInfo(options.nodeInfo.name, process.env, advertisedHomeAccountName) } : {}),
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
    server, serverDisplayName, actors, keys, loader, workerErrors,
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

function homeAccountHandleName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const address = parseWebFingerAddress(value).address;
    const separator = address.lastIndexOf('@');
    return separator > 0 ? address.slice(0, separator) : undefined;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withWebFingerContext(context: unknown): unknown {
  if (context === undefined) return [WEBFINGER_CONTEXT];
  const contexts = Array.isArray(context) ? [...context] : [context];
  if (!contexts.includes(WEBFINGER_CONTEXT)) contexts.push(WEBFINGER_CONTEXT);
  return contexts;
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
