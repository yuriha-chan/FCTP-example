import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { createActivity, parseActivity, type Activity } from '@fctp/federation';
import { parseWebFingerAddress, resolveActor } from '@fctp/identity';
import { TokenCredentialStore, digestDiplomaticToken, type CredentialState } from '@fctp/auth';
import { validateModel, type FCTPActor, type TokenDeclaration, type URI } from '@fctp/protocol';
import { JsonSnapshotStore, type StoreState } from './store.js';
import { nodeInfoDocument, nodeInfoLinks, type NodeInfoRuntime } from './nodeinfo.js';

export interface VerificationReport {
  cryptographic: { verified: boolean; error?: string };
  attribution: { attributed: boolean; publisher?: URI; key?: URI; error?: string };
  expectedIssuer: { matches: boolean; expected?: URI; actual?: URI };
}
export interface HandlerContext {
  recipientActor: URI;
  senderActor: URI;
  activityId: URI;
  objectId?: URI;
  receivedAt: string;
  verification: VerificationReport;
  store: JsonSnapshotStore;
}
export type ActivityHandler = (context: HandlerContext, object: unknown, activity: Activity) => Promise<void>;
export interface ActorRegistration { actor: FCTPActor & Record<string, unknown>; document?: Record<string, unknown> }
export interface CustomRouteContext { request: IncomingMessage; response: ServerResponse; url: URL; base: FctpServer }
export type CustomRoute = (context: CustomRouteContext) => boolean | Promise<boolean>;
export interface FctpServerOptions {
  storeFile: string;
  origin?: string;
  fetcher?: typeof fetch;
  verifyInbound?: (localActorId: URI, senderActorId: URI, activity: Activity) => Promise<VerificationReport>;
  authorizeAdmin?: (request: IncomingMessage, actor: FCTPActor) => Promise<boolean>;
  authorizeResource?: (request: IncomingMessage, actor: FCTPActor, resourceId: URI, player?: URI) => Promise<{ allowed: boolean; player?: URI }>;
  signActivity?: (actorId: URI, activity: Activity) => Promise<Activity>;
  corsOrigin?: string;
  nodeInfo?: NodeInfoRuntime;
}
interface ResourceRecord { body: unknown; public: boolean; actorId?: URI; etag: string }

export class FctpServer {
  readonly store: JsonSnapshotStore;
  readonly #handlers = new Map<string, ActivityHandler[]>();
  readonly #resources = new Map<string, ResourceRecord>();
  readonly #routes: CustomRoute[] = [];
  readonly #fetcher: typeof fetch;
  readonly #signActivity: NonNullable<FctpServerOptions['signActivity']>;
  readonly #verifyInbound: NonNullable<FctpServerOptions['verifyInbound']>;
  readonly #authorizeAdmin: NonNullable<FctpServerOptions['authorizeAdmin']>;
  readonly #authorizeResource: NonNullable<FctpServerOptions['authorizeResource']>;
  readonly #origin: string | undefined;
  readonly #corsOrigin: string;
  readonly #nodeInfo: NodeInfoRuntime | undefined;
  #http?: Server;
  #inboxRun: Promise<void> = Promise.resolve();

  constructor(options: FctpServerOptions) {
    this.store = new JsonSnapshotStore(options.storeFile);
    this.#fetcher = options.fetcher ?? fetch;
    this.#signActivity = options.signActivity ?? (async () => { throw new Error('Outbound Activity signer is not configured'); });
    this.#verifyInbound = options.verifyInbound ?? (async () => ({
      cryptographic: { verified: false, error: 'no inbound proof verifier configured' },
      attribution: { attributed: false, error: 'not checked' },
      expectedIssuer: { matches: false }
    }));
    this.#authorizeAdmin = options.authorizeAdmin ?? (async () => false);
    this.#authorizeResource = options.authorizeResource ?? (async () => ({ allowed: false }));
    const origin = options.origin === undefined ? undefined : new URL(options.origin);
    if (origin && (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)) {
      throw new TypeError('origin must be an HTTP(S) origin');
    }
    this.#origin = origin?.origin;
    this.#corsOrigin = options.corsOrigin ?? '*';
    this.#nodeInfo = options.nodeInfo;
  }

  async open(): Promise<void> { await this.store.open(); }

  async registerActor(registration: ActorRegistration): Promise<void> {
    const actor = registration.document ?? registration.actor as Record<string, unknown>;
    await this.store.transaction((state) => { state.actors[registration.actor.id] = structuredClone(actor); });
  }

  async enrollPlayer(playerId: URI, homeActorId: URI): Promise<void> {
    await this.store.transaction((state) => { state.enrollments[playerId] = homeActorId; });
  }

  async resolveRecipientInbox(actorId: URI): Promise<URI> {
    const cached = await this.store.read((state) => state.remoteActors[actorId]?.inbox);
    if (cached) return cached as URI;
    const { actor } = await resolveActor(actorId, this.#fetcher);
    const validated = validateModel<FCTPActor>(actor, 'Actor');
    if (!validated.success || validated.data.id !== actorId) throw new TypeError('Invalid remote Actor document');
    const inbox = validated.data.inbox;
    await this.store.transaction((state) => { state.remoteActors[actorId] = { actor: structuredClone(validated.data) as Record<string, unknown>, inbox }; });
    return inbox;
  }

  async applyTokenDeclaration(resourceServerId: URI, senderHomeId: URI, declaration: TokenDeclaration): Promise<'applied' | 'stale' | 'duplicate' | 'conflict'> {
    return this.store.transaction((state) => {
      if (state.enrollments[declaration.actor] !== senderHomeId) throw new Error('Token declaration sender is not the enrolled Home');
      const key = `${resourceServerId}\u0000${declaration.actor}`;
      const current = state.credentials[key] as CredentialState | undefined;
      const store = createCredentialStoreFromSnapshot(current ? { [declaration.actor]: current } : {});
      const result = store.apply(declaration);
      const credential = store.get(declaration.actor);
      if (credential) state.credentials[key] = credential;
      return result;
    });
  }

  async authenticateDiplomaticToken(resourceServerId: URI, token: string): Promise<URI | undefined> {
    const credentials = await this.store.read((state) => Object.entries(state.credentials)
      .filter(([key]) => key.startsWith(`${resourceServerId}\u0000`))
      .map(([key, value]) => [key.slice(resourceServerId.length + 1), value as CredentialState] as const));
    let digest: string;
    try {
      digest = await digestDiplomaticToken(token);
    } catch (error) {
      if (error instanceof TypeError || error instanceof DOMException) return undefined;
      throw error;
    }
    for (const [playerId, credential] of credentials) {
      if (credential.status === 'active' && safeEqual(credential.tokenDigest, digest)) return playerId;
    }
    return undefined;
  }

  on(actorId: URI, objectType: string, handler: ActivityHandler): () => void {
    const key = `${actorId}\u0000${objectType}`;
    const handlers = this.#handlers.get(key) ?? [];
    handlers.push(handler);
    this.#handlers.set(key, handlers);
    return () => this.#handlers.set(key, (this.#handlers.get(key) ?? []).filter((candidate) => candidate !== handler));
  }

  addRoute(route: CustomRoute): void { this.#routes.push(route); }

  checkAdmin(request: IncomingMessage, actor: FCTPActor): Promise<boolean> { return this.#authorizeAdmin(request, actor); }

  async publish(actorId: URI, recipientActorId: URI, inbox: URI, object: Record<string, unknown>, activityId: URI): Promise<Activity> {
    const raw = createActivity({ id: activityId, actor: actorId, object, to: recipientActorId });
    const activity = await this.#signActivity(actorId, raw);
    const payload = JSON.stringify(activity);
    await this.store.transaction((state) => {
      const actor = state.actors[actorId];
      if (!actor) throw new Error(`Unknown local Actor: ${actorId}`);
      enqueue(state, { actorId, inbox, activityId, object, activity, payload });
    });
    return activity;
  }

  async commit<T>(domainMutation: (domain: Record<string, unknown>, state: StoreState) => T, outgoing: Array<{
    actorId: URI; recipientActorId: URI; inbox: URI; object: Record<string, unknown>; activityId: URI
  }> = [], publications: Array<{ actorId: URI; object: Record<string, unknown>; activityId: URI }> = []): Promise<T> {
    const activities = await Promise.all(outgoing.map(async (message) => {
      const raw = createActivity({ id: message.activityId, actor: message.actorId, object: message.object, to: message.recipientActorId });
      const activity = await this.#signActivity(message.actorId, raw);
      return { message, activity, payload: JSON.stringify(activity) };
    }));
    const localActivities = await Promise.all(publications.map(async (publication) => {
      const raw = createActivity({ id: publication.activityId, actor: publication.actorId, object: publication.object, to: [] });
      const activity = await this.#signActivity(publication.actorId, raw);
      return { publication, activity, payload: JSON.stringify(activity) };
    }));
    return this.store.transaction((state) => {
      const result = domainMutation(state.domain, state);
      for (const { message, activity, payload } of activities) {
        if (!state.actors[message.actorId]) throw new Error(`Unknown local Actor: ${message.actorId}`);
        enqueue(state, { actorId: message.actorId, inbox: message.inbox, activityId: message.activityId, object: message.object, activity, payload });
      }
      for (const { publication, activity, payload } of localActivities) {
        if (!state.actors[publication.actorId]) throw new Error(`Unknown local Actor: ${publication.actorId}`);
        archivePublication(state, { actorId: publication.actorId, activityId: publication.activityId, object: publication.object, activity, payload });
      }
      return result;
    });
  }

  async receive(localActorId: URI, activity: Activity): Promise<'queued' | 'duplicate'> {
    const parsed = parseActivity(activity);
    if (!parsed.activity.to.includes(localActorId)) throw new TypeError('Activity is not addressed to this Actor');
    const serializedObject = JSON.stringify(parsed.object);
    const activityHash = hash(activity);
    const objectHash = hash(serializedObject);
    return this.store.transaction((state) => {
      const activityKey = `${localActorId}\u0000${parsed.activityId}`;
      const objectKey = parsed.objectId ? `${localActorId}\u0000${parsed.objectId}` : undefined;
      const previousActivity = state.inboxActivityHashes[activityKey];
      const previousObject = objectKey ? state.inboxObjectHashes[objectKey] : undefined;
      if (previousActivity || previousObject) {
        if (previousActivity && previousActivity !== activityHash || previousObject && previousObject !== objectHash) throw new TypeError('Conflicting reuse of Activity or object ID');
        if (!previousActivity) state.inboxActivityHashes[activityKey] = activityHash;
        return 'duplicate';
      }
      state.inboxActivityHashes[activityKey] = activityHash;
      if (objectKey) state.inboxObjectHashes[objectKey] = objectHash;
      state.inboxQueue.push({ localActorId, activityId: parsed.activityId, ...(parsed.objectId ? { objectId: parsed.objectId } : {}), activity: structuredClone(activity) as Record<string, unknown>, sender: parsed.actor, receivedAt: new Date().toISOString() });
      return 'queued';
    });
  }

  processInbox(limit = 100): Promise<number> {
    const run = this.#inboxRun.then(() => this.#processInbox(limit), () => this.#processInbox(limit));
    this.#inboxRun = run.then(() => undefined, () => undefined);
    return run;
  }

  async #processInbox(limit: number): Promise<number> {
    let processed = 0;
    let examined = 0;
    const attempted = new Set<string>();
    const failures: Error[] = [];
    while (examined < limit) {
      const now = Date.now();
      const item = await this.store.read((state) => state.inboxQueue.find((candidate) => (candidate.nextAttemptAt ?? 0) <= now && !attempted.has(`${candidate.localActorId}\u0000${candidate.activityId}`)));
      if (!item) break;
      const key = `${item.localActorId}\u0000${item.activityId}`;
      attempted.add(key);
      examined++;
      try {
        const parsed = parseActivity(item.activity);
        const type = getObjectType(parsed.object);
        if (type === 'TokenDigest' || type === 'TokenRevoke') {
          const validation = validateModel<TokenDeclaration>(parsed.object, type);
          if (!validation.success) {
            const reason = `Invalid ${type} declaration`;
            await this.store.transaction((state) => {
              state.inboxQueue = state.inboxQueue.filter((candidate) => !(candidate.localActorId === item.localActorId && candidate.activityId === item.activityId));
              state.inboxRejected.push({ localActorId: item.localActorId, activityId: item.activityId, ...(item.objectId ? { objectId: item.objectId } : {}), activity: structuredClone(item.activity), sender: item.sender, receivedAt: item.receivedAt, reason });
            });
            failures.push(new TypeError(reason));
            continue;
          }
          const report = await this.#verifyInbound(item.localActorId, item.sender, parsed.activity);
          if (!report.cryptographic.verified || !report.attribution.attributed || !report.expectedIssuer.matches) throw new Error('Token declaration Activity verification failed');
          await this.applyTokenDeclaration(item.localActorId, item.sender, validation.data);
          const handlers = this.#handlers.get(`${item.localActorId}\u0000${type}`) ?? [];
          for (const handler of handlers) await handler({ recipientActor: item.localActorId, senderActor: item.sender, activityId: item.activityId, ...(item.objectId ? { objectId: item.objectId } : {}), receivedAt: item.receivedAt, verification: report, store: this.store }, parsed.object, parsed.activity);
        } else {
          const report = await this.#verifyInbound(item.localActorId, item.sender, parsed.activity);
          const handlers = this.#handlers.get(`${item.localActorId}\u0000${type}`) ?? [];
          for (const handler of handlers) await handler({ recipientActor: item.localActorId, senderActor: item.sender, activityId: item.activityId, ...(item.objectId ? { objectId: item.objectId } : {}), receivedAt: item.receivedAt, verification: report, store: this.store }, parsed.object, parsed.activity);
        }
        await this.store.transaction((state) => {
          state.inboxQueue = state.inboxQueue.filter((candidate) => !(candidate.activityId === item.activityId && candidate.localActorId === item.localActorId));
        });
        processed++;
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failures.push(failure);
        await this.store.transaction((state) => {
          const queued = state.inboxQueue.find((candidate) => candidate.activityId === item.activityId && candidate.localActorId === item.localActorId);
          if (!queued) return;
          queued.attempts = (queued.attempts ?? 0) + 1;
          queued.diagnostic = failure.message;
          queued.nextAttemptAt = Date.now() + Math.min(60_000, 500 * (2 ** Math.min(queued.attempts, 7)));
        });
      }
    }
    if (failures.length) throw new AggregateError(failures, `Inbox processing failed for ${failures.length} item(s)`);
    return processed;
  }

  async processOutbox(limit = 100): Promise<number> {
    let delivered = 0;
    for (let i = 0; i < limit; i++) {
      const item = await this.store.read((state) => state.outbox.find((candidate) => candidate.nextAttemptAt <= Date.now()));
      if (!item) break;
      let success = false;
      try {
        const response = await this.#fetcher(item.inbox, { method: 'POST', headers: { 'Content-Type': 'application/activity+json' }, body: item.payload });
        success = response.status === 202;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        success = false;
      }
      await this.store.transaction((state) => {
        const queued = state.outbox.find((candidate) => candidate.id === item.id && candidate.actorId === item.actorId);
        if (!queued) return;
        if (success) {
          state.outbox = state.outbox.filter((candidate) => !(candidate.id === item.id && candidate.actorId === item.actorId));
          delivered++;
        } else {
          queued.attempts++;
          queued.nextAttemptAt = Date.now() + Math.min(60_000, 500 * (2 ** Math.min(queued.attempts, 7)));
        }
      });
    }
    return delivered;
  }

  registerResource(id: URI, body: unknown, options: { public?: boolean; actorId?: URI } = {}): void {
    const serialized = JSON.stringify(body);
    this.#resources.set(id, { body: structuredClone(body), public: options.public ?? true, ...(options.actorId ? { actorId: options.actorId } : {}), etag: `"${createHash('sha256').update(serialized).digest('base64url')}"` });
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<{ port: number; close: () => Promise<void> }> {
    if (this.#http) throw new Error('Server is already listening');
    this.#http = createServer((request, response) => { void this.#handle(request, response); });
    await new Promise<void>((resolve, reject) => { this.#http!.once('error', reject); this.#http!.listen(port, host, resolve); });
    const address = this.#http.address();
    if (!address || typeof address === 'string') throw new Error('Unexpected HTTP listen address');
    return { port: address.port, close: () => new Promise<void>((resolve, reject) => this.#http?.close((error) => error ? reject(error) : resolve())) };
  }

  #base(request: IncomingMessage): string {
    return this.#origin ?? `http://${request.headers.host ?? 'localhost'}`;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Access-Control-Allow-Origin', this.#corsOrigin);
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-None-Match');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    const url = new URL(request.url ?? '/', this.#base(request));
    try {
      if (this.#nodeInfo && request.method === 'GET' && url.pathname === '/.well-known/nodeinfo') {
        json(response, 200, nodeInfoLinks(this.#base(request)), 'application/json', { 'Cache-Control': 'no-store' });
        return;
      }
      if (this.#nodeInfo && request.method === 'GET' && url.pathname === '/nodeinfo/2.1') {
        json(response, 200, nodeInfoDocument(this.#nodeInfo), 'application/json', { 'Cache-Control': 'no-store' });
        return;
      }
      for (const route of this.#routes) if (await route({ request, response, url, base: this })) return;
      if (url.pathname === '/.well-known/webfinger' && request.method === 'GET') { await this.#webfinger(url, response); return; }
      const inboxMatch = /^\/actors\/([^/]+)\/inbox$/.exec(url.pathname);
      if (inboxMatch && request.method === 'POST') { await this.#inbox(decodeURIComponent(inboxMatch[1]!), request, response); return; }
      const outboxMatch = /^\/actors\/([^/]+)\/outbox$/.exec(url.pathname);
      if (outboxMatch && request.method === 'GET') { await this.#outbox(decodeURIComponent(outboxMatch[1]!), response); return; }
      const actorMatch = /^\/actors\/([^/]+)$/.exec(url.pathname);
      if (actorMatch && request.method === 'GET') { await this.#actor(decodeURIComponent(actorMatch[1]!), response); return; }
      const objectMatch = /^\/objects\/(.+)$/.exec(url.pathname);
      if (objectMatch && request.method === 'GET') { await this.#object(decodeURIComponent(objectMatch[1]!), request, response); return; }
      json(response, 404, { error: 'not-found' });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : 'bad-request' });
    }
  }

  async #webfinger(url: URL, response: ServerResponse): Promise<void> {
    const resource = url.searchParams.get('resource');
    if (!resource?.startsWith('acct:')) { json(response, 400, { error: 'invalid-resource' }); return; }
    const subject = resource.slice(5);
    const requested = normalizeWebFingerAddress(subject);
    if (requested === undefined) { json(response, 404, { error: 'not-found' }); return; }
    const actors = await this.store.read((state) => Object.entries(state.actors));
    const match = actors.find(([id, actor]) => {
      const role = actor.role;
      const pathPart = new URL(id).pathname.split('/').filter(Boolean).at(-1);
      if (typeof role !== 'string' || !pathPart) return false;
      const host = new URL(id).host;
      const derived = role === 'player' ? `${pathPart}@${host}` : `${pathPart}.${role}@${host}`;
      const advertised = typeof actor.webfinger === 'string' ? normalizeWebFingerAddress(actor.webfinger) : undefined;
      return requested === derived || (advertised !== undefined && requested === advertised);
    });
    if (!match) { json(response, 404, { error: 'not-found' }); return; }
    json(response, 200, { subject, links: [{ rel: 'self', type: 'application/activity+json', href: match[0] }] }, 'application/jrd+json');
  }

  async #actor(actorId: string, response: ServerResponse): Promise<void> {
    const entries = await this.store.read((state) => Object.entries(state.actors));
    const actor = entries.find(([id]) => new URL(id).pathname.split('/').filter(Boolean).at(-1) === actorId)?.[1];
    if (!actor) { json(response, 404, { error: 'not-found' }); return; }
    json(response, 200, actor, 'application/activity+json');
  }

  async #inbox(actorName: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const actorEntry = await this.store.read((state) => Object.entries(state.actors).find(([id]) => new URL(id).pathname.split('/').filter(Boolean).at(-1) === actorName));
    if (!actorEntry) { json(response, 404, { error: 'not-found' }); return; }
    const body = await readBody(request);
    const activity = JSON.parse(body) as Activity;
    const status = await this.receive(actorEntry[0], activity);
    json(response, 202, { status });
  }

  async #outbox(actorName: string, response: ServerResponse): Promise<void> {
    const entries = await this.store.read((state) => Object.entries(state.actors));
    const actor = entries.find(([id]) => new URL(id).pathname.split('/').filter(Boolean).at(-1) === actorName);
    if (!actor) { json(response, 404, { error: 'not-found' }); return; }
    const activities = await this.store.read((state) => state.outboxArchive.filter((entry) => entry.actorId === actor[0]).map((entry) => entry.activity));
    json(response, 200, { '@context': 'https://www.w3.org/ns/activitystreams', id: `${actor[0].replace(/\/$/, '')}/outbox`, type: 'OrderedCollection', totalItems: activities.length, orderedItems: activities });
  }

  async #object(id: URI, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const absoluteId = new URL(request.url ?? '/', this.#base(request)).href;
    const resource = this.#resources.get(absoluteId);
    const persisted = resource ? undefined : await this.store.read((state) => state.objects[absoluteId]);
    if (!resource && persisted === undefined) { json(response, 404, { error: 'not-found' }); return; }
    const actorId = resource?.actorId;
    if (resource && !resource.public) {
      const actorDocument = actorId ? await this.store.read((state) => state.actors[actorId]) : undefined;
      const authorization = request.headers.authorization;
      if (!authorization?.startsWith('Bearer ')) { json(response, 401, { error: 'unauthorized' }); return; }
      const token = authorization.slice('Bearer '.length);
      const player = actorDocument ? await this.authenticateDiplomaticToken(String(actorDocument.id), token) : undefined;
      if (!actorDocument || !player) { json(response, 401, { error: 'unauthorized' }); return; }
      const result = await this.#authorizeResource(request, actorDocument as FCTPActor, id, player);
      if (!result.allowed) { json(response, 403, { error: 'forbidden' }); return; }
    }
    const etag = resource?.etag;
    if (etag && request.headers['if-none-match'] === etag) { response.writeHead(304, { ETag: etag, 'Cache-Control': resource?.public ? 'public, max-age=0, must-revalidate' : 'private, no-store' }).end(); return; }
    json(response, 200, resource?.body ?? persisted, 'application/ld+json', etag ? { ETag: etag, 'Cache-Control': resource?.public ? 'public, max-age=0, must-revalidate' : 'private, no-store' } : {});
  }
}

export async function requireAdmin(server: FctpServer, request: IncomingMessage, actor: FCTPActor, authorize: (request: IncomingMessage, actor: FCTPActor) => Promise<boolean>): Promise<void> {
  if (!await authorize(request, actor)) throw new Error('administrator-authorization-failed');
}

export function createCredentialStoreFromSnapshot(snapshot: Record<string, CredentialState>): TokenCredentialStore {
  const store = new TokenCredentialStore(); store.restore(snapshot); return store;
}

function normalizeWebFingerAddress(value: string): string | undefined {
  try {
    return parseWebFingerAddress(value).address;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return undefined;
  }
}
function hash(value: unknown): string { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('base64url'); }
function enqueue(state: StoreState, entry: { actorId: URI; inbox: URI; activityId: URI; object: Record<string, unknown>; activity: Activity; payload: string }): void {
  if (!archivePublication(state, entry)) return;
  state.outbox.push({ id: entry.activityId, actorId: entry.actorId, inbox: entry.inbox, activity: structuredClone(entry.activity) as Record<string, unknown>, payload: entry.payload, attempts: 0, nextAttemptAt: Date.now() });
}
function archivePublication(state: StoreState, entry: { actorId: URI; activityId: URI; object: Record<string, unknown>; activity: Activity; payload: string }): boolean {
  const archived = state.outboxArchive.find((item) => item.actorId === entry.actorId && item.activity.id === entry.activityId);
  if (archived) {
    if (JSON.stringify(archived.activity) !== entry.payload) throw new TypeError('Conflicting reuse of outgoing Activity ID');
    return false;
  }
  const objectId = typeof entry.object.id === 'string' ? entry.object.id : undefined;
  if (objectId && state.objects[objectId] !== undefined && hash(state.objects[objectId]) !== hash(entry.object)) throw new TypeError('Conflicting reuse of outgoing object ID');
  if (objectId) state.objects[objectId] = structuredClone(entry.object);
  state.outboxArchive.push({ actorId: entry.actorId, activity: structuredClone(entry.activity) as Record<string, unknown> });
  return true;
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function getObjectType(object: unknown): string {
  if (typeof object !== 'object' || object === null || Array.isArray(object)) return '';
  const value = object as Record<string, unknown>;
  if ('tokenDigest' in value) return 'TokenDigest';
  if ('tokenRevoke' in value) return 'TokenRevoke';
  return typeof value.type === 'string' ? value.type : '';
}
function json(response: ServerResponse, status: number, body: unknown, type = 'application/json', headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': type, ...headers }); response.end(JSON.stringify(body));
}
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
