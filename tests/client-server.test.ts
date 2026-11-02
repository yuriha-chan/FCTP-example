import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveDiplomaticToken } from '@fctp/auth';
import { createLocalDocumentLoader, verifyProofCryptography } from '@fctp/identity';
import type { Route, URI } from '@fctp/protocol';
import { actionIsComplete } from '@fctp/client-sdk';
import type { AccountRecord, ActionRecord, AuthorityRecord, PageResponse, PublicAccountRecord, ServerRecord, SourcedObservation } from '@fctp/client-sdk';
import type { ActionHandler } from '../apps/client-server/src/actions.js';
import { createClientApplication, type ClientApplication, type CreateClientApplicationOptions } from '../apps/client-server/src/app.js';
import { createClientToken, digestClientToken } from '../apps/client-server/src/sessions.js';
import { startClientServer } from '../apps/demo/src/client-server.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';

const unauthenticatedFetch: typeof fetch = globalThis.fetch.bind(globalThis);
const clientOrigins = new Set<string>();
const clientApplications = new Map<string, ClientApplication>();
const clientTokens = new Map<string, string>();

function tokenKey(origin: string, accountId: string): string {
  return `${origin}\0${accountId}`;
}

function registerClientToken(origin: string, accountId: string, token: string): void {
  clientTokens.set(tokenKey(origin, accountId), token);
}

async function ensureClientSession(origin: string, accountId: string): Promise<string | undefined> {
  const existing = clientTokens.get(tokenKey(origin, accountId));
  if (existing !== undefined) return existing;
  const application = clientApplications.get(origin);
  if (!application) return undefined;
  const account = await application.state.read((state) => state.accounts[accountId]);
  if (!account || account.login.status !== 'signed-in') return undefined;
  const token = createClientToken();
  clientTokens.set(tokenKey(origin, accountId), token);
  await application.state.transaction((state) => {
    state.clientSessions[digestClientToken(token)] = { accountId, issuedAt: new Date().toISOString() };
  });
  return token;
}

function requestedAccountId(input: RequestInfo | URL, init?: RequestInit): string | undefined {
  let url: URL;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return undefined;
  }
  const query = url.searchParams.getAll('accountId').map((value) => value.trim()).filter((value) => value.length > 0);
  if (query.length === 1) return query[0];
  const logout = /^\/api\/accounts\/([^/]+)\/logout$/.exec(url.pathname);
  if (logout) {
    try {
      return decodeURIComponent(logout[1]!);
    } catch {
      return undefined;
    }
  }
  if (typeof init?.body === 'string') {
    try {
      const body: unknown = JSON.parse(init.body);
      if (isRecord(body) && typeof body.accountId === 'string' && body.accountId.trim()) return body.accountId.trim();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let origin: string;
  try {
    origin = new URL(input instanceof Request ? input.url : String(input)).origin;
  } catch {
    return unauthenticatedFetch(input, init);
  }
  if (!clientOrigins.has(origin)) return unauthenticatedFetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (headers.has('Authorization')) return unauthenticatedFetch(input, init);
  const accountId = requestedAccountId(input, init);
  if (accountId !== undefined) {
    const token = await ensureClientSession(origin, accountId);
    if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
  }
  return unauthenticatedFetch(input, { ...init, headers });
}

test('serves the browser client and static assets on an isolated port', async () => {
  const client = await startClientServer({ port: 0 });
  try {
    const html = await fetch(client.origin);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type') ?? '', /text\/html/);
    const markup = await html.text();
    const scriptPath = /src="([^"]+\.js)"/.exec(markup)?.[1];
    const stylePath = /href="([^"]+\.css)"/.exec(markup)?.[1];
    assert.ok(scriptPath, 'the served page must reference its built script');
    assert.ok(stylePath, 'the served page must reference its built stylesheet');
    const bundle = await fetch(new URL(scriptPath, client.origin));
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type') ?? '', /javascript/);
    assert.ok((await bundle.text()).length > 0);
    const stylesheet = await fetch(new URL(stylePath, client.origin));
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type') ?? '', /text\/css/);
    assert.ok((await stylesheet.text()).length > 0);
    assert.equal((await fetch(new URL('/package.json', client.origin))).status, 404);
    assert.equal((await fetch(new URL('/../../package.json', client.origin))).status, 404);
  } finally {
    await client.close();
  }
  await assert.rejects(fetch(client.origin));
});

test('serves the frontend for each known topic route', async () => {
  const client = await startClientServer({ port: 0 });
  try {
    for (const path of [
      '/connections', '/explore', '/logistics', '/authoring', '/activity', '/administration',
      '/authoring/assets/edit/draft%3Aalpha', '/authoring/varieties/edit/draft%3Abeta'
    ]) {
      const response = await fetch(new URL(path, client.origin));
      assert.equal(response.status, 200, `${path} must serve the frontend`);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      assert.match(await response.text(), /<html/i);
    }
    const unknown = await fetch(new URL('/not-a-topic', client.origin));
    assert.equal(unknown.status, 404);
  } finally {
    await client.close();
  }
});

const firstAccount: AccountRecord = {
  id: 'account:first',
  handle: '@sana@first.test:4200',
  homeServer: 'first.test:4200',
  actorId: 'https://first.test:4200/actors/sana',
  homeAuthority: 'https://first.test:4200/actors/home',
  login: { status: 'signed-in', homeServer: 'first.test:4200', nativeToken: 'first-native-token' }
};

const secondAccount: AccountRecord = {
  id: 'account:second',
  handle: '@orla@second.test:4200',
  homeServer: 'second.test:4200',
  actorId: 'https://second.test:4200/actors/orla',
  homeAuthority: 'https://second.test:4200/actors/home',
  login: { status: 'signed-in', homeServer: 'second.test:4200', nativeToken: 'second-native-token' }
};

const serverRecord: ServerRecord = {
  server: 'harbor.test:4200',
  origin: 'https://harbor.test:4200',
  authorities: ['https://harbor.test:4200/actors/registry']
};

const authorityRecord: AuthorityRecord = {
  handle: '@harbor.registry@harbor.test:4200',
  actorId: 'https://harbor.test:4200/actors/registry',
  server: 'harbor.test:4200',
  roles: ['registry']
};

const observationRecord: SourcedObservation<unknown> = {
  state: 'available',
  source: 'https://harbor.test:4200/local/registry/state',
  observedAt: '2026-10-29T12:00:00Z',
  value: { entries: [] }
};

const actionRecord: ActionRecord = {
  id: 'action:1',
  statusUrl: '/api/activity/action:1',
  accountId: firstAccount.id,
  targetId: authorityRecord.actorId,
  resultReferences: [{ kind: 'job', id: 'job:1' }],
  intent: { kind: 'mine', inputs: { count: 1 } },
  submittedAt: '2026-10-29T12:00:00Z',
  submission: { status: 'accepted', result: 'job:1' },
  outcome: { status: 'pending', evidence: [] }
};

test('client application retains concurrent account transactions and persists them after recreation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-application-'));
  const storeFile = join(directory, 'client.store.json');
  let application = await createClientApplication({ storeFile });
  try {
    await Promise.all([
      application.state.transaction(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        state.accounts[firstAccount.id] = firstAccount;
      }),
      application.state.transaction((state) => {
        state.accounts[secondAccount.id] = secondAccount;
      })
    ]);
    const concurrent = await application.state.read((state) => state.accounts);
    assert.deepEqual(Object.keys(concurrent).sort(), [firstAccount.id, secondAccount.id].sort());
    assert.equal(concurrent[firstAccount.id]?.login.status, 'signed-in');
    assert.equal(concurrent[secondAccount.id]?.login.status, 'signed-in');

    await application.close();
    application = await createClientApplication({ storeFile });
    const reopened = await application.state.read((state) => state.accounts);
    assert.deepEqual(Object.keys(reopened).sort(), [firstAccount.id, secondAccount.id].sort());
    assert.deepEqual(reopened[firstAccount.id], firstAccount);
    assert.deepEqual(reopened[secondAccount.id], secondAccount);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('client application persists every client collection after recreation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-collections-'));
  const storeFile = join(directory, 'client.store.json');
  let application = await createClientApplication({ storeFile });
  const draft = { id: 'draft:1', title: 'Harbor notes' };
  const routePlan = { id: 'route-plan:1', routeId: 'https://harbor.test:4200/routes/approach' };
  const followedRequest = { id: 'request:1', accountId: firstAccount.id };
  const followedJob = { id: 'job:1', accountId: secondAccount.id };
  try {
    await application.state.transaction((state) => {
      state.servers[serverRecord.server] = serverRecord;
      state.authorities[authorityRecord.actorId] = authorityRecord;
      state.accounts[firstAccount.id] = firstAccount;
      state.observations['observation:registry'] = observationRecord;
      state.drafts[draft.id] = draft;
      state.routePlans[routePlan.id] = routePlan;
      state.actions[actionRecord.id] = actionRecord;
      state.followedRequests[followedRequest.id] = followedRequest;
      state.followedJobs[followedJob.id] = followedJob;
    });
    await application.close();
    application = await createClientApplication({ storeFile });
    const clientState = await application.state.read((state) => state);
    assert.deepEqual(clientState.servers[serverRecord.server], serverRecord);
    assert.deepEqual(clientState.authorities[authorityRecord.actorId], authorityRecord);
    assert.deepEqual(clientState.accounts[firstAccount.id], firstAccount);
    assert.deepEqual(clientState.observations['observation:registry'], observationRecord);
    assert.deepEqual(clientState.drafts[draft.id], draft);
    assert.deepEqual(clientState.routePlans[routePlan.id], routePlan);
    assert.deepEqual(clientState.actions[actionRecord.id], actionRecord);
    assert.deepEqual(clientState.followedRequests[followedRequest.id], followedRequest);
    assert.deepEqual(clientState.followedJobs[followedJob.id], followedJob);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('supplied server seeds do not become discovered records and reopen preserves discovered servers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-seeds-'));
  const storeFile = join(directory, 'client.store.json');
  const seedServers = ['http://127.0.0.1:4100', 'https://world.example:4200'];
  let application = await createClientApplication({ storeFile, seedServers });
  try {
    const seeded = await application.state.read((state) => state.servers);
    assert.deepEqual(seeded, {});
    await application.state.transaction((state) => {
      state.servers[serverRecord.server] = serverRecord;
    });
    await application.close();
    application = await createClientApplication({ storeFile, seedServers });
    const reopened = await application.state.read((state) => state.servers);
    assert.deepEqual(Object.keys(reopened), [serverRecord.server]);
    assert.deepEqual(reopened[serverRecord.server], serverRecord);
    assert.equal(JSON.stringify(reopened).includes(seedServers[0]!), false);
    assert.equal(JSON.stringify(reopened).includes(seedServers[1]!), false);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('client server exposes a credential-free health API beside static assets on the same origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-health-'));
  const storeFile = join(directory, 'client.store.json');
  const seedOrigin = 'https://seeded-world.example:4300';
  const application = await createClientApplication({ storeFile, seedServers: [seedOrigin] });
  const client = await startClientServer({ port: 0, application });
  try {
    await application.state.transaction((state) => {
      state.accounts[firstAccount.id] = firstAccount;
    });
    const healthResponse = await fetch(new URL('/api/health', client.origin));
    assert.equal(healthResponse.status, 200);
    assert.match(healthResponse.headers.get('content-type') ?? '', /application\/json/);
    const healthBody = await healthResponse.text();
    const health = JSON.parse(healthBody) as Record<string, unknown>;
    assert.equal(typeof health, 'object');
    for (const secret of [seedOrigin, firstAccount.id, firstAccount.handle, 'first-native-token']) {
      assert.equal(healthBody.includes(secret), false, secret);
    }

    const html = await fetch(client.origin);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await html.text(), /<div id="root">/);

    assert.equal((await fetch(new URL('/api/unknown', client.origin))).status, 404);
    assert.equal((await fetch(new URL('/', client.origin), { method: 'POST' })).status, 405);
  } finally {
    await client.close();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

interface FixtureHomeAccount {
  handle: string;
  actorId: string;
  password: string;
  nativeToken: string;
  unavailable?: boolean;
}

interface FixtureHome {
  origin: string;
  homeActorId: string;
  accounts: FixtureHomeAccount[];
}

type FixtureAuthorityRole = 'home' | 'registry' | 'territory' | 'asset-server' | 'player';

interface FixtureAuthorityActor {
  handle: string;
  actorId: string;
  role: FixtureAuthorityRole;
}

interface FixtureAuthority {
  origin: string;
  server: string;
  actors: FixtureAuthorityActor[];
  failInfo?: boolean;
}

interface UpstreamCall {
  url: string;
  method: string;
  body?: unknown;
}

const firstLoginAccount: FixtureHomeAccount = {
  handle: firstAccount.handle,
  actorId: firstAccount.actorId!,
  password: 'first-login-password',
  nativeToken: 'first-native-token'
};

const secondLoginAccount: FixtureHomeAccount = {
  handle: secondAccount.handle,
  actorId: secondAccount.actorId!,
  password: 'second-login-password',
  nativeToken: 'second-native-token'
};

const firstHome: FixtureHome = {
  origin: 'https://first.test:4200',
  homeActorId: firstAccount.homeAuthority!,
  accounts: [firstLoginAccount]
};

const secondHome: FixtureHome = {
  origin: 'https://second.test:4200',
  homeActorId: secondAccount.homeAuthority!,
  accounts: [secondLoginAccount]
};

function fixtureHomes(): FixtureHome[] {
  return [{ ...firstHome, accounts: [{ ...firstLoginAccount }] }, { ...secondHome, accounts: [{ ...secondLoginAccount }] }];
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function createFixtureFetch(homes: readonly FixtureHome[], authorities: readonly FixtureAuthority[]): { fetch: typeof fetch; calls: UpstreamCall[] } {
  const calls: UpstreamCall[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ url, method, ...(body === undefined ? {} : { body }) });
    const parsed = new URL(url);
    const home = homes.find((candidate) => new URL(candidate.origin).host === parsed.host);
    if (home) return homeResponse(home, parsed, method, body);
    const authority = authorities.find((candidate) => new URL(candidate.origin).host === parsed.host);
    if (authority) return authorityResponse(authority, url, parsed);
    return new Response(JSON.stringify({ error: 'not-found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch: fetcher, calls };
}

function homeResponse(home: FixtureHome, url: URL, method: string, body: unknown): Response {
  if (url.pathname === '/.well-known/webfinger') {
    const resource = url.searchParams.get('resource') ?? '';
    const handle = resource.startsWith('acct:') ? resource.slice(5) : resource;
    const account = home.accounts.find((candidate) => candidate.handle === handle);
    if (!account) return new Response(JSON.stringify({ error: 'unknown-account' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ subject: `acct:${account.handle}`, links: [{ rel: 'self', href: account.actorId }] }), { status: 200, headers: { 'Content-Type': 'application/jrd+json' } });
  }
  const actor = home.accounts.find((candidate) => candidate.actorId === url.href);
  if (actor) return new Response(JSON.stringify({ id: actor.actorId, role: 'player' }), { status: 200, headers: { 'Content-Type': 'application/activity+json' } });
  if (url.href === home.homeActorId) return new Response(JSON.stringify({ id: home.homeActorId, role: 'home' }), { status: 200, headers: { 'Content-Type': 'application/activity+json' } });
  if (url.pathname === '/local/info') return new Response(JSON.stringify({ kind: 'authority', actor: { home: home.homeActorId } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url.pathname === '/local/home/login' && method === 'POST') {
    const request = bodyRecord(body);
    const account = home.accounts.find((candidate) => candidate.handle === request.handle);
    if (!account || account.password !== request.password) {
      return new Response(JSON.stringify({ status: 'rejected', handle: request.handle, reason: 'invalid-credentials' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    if (account.unavailable) {
      return new Response(JSON.stringify({ status: 'unavailable', handle: account.handle, reason: 'account-unavailable' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ status: 'signed-in', handle: account.handle, actorId: account.actorId, nativeToken: account.nativeToken }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'not-found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}

function authorityResponse(authority: FixtureAuthority, url: string, parsed: URL): Response {
  if (authority.failInfo) throw new TypeError(`Connection refused by ${authority.origin}`);
  if (parsed.pathname === '/.well-known/webfinger') {
    const resource = parsed.searchParams.get('resource') ?? '';
    const handle = resource.startsWith('acct:') ? resource.slice(5) : resource;
    const actor = authority.actors.find((candidate) => candidate.handle === handle);
    if (!actor) return new Response(JSON.stringify({ error: 'unknown-handle' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ subject: `acct:${actor.handle}`, links: [{ rel: 'self', href: actor.actorId }] }), { status: 200, headers: { 'Content-Type': 'application/jrd+json' } });
  }
  const actor = authority.actors.find((candidate) => candidate.actorId === url);
  if (actor) return new Response(JSON.stringify({ id: actor.actorId, role: actor.role }), { status: 200, headers: { 'Content-Type': 'application/activity+json' } });
  if (parsed.pathname === '/local/info') {
    const actors = Object.fromEntries(authority.actors.map((candidate) => [candidate.role, candidate.actorId]));
    return new Response(JSON.stringify({ kind: 'authority', actor: actors, ids: { actor: actors } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'not-found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}

async function openFixtureApplication(storeFile: string, fetchImpl?: typeof fetch, extra: Partial<CreateClientApplicationOptions> = {}) {
  const application = await createClientApplication({ storeFile, ...(fetchImpl ? { fetch: fetchImpl } : {}), ...extra });
  const client = await startClientServer({ port: 0, application });
  clientOrigins.add(client.origin);
  clientApplications.set(client.origin, application);
  for (const key of clientTokens.keys()) if (key.startsWith(`${client.origin}\0`)) clientTokens.delete(key);
  return { application, client };
}

async function readAccounts(origin: string, token: string): Promise<{ accounts: PublicAccountRecord[] }> {
  const response = await fetch(new URL('/api/accounts', origin), { headers: authorization(token) });
  assert.equal(response.status, 200);
  return await response.json() as { accounts: PublicAccountRecord[] };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

interface ExploreTerritoryFixture {
  origins: { policy: string; simulation: string; additional: string };
  policy: Awaited<ReturnType<typeof createPolicyApp>>;
  simulation: Awaited<ReturnType<typeof createSimulationApp>>;
  additional: Awaited<ReturnType<typeof createPolicyApp>>;
  close(): Promise<void>;
}

async function startExploreTerritories(directory: string): Promise<ExploreTerritoryFixture> {
  const [policyPort, simulationPort, additionalPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const origins = {
    policy: `http://127.0.0.1:${policyPort}`,
    simulation: `http://127.0.0.1:${simulationPort}`,
    additional: `http://127.0.0.1:${additionalPort}`
  };
  const authorityOrigin = 'http://127.0.0.1:1';
  const policy = await createPolicyApp({ origin: origins.policy, storeFile: join(directory, 'policy.store.json'), authorityOrigin, peerOrigin: origins.simulation, adminSecret: 'explore-admin' });
  const simulation = await createSimulationApp({ origin: origins.simulation, storeFile: join(directory, 'simulation.store.json'), authorityOrigin, peerOrigin: origins.policy, adminSecret: 'explore-admin' });
  const additional = await createPolicyApp({ origin: origins.additional, storeFile: join(directory, 'additional.store.json'), authorityOrigin, peerOrigin: origins.simulation, adminSecret: 'explore-admin' });
  await Promise.all([
    policy.host.listen(policyPort, '127.0.0.1'),
    simulation.host.listen(simulationPort, '127.0.0.1'),
    additional.host.listen(additionalPort, '127.0.0.1')
  ]);
  return {
    origins,
    policy,
    simulation,
    additional,
    async close() {
      await Promise.allSettled([policy.host.close(), simulation.host.close(), additional.host.close()]);
    }
  };
}

interface ExploreCall { url: string; method: string; authorization: string }

function countingExploreFetch(calls: ExploreCall[]): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : String(input);
    const method = init?.method ?? request?.method ?? 'GET';
    const headers = new Headers(init?.headers ?? request?.headers);
    calls.push({ url, method, authorization: headers.get('authorization') ?? '' });
    return fetch(input, init);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findRecord(value: unknown, predicate: (record: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findRecord(entry, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (predicate(value)) return value;
  for (const entry of Object.values(value)) {
    const found = findRecord(entry, predicate);
    if (found) return found;
  }
  return undefined;
}

function placeRecords(body: unknown): Array<Record<string, unknown>> {
  if (!isRecord(body) || !isRecord(body.data)) return [];
  const places = body.data.places;
  if (Array.isArray(places)) return places.filter(isRecord);
  if (isRecord(places)) return Object.values(places).filter(isRecord);
  return [];
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) as unknown : undefined;
}

async function discoverOrigins(origin: string, servers: readonly string[]): Promise<void> {
  for (const server of servers) {
    const response = await fetch(new URL('/api/servers', origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: server })
    });
    assert.equal(response.status, 200, `discovering ${server}`);
  }
}

async function refreshExplore(origin: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(new URL('/api/explore/refresh', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('logs in distinct accounts concurrently and retains them across restart while logging out one account only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-accounts-'));
  const storeFile = join(directory, 'client.store.json');
  const fixture = createFixtureFetch(fixtureHomes(), []);
  let opened = await openFixtureApplication(storeFile, fixture.fetch);
  try {
    const [firstResponse, secondResponse] = await Promise.all([
      fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: firstLoginAccount.handle, password: firstLoginAccount.password }) }),
      fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: secondLoginAccount.handle, password: secondLoginAccount.password }) })
    ]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    const firstBody = await firstResponse.json() as { account: PublicAccountRecord; status: string; clientToken: string };
    const secondBody = await secondResponse.json() as { account: PublicAccountRecord; status: string; clientToken: string };
    assert.equal(firstBody.status, 'signed-in');
    assert.equal(secondBody.status, 'signed-in');
    assert.equal(firstBody.account.handle, firstLoginAccount.handle);
    assert.equal(secondBody.account.handle, secondLoginAccount.handle);
    assert.equal(firstBody.account.login.status, 'signed-in');
    assert.equal(secondBody.account.login.status, 'signed-in');
    assert.notEqual(firstBody.account.id, secondBody.account.id);
    assert.notEqual(firstBody.clientToken, secondBody.clientToken);
    registerClientToken(opened.client.origin, firstBody.account.id, firstBody.clientToken);
    registerClientToken(opened.client.origin, secondBody.account.id, secondBody.clientToken);
    for (const text of [JSON.stringify(firstBody), JSON.stringify(secondBody)]) {
      assert.equal(text.includes(firstLoginAccount.nativeToken), false);
      assert.equal(text.includes(secondLoginAccount.nativeToken), false);
      assert.equal(text.includes(firstLoginAccount.password), false);
      assert.equal(text.includes(secondLoginAccount.password), false);
    }

    const loginCalls = fixture.calls.filter((call) => new URL(call.url).pathname === '/local/home/login');
    assert.equal(loginCalls.length, 2);
    const callsByOrigin = new Map(loginCalls.map((call) => [new URL(call.url).origin, call]));
    assert.deepEqual(callsByOrigin.get(firstHome.origin)?.body, { handle: firstLoginAccount.handle, password: firstLoginAccount.password });
    assert.deepEqual(callsByOrigin.get(secondHome.origin)?.body, { handle: secondLoginAccount.handle, password: secondLoginAccount.password });

    const listed = await readAccounts(opened.client.origin, firstBody.clientToken);
    assert.deepEqual(listed.accounts.map((account) => account.id), [firstBody.account.id]);
    assert.equal(listed.accounts.every((account) => account.login.status === 'signed-in'), true);
    const listedSecond = await readAccounts(opened.client.origin, secondBody.clientToken);
    assert.deepEqual(listedSecond.accounts.map((account) => account.id), [secondBody.account.id]);

    const firstId = firstBody.account.id;
    const secondId = secondBody.account.id;
    await opened.client.close();
    await opened.application.close();
    opened = await openFixtureApplication(storeFile, fixture.fetch);
    const reopened = await readAccounts(opened.client.origin, firstBody.clientToken);
    assert.deepEqual(reopened.accounts.map((account) => account.id), [firstId]);
    assert.equal(reopened.accounts.every((account) => account.login.status === 'signed-in'), true);

    const logoutResponse = await fetch(new URL(`/api/accounts/${encodeURIComponent(firstId)}/logout`, opened.client.origin), { method: 'POST', headers: authorization(firstBody.clientToken) });
    assert.equal(logoutResponse.status, 200);
    const logoutBody = await logoutResponse.json() as { account: PublicAccountRecord };
    assert.equal(logoutBody.account.id, firstId);
    assert.equal(logoutBody.account.handle, firstLoginAccount.handle);
    assert.equal(logoutBody.account.login.status, 'signed-out');
    assert.equal(JSON.stringify(logoutBody).includes(firstLoginAccount.nativeToken), false);
    const afterLogout = await readAccounts(opened.client.origin, secondBody.clientToken);
    assert.deepEqual(afterLogout.accounts.map((account) => account.id), [secondId]);
    assert.equal(afterLogout.accounts[0]?.login.status, 'signed-in');
    const retainedFirst = await opened.application.state.read((state) => state.accounts[firstId]);
    assert.equal(retainedFirst?.login.status, 'signed-out');
    assert.equal(retainedFirst?.handle, firstLoginAccount.handle);
    assert.equal((await fetch(new URL('/api/accounts', opened.client.origin), { headers: authorization(firstBody.clientToken) })).status, 401);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('successful login retains the Home server and authority across accounts, restart and logout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-known-servers-'));
  const storeFile = join(directory, 'client.store.json');
  const fixture = createFixtureFetch(fixtureHomes(), []);
  let opened = await openFixtureApplication(storeFile, fixture.fetch);
  try {
    const emptyResponse = await fetch(new URL('/api/servers', opened.client.origin));
    assert.equal(emptyResponse.status, 200);
    assert.deepEqual(await emptyResponse.json(), { servers: [], authorities: [] });

    const first = await loginClient(opened.client.origin, firstLoginAccount);
    const firstResponse = await fetch(new URL('/api/servers', opened.client.origin));
    assert.equal(firstResponse.status, 200);
    const firstKnown = await firstResponse.json() as { servers: ServerRecord[]; authorities: AuthorityRecord[] };
    const firstServer = firstKnown.servers.find((candidate) => candidate.server === firstAccount.homeServer);
    assert.ok(firstServer);
    assert.equal(firstServer.origin, 'https://first.test:4200');
    assert.ok(firstServer.authorities.includes(firstAccount.homeAuthority!));
    const firstAuthority = firstKnown.authorities.find((candidate) => candidate.actorId === firstAccount.homeAuthority);
    assert.ok(firstAuthority);
    assert.equal(firstAuthority.server, firstAccount.homeServer);
    assert.ok(firstAuthority.roles.includes('home'));

    await loginClient(opened.client.origin, secondLoginAccount);
    const bothResponse = await fetch(new URL('/api/servers', opened.client.origin));
    assert.equal(bothResponse.status, 200);
    const bothKnown = await bothResponse.json() as { servers: ServerRecord[]; authorities: AuthorityRecord[] };
    for (const account of [firstAccount, secondAccount]) {
      const server = bothKnown.servers.find((candidate) => candidate.server === account.homeServer);
      assert.ok(server);
      assert.equal(server.origin, new URL(account.homeAuthority!).origin);
      assert.ok(server.authorities.includes(account.homeAuthority!));
      const authority = bothKnown.authorities.find((candidate) => candidate.actorId === account.homeAuthority);
      assert.ok(authority);
      assert.equal(authority.server, account.homeServer);
      assert.ok(authority.roles.includes('home'));
    }

    await opened.client.close();
    await opened.application.close();
    opened = await openFixtureApplication(storeFile, fixture.fetch);
    const reopenedResponse = await fetch(new URL('/api/servers', opened.client.origin));
    assert.equal(reopenedResponse.status, 200);
    const reopened = await reopenedResponse.json() as { servers: ServerRecord[]; authorities: AuthorityRecord[] };
    for (const account of [firstAccount, secondAccount]) {
      const server = reopened.servers.find((candidate) => candidate.server === account.homeServer);
      assert.ok(server);
      assert.equal(server.origin, new URL(account.homeAuthority!).origin);
      assert.ok(server.authorities.includes(account.homeAuthority!));
      const authority = reopened.authorities.find((candidate) => candidate.actorId === account.homeAuthority);
      assert.ok(authority);
      assert.equal(authority.server, account.homeServer);
      assert.ok(authority.roles.includes('home'));
    }

    const logoutResponse = await fetch(new URL(`/api/accounts/${encodeURIComponent(first.account.id)}/logout`, opened.client.origin), { method: 'POST', headers: authorization(first.clientToken) });
    assert.equal(logoutResponse.status, 200);
    const afterLogoutResponse = await fetch(new URL('/api/servers', opened.client.origin));
    assert.equal(afterLogoutResponse.status, 200);
    const afterLogout = await afterLogoutResponse.json() as { servers: ServerRecord[]; authorities: AuthorityRecord[] };
    for (const account of [firstAccount, secondAccount]) {
      const server = afterLogout.servers.find((candidate) => candidate.server === account.homeServer);
      assert.ok(server);
      assert.equal(server.origin, new URL(account.homeAuthority!).origin);
      assert.ok(server.authorities.includes(account.homeAuthority!));
      const authority = afterLogout.authorities.find((candidate) => candidate.actorId === account.homeAuthority);
      assert.ok(authority);
      assert.equal(authority.server, account.homeServer);
      assert.ok(authority.roles.includes('home'));
    }
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejected and unavailable logins return client errors without retaining signed-in tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-login-errors-'));
  const storeFile = join(directory, 'client.store.json');
  const blocked: FixtureHomeAccount = { handle: '@blocked@blocked.test', actorId: 'https://blocked.test/actors/blocked', password: 'blocked-password', nativeToken: 'blocked-native-token', unavailable: true };
  const home = fixtureHomes()[0]!;
  const fixture = createFixtureFetch([home, { origin: 'https://blocked.test', homeActorId: 'https://blocked.test/actors/home', accounts: [blocked] }], []);
  const opened = await openFixtureApplication(storeFile, fixture.fetch);
  try {
    const obsoleteResponse = await fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: firstLoginAccount.handle, password: firstLoginAccount.password, homeOrigin: home.origin }) });
    assert.equal(obsoleteResponse.status, 400);
    assert.ok((await obsoleteResponse.text()).length > 0);

    const rejectedResponse = await fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: firstLoginAccount.handle, password: 'wrong-password' }) });
    assert.ok(rejectedResponse.status >= 400 && rejectedResponse.status < 500);
    const rejectedBody = await rejectedResponse.json() as { account?: PublicAccountRecord; status?: string };
    assert.equal(rejectedBody.status, 'rejected');
    assert.notEqual(rejectedBody.account?.login.status, 'signed-in');
    assert.equal(JSON.stringify(rejectedBody).includes(firstLoginAccount.nativeToken), false);
    assert.equal(JSON.stringify(rejectedBody).includes('wrong-password'), false);

    const unavailableResponse = await fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: blocked.handle, password: blocked.password }) });
    assert.ok(unavailableResponse.status >= 400 && unavailableResponse.status < 500);
    const unavailableBody = await unavailableResponse.json() as { account?: PublicAccountRecord; status?: string };
    assert.equal(unavailableBody.status, 'unavailable');
    assert.notEqual(unavailableBody.account?.login.status, 'signed-in');
    assert.equal(JSON.stringify(unavailableBody).includes(blocked.nativeToken), false);

    const retainedAccounts = await opened.application.state.read((state) => state.accounts);
    assert.deepEqual(retainedAccounts, {});
    const retainedServers = await opened.application.state.read((state) => state.servers);
    const retainedAuthorities = await opened.application.state.read((state) => state.authorities);
    assert.deepEqual(retainedServers, {});
    assert.deepEqual(retainedAuthorities, {});
    assert.equal(JSON.stringify(retainedAccounts).includes(firstLoginAccount.nativeToken), false);
    assert.equal(JSON.stringify(retainedAccounts).includes(blocked.nativeToken), false);
    assert.equal((await fetch(new URL('/api/accounts', opened.client.origin))).status, 401);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed server discovery leaves every retained account signed in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-discovery-failure-'));
  const storeFile = join(directory, 'client.store.json');
  const fixture = createFixtureFetch(fixtureHomes(), [{ origin: 'http://broken.test:4300', server: 'broken.test:4300', actors: [], failInfo: true }]);
  const opened = await openFixtureApplication(storeFile, fixture.fetch);
  try {
    const logins = await Promise.all([
      fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: firstLoginAccount.handle, password: firstLoginAccount.password }) }),
      fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: secondLoginAccount.handle, password: secondLoginAccount.password }) })
    ]);
    const bodies = await Promise.all(logins.map(async (response) => { assert.equal(response.status, 200); return await response.json() as { account: PublicAccountRecord; clientToken: string } }));
    const ids = bodies.map((body) => body.account.id).sort();
    for (const body of bodies) registerClientToken(opened.client.origin, body.account.id, body.clientToken);

    const failure = await fetch(new URL('/api/servers', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: 'http://broken.test:4300' }) });
    assert.ok(failure.status >= 400);
    const failureText = await failure.text();
    assert.ok(failureText.length > 0 && failureText.length < 2000);
    const failureBody = bodyRecord(JSON.parse(failureText) as unknown);
    assert.equal(typeof (failureBody.error ?? failureBody.reason), 'string');
    assert.equal(failureText.includes(firstLoginAccount.nativeToken), false);
    assert.equal(failureText.includes(secondLoginAccount.nativeToken), false);

    const listed = await Promise.all(bodies.map((body) => readAccounts(opened.client.origin, body.clientToken)));
    assert.deepEqual(listed.flatMap((entry) => entry.accounts.map((account) => account.id)).sort(), ids);
    assert.equal(listed.every((entry) => entry.accounts.every((account) => account.login.status === 'signed-in')), true);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovers public server authorities before login and retains them after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-servers-'));
  const storeFile = join(directory, 'client.store.json');
  const authority: FixtureAuthority = {
    origin: 'http://harbor.test:4200',
    server: 'harbor.test:4200',
    actors: [
      { handle: '@harbor.registry@harbor.test:4200', actorId: 'http://harbor.test:4200/actors/registry', role: 'registry' },
      { handle: '@harbor.home@harbor.test:4200', actorId: 'http://harbor.test:4200/actors/home', role: 'home' },
      { handle: '@harbor.player@harbor.test:4200', actorId: 'http://harbor.test:4200/actors/player', role: 'player' },
      { handle: '@harbor.territory@harbor.test:4200', actorId: 'http://harbor.test:4200/actors/territory', role: 'territory' }
    ]
  };
  const fixture = createFixtureFetch([], [authority]);
  let opened = await openFixtureApplication(storeFile, fixture.fetch);
  try {
    assert.equal((await fetch(new URL('/api/accounts', opened.client.origin))).status, 401);
    const response = await fetch(new URL('/api/servers', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: authority.origin }) });
    assert.equal(response.status, 200);
    const body = await response.json() as { servers: ServerRecord[]; authorities: AuthorityRecord[] };
    const server = body.servers.find((candidate) => candidate.origin === authority.origin);
    assert.ok(server);
    assert.equal(server.server, authority.server);
    const registry = body.authorities.find((candidate) => candidate.actorId === authority.actors[0]!.actorId);
    const home = body.authorities.find((candidate) => candidate.actorId === authority.actors[1]!.actorId);
    const territory = body.authorities.find((candidate) => candidate.actorId === authority.actors[3]!.actorId);
    assert.ok(registry);
    assert.ok(home);
    assert.ok(territory);
    assert.equal(registry.handle, undefined, 'Actor paths do not establish a discoverable handle');
    assert.equal(home.handle, undefined, 'An unadvertised handle remains unknown');
    assert.ok(registry.roles.includes('registry'));
    assert.ok(home.roles.includes('home'));
    assert.ok(territory.roles.includes('territory'));
    assert.ok(server.authorities.includes(authority.actors[3]!.actorId));
    assert.equal(body.authorities.some((candidate) => candidate.actorId === authority.actors[2]!.actorId), false);
    assert.ok(fixture.calls.some((call) => call.url === `${authority.origin}/local/info`));
    assert.ok(fixture.calls.some((call) => call.url === authority.actors[0]!.actorId));
    assert.ok(fixture.calls.some((call) => call.url === authority.actors[1]!.actorId));

    const callCount = fixture.calls.length;
    const retainedResponse = await fetch(new URL('/api/servers', opened.client.origin));
    assert.equal(retainedResponse.status, 200);
    assert.deepEqual(await retainedResponse.json(), body);
    assert.equal(fixture.calls.length, callCount);

    await opened.client.close();
    await opened.application.close();
    opened = await openFixtureApplication(storeFile, fixture.fetch);
    const reopenedResponse = await fetch(new URL('/api/servers', opened.client.origin));
    assert.equal(reopenedResponse.status, 200);
    assert.deepEqual(await reopenedResponse.json(), body);
    assert.equal((await fetch(new URL('/api/accounts', opened.client.origin))).status, 401);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('requires exactly one valid server discovery input and resolves a matching authority handle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-server-input-'));
  const storeFile = join(directory, 'client.store.json');
  const authority: FixtureAuthority = {
    origin: 'http://harbor.test:4200',
    server: 'harbor.test:4200',
    actors: [{ handle: '@harbor.registry@harbor.test:4200', actorId: 'http://harbor.test:4200/actors/registry', role: 'registry' }]
  };
  const fixture = createFixtureFetch([], [authority]);
  const opened = await openFixtureApplication(storeFile, fixture.fetch);
  try {
    const post = (body: unknown) => fetch(new URL('/api/servers', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const invalid of [{}, { origin: authority.origin, handle: authority.actors[0]!.handle }, { origin: 'ftp://harbor.test:4200' }, { handle: 'not-a-handle' }]) {
      const response = await post(invalid);
      assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(invalid));
      assert.ok((await response.text()).length > 0);
    }
    const emptyResponse = await fetch(new URL('/api/servers', opened.client.origin));
    assert.equal(emptyResponse.status, 200);
    assert.deepEqual(await emptyResponse.json(), { servers: [], authorities: [] });

    const originResponse = await post({ origin: authority.origin });
    assert.equal(originResponse.status, 200);
    const handleResponse = await post({ handle: authority.actors[0]!.handle });
    assert.equal(handleResponse.status, 200);
    const body = await handleResponse.json() as { servers: ServerRecord[]; authorities: AuthorityRecord[] };
    assert.equal(body.servers.some((candidate) => candidate.origin === authority.origin), true);
    const resolved = body.authorities.find((candidate) => candidate.actorId === authority.actors[0]!.actorId);
    assert.ok(resolved);
    assert.ok(resolved.roles.includes('registry'));
    assert.ok(fixture.calls.some((call) => new URL(call.url).pathname === '/.well-known/webfinger'));
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('resolves administrator credentials only for signed-in explicitly bound accounts and targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-administrator-'));
  const storeFile = join(directory, 'client.store.json');
  const fixture = createFixtureFetch(fixtureHomes(), []);
  const registryActor = 'http://harbor.test:4200/actors/registry';
  const otherActor = 'http://other.test:4200/actors/registry';
  const missingSourceActor = 'http://harbor.test:4200/actors/policy';
  let opened = await openFixtureApplication(storeFile, fixture.fetch);
  try {
    const login = await fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: firstLoginAccount.handle, password: firstLoginAccount.password }) });
    assert.equal(login.status, 200);
    const loginBody = await login.json() as { account: PublicAccountRecord; clientToken: string };
    const accountId = loginBody.account.id;
    registerClientToken(opened.client.origin, accountId, loginBody.clientToken);
    await opened.client.close();
    await opened.application.close();

    opened = await openFixtureApplication(storeFile, fixture.fetch, {
      administratorBindings: [
        { accountId, authorityActorIds: [registryActor], credentialSource: 'registry-administrator' },
        { accountId, authorityActorIds: [missingSourceActor], credentialSource: 'missing-source' }
      ],
      administratorCredentials: { 'registry-administrator': 'registry-administrator-secret' }
    });
    const resolver = opened.application;
    assert.equal(typeof resolver.resolveAdministratorCredential, 'function');
    assert.equal(await resolver.resolveAdministratorCredential(accountId, registryActor), 'registry-administrator-secret');
    await assert.rejects(resolver.resolveAdministratorCredential(accountId, otherActor));
    await assert.rejects(resolver.resolveAdministratorCredential('account:missing', registryActor));
    await assert.rejects(resolver.resolveAdministratorCredential(accountId, missingSourceActor));

    const accountsText = await (await fetch(new URL('/api/accounts', opened.client.origin), { headers: authorization(loginBody.clientToken) })).text();
    const serversText = await (await fetch(new URL('/api/servers', opened.client.origin))).text();
    for (const text of [accountsText, serversText]) {
      assert.equal(text.includes('registry-administrator-secret'), false);
      assert.equal(text.includes('missing-source'), false);
    }

    const logout = await fetch(new URL(`/api/accounts/${encodeURIComponent(accountId)}/logout`, opened.client.origin), { method: 'POST', headers: authorization(loginBody.clientToken) });
    assert.equal(logout.status, 200);
    await assert.rejects(resolver.resolveAdministratorCredential(accountId, registryActor));
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const observationSourceA = 'https://harbor.test:4200/local/registry/state';
const observationSourceB = 'https://peer.test:4200/local/registry/state';

test('observation service retains not-retrieved, empty, competing-source, stale and unavailable states without merging sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-observations-'));
  const storeFile = join(directory, 'client.store.json');
  const application = await createClientApplication({ storeFile, observationTimeoutMs: 200 });
  try {
    const missing = await application.observations.readOne('vessel:harbor:location', observationSourceA);
    assert.equal(missing.state, 'not-retrieved');
    assert.equal(missing.source, observationSourceA);

    const available = await application.observations.refresh({
      key: 'vessel:harbor:location',
      source: observationSourceA,
      load: async () => ({ port: 'alpha' })
    });
    assert.equal(available.state, 'available');
    assert.equal(available.source, observationSourceA);
    if (available.state === 'available' || available.state === 'empty' || available.state === 'stale') {
      assert.equal(Number.isFinite(Date.parse(available.observedAt)), true);
      assert.deepEqual(available.value, { port: 'alpha' });
    }

    const empty = await application.observations.refresh({
      key: 'vessel:harbor:cargo',
      source: observationSourceA,
      load: async () => ({ entries: [] }),
      isEmpty: (value) => value.entries.length === 0
    });
    assert.equal(empty.state, 'empty');
    assert.deepEqual((empty as { value: unknown }).value, { entries: [] });

    const competing = await application.observations.refresh({
      key: 'vessel:harbor:location',
      source: observationSourceB,
      load: async () => ({ port: 'beta' })
    });
    assert.equal(competing.state, 'available');
    const retained = await application.observations.read('vessel:harbor:location');
    assert.deepEqual(retained.map((observation) => observation.source).sort(), [observationSourceA, observationSourceB].sort());
    assert.deepEqual((await application.observations.readOne('vessel:harbor:location', observationSourceA) as { value: unknown }).value, { port: 'alpha' });
    assert.deepEqual((await application.observations.readOne('vessel:harbor:location', observationSourceB) as { value: unknown }).value, { port: 'beta' });

    const stale = await application.observations.refresh({
      key: 'vessel:harbor:location',
      source: observationSourceA,
      load: async () => { throw new Error('registry unavailable'); }
    });
    assert.equal(stale.state, 'stale');
    assert.equal(stale.source, observationSourceA);
    assert.match((stale as { error?: string }).error ?? '', /registry unavailable/i);
    assert.equal((stale as { observedAt: string }).observedAt, (available as { observedAt: string }).observedAt);
    assert.deepEqual((stale as { value: unknown }).value, { port: 'alpha' });

    const unavailable = await application.observations.refresh({
      key: 'vessel:harbor:crew',
      source: observationSourceA,
      load: async () => { throw new Error('crew service unavailable'); }
    });
    assert.equal(unavailable.state, 'unavailable');
    assert.match((unavailable as { error: string }).error, /crew service unavailable/i);

    assert.equal((await application.observations.readOne('vessel:harbor:location', observationSourceB)).state, 'available');
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('observation refresh bounds a hung source without blocking independent refreshes or retained writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-observation-timeout-'));
  const storeFile = join(directory, 'client.store.json');
  const application = await createClientApplication({ storeFile, observationTimeoutMs: 300 });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let aborted = false;
  try {
    const hung = application.observations.refresh({
      key: 'territory:slow:state',
      source: 'https://slow.test:4200/local/state',
      load: async (signal) => {
        signal.addEventListener('abort', () => { aborted = true; });
        await gate;
        return { late: true };
      }
    }).then((value) => ({ state: 'fulfilled' as const, value }), (error: unknown) => ({ state: 'rejected' as const, error }));
    const settled = await Promise.race([
      application.state.transaction((state) => {
        state.drafts['draft:independent'] = { id: 'draft:independent' };
        return 'written';
      }).then(() => 'written' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 100))
    ]);
    assert.equal(settled, 'written');
    const independent = await application.observations.refresh({
      key: 'territory:fast:state',
      source: 'https://fast.test:4200/local/state',
      load: async () => ({ ready: true })
    });
    assert.equal(independent.state, 'available');
    const timedOut = await hung;
    assert.equal(timedOut.state, 'fulfilled');
    if (timedOut.state === 'fulfilled') {
      assert.equal(timedOut.value.state, 'unavailable');
      assert.match((timedOut.value as { error: string }).error, /tim(e|ed) out|timeout/i);
    }
    assert.equal(aborted, true);
    assert.deepEqual(await application.state.read((state) => state.drafts['draft:independent']), { id: 'draft:independent' });
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await application.observations.readOne('territory:slow:state', 'https://slow.test:4200/local/state')).state, 'unavailable');
  } finally {
    release?.();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function seedSignedInAccount(application: ClientApplication): Promise<void> {
  await application.state.transaction((state) => {
    state.accounts[firstAccount.id] = firstAccount;
  });
}

test('action submit prepares first, persists sending, keeps explicit account target and intent, and persists followed references', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-action-submit-'));
  const storeFile = join(directory, 'client.store.json');
  const calls: string[] = [];
  let sendingRecord: ActionRecord | undefined;
  const handler: ActionHandler = {
    async prepare(input) {
      calls.push(`prepare:${input.accountId}:${input.targetId}:${input.intent.kind}:${JSON.stringify(input.intent.inputs)}`);
      return { accepted: true };
    },
    async submit(input) {
      calls.push(`submit:${input.accountId}:${input.targetId}:${input.intent.kind}`);
      sendingRecord = await application.state.read((state) => Object.values(state.actions).find((action) => action.accountId === input.accountId));
      return {
        result: 'request:submitted',
        references: [{ kind: 'request', id: 'request:submitted' }, { kind: 'job', id: 'job:followed' }]
      };
    },
    async reconcile() {
      return { status: 'pending', evidence: [] };
    }
  };
  const application = await createClientApplication({ storeFile, actionHandlers: { mine: handler } });
  try {
    await seedSignedInAccount(application);
    const record = await application.actions.submit({
      accountId: firstAccount.id,
      targetId: authorityRecord.actorId,
      intent: { kind: 'mine', inputs: { count: 3 } }
    });
    assert.equal(sendingRecord?.submission.status, 'sending');
    assert.equal(sendingRecord?.accountId, firstAccount.id);
    assert.equal(record.submission.status, 'accepted');
    assert.equal(record.submission.result, 'request:submitted');
    assert.equal(record.outcome.status, 'pending');
    assert.equal(record.accountId, firstAccount.id);
    assert.equal(record.targetId, authorityRecord.actorId);
    assert.deepEqual(record.intent, { kind: 'mine', inputs: { count: 3 } });
    assert.deepEqual(record.resultReferences.map((reference) => `${reference.kind}:${reference.id}`).sort(), ['job:job:followed', 'request:request:submitted']);
    assert.match(calls[0] ?? '', new RegExp(`^prepare:${escapeRegExp(firstAccount.id)}:${escapeRegExp(authorityRecord.actorId)}:mine:`));
    assert.match(calls[1] ?? '', new RegExp(`^submit:${escapeRegExp(firstAccount.id)}:${escapeRegExp(authorityRecord.actorId)}:mine`));

    const followedRequests = await application.state.read((state) => state.followedRequests);
    assert.equal(Object.values(followedRequests).some((entry) => entry.actionId === record.id && entry.accountId === firstAccount.id && entry.targetId === authorityRecord.actorId && entry.id === 'request:submitted'), true);
    const followedJobs = await application.state.read((state) => state.followedJobs);
    assert.equal(Object.values(followedJobs).some((entry) => entry.actionId === record.id && entry.accountId === firstAccount.id && entry.targetId === authorityRecord.actorId && entry.id === 'job:followed'), true);

    assert.deepEqual((await application.actions.list(firstAccount.id)).map((action) => action.id), [record.id]);
    assert.deepEqual(await application.actions.list(secondAccount.id), []);
    assert.deepEqual(await application.actions.get(record.id, firstAccount.id), record);
    assert.equal(await application.actions.get(record.id, secondAccount.id), undefined);
    const serialized = JSON.stringify(await application.actions.list(firstAccount.id));
    assert.equal(serialized.includes(firstAccount.login.status === 'signed-in' ? firstAccount.login.nativeToken : ''), false);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('prepare rejection prevents submission and leaves an inspectable rejected failed result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-action-prepare-rejection-'));
  const storeFile = join(directory, 'client.store.json');
  let submitted = 0;
  const handler: ActionHandler = {
    async prepare() { return { accepted: false, reason: 'missing prerequisite: ore' }; },
    async submit() { submitted += 1; return { result: 'should-not-happen' }; }
  };
  const application = await createClientApplication({ storeFile, actionHandlers: { mine: handler } });
  try {
    await seedSignedInAccount(application);
    const record = await application.actions.submit({
      accountId: firstAccount.id,
      targetId: authorityRecord.actorId,
      intent: { kind: 'mine', inputs: { count: 1 } }
    });
    assert.equal(submitted, 0);
    assert.equal(record.submission.status, 'rejected');
    assert.match(record.submission.error ?? '', /missing prerequisite/i);
    assert.equal(record.outcome.status, 'failed');
    assert.deepEqual(await application.actions.get(record.id, firstAccount.id), record);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('action callbacks time out without replay and reconciliation retains newly discovered references', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-action-deadlines-'));
  let submissions = 0;
  const application = await createClientApplication({
    storeFile: join(directory, 'client.store.json'), actionTimeoutMs: 30,
    actionHandlers: {
      hung: { async submit() { submissions += 1; return new Promise(() => {}); } },
      pending: {
        async submit() { return {}; },
        async reconcile() { return { status: 'pending', references: [{ kind: 'job', id: 'job:discovered' }], result: 'job discovered' }; }
      },
      sync: { submit() { throw new Error('synchronous callback failure'); } }
    }
  });
  try {
    await seedSignedInAccount(application);
    const input = { accountId: firstAccount.id, targetId: authorityRecord.actorId };
    const hung = await application.actions.submit({ ...input, intent: { kind: 'hung', inputs: {} } });
    assert.equal(hung.submission.status, 'unverified');
    assert.match(hung.submission.error ?? '', /timed out|timeout/i);
    await application.actions.reconcile(hung.id, firstAccount.id);
    assert.equal(submissions, 1);
    const sync = await application.actions.submit({ ...input, intent: { kind: 'sync', inputs: {} } });
    assert.match(sync.submission.error ?? '', /synchronous callback failure/);
    const pending = await application.actions.submit({ ...input, intent: { kind: 'pending', inputs: {} } });
    const reconciled = await application.actions.reconcile(pending.id, firstAccount.id);
    assert.deepEqual(reconciled.resultReferences, [{ kind: 'job', id: 'job:discovered' }]);
    assert.equal(Object.values(await application.state.read((state) => state.followedJobs)).some((entry) => entry.actionId === pending.id && entry.id === 'job:discovered'), true);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('action submit requires a retained signed-in account and never submits for missing or signed-out accounts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-action-account-scope-'));
  const storeFile = join(directory, 'client.store.json');
  let submitted = 0;
  const application = await createClientApplication({
    storeFile,
    actionHandlers: { mine: { async submit() { submitted += 1; return { result: 'unexpected' }; } } }
  });
  try {
    const request = { accountId: firstAccount.id, targetId: authorityRecord.actorId, intent: { kind: 'mine', inputs: { count: 1 } } };
    await assert.rejects(application.actions.submit(request), /account|signed/i);
    await application.state.transaction((state) => {
      state.accounts[firstAccount.id] = { ...firstAccount, login: { status: 'signed-out' } };
    });
    await assert.rejects(application.actions.submit(request), /account|signed/i);
    assert.equal(submitted, 0);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('submit transport uncertainty stays unverified, is never resubmitted, and survives recreation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-action-transport-'));
  const storeFile = join(directory, 'client.store.json');
  let submitted = 0;
  const handler: ActionHandler = {
    async submit() { submitted += 1; throw new Error('connection reset during submission'); },
    async reconcile() { return { status: 'unverified', error: 'outcome still unknown' }; }
  };
  let application = await createClientApplication({ storeFile, actionHandlers: { mine: handler } });
  let actionId = '';
  try {
    await seedSignedInAccount(application);
    const record = await application.actions.submit({
      accountId: firstAccount.id,
      targetId: authorityRecord.actorId,
      intent: { kind: 'mine', inputs: { count: 2 } }
    });
    actionId = record.id;
    assert.equal(record.submission.status, 'unverified');
    assert.equal(record.outcome.status, 'unverified');
    assert.match(`${record.submission.error ?? ''} ${record.outcome.error ?? ''}`, /connection reset|unknown/i);
    const reconciled = await application.actions.reconcile(actionId, firstAccount.id);
    assert.equal(reconciled.submission.status, 'unverified');
    assert.equal(submitted, 1);

    await application.close();
    application = await createClientApplication({ storeFile, actionHandlers: { mine: handler } });
    const reopened = await application.actions.get(actionId, firstAccount.id);
    assert.equal(reopened?.submission.status, 'unverified');
    assert.equal(reopened?.outcome.status, 'unverified');
    await application.actions.reconcile(actionId, firstAccount.id);
    assert.equal(submitted, 1);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('accepted submission and references survive failed read-back, and completion requires nonempty evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-action-readback-'));
  const storeFile = join(directory, 'client.store.json');
  let mode: 'readback-failure' | 'no-evidence' | 'evidence' = 'readback-failure';
  const handler: ActionHandler = {
    async submit() { return { result: 'job:accepted', references: [{ kind: 'job', id: 'job:accepted' }] }; },
    async reconcile() {
      if (mode === 'readback-failure') throw new Error('read-back endpoint unavailable');
      if (mode === 'no-evidence') return { status: 'completed', evidence: [] };
      return { status: 'completed', evidence: [{ source: observationSourceA, observedAt: '2026-10-29T12:00:00Z', changes: { status: 'done' } }] };
    }
  };
  const application = await createClientApplication({ storeFile, actionHandlers: { mine: handler } });
  try {
    await seedSignedInAccount(application);
    const record = await application.actions.submit({
      accountId: firstAccount.id,
      targetId: authorityRecord.actorId,
      intent: { kind: 'mine', inputs: { count: 1 } }
    });
    const failedReadBack = await application.actions.reconcile(record.id, firstAccount.id);
    assert.equal(failedReadBack.submission.status, 'accepted');
    assert.equal(failedReadBack.submission.result, 'job:accepted');
    assert.deepEqual(failedReadBack.resultReferences, [{ kind: 'job', id: 'job:accepted' }]);
    assert.equal(failedReadBack.outcome.status, 'unverified');
    assert.match(failedReadBack.outcome.error ?? '', /read-back/i);
    assert.equal(failedReadBack.outcome.evidence.length, 0);

    mode = 'no-evidence';
    const noEvidence = await application.actions.reconcile(record.id, firstAccount.id);
    assert.notEqual(noEvidence.outcome.status, 'completed');
    assert.equal(actionIsComplete(noEvidence), false);

    mode = 'evidence';
    const completed = await application.actions.reconcile(record.id, firstAccount.id);
    assert.equal(completed.outcome.status, 'completed');
    assert.equal(completed.outcome.evidence.length, 1);
    assert.equal(completed.outcome.evidence[0]?.source, observationSourceA);
    assert.equal(actionIsComplete(completed), true);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('pending action references persist and an explicitly reconciled action completes after recreation with handlers registered again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-action-restart-'));
  const storeFile = join(directory, 'client.store.json');
  let submitted = 0;
  const handler: ActionHandler = {
    async submit() { submitted += 1; return { result: 'job:pending', references: [{ kind: 'job', id: 'job:pending' }] }; },
    async reconcile() {
      return { status: 'completed', evidence: [{ source: observationSourceB, observedAt: '2026-10-29T12:05:00Z', changes: { job: 'job:pending' } }] };
    }
  };
  let application = await createClientApplication({ storeFile, actionHandlers: { mine: handler } });
  let actionId = '';
  try {
    await seedSignedInAccount(application);
    const record = await application.actions.submit({
      accountId: firstAccount.id,
      targetId: authorityRecord.actorId,
      intent: { kind: 'mine', inputs: { count: 4 } }
    });
    actionId = record.id;
    assert.equal(record.outcome.status, 'pending');
    const followedJobs = await application.state.read((state) => state.followedJobs);
    assert.equal(Object.values(followedJobs).some((entry) => entry.actionId === actionId && entry.id === 'job:pending'), true);

    await application.close();
    application = await createClientApplication({ storeFile, actionHandlers: { mine: handler } });
    const retained = await application.actions.get(actionId, firstAccount.id);
    assert.equal(retained?.outcome.status, 'pending');
    const reconciled = await application.actions.reconcile(actionId, firstAccount.id);
    assert.equal(reconciled.outcome.status, 'completed');
    assert.equal(reconciled.outcome.evidence.length, 1);
    assert.equal(submitted, 1);
    const reopenedJobs = await application.state.read((state) => state.followedJobs);
    assert.equal(Object.values(reopenedJobs).some((entry) => entry.actionId === actionId && entry.id === 'job:pending'), true);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('interrupted sending records become unverified on reopening without replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-action-interrupted-'));
  const storeFile = join(directory, 'client.store.json');
  const interrupted: ActionRecord = {
    ...actionRecord,
    id: 'action:interrupted',
    statusUrl: '/api/activity/action%3Ainterrupted',
    submission: { status: 'sending' },
    outcome: { status: 'pending', evidence: [] }
  };
  let submitted = 0;
  let application = await createClientApplication({ storeFile });
  try {
    await application.state.transaction((state) => {
      state.accounts[firstAccount.id] = firstAccount;
      state.actions[interrupted.id] = interrupted;
    });
    await application.close();
    application = await createClientApplication({
      storeFile,
      actionHandlers: { mine: { async submit() { submitted += 1; return { result: 'replayed' }; } } }
    });
    const recovered = await application.actions.get(interrupted.id, firstAccount.id);
    assert.equal(recovered?.submission.status, 'unverified');
    assert.equal(recovered?.outcome.status, 'unverified');
    assert.ok((recovered?.outcome.error ?? recovered?.submission.error ?? '').length > 0);
    assert.equal(submitted, 0);
    const listed = await application.actions.list(firstAccount.id);
    assert.equal(listed.some((action) => action.id === interrupted.id && action.submission.status === 'unverified'), true);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('activity HTTP reads retained state only and explicit refresh reconciles without submitting or touching the network', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-activity-http-'));
  const storeFile = join(directory, 'client.store.json');
  let submitted = 0;
  let reconciled = 0;
  const handler: ActionHandler = {
    async submit() { submitted += 1; return { result: 'should-not-submit' }; },
    async reconcile(input) {
      reconciled += 1;
      assert.equal(input.accountId, firstAccount.id);
      assert.equal(input.targetId, authorityRecord.actorId);
      assert.equal(input.intent.kind, 'mine');
      assert.deepEqual(input.references, actionRecord.resultReferences);
      return { status: 'completed', evidence: [{ source: observationRecord.source, observedAt: '2026-10-29T12:05:00Z', changes: { job: 'job:1' } }] };
    }
  };
  const fixture = createFixtureFetch(fixtureHomes(), []);
  const opened = await openFixtureApplication(storeFile, fixture.fetch, { actionHandlers: { mine: handler } });
  try {
    await opened.application.state.transaction((state) => {
      state.accounts[firstAccount.id] = firstAccount;
      state.accounts[secondAccount.id] = secondAccount;
      state.actions[actionRecord.id] = { ...actionRecord, outcome: { ...actionRecord.outcome, evidence: [{ source: observationRecord.source, observedAt: '2026-10-29T12:00:00Z' }] } };
      state.observations['observation:registry'] = observationRecord;
      state.observations['unrelated:other-account'] = { state: 'available', source: 'https://other.test/private', observedAt: '2026-10-29T12:00:00Z', value: { privateNote: 'unrelated-account-observation' } };
      state.identities[authorityRecord.actorId] = {
        actorId: authorityRecord.actorId,
        source: authorityRecord.actorId,
        state: 'available',
        verified: true,
        ...(authorityRecord.handle === undefined ? {} : { handle: authorityRecord.handle }),
        observedAt: '2026-10-29T12:00:00Z'
      };
    });
    const activityUrl = (query = '') => new URL(`/api/activity${query}`, opened.client.origin);
    const detailUrl = new URL(`/api/activity/${encodeURIComponent(actionRecord.id)}?accountId=${encodeURIComponent(firstAccount.id)}`, opened.client.origin);

    const listResponse = await fetch(activityUrl(`?accountId=${encodeURIComponent(firstAccount.id)}`));
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json() as PageResponse<{ actions: ActionRecord[] }>;
    assert.deepEqual(listBody.data.actions.map((action) => action.id), [actionRecord.id]);
    const listText = JSON.stringify(listBody);
    assert.equal(listText.includes(firstAccount.login.status === 'signed-in' ? firstAccount.login.nativeToken : ''), false);
    assert.equal(listText.includes('unrelated-account-observation'), false);
    assert.equal(fixture.calls.length, 0, 'reading activity must not call upstream services');

    const otherList = await fetch(activityUrl(`?accountId=${encodeURIComponent(secondAccount.id)}`));
    assert.equal(otherList.status, 200);
    assert.deepEqual(((await otherList.json()) as PageResponse<{ actions: ActionRecord[] }>).data.actions, []);
    const missingScope = await fetch(activityUrl());
    assert.equal(missingScope.status, 400);
    assert.ok((await missingScope.text()).length > 0);

    const detailResponse = await fetch(detailUrl);
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as PageResponse<{ action: ActionRecord }>;
    assert.equal(detail.data.action.id, actionRecord.id);
    assert.equal(detail.actions.some((action) => action.method === 'POST' && action.endpoint.endsWith(`/api/activity/${encodeURIComponent(actionRecord.id)}/refresh`)), true);
    assert.equal(Object.values(detail.observations).some((observation) => observation.source === observationRecord.source), true);
    assert.equal(fixture.calls.length, 0, 'reading activity detail must not call upstream services');

    const wrongAccount = await fetch(new URL(`/api/activity/${encodeURIComponent(actionRecord.id)}?accountId=${encodeURIComponent(secondAccount.id)}`, opened.client.origin));
    assert.equal(wrongAccount.status, 404);
    assert.ok((await wrongAccount.text()).length > 0);
    const missingAction = await fetch(new URL(`/api/activity/${encodeURIComponent('action:missing')}?accountId=${encodeURIComponent(firstAccount.id)}`, opened.client.origin));
    assert.equal(missingAction.status, 404);

    const refreshResponse = await fetch(new URL(`/api/activity/${encodeURIComponent(actionRecord.id)}/refresh`, opened.client.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: firstAccount.id })
    });
    assert.equal(refreshResponse.status, 200);
    const refreshed = await refreshResponse.json() as PageResponse<{ action: ActionRecord }>;
    assert.equal(refreshed.data.action.submission.status, 'accepted');
    assert.equal(refreshed.data.action.outcome.status, 'completed');
    assert.equal(refreshed.data.action.outcome.evidence.length, 1);
    assert.equal(reconciled, 1);
    assert.equal(submitted, 0);
    assert.equal(fixture.calls.length, 0, 'refresh reconciles through the registered handler only');
    const refreshText = JSON.stringify(refreshed);
    assert.equal(refreshText.includes(firstAccount.login.status === 'signed-in' ? firstAccount.login.nativeToken : ''), false);

    const afterRead = await fetch(detailUrl);
    assert.equal(afterRead.status, 200);
    assert.equal(reconciled, 1, 'a GET after refresh must not reconcile again');
    const missingRefreshScope = await fetch(new URL(`/api/activity/${encodeURIComponent(actionRecord.id)}/refresh`, opened.client.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(missingRefreshScope.status, 400);
    const wrongRefreshAccount = await fetch(new URL(`/api/activity/${encodeURIComponent(actionRecord.id)}/refresh`, opened.client.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: secondAccount.id })
    });
    assert.equal(wrongRefreshAccount.status, 404);
    assert.equal(reconciled, 1);
    assert.equal(submitted, 0);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('explore refresh retains advertised Territory geography, follows route references outward, and isolates a failed source', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-explore-geography-'));
  const territories = await startExploreTerritories(directory);
  const calls: ExploreCall[] = [];
  const opened = await openFixtureApplication(join(directory, 'client.store.json'), countingExploreFetch(calls));
  try {
    await discoverOrigins(opened.client.origin, Object.values(territories.origins));

    const readCalls = calls.length;
    const beforeResponse = await fetch(new URL('/api/explore/places', opened.client.origin));
    assert.equal(beforeResponse.status, 200);
    const before = await readJsonResponse(beforeResponse);
    assert.deepEqual(placeRecords(before), []);
    assert.equal(calls.length, readCalls, 'reading places must not perform world IO');

    const refreshResponse = await refreshExplore(opened.client.origin);
    assert.equal(refreshResponse.status, 200);
    const refreshed = await readJsonResponse(refreshResponse);
    const places = placeRecords(refreshed);
    const eastId = territories.policy.ids.ports[0]!;
    const westId = territories.policy.ids.ports[1]!;
    const simulationId = territories.simulation.ids.ports[0]!;
    const east = places.find((place) => place.id === eastId);
    assert.equal(east?.name, 'East Haven');
    const simulationPlace = places.find((place) => place.id === simulationId);
    assert.equal(simulationPlace?.name, 'Simulation Harbor');
    assert.ok(places.filter((place) => place.name === 'East Haven').length >= 2, 'the additional discovered Territory contributes its own East Haven place');
    assert.ok(places.some((place) => typeof place.id === 'string' && place.id.startsWith(territories.origins.additional)), 'the additional server is discovered from its data rather than a fixed panel');

    const text = JSON.stringify(refreshed);
    assert.match(text, /Haven Island/);
    assert.match(text, /Harbor District/);
    assert.match(text, /Coast|Boundary/);
    assert.match(text, new RegExp(escapeRegExp(territories.policy.ids.map)));
    assert.equal(text.includes('Territory A'), false);
    assert.equal(text.includes('Territory B'), false);

    const detailResponse = await fetch(new URL(`/api/explore/places/${encodeURIComponent(eastId)}`, opened.client.origin));
    assert.equal(detailResponse.status, 200);
    const detail = await readJsonResponse(detailResponse);
    const detailPlace = findRecord(detail, (record) => record.id === eastId);
    assert.equal(detailPlace?.name, 'East Haven');
    const coastal = findRecord(detail, (record) => record.id === territories.policy.ids.routes[1]);
    assert.equal(coastal?.from, territories.policy.ids.ports[0]);
    assert.equal(coastal?.to, territories.policy.ids.ports[1]);
    const detailText = JSON.stringify(detail);
    assert.equal(detailText.includes(westId), true, 'a route endpoint whose detail retrieval failed remains known geography');
    assert.match(detailText, /unresolved|unknown|unavailable|not-retrieved|401|unauthorized|forbidden/i);

    const afterReadCalls = calls.length;
    await fetch(new URL('/api/explore/places', opened.client.origin));
    await fetch(new URL(`/api/explore/places/${encodeURIComponent(eastId)}`, opened.client.origin));
    assert.equal(calls.length, afterReadCalls, 'place reads after refresh must not perform world IO');

    await territories.simulation.host.close();
    const isolatedResponse = await refreshExplore(opened.client.origin);
    assert.equal(isolatedResponse.status, 200, 'one unavailable Territory does not stop another');
    const isolated = await readJsonResponse(isolatedResponse);
    assert.ok(placeRecords(isolated).some((place) => place.id === eastId));
    assert.ok(placeRecords(isolated).some((place) => place.id === simulationId), 'previously retained geography is not erased by a source failure');
    const observations = isRecord(isolated) && isRecord(isolated.observations) ? Object.values(isolated.observations).filter(isRecord) : [];
    assert.ok(observations.some((observation) => typeof observation.source === 'string' && observation.source.includes(territories.origins.simulation) && (observation.state === 'unavailable' || observation.state === 'stale') && typeof observation.error === 'string' && observation.error.length > 0), 'the failed source keeps its error and freshness state');
  } finally {
    await opened.client.close();
    await opened.application.close();
    await territories.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('explore saves directed route plans with leg provenance, scopes plan detail to its account, and survives restart', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-explore-routes-'));
  const storeFile = join(directory, 'client.store.json');
  const territories = await startExploreTerritories(directory);
  const calls: ExploreCall[] = [];
  let opened = await openFixtureApplication(storeFile, countingExploreFetch(calls));
  try {
    await opened.application.state.transaction((state) => {
      state.accounts[firstAccount.id] = firstAccount;
      state.accounts[secondAccount.id] = secondAccount;
    });
    await discoverOrigins(opened.client.origin, Object.values(territories.origins));
    assert.equal((await refreshExplore(opened.client.origin)).status, 200);

    const from = territories.policy.ids.ports[0]!;
    const to = territories.policy.ids.ports[1]!;
    const createResponse = await fetch(new URL('/api/explore/routes', opened.client.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: firstAccount.id, from, to })
    });
    assert.equal(createResponse.status, 200);
    const created = await readJsonResponse(createResponse);
    const plan = findRecord(created, (record) => record.accountId === firstAccount.id && record.from === from && record.to === to && Array.isArray(record.legs));
    assert.ok(plan && typeof plan.id === 'string');
    const planId = plan.id as string;
    assert.equal(plan.accountId, firstAccount.id);
    assert.ok(Array.isArray(plan.legs));
    const legs = plan.legs as Array<Record<string, unknown>>;
    assert.equal(legs.length, 1);
    assert.equal(legs[0]?.routeId, territories.policy.ids.routes[1]);
    assert.equal(legs[0]?.from, from);
    assert.equal(legs[0]?.to, to);
    assert.equal(legs[0]?.territoryId, territories.policy.ids.actor);
    assert.match(JSON.stringify(plan), /block|401|unauthor|forbid|unavailable/i, 'the connected plan carries the readable access blocker for the unresolved endpoint');

    const detailUrl = new URL(`/api/explore/routes/${encodeURIComponent(planId)}?accountId=${encodeURIComponent(firstAccount.id)}`, opened.client.origin);
    const detailResponse = await fetch(detailUrl);
    assert.equal(detailResponse.status, 200);
    const detail = await readJsonResponse(detailResponse);
    assert.equal(findRecord(detail, (record) => record.id === planId && record.from === from && record.to === to) !== undefined, true);

    const wrongAccount = await fetch(new URL(`/api/explore/routes/${encodeURIComponent(planId)}?accountId=${encodeURIComponent(secondAccount.id)}`, opened.client.origin));
    assert.equal(wrongAccount.status, 404);
    const wrongText = await wrongAccount.text();
    assert.equal(wrongText.includes(planId), false);
    assert.equal(wrongText.includes(from), false);

    const missingScope = await fetch(new URL(`/api/explore/routes/${encodeURIComponent(planId)}`, opened.client.origin));
    assert.equal(missingScope.status, 400);

    const unknownEndpoint = await fetch(new URL('/api/explore/routes', opened.client.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: firstAccount.id, from: 'https://unknown.test/objects/ports/nowhere', to })
    });
    assert.ok(unknownEndpoint.status >= 400 && unknownEndpoint.status < 500);
    const unknownBody = await readJsonResponse(unknownEndpoint);
    const unknownMessage = isRecord(unknownBody) && typeof unknownBody.error === 'string' ? unknownBody.error : JSON.stringify(unknownBody);

    const reverse = await fetch(new URL('/api/explore/routes', opened.client.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: firstAccount.id, from: to, to: from })
    });
    assert.ok(reverse.status >= 400 && reverse.status < 500, 'the reverse direction is not fabricated');
    const reverseBody = await readJsonResponse(reverse);
    const reverseMessage = isRecord(reverseBody) && typeof reverseBody.error === 'string' ? reverseBody.error : JSON.stringify(reverseBody);
    assert.ok(unknownMessage.length > 0 && reverseMessage.length > 0);
    assert.notEqual(unknownMessage, reverseMessage, 'unknown endpoints and known unreachability are distinguishable');

    const crossServer = await fetch(new URL('/api/explore/routes', opened.client.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: firstAccount.id, from, to: territories.simulation.ids.ports[0] })
    });
    assert.ok(crossServer.status >= 400 && crossServer.status < 500, 'a route is not fabricated across servers');

    await opened.client.close();
    await opened.application.close();
    opened = await openFixtureApplication(storeFile, countingExploreFetch(calls));
    const afterRestart = await fetch(new URL(`/api/explore/routes/${encodeURIComponent(planId)}?accountId=${encodeURIComponent(firstAccount.id)}`, opened.client.origin));
    assert.equal(afterRestart.status, 200);
    const retained = await readJsonResponse(afterRestart);
    const retainedPlan = findRecord(retained, (record) => record.id === planId);
    assert.equal(retainedPlan?.from, from);
    assert.equal(retainedPlan?.to, to);
    assert.equal(JSON.stringify(retained).includes(firstAccount.login.status === 'signed-in' ? firstAccount.login.nativeToken : ''), false);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await territories.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('shared resource reader retains public-first content, source identity, and explicit refresh without serializing credentials', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-resource-reader-'));
  const territories = await startExploreTerritories(directory);
  const calls: ExploreCall[] = [];
  const opened = await openFixtureApplication(join(directory, 'client.store.json'), countingExploreFetch(calls));
  try {
    await opened.application.state.transaction((state) => { state.accounts[firstAccount.id] = firstAccount; });
    const resourceUri = `${territories.policy.ids.assets[0]}/text`;
    const resourceUrl = new URL(`/api/resources/${encodeURIComponent(resourceUri)}?authorityId=${encodeURIComponent(territories.policy.ids.actor)}`, opened.client.origin);

    const readCalls = calls.length;
    const beforeResponse = await fetch(resourceUrl);
    assert.equal(beforeResponse.status, 200);
    const before = await readJsonResponse(beforeResponse);
    assert.equal(calls.length, readCalls, 'reading a retained resource must not perform world IO');
    const beforeObservation = findRecord(before, (record) => record.source === resourceUri);
    assert.equal(beforeObservation?.state, 'not-retrieved');

    const refreshResponse = await fetch(new URL(`${resourceUrl.pathname}/refresh`, opened.client.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorityId: territories.policy.ids.actor })
    });
    assert.equal(refreshResponse.status, 200);
    const refreshed = await readJsonResponse(refreshResponse);
    const refreshedText = JSON.stringify(refreshed);
    assert.match(refreshedText, /raw island mineral/);
    const available = findRecord(refreshed, (record) => record.source === resourceUri && record.state === 'available');
    assert.ok(available, 'the reader preserves the exact resource source identity');
    const resourceCall = calls.find((call) => call.url === resourceUri);
    assert.ok(resourceCall);
    assert.equal(resourceCall.authorization, '', 'public-first retrieval does not send credentials');
    assert.equal(refreshedText.includes(firstAccount.login.status === 'signed-in' ? firstAccount.login.nativeToken : ''), false);

    const afterRefreshCalls = calls.length;
    const retainedResponse = await fetch(resourceUrl);
    assert.equal(retainedResponse.status, 200);
    assert.match(JSON.stringify(await readJsonResponse(retainedResponse)), /raw island mineral/);
    assert.equal(calls.length, afterRefreshCalls, 'a retained reader read does not contact the world again');

    const privateUri = territories.policy.ids.ports[1]!;
    const privateResponse = await fetch(new URL(`/api/resources/${encodeURIComponent(privateUri)}/refresh`, opened.client.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: firstAccount.id, authorityId: territories.policy.ids.actor })
    });
    assert.equal(privateResponse.status, 200);
    const privateBody = await readJsonResponse(privateResponse);
    const privateObservation = findRecord(privateBody, (record) => record.source === privateUri && (record.state === 'unavailable' || record.state === 'stale'));
    assert.ok(privateObservation, 'an unauthorized selected resource remains an unavailable observation');
    assert.equal(typeof privateObservation.error, 'string');
    assert.equal(JSON.stringify(privateBody).includes('West Haven'), false, 'the reader does not fabricate content for an unauthorized resource');
  } finally {
    await opened.client.close();
    await opened.application.close();
    await territories.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('explore exposes competing vessel position observations from two authorities without merging their sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-explore-positions-'));
  const opened = await openFixtureApplication(join(directory, 'client.store.json'));
  try {
    await opened.application.state.transaction((state) => { state.accounts[firstAccount.id] = firstAccount; });
    const vessel = 'https://harbor.test:4200/objects/vessels/demo';
    await opened.application.observations.refresh({
      key: `position:${firstAccount.id}:${vessel}`,
      source: 'https://registry.test:4200/local/registry/state',
      load: async () => ({ vessel, placeId: 'https://harbor.test:4200/objects/ports/east', status: 'berthed' })
    });
    await opened.application.observations.refresh({
      key: `position:${firstAccount.id}:${vessel}`,
      source: 'https://territory.test:4200/local/state',
      load: async () => ({ vessel, placeId: 'https://territory.test:4200/objects/ports/main', status: 'pending' })
    });
    const response = await fetch(new URL(`/api/explore/places?accountId=${encodeURIComponent(firstAccount.id)}&vesselId=${encodeURIComponent(vessel)}`, opened.client.origin));
    assert.equal(response.status, 200);
    const body = await readJsonResponse(response);
    const registry = findRecord(body, (record) => record.source === 'https://registry.test:4200/local/registry/state');
    const territory = findRecord(body, (record) => record.source === 'https://territory.test:4200/local/state');
    assert.equal(isRecord(registry?.value) ? registry.value.status : undefined, 'berthed');
    assert.equal(isRecord(territory?.value) ? territory.value.status : undefined, 'pending');
    assert.notEqual((registry?.value as Record<string, unknown> | undefined)?.placeId, (territory?.value as Record<string, unknown> | undefined)?.placeId, 'the two authorities keep their own recorded positions');
    const text = JSON.stringify(body);
    assert.equal(text.includes('https://harbor.test:4200/objects/ports/east'), true);
    assert.equal(text.includes('https://territory.test:4200/objects/ports/main'), true);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('shared reader authenticates only after challenge and retains private content only for the acting account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-reader-scope-'));
  const resource = 'https://resources.test/private';
  const authority = 'https://resources.test/actors/keeper';
  const calls: string[] = [];
  const nativeToken = Buffer.from('reader-fixture-native-token').toString('base64');
  const opened = await openFixtureApplication(join(directory, 'client.json'), async (_input, init) => {
    const bearer = new Headers(init?.headers).get('authorization') ?? '';
    calls.push(bearer);
    return bearer ? Response.json({ name: 'Private manuscript' }) : new Response('', { status: 401 });
  });
  try {
    await opened.application.state.transaction((state) => {
      state.accounts[firstAccount.id] = { ...firstAccount, login: { status: 'signed-in', homeServer: firstAccount.homeServer, nativeToken } };
      state.accounts[secondAccount.id] = secondAccount;
      state.identities[authority] = {
        actorId: authority,
        source: authority,
        state: 'available',
        verified: true,
        handle: '@keeper@resources.test',
        observedAt: new Date().toISOString()
      };
    });
    const path = `/api/resources/${encodeURIComponent(resource)}`;
    const response = await fetch(new URL(`${path}/refresh`, opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: firstAccount.id, authorityId: authority })
    });
    assert.equal(response.status, 200);
    assert.match(JSON.stringify(await response.json()), /Private manuscript/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0], '');
    assert.equal(calls[1], `Bearer ${await deriveDiplomaticToken(nativeToken, authority as URI)}`);
    for (const query of ['', `?accountId=${encodeURIComponent(secondAccount.id)}`]) {
      const other = await fetch(new URL(`${path}${query}`, opened.client.origin));
      assert.doesNotMatch(await other.text(), /Private manuscript/);
    }
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Explore never returns another account or vessel capability snapshot in page data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-explore-scope-'));
  const opened = await openFixtureApplication(join(directory, 'client.json'));
  try {
    await opened.application.state.transaction((state) => {
      state.accounts[firstAccount.id] = firstAccount;
      state.accounts[secondAccount.id] = secondAccount;
    });
    const vessel = 'https://vessels.test/one';
    await opened.application.observations.refresh({
      key: `explore\0capabilities\0${firstAccount.id}\0${vessel}\0https://authority.test/actor`,
      source: 'https://authority.test/local/actions',
      load: async () => ({ territoryId: 'https://authority.test/actor', accountId: firstAccount.id, vesselId: vessel, actions: [{ id: 'private-op', label: 'Account private operation', available: true, effect: 'private' }] })
    });
    for (const query of ['', `?accountId=${encodeURIComponent(secondAccount.id)}&vesselId=${encodeURIComponent(vessel)}`, `?accountId=${encodeURIComponent(firstAccount.id)}&vesselId=${encodeURIComponent('https://vessels.test/two')}`]) {
      const response = await fetch(new URL(`/api/explore/places${query}`, opened.client.origin));
      assert.equal(response.status, 200);
      assert.doesNotMatch(await response.text(), /Account private operation/);
    }
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Explore follows explicitly linked Territory geography outward without assuming an actions service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-explore-outward-'));
  const first = 'https://one.test/keepers/geographer';
  const second = 'https://two.test/council/shore';
  const start = 'https://one.test/stops/start';
  const middle = 'https://two.test/stops/middle';
  const end = 'https://two.test/stops/end';
  const documents: Record<string, unknown> = {
    [first]: { id: first, role: 'territory', resources: { ports: 'https://one.test/ports', routes: 'https://one.test/routes', areas: [] } },
    [second]: { id: second, role: 'territory', name: 'Outer shore', resources: { ports: 'https://two.test/ports', routes: 'https://two.test/routes', areas: [] } },
    'https://one.test/ports': { items: [{ id: start, type: 'Port', name: 'Start', territory: first }] },
    'https://one.test/routes': { items: [{ id: 'https://one.test/crossing', type: 'Route', from: start, to: middle }] },
    [middle]: { id: middle, type: 'Port', name: 'Middle', territory: second },
    'https://two.test/ports': { items: [{ id: middle, type: 'Port', name: 'Middle', territory: second }, { id: end, type: 'Port', name: 'End', territory: second }] },
    'https://two.test/routes': { items: [{ id: 'https://two.test/onward', type: 'Route', from: middle, to: end }] },
    'https://one.test/local/info': { kind: 'custom', actor: first, endpoints: [] },
    'https://two.test/local/info': { kind: 'custom', actor: second, endpoints: [] }
  };
  const calls: string[] = [];
  const opened = await openFixtureApplication(join(directory, 'client.json'), async (input) => {
    const uri = String(input);
    calls.push(uri);
    return documents[uri] === undefined ? new Response('', { status: 404 }) : Response.json(documents[uri]);
  });
  try {
    await opened.application.state.transaction((state) => {
      state.accounts[firstAccount.id] = firstAccount;
      state.authorities[first] = { actorId: first, server: 'one.test', roles: ['territory'] };
    });
    const refreshed = await refreshExplore(opened.client.origin, { accountId: firstAccount.id, vesselId: 'https://vessels.test/one' });
    assert.equal(refreshed.status, 200);
    const body = await refreshed.json();
    assert.ok(placeRecords(body).some((place) => place.id === end));
    assert.ok(findRecord(body, (record) => record.id === 'https://two.test/onward' && record.from === middle && record.to === end));
    assert.equal(calls.some((uri) => new URL(uri).pathname === '/local/actions'), false);
    const route = await fetch(new URL('/api/explore/routes', opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: firstAccount.id, from: start, to: end })
    });
    assert.equal(route.status, 200);
    const plan = findRecord(await route.json(), (record) => Array.isArray(record.legs));
    assert.equal((plan?.legs as unknown[]).length, 2);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

interface ProductionWorld {
  origins: { authority: string; policy: string; simulation: string };
  adminSecret: string;
  authority: Awaited<ReturnType<typeof createAuthorityApp>>;
  policy: Awaited<ReturnType<typeof createPolicyApp>>;
  simulation: Awaited<ReturnType<typeof createSimulationApp>>;
  accounts: Record<'first' | 'second', AccountRecord>;
  nativeTokens: Record<'first' | 'second', string>;
  governor?: AccountRecord;
  close(): Promise<void>;
}

interface ProductionWorldOptions {
  administratorNames?: string[];
  accountPasswords?: Record<string, string>;
  additionalPolicyRoutes?: (origins: { policyOrigin: string; simulationOrigin: string }) => Route[];
  additionalSimulationRoutes?: (origins: { policyOrigin: string; simulationOrigin: string }) => Route[];
}

async function startProductionWorld(directory: string, options: ProductionWorldOptions = {}): Promise<ProductionWorld> {
  const [authorityPort, policyPort, simulationPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const origins = {
    authority: `http://127.0.0.1:${authorityPort}`,
    policy: `http://127.0.0.1:${policyPort}`,
    simulation: `http://127.0.0.1:${simulationPort}`
  };
  const adminSecret = 'task08-production-admin';
  const playerNames = ['player', 'other'];
  const additionalPolicyRoutes = options.additionalPolicyRoutes?.({ policyOrigin: origins.policy, simulationOrigin: origins.simulation }) ?? [];
  const additionalSimulationRoutes = options.additionalSimulationRoutes?.({ policyOrigin: origins.policy, simulationOrigin: origins.simulation }) ?? [];
  const authority = await createAuthorityApp({
    origin: origins.authority, storeFile: join(directory, 'authority.json'), adminSecret, playerNames,
    ...(options.administratorNames === undefined ? {} : { administratorNames: options.administratorNames }),
    ...(options.accountPasswords === undefined ? {} : { accountPasswords: options.accountPasswords })
  });
  const policy = await createPolicyApp({ origin: origins.policy, storeFile: join(directory, 'policy.json'), authorityOrigin: origins.authority, playerNames, peerOrigin: origins.simulation, adminSecret, additionalRoutes: additionalPolicyRoutes });
  const simulation = await createSimulationApp({ origin: origins.simulation, storeFile: join(directory, 'simulation.json'), authorityOrigin: origins.authority, playerNames, peerOrigin: origins.policy, adminSecret, additionalRoutes: additionalSimulationRoutes });
  await Promise.all([
    authority.authority.listen(authorityPort, '127.0.0.1'),
    policy.host.listen(policyPort, '127.0.0.1'),
    simulation.host.listen(simulationPort, '127.0.0.1')
  ]);
  const adminHeaders = { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' };
  const accounts = {} as Record<'first' | 'second', AccountRecord>;
  const nativeTokens = {} as Record<'first' | 'second', string>;
  for (const [index, name] of playerNames.entries()) {
    const key: 'first' | 'second' = index === 0 ? 'first' : 'second';
    const actorId = authority.ids.players[name]!;
    const issued = await fetch(`${origins.authority}/local/home/issue`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: actorId }) });
    assert.equal(issued.status, 200);
    const nativeToken = (await issued.json() as { nativeToken: string }).nativeToken;
    nativeTokens[key] = nativeToken;
    accounts[key] = {
      id: `account:task08-${key}`,
      handle: `@${name}@${new URL(origins.authority).host}`,
      homeServer: new URL(origins.authority).host,
      actorId,
      homeAuthority: authority.ids.actor.home,
      login: { status: 'signed-in', homeServer: new URL(origins.authority).host, nativeToken }
    };
    for (const territory of [policy, simulation]) {
      const digest = await fetch(`${origins.authority}/local/home/digest-request`, {
        method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: actorId, resourceActor: territory.ids.actor })
      });
      assert.equal(digest.status, 202);
      assert.equal(await authority.authority.server.processOutbox(), 1);
      assert.equal(await territory.host.server.processInbox(), 1);
    }
  }
  let governor: AccountRecord | undefined;
  const governorName = options.administratorNames?.[0];
  if (governorName !== undefined) {
    const actorId = authority.ids.players[governorName]!;
    const issued = await fetch(`${origins.authority}/local/home/issue`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: actorId }) });
    assert.equal(issued.status, 200);
    const nativeToken = (await issued.json() as { nativeToken: string }).nativeToken;
    governor = {
      id: `@${governorName}@${new URL(origins.authority).host}`,
      handle: `@${governorName}@${new URL(origins.authority).host}`,
      homeServer: new URL(origins.authority).host,
      actorId,
      homeAuthority: authority.ids.actor.home,
      login: { status: 'signed-in', homeServer: new URL(origins.authority).host, nativeToken }
    };
  }
  return {
    origins, adminSecret, authority, policy, simulation, accounts, nativeTokens,
    ...(governor === undefined ? {} : { governor }),
    async close() {
      await Promise.allSettled([simulation.host.close(), policy.host.close(), authority.authority.close()]);
    }
  };
}

interface AuthoringFetchControl {
  fail?: (url: URL, method: string) => boolean;
}

function authoringFetch(calls: ExploreCall[], control: AuthoringFetchControl): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : String(input);
    const method = init?.method ?? request?.method ?? 'GET';
    const headers = new Headers(init?.headers ?? request?.headers);
    calls.push({ url, method, authorization: headers.get('authorization') ?? '' });
    if (control.fail?.(new URL(url), method)) throw new TypeError('authoring read-back unavailable');
    return fetch(input, init);
  };
}

async function openAuthoringClient(
  storeFile: string,
  world: ProductionWorld,
  control: AuthoringFetchControl
): Promise<{ application: ClientApplication; client: Awaited<ReturnType<typeof startClientServer>>; calls: ExploreCall[] }> {
  const calls: ExploreCall[] = [];
  const opened = await openFixtureApplication(storeFile, authoringFetch(calls, control));
  await opened.application.state.transaction((state) => {
    state.accounts[world.accounts.first.id] = world.accounts.first;
    state.accounts[world.accounts.second.id] = world.accounts.second;
  });
  await discoverOrigins(opened.client.origin, Object.values(world.origins));
  return { ...opened, calls };
}

function draftFrom(body: unknown): Record<string, unknown> {
  const draft = findRecord(body, (record) => typeof record.id === 'string' && typeof record.kind === 'string' && isRecord(record.fields) && typeof record.accountId === 'string');
  assert.ok(draft, `Expected an authoring draft in ${JSON.stringify(body)}`);
  return draft;
}

function libraryData(body: unknown): Record<string, unknown> {
  assert.ok(isRecord(body) && isRecord(body.data), `Expected library page data in ${JSON.stringify(body)}`);
  return body.data;
}

function libraryRecords(body: unknown, name: string): Array<Record<string, unknown>> {
  const value = libraryData(body)[name];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function publicationResourceRefs(action: ActionRecord): Array<{ kind: string; id: string }> {
  return action.resultReferences.filter((reference) => reference.kind === 'resource');
}

function assertNoSecrets(value: unknown, secrets: readonly string[]): void {
  const text = JSON.stringify(value);
  for (const secret of secrets) if (secret) assert.equal(text.includes(secret), false, 'credentials must not be serialized');
}

async function postJson(url: URL, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await readJsonResponse(response) };
}

async function getJson(url: URL): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url);
  return { status: response.status, body: await readJsonResponse(response) };
}

async function seedAuthorityAsset(world: ProductionWorld, nativeToken: string, name: string, text: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${world.origins.authority}/local/authoring/assets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${nativeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, text })
  });
  assert.equal(response.status, 201);
  const body = await response.json() as Record<string, unknown>;
  return isRecord(body.asset) ? body.asset : body;
}

async function exchangeWorld(
  source: { processOutbox(): Promise<number>; processInbox(): Promise<number> },
  target: { processOutbox(): Promise<number>; processInbox(): Promise<number> }
): Promise<void> {
  await source.processOutbox();
  await target.processInbox();
  await target.processOutbox();
  await source.processInbox();
}

async function openProductionClient(
  storeFile: string,
  world: ProductionWorld,
  extra: Partial<CreateClientApplicationOptions> = {}
): Promise<{ application: ClientApplication; client: Awaited<ReturnType<typeof startClientServer>>; calls: ExploreCall[] }> {
  const calls: ExploreCall[] = [];
  const opened = await openFixtureApplication(storeFile, countingExploreFetch(calls), extra);
  await opened.application.state.transaction((state) => {
    state.accounts[world.accounts.first.id] = world.accounts.first;
    state.accounts[world.accounts.second.id] = world.accounts.second;
  });
  await discoverOrigins(opened.client.origin, Object.values(world.origins));
  return { ...opened, calls };
}

function collectRecords(value: unknown): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  const seen = new Set<object>();
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!isRecord(entry) || seen.has(entry)) return;
    seen.add(entry);
    records.push(entry);
    for (const child of Object.values(entry)) visit(child);
  };
  visit(value);
  return records;
}

function observationRecords(value: unknown): Array<Record<string, unknown>> {
  return collectRecords(value).filter((record) => typeof record.source === 'string' && typeof record.state === 'string');
}

function findObservation(value: unknown, origin: string, states: readonly string[]): Record<string, unknown> | undefined {
  return observationRecords(value).find((record) => typeof record.source === 'string' && record.source.includes(origin) && states.includes(String(record.state)));
}

const operationKinds = new Set(['mine', 'manufacture', 'transfer', 'load', 'unload']);

function operationRecords(value: unknown): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return collectRecords(value).filter((record) => {
    const kind = typeof record.kind === 'string' ? record.kind : undefined;
    const id = typeof record.operationId === 'string' ? record.operationId : typeof record.id === 'string' ? record.id : undefined;
    if (!kind || !id || !operationKinds.has(kind) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function operationIdentifier(record: Record<string, unknown>): string {
  const id = typeof record.operationId === 'string' ? record.operationId : record.id;
  assert.equal(typeof id, 'string');
  return id as string;
}

function requireOperation(value: unknown, kind: string, predicate: (record: Record<string, unknown>) => boolean = () => true): Record<string, unknown> {
  const operation = operationRecords(value).find((record) => record.kind === kind && predicate(record));
  assert.ok(operation, `Expected a ${kind} production operation in ${JSON.stringify(value)}`);
  return operation;
}

function recordText(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function actionFromBody(body: unknown): ActionRecord {
  assert.ok(isRecord(body) && isRecord(body.action), `Expected an action response, received ${JSON.stringify(body)}`);
  return body.action as unknown as ActionRecord;
}

function findJobRecord(value: unknown, jobId: string): Record<string, unknown> | undefined {
  return collectRecords(value).find((record) =>
    record.id === jobId || record.jobId === jobId || record.reference === jobId || record.job === jobId
  );
}

function productionUrl(origin: string, accountId: string, vesselId: string): URL {
  const url = new URL('/api/production', origin);
  url.searchParams.set('accountId', accountId);
  url.searchParams.set('vesselId', vesselId);
  return url;
}

function logisticsPath(vesselId: string, suffix = ''): string {
  return `/api/logistics/vessels/${encodeURIComponent(vesselId)}${suffix}`;
}

const task08AdminHeaders = (world: ProductionWorld) => ({ Authorization: `Bearer ${world.adminSecret}`, 'Content-Type': 'application/json' });

async function submitLogisticsEntry(clientOrigin: string, world: ProductionWorld, territory: 'policy' | 'simulation'): Promise<ActionRecord> {
  const target = world[territory];
  const response = await fetch(new URL(logisticsPath(world.authority.ids.vessel, '/entry'), clientOrigin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: world.accounts.first.id,
      territoryId: target.ids.actor,
      portId: target.ids.ports[0],
      routeId: target.ids.routes[0]
    })
  });
  assert.equal(response.status, 200, await response.clone().text());
  return actionFromBody(await response.json());
}

async function submitLogisticsEntryFor(clientOrigin: string, world: ProductionWorld, accountId: string, vesselId: string, territory: 'policy' | 'simulation'): Promise<ActionRecord> {
  const target = world[territory];
  const response = await fetch(new URL(logisticsPath(vesselId, '/entry'), clientOrigin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, territoryId: target.ids.actor, portId: target.ids.ports[0], routeId: target.ids.routes[0] })
  });
  assert.equal(response.status, 200, await response.clone().text());
  return actionFromBody(await response.json());
}

function journeyOutboundRouteId(world: ProductionWorld): string {
  return `${world.origins.policy}/objects/routes/outbound`;
}

async function saveJourneyPlan(clientOrigin: string, accountId: string, from: string, to: string): Promise<Record<string, unknown>> {
  const response = await postJson(new URL('/api/explore/routes', clientOrigin), { accountId, from, to });
  assert.equal(response.status, 200, `saving the connected plan: ${JSON.stringify(response.body)}`);
  const plan = findRecord(response.body, (record) => typeof record.id === 'string' && record.accountId === accountId && record.from === from && record.to === to && Array.isArray(record.legs));
  assert.ok(plan, `Expected a saved route plan in ${JSON.stringify(response.body)}`);
  return plan;
}

async function traverseJourney(clientOrigin: string, accountId: string, vesselId: string, routePlanId: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: unknown; action?: ActionRecord }> {
  const response = await postJson(new URL(logisticsPath(vesselId, '/traverse'), clientOrigin), { accountId, routePlanId, ...extra });
  return { status: response.status, body: response.body, ...(response.status === 200 ? { action: actionFromBody(response.body) } : {}) };
}

function actionJourneyLegs(action: ActionRecord): Array<Record<string, unknown>> {
  const journey = (action as unknown as Record<string, unknown>).journey;
  assert.ok(isRecord(journey), `Expected typed journey progress on the traverse action, received ${JSON.stringify(action)}`);
  assert.ok(Array.isArray(journey.legs) && journey.legs.length > 0, 'journey progress exposes per-leg steps');
  return journey.legs.filter(isRecord);
}

async function registryEntryRequests(world: ProductionWorld, vesselId: string, territoryId: string): Promise<Array<Record<string, unknown>>> {
  const state = await world.authority.registry.state(vesselId);
  return Object.values(state.requests).filter((request): request is Record<string, unknown> => isRecord(request) && request.type === 'EntryRequest' && isRecord(request.destination) && request.destination.territory === territoryId);
}

async function registryEvents(world: ProductionWorld, vesselId: string): Promise<Array<Record<string, unknown>>> {
  return (await world.authority.registry.state(vesselId)).events as unknown as Array<Record<string, unknown>>;
}

async function refreshJourneyUntil(clientOrigin: string, accountId: string, actionId: string, predicate: (action: ActionRecord) => boolean | Promise<boolean>, label: string, attempts = 10): Promise<ActionRecord> {
  let action = await readActivityAction(clientOrigin, accountId, actionId);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate(action)) return action;
    action = await refreshActivityAction(clientOrigin, accountId, actionId);
  }
  assert.ok(await predicate(action), label);
  return action;
}

function controllableJourneyFetch(calls: ExploreCall[], control: { fail?: (url: URL, method: string) => boolean }): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : String(input);
    const method = init?.method ?? request?.method ?? 'GET';
    const headers = new Headers(init?.headers ?? request?.headers);
    calls.push({ url, method, authorization: headers.get('authorization') ?? '' });
    if (control.fail?.(new URL(url), method)) throw new TypeError('controlled observation unavailable');
    return fetch(input, init);
  };
}

async function executeOperation(
  clientOrigin: string,
  world: ProductionWorld,
  operationId: string,
  inputs: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Promise<{ status: number; body: unknown; action?: ActionRecord }> {
  const response = await fetch(new URL(`/api/production/operations/${encodeURIComponent(operationId)}/execute`, clientOrigin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: world.accounts.first.id, vesselId: world.authority.ids.vessel, inputs, ...extra })
  });
  const body = await readJsonResponse(response);
  return { status: response.status, body, ...(response.status === 200 ? { action: actionFromBody(body) } : {}) };
}

test('logistics refresh retains scoped Registry and Territory observations, reads retained state without IO, and isolates a failed source', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task08-logistics-'));
  const world = await startProductionWorld(directory);
  const opened = await openProductionClient(join(directory, 'client.json'), world);
  const vessel = world.authority.ids.vessel;
  const accountId = world.accounts.first.id;
  try {
    const readCalls = opened.calls.length;
    const beforeResponse = await fetch(new URL(`${logisticsPath(vessel)}?accountId=${encodeURIComponent(accountId)}`, opened.client.origin));
    assert.equal(beforeResponse.status, 200);
    const before = await readJsonResponse(beforeResponse);
    assert.equal(opened.calls.length, readCalls, 'reading retained logistics must not contact the world');
    assert.equal(typeof before, 'object');

    const refreshResponse = await fetch(new URL(logisticsPath(vessel, '/refresh'), opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId })
    });
    assert.equal(refreshResponse.status, 200);
    const refreshed = await readJsonResponse(refreshResponse);
    const refreshedText = JSON.stringify(refreshed);
    assert.match(refreshedText, new RegExp(escapeRegExp(world.authority.ids.actor.registry)));
    assert.match(refreshedText, new RegExp(escapeRegExp(world.policy.ids.actor)));
    assert.match(refreshedText, new RegExp(escapeRegExp(world.simulation.ids.actor)));
    assert.match(refreshedText, /adoption/i);
    assert.match(refreshedText, /shared|cargo|stock/i);
    assert.ok(findObservation(refreshed, world.origins.authority, ['available', 'empty']), 'Registry observation is retained from its own source');
    assert.ok(findObservation(refreshed, world.origins.policy, ['available', 'empty']), 'Policy Territory observation is retained independently');
    assert.ok(findObservation(refreshed, world.origins.simulation, ['available', 'empty']), 'Simulation Territory observation is retained independently');
    assert.ok(opened.calls.some((call) => call.url.includes('/local/registry/state')), 'refresh reads Registry state');
    assert.ok(opened.calls.some((call) => new URL(call.url).origin === world.origins.policy && call.url.includes('/local/actions')), 'refresh reads Policy actions');
    assert.ok(opened.calls.some((call) => new URL(call.url).origin === world.origins.simulation && call.url.includes('/local/actions')), 'refresh reads Simulation actions');

    const retainedCalls = opened.calls.length;
    const retainedResponse = await fetch(new URL(`${logisticsPath(vessel)}?accountId=${encodeURIComponent(accountId)}`, opened.client.origin));
    assert.equal(retainedResponse.status, 200);
    assert.deepEqual(await readJsonResponse(retainedResponse), refreshed);
    assert.equal(opened.calls.length, retainedCalls, 'retained logistics reads never perform world IO');

    await world.simulation.host.close();
    const isolatedResponse = await fetch(new URL(logisticsPath(vessel, '/refresh'), opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId })
    });
    assert.equal(isolatedResponse.status, 200, 'a failed source does not fail the scoped page');
    const isolated = await readJsonResponse(isolatedResponse);
    const failed = findObservation(isolated, world.origins.simulation, ['stale', 'unavailable']);
    assert.ok(failed, 'the failed Simulation source keeps its stale or unavailable observation');
    assert.equal(typeof failed.error, 'string');
    assert.ok(findObservation(isolated, world.origins.authority, ['available', 'empty', 'stale']));
    assert.ok(findObservation(isolated, world.origins.policy, ['available', 'empty']));

    const missingScope = await fetch(new URL(logisticsPath(vessel), opened.client.origin));
    assert.equal(missingScope.status, 400);
    const unknownAccount = await fetch(new URL(`${logisticsPath(vessel)}?accountId=${encodeURIComponent('account:unknown')}`, opened.client.origin));
    assert.ok([401, 403, 404].includes(unknownAccount.status));
    const otherAccountRead = await fetch(new URL(`${logisticsPath(vessel)}?accountId=${encodeURIComponent(world.accounts.second.id)}`, opened.client.origin));
    assert.ok([403, 404].includes(otherAccountRead.status));
    const otherAccountRefresh = await fetch(new URL(logisticsPath(vessel, '/refresh'), opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: world.accounts.second.id })
    });
    assert.ok([403, 404].includes(otherAccountRefresh.status));

    for (const secret of Object.values(world.nativeTokens)) assert.equal(refreshedText.includes(secret), false);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('logistics entry and departure reconcile real Registry evidence, and adoption never rewrites Territory state', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task08-circulation-'));
  const world = await startProductionWorld(directory);
  const opened = await openProductionClient(join(directory, 'client.json'), world);
  const vessel = world.authority.ids.vessel;
  const accountId = world.accounts.first.id;
  const refresh = async (): Promise<unknown> => {
    const response = await fetch(new URL(logisticsPath(vessel, '/refresh'), opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId })
    });
    assert.equal(response.status, 200);
    return readJsonResponse(response);
  };
  const activity = async (actionId: string): Promise<ActionRecord> => {
    const response = await fetch(new URL(`/api/activity/${encodeURIComponent(actionId)}?accountId=${encodeURIComponent(accountId)}`, opened.client.origin));
    assert.equal(response.status, 200);
    const body = await response.json() as PageResponse<{ action: ActionRecord }>;
    return body.data.action;
  };
  try {
    const entry = await submitLogisticsEntry(opened.client.origin, world, 'policy');
    assert.equal(entry.submission.status, 'accepted');
    const entryReference = entry.resultReferences.find((reference) => reference.kind === 'request');
    assert.ok(entryReference, 'entry action retains the Registry request reference');
    const beforeDelivery = await refresh();
    assert.match(JSON.stringify(beforeDelivery), new RegExp(escapeRegExp(entryReference.id)));
    const pendingSummary = findRecord(beforeDelivery, (record) => record.authorityId === world.authority.ids.actor.registry && Array.isArray(record.pendingRequests));
    assert.ok((pendingSummary?.pendingRequests as unknown[] | undefined)?.some((request) => JSON.stringify(request).includes(entryReference.id)), 'Registry summary exposes actual pending requests');
    const pendingRegistry = await world.authority.registry.state(vessel);
    assert.equal(pendingRegistry.events.some((event) => event.type === 'BerthingEvent'), false, 'accepted entry is not arrival');

    await exchangeWorld(world.authority.authority.server, world.policy.host.server);
    const afterDelivery = await refresh();
    assert.match(JSON.stringify(afterDelivery), /berth|active|visit/i);
    const berthSummary = findRecord(afterDelivery, (record) => record.authorityId === world.authority.ids.actor.registry && isRecord(record.location));
    assert.equal((berthSummary?.location as Record<string, unknown> | undefined)?.status, 'berthed');
    const arrivedRegistry = await world.authority.registry.state(vessel);
    assert.equal(arrivedRegistry.events.some((event) => event.type === 'BerthingEvent'), true, 'real BerthingEvent reconciles arrival');
    const entryAction = await activity(entry.id);
    assert.equal(entryAction.outcome.status, 'completed');
    assert.ok(entryAction.outcome.evidence.length > 0);

    const departureResponse = await fetch(new URL(logisticsPath(vessel, '/departure'), opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, territoryId: world.policy.ids.actor, portId: world.policy.ids.ports[0], routeId: world.policy.ids.routes[0] })
    });
    assert.equal(departureResponse.status, 200);
    const departure = actionFromBody(await departureResponse.json());
    assert.equal(departure.submission.status, 'accepted');
    await refresh();
    const departurePending = await world.authority.registry.state(vessel);
    assert.equal(departurePending.events.some((event) => event.type === 'DepartureEvent'), false, 'accepted departure is not yet departure evidence');

    await exchangeWorld(world.authority.authority.server, world.policy.host.server);
    await refresh();
    const departed = await world.authority.registry.state(vessel);
    assert.equal(departed.events.some((event) => event.type === 'DepartureEvent'), true);
    assert.equal(departed.events.some((event) => event.type === 'ExitEvent'), true);
    const departureAction = await activity(departure.id);
    assert.equal(departureAction.outcome.status, 'completed');
    assert.ok(departureAction.outcome.evidence.length > 0);

    const territoryBefore = structuredClone(await world.policy.territory.ledger);
    const adoptionResponse = await fetch(new URL(logisticsPath(vessel, '/adoption'), opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, adoption: false })
    });
    assert.equal(adoptionResponse.status, 200);
    const adoption = actionFromBody(await adoptionResponse.json());
    assert.equal(adoption.submission.status, 'accepted');
    assert.equal((await world.authority.registry.state(vessel)).adoption, false);
    assert.deepEqual(await world.policy.territory.ledger, territoryBefore, 'Registry adoption does not rewrite Territory state');
    assert.match(JSON.stringify(await refresh()), /"adoption"\s*:\s*false/);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('production exposes typed Policy operations and executes immediate mine, manufacture, transfer, load, unload, repeat, insufficiency, and tamper checks', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task08-policy-production-'));
  const storeFile = join(directory, 'client.json');
  const world = await startProductionWorld(directory);
  const opened = await openProductionClient(storeFile, world);
  const vessel = world.authority.ids.vessel;
  const accountId = world.accounts.first.id;
  const secondVessel = world.authority.ids.vessels.other!;
  try {
    const readCalls = opened.calls.length;
    const retainedBefore = await fetch(productionUrl(opened.client.origin, accountId, vessel));
    assert.equal(retainedBefore.status, 200);
    assert.equal(opened.calls.length, readCalls, 'retained production reads do not perform world IO');

    const entry = await submitLogisticsEntry(opened.client.origin, world, 'policy');
    assert.equal(entry.submission.status, 'accepted');
    await exchangeWorld(world.authority.authority.server, world.policy.host.server);

    const refreshResponse = await fetch(new URL('/api/production/refresh', opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, vesselId: vessel })
    });
    assert.equal(refreshResponse.status, 200);
    const refreshed = await readJsonResponse(refreshResponse);
    assert.match(JSON.stringify(refreshed), new RegExp(escapeRegExp(world.policy.ids.actor)));
    const mine = requireOperation(refreshed, 'mine');
    const manufacture = requireOperation(refreshed, 'manufacture');
    const transfer = requireOperation(refreshed, 'transfer', (record) => /to port|warehouse/i.test(recordText(record)));
    const load = requireOperation(refreshed, 'load');
    const unload = requireOperation(refreshed, 'unload');
    assert.match(recordText(mine), /count|quantity/i);
    assert.match(recordText(manufacture), /recipe|ore-to-metal|insufficient|block/i);
    assert.match(recordText(load), /cargo|variety|count|block/i);

    const mineId = operationIdentifier(mine);
    const firstMine = await executeOperation(opened.client.origin, world, mineId, { count: 2 });
    assert.equal(firstMine.status, 200);
    assert.ok(firstMine.action);
    assert.equal(firstMine.action.submission.status, 'accepted');
    assert.equal(actionIsComplete(firstMine.action), true, 'immediate Policy mining carries completion evidence');
    assert.equal((await world.policy.territory.state).rawInventory[world.policy.ids.varieties.ore], 2);

    const repeatMine = await executeOperation(opened.client.origin, world, mineId, { count: 1 });
    assert.equal(repeatMine.status, 200);
    assert.ok(repeatMine.action);
    assert.equal(actionIsComplete(repeatMine.action), true);
    assert.equal((await world.policy.territory.state).rawInventory[world.policy.ids.varieties.ore], 3, 'repeated production reuses the existing operation definition');

    const excessiveMine = await executeOperation(opened.client.origin, world, mineId, { count: 500 });
    assert.ok(excessiveMine.action);
    assert.equal(actionIsComplete(excessiveMine.action), false, 'a rejected quantity is not completion evidence');
    assert.equal((await world.policy.territory.state).rawInventory[world.policy.ids.varieties.ore], 3);

    const refreshAgain = await fetch(new URL('/api/production/refresh', opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, vesselId: vessel })
    });
    assert.equal(refreshAgain.status, 200);
    const refreshedAgain = await readJsonResponse(refreshAgain);
    assert.equal(operationIdentifier(requireOperation(refreshedAgain, 'mine')), mineId, 'operation references remain stable across refresh');

    const manufactureId = operationIdentifier(requireOperation(refreshedAgain, 'manufacture'));
    const produced = await executeOperation(opened.client.origin, world, manufactureId, { recipe: 'ore-to-metal', count: 1 });
    assert.equal(produced.status, 200);
    assert.ok(produced.action);
    assert.equal(actionIsComplete(produced.action), true);
    const afterManufacture = await world.policy.territory.state;
    assert.equal(afterManufacture.rawInventory[world.policy.ids.varieties.ore], 1);
    assert.equal(afterManufacture.rawInventory[world.policy.ids.varieties.metal], 1);

    const transferId = operationIdentifier(transfer);
    const transferred = await executeOperation(opened.client.origin, world, transferId, { direction: 'to-port', variety: world.policy.ids.varieties.metal, count: 1 });
    assert.equal(transferred.status, 200);
    assert.ok(transferred.action);
    assert.equal(actionIsComplete(transferred.action), true);
    assert.equal((await world.policy.territory.state).portInventory[world.policy.ids.varieties.metal], 1);

    const loadId = operationIdentifier(load);
    const loaded = await executeOperation(opened.client.origin, world, loadId, { variety: world.policy.ids.varieties.metal, count: 1 });
    assert.equal(loaded.status, 200);
    assert.ok(loaded.action);
    assert.equal(actionIsComplete(loaded.action), true);
    const policyAfterLoad = await world.policy.territory.ledger;
    assert.deepEqual(policyAfterLoad.state.vessels[vessel]?.manifest.entries, [{ variety: world.policy.ids.varieties.metal, count: 1, data: {} }]);
    const cargoRefresh = await fetch(new URL(logisticsPath(vessel, '/refresh'), opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId })
    });
    assert.equal(cargoRefresh.status, 200);
    const cargoSummary = findRecord(await cargoRefresh.json(), (record) => record.authorityId === world.policy.ids.actor && record.kind === 'policy' && 'cargo' in record);
    assert.deepEqual(cargoSummary?.cargo, policyAfterLoad.state.vessels[vessel]?.manifest, 'Policy summary retains own vessel cargo');
    assert.equal(policyAfterLoad.state.portInventory[world.policy.ids.varieties.metal], 0);
    await exchangeWorld(world.policy.host.server, world.authority.authority.server);
    const registryAfterLoad = await world.authority.registry.state(vessel);
    assert.deepEqual(registryAfterLoad.cargo?.entries, [{ variety: world.policy.ids.varieties.metal, count: 1, data: {} }], 'Registry cargo and Territory cargo are observed independently');

    const unloadId = operationIdentifier(unload);
    const unloaded = await executeOperation(opened.client.origin, world, unloadId, { variety: world.policy.ids.varieties.metal, count: 1 });
    assert.equal(unloaded.status, 200);
    assert.ok(unloaded.action);
    assert.equal(actionIsComplete(unloaded.action), true);
    const policyAfterUnload = await world.policy.territory.ledger;
    assert.deepEqual(policyAfterUnload.state.vessels[vessel]?.manifest.entries, []);
    assert.equal(policyAfterUnload.state.portInventory[world.policy.ids.varieties.metal], 1);

    const beforeInsufficient = await world.policy.territory.state;
    const insufficient = await executeOperation(opened.client.origin, world, manufactureId, { recipe: 'ore-to-metal', count: 2 });
    assert.ok(insufficient.action, 'insufficient inputs still produce an inspectable action');
    assert.equal(actionIsComplete(insufficient.action), false);
    assert.equal((await world.policy.territory.state).rawInventory[world.policy.ids.varieties.ore], beforeInsufficient.rawInventory[world.policy.ids.varieties.ore]);

    const targetTamper = await executeOperation(opened.client.origin, world, mineId, { count: 1 }, { vesselId: secondVessel });
    assert.ok(targetTamper.status >= 400 && targetTamper.status < 500, 'caller cannot replace the selected vessel');
    const inputTamper = await executeOperation(opened.client.origin, world, mineId, { count: 1, vessel: secondVessel, entryRequest: 'https://evil.test/request', target: 'https://evil.test/target' });
    if (inputTamper.status === 200 && inputTamper.action) {
      assert.notEqual(inputTamper.action.intent.inputs.vessel, secondVessel);
      assert.notEqual(inputTamper.action.intent.inputs.target, 'https://evil.test/target');
    }
    const secondVesselState = await world.policy.territory.state;
    assert.equal(secondVesselState.vessels[secondVessel], undefined);

    const otherAccount = await fetch(new URL(`/api/production/operations/${encodeURIComponent(mineId)}/execute`, opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: world.accounts.second.id, vesselId: vessel, inputs: { count: 1 } })
    });
    assert.ok([403, 404].includes(otherAccount.status), 'another account cannot execute for the owned vessel');

    const rendered = JSON.stringify([refreshed, refreshedAgain, firstMine.body, produced.body, transferred.body, loaded.body, unloaded.body, insufficient.body]);
    for (const secret of Object.values(world.nativeTokens)) assert.equal(rendered.includes(secret), false);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('production never sends credentials to a foreign advertised operation endpoint', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task08-endpoint-'));
  const world = await startProductionWorld(directory);
  const foreignCalls: string[] = [];
  const guardedFetch: typeof fetch = async (input, init) => {
    const uri = String(input);
    if (uri.startsWith('https://foreign.test/')) {
      foreignCalls.push(uri);
      return Response.json({ success: true });
    }
    const response = await fetch(input, init);
    if (new URL(uri).origin === world.origins.policy && new URL(uri).pathname === '/local/actions' && response.ok) {
      const payload = await response.json() as { actions: Array<{ id: string; request?: { href: string; method: string } }> };
      const mine = payload.actions.find((action) => action.id === 'mine-ore');
      if (mine?.request) mine.request.href = 'https://foreign.test/local/mine';
      return Response.json(payload);
    }
    return response;
  };
  const opened = await openProductionClient(join(directory, 'client.json'), world, { fetch: guardedFetch });
  try {
    const refreshed = await fetch(new URL('/api/production/refresh', opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: world.accounts.first.id, vesselId: world.authority.ids.vessel })
    });
    assert.equal(refreshed.status, 200);
    const mine = requireOperation(await refreshed.json(), 'mine', (operation) => operation.authorityId === world.policy.ids.actor);
    const submitted = await executeOperation(opened.client.origin, world, operationIdentifier(mine), { count: 1 });
    assert.equal(submitted.action?.outcome.status === 'completed', false);
    assert.deepEqual(foreignCalls, [], 'a challenged or advertised foreign endpoint must not receive this authority credential');
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Policy completion cannot reuse an audit entry from a previous identical operation', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task08-audit-'));
  const world = await startProductionWorld(directory);
  let acknowledgeOnly = false;
  const fetcher: typeof fetch = (input, init) => {
    if (acknowledgeOnly && String(input) === `${world.origins.policy}/local/mine` && init?.method === 'POST') return Promise.resolve(Response.json({ success: true }));
    return fetch(input, init);
  };
  const opened = await openProductionClient(join(directory, 'client.json'), world, { fetch: fetcher });
  try {
    const refreshed = await fetch(new URL('/api/production/refresh', opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: world.accounts.first.id, vesselId: world.authority.ids.vessel })
    });
    const mine = requireOperation(await refreshed.json(), 'mine', (operation) => operation.authorityId === world.policy.ids.actor);
    const first = await executeOperation(opened.client.origin, world, operationIdentifier(mine), { count: 1 });
    assert.ok(first.action && actionIsComplete(first.action));
    acknowledgeOnly = true;
    const second = await executeOperation(opened.client.origin, world, operationIdentifier(mine), { count: 1 });
    assert.ok(second.action);
    assert.equal(actionIsComplete(second.action), false, 'old matching audit entry cannot establish a later action outcome');
    assert.equal((await world.policy.territory.state).rawInventory[world.policy.ids.varieties.ore], 1);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('vessel metadata cannot redirect a Home native credential to a foreign Registry', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task08-native-audience-'));
  const world = await startProductionWorld(directory);
  const foreignCalls: string[] = [];
  const forged = `${world.origins.authority}/objects/vessels/forged`;
  const original = (await world.authority.registry.state()).vessel!;
  const fetcher: typeof fetch = (input, init) => {
    const uri = String(input);
    if (uri === forged) return Promise.resolve(Response.json({ ...original, id: forged, registry: 'https://foreign.test/actors/registry' }));
    if (uri.startsWith('https://foreign.test/')) {
      foreignCalls.push(uri);
      return Promise.resolve(Response.json({ ...original, state: {}, actions: [] }));
    }
    return fetch(input, init);
  };
  const opened = await openProductionClient(join(directory, 'client.json'), world, { fetch: fetcher });
  try {
    const response = await fetch(new URL(logisticsPath(forged, '/refresh'), opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: world.accounts.first.id })
    });
    assert.ok(response.status >= 400 && response.status < 500);
    assert.deepEqual(foreignCalls, []);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('equal local job numbers at independent simulation authorities retain distinct job identities', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task08-job-scope-'));
  const world = await startProductionWorld(directory);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const other = await createSimulationApp({ origin, storeFile: join(directory, 'other-sim.json'), authorityOrigin: world.origins.authority, peerOrigin: world.origins.policy, playerNames: ['player', 'other'], adminSecret: world.adminSecret });
  await other.host.listen(port, '127.0.0.1');
  await world.authority.home.requestDigest(world.authority.ids.actor.player, { id: other.ids.actor, inbox: other.host.actor('territory').inbox });
  await world.authority.authority.server.processOutbox();
  await other.host.server.processInbox();
  const opened = await openProductionClient(join(directory, 'client.json'), world);
  try {
    await discoverOrigins(opened.client.origin, [origin]);
    const refreshed = await fetch(new URL('/api/production/refresh', opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: world.accounts.first.id, vesselId: world.authority.ids.vessel })
    });
    const body = await refreshed.json();
    const first = await executeOperation(opened.client.origin, world, operationIdentifier(requireOperation(body, 'mine', (operation) => operation.authorityId === world.simulation.ids.actor)), { count: 1, duration: 1 });
    const second = await executeOperation(opened.client.origin, world, operationIdentifier(requireOperation(body, 'mine', (operation) => operation.authorityId === other.ids.actor)), { count: 2, duration: 1 });
    const firstJob = first.action?.resultReferences.find((reference) => reference.kind === 'job');
    const secondJob = second.action?.resultReferences.find((reference) => reference.kind === 'job');
    assert.ok(firstJob && secondJob);
    assert.notEqual(firstJob.id, secondJob.id, 'a job identity must include its issuing authority');
    for (const [reference, authorityId] of [[firstJob, world.simulation.ids.actor], [secondJob, other.ids.actor]] as const) {
      const url = new URL(`/api/production/jobs/${encodeURIComponent(reference.id)}`, opened.client.origin);
      url.searchParams.set('accountId', world.accounts.first.id);
      url.searchParams.set('vesselId', world.authority.ids.vessel);
      const response = await fetch(url);
      assert.equal(response.status, 200);
      const page = await response.json() as { data: { job: { authorityId: string } } };
      assert.equal(page.data.job.authorityId, authorityId);
    }
  } finally {
    await opened.client.close();
    await opened.application.close();
    await other.host.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('production tracks Simulation jobs and handling as pending until test-admin ticks, then retains completion evidence across restart', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task08-simulation-production-'));
  const storeFile = join(directory, 'client.json');
  const world = await startProductionWorld(directory);
  let opened = await openProductionClient(storeFile, world);
  const vessel = world.authority.ids.vessel;
  const accountId = world.accounts.first.id;
  const adminRequest = async (path: string): Promise<Response> => fetch(`${world.origins.simulation}${path}`, { method: 'POST', headers: task08AdminHeaders(world), body: '{}' });
  const refreshProduction = async (): Promise<unknown> => {
    const response = await fetch(new URL('/api/production/refresh', opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, vesselId: vessel })
    });
    assert.equal(response.status, 200);
    return readJsonResponse(response);
  };
  const jobPath = (jobId: string) => `/api/production/jobs/${encodeURIComponent(jobId)}`;
  const readJob = async (jobId: string): Promise<unknown> => {
    const response = await fetch(new URL(`${jobPath(jobId)}?accountId=${encodeURIComponent(accountId)}&vesselId=${encodeURIComponent(vessel)}`, opened.client.origin));
    assert.equal(response.status, 200);
    return readJsonResponse(response);
  };
  const refreshJob = async (jobId: string): Promise<unknown> => {
    const response = await fetch(new URL(jobPath(jobId) + '/refresh', opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, vesselId: vessel })
    });
    assert.equal(response.status, 200);
    return readJsonResponse(response);
  };
  try {
    const entry = await submitLogisticsEntry(opened.client.origin, world, 'simulation');
    assert.equal(entry.submission.status, 'accepted');
    await exchangeWorld(world.authority.authority.server, world.simulation.host.server);
    assert.equal((await world.simulation.territory.state()).simulation.vessels[0]?.status, 'pending', 'entry does not itself berth');
    assert.equal((await adminRequest('/local/admin/tick')).status, 200);
    await exchangeWorld(world.simulation.host.server, world.authority.authority.server);
    assert.equal((await world.simulation.territory.state()).simulation.vessels[0]?.status, 'berthed');

    const production = await refreshProduction();
    const fromSimulation = (record: Record<string, unknown>): boolean => record.authorityId === world.simulation.ids.actor;
    const mine = requireOperation(production, 'mine', fromSimulation);
    const manufacture = requireOperation(production, 'manufacture', (record) => fromSimulation(record) && /native|ore/i.test(recordText(record)));
    assert.match(recordText(manufacture), /recipe|count/i);
    const load = requireOperation(production, 'load', fromSimulation);
    const unload = requireOperation(production, 'unload', fromSimulation);
    assert.match(recordText(mine), /tick|job|duration|count/i);
    assert.match(recordText(load), /handling|duration|cargo|block/i);
    assert.match(recordText(unload), /handling|duration|cargo|block/i);

    const tickBefore = (await world.simulation.territory.state()).simulation.tick;
    const mining = await executeOperation(opened.client.origin, world, operationIdentifier(mine), { count: 1, duration: 1 });
    assert.equal(mining.status, 200);
    assert.ok(mining.action);
    assert.equal(mining.action.submission.status, 'accepted');
    assert.equal(mining.action.outcome.status, 'pending', 'Simulation mining does not complete on submission');
    const miningJob = mining.action.resultReferences.find((reference) => reference.kind === 'job');
    assert.ok(miningJob, 'Simulation job reference is persisted on the action');
    assert.equal((await world.simulation.territory.state()).simulation.tick, tickBefore, 'submission never ticks the world');

    const pendingJob = await readJob(miningJob.id);
    assert.ok(findJobRecord(pendingJob, miningJob.id), 'job page retains the returned job');
    assert.match(JSON.stringify(pendingJob), /pending|progress|remaining|queued/i);
    const stillPending = await refreshJob(miningJob.id);
    assert.match(JSON.stringify(stillPending), /pending|progress|remaining|queued/i);
    assert.equal((await world.simulation.territory.state()).simulation.tick, tickBefore, 'job refresh never ticks the world');

    assert.equal((await adminRequest('/local/admin/tick')).status, 200);
    await exchangeWorld(world.simulation.host.server, world.authority.authority.server);
    const completedJob = await refreshJob(miningJob.id);
    assert.match(JSON.stringify(completedJob), /completed|evidence/i);
    assert.match(JSON.stringify(completedJob), new RegExp(escapeRegExp(world.simulation.ids.varieties.ore)));
    const afterMining = await world.simulation.territory.state();
    assert.equal(afterMining.simulation.rawStock.find((item) => item.commodity === world.simulation.ids.varieties.ore)?.count, 1);

    const afterMiningProduction = await refreshProduction();
    const loadOperation = requireOperation(afterMiningProduction, 'load', fromSimulation);
    const loading = await executeOperation(opened.client.origin, world, operationIdentifier(loadOperation), { variety: world.simulation.ids.varieties.ore, count: 1, duration: 1 });
    assert.equal(loading.status, 200);
    assert.ok(loading.action);
    assert.equal(loading.action.outcome.status, 'pending');
    const handlingJob = loading.action.resultReferences.find((reference) => reference.kind === 'job');
    assert.ok(handlingJob, 'handling job reference is retained');
    assert.equal((await world.simulation.territory.state()).simulation.handlingJobs.length, 1);
    const pendingHandling = await refreshJob(handlingJob.id);
    assert.match(JSON.stringify(pendingHandling), /pending|progress|remaining|queued/i);

    assert.equal((await adminRequest('/local/admin/tick')).status, 200);
    await exchangeWorld(world.simulation.host.server, world.authority.authority.server);
    const completedHandling = await refreshJob(handlingJob.id);
    assert.match(JSON.stringify(completedHandling), /completed|evidence/i);
    const afterLoad = await world.simulation.territory.state();
    assert.equal(afterLoad.simulation.rawStock.find((item) => item.commodity === world.simulation.ids.varieties.ore), undefined);
    assert.equal(afterLoad.simulation.vessels[0]?.cargo.find((item) => item.commodity === world.simulation.ids.varieties.ore)?.count, 1, 'real tick completes handling');
    const registryAfterLoad = await world.authority.registry.state(vessel);
    assert.deepEqual(registryAfterLoad.cargo?.entries, [{ variety: world.simulation.ids.varieties.ore, count: 1, data: {} }], 'Registry cargo is distinct from Simulation shared stock');

    const afterLoadingProduction = await refreshProduction();
    const unloading = await executeOperation(opened.client.origin, world, operationIdentifier(requireOperation(afterLoadingProduction, 'unload', fromSimulation)), { variety: world.simulation.ids.varieties.ore, count: 1, duration: 1 });
    assert.equal(unloading.status, 200);
    const unloadJob = unloading.action?.resultReferences.find((reference) => reference.kind === 'job');
    assert.ok(unloadJob);
    assert.equal((await adminRequest('/local/admin/tick')).status, 200);
    await exchangeWorld(world.simulation.host.server, world.authority.authority.server);
    await refreshJob(unloadJob.id);
    assert.equal((await world.simulation.territory.state()).simulation.vessels[0]?.cargo.length, 0);
    const afterUnloadingProduction = await refreshProduction();
    const manufacturing = await executeOperation(opened.client.origin, world, operationIdentifier(requireOperation(afterUnloadingProduction, 'manufacture', (operation) => fromSimulation(operation) && /native/i.test(recordText(operation)))), { recipe: 'native', count: 1 });
    assert.equal(manufacturing.status, 200);
    assert.equal(manufacturing.action?.outcome.status, 'pending');
    const manufactureJob = manufacturing.action?.resultReferences.find((reference) => reference.kind === 'job');
    assert.ok(manufactureJob);
    assert.equal((await adminRequest('/local/admin/tick')).status, 200);
    assert.equal((await adminRequest('/local/admin/tick')).status, 200);
    const manufactured = await refreshJob(manufactureJob.id);
    assert.match(JSON.stringify(manufactured), /completed/);
    assert.equal((await world.simulation.territory.state()).simulation.productStock.find((item) => item.commodity === world.simulation.ids.varieties.metal)?.count, 1);

    const retainedJobCalls = opened.calls.length;
    await readJob(handlingJob.id);
    await fetch(productionUrl(opened.client.origin, accountId, vessel));
    assert.equal(opened.calls.length, retainedJobCalls, 'reading retained jobs and production never contacts the world');

    await opened.client.close();
    await opened.application.close();
    opened = await openProductionClient(storeFile, world);
    const reopenedProduction = await fetch(productionUrl(opened.client.origin, accountId, vessel));
    assert.equal(reopenedProduction.status, 200);
    const reopenedProductionBody = await readJsonResponse(reopenedProduction);
    assert.match(JSON.stringify(reopenedProductionBody), /mine|manufacture|load|unload/i);
    const reopenedJob = await readJob(handlingJob.id);
    assert.match(JSON.stringify(reopenedJob), /completed|evidence/i);
    const reopenedActivity = await fetch(new URL(`/api/activity/${encodeURIComponent(loading.action!.id)}?accountId=${encodeURIComponent(accountId)}`, opened.client.origin));
    assert.equal(reopenedActivity.status, 200);
    const activityBody = await reopenedActivity.json() as PageResponse<{ action: ActionRecord }>;
    assert.deepEqual(activityBody.data.action.resultReferences, loading.action!.resultReferences, 'action and job references survive recreation');

    for (const text of [JSON.stringify(stillPending), JSON.stringify(completedJob), JSON.stringify(completedHandling), JSON.stringify(reopenedProductionBody)]) {
      for (const secret of Object.values(world.nativeTokens)) assert.equal(text.includes(secret), false);
    }
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('library and drafts retain scoped incomplete authoring fields without world IO and survive restart', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task09-library-drafts-'));
  const storeFile = join(directory, 'client.json');
  const world = await startProductionWorld(directory);
  let opened = await openProductionClient(storeFile, world);
  const first = world.accounts.first;
  const second = world.accounts.second;
  const libraryUrl = (accountId: string) => new URL(`/api/library?accountId=${encodeURIComponent(accountId)}`, opened.client.origin);
  try {
    const readCalls = opened.calls.length;
    const empty = await getJson(libraryUrl(first.id));
    assert.equal(empty.status, 200);
    assert.equal(opened.calls.length, readCalls, 'reading the retained library must not perform world IO');
    assert.deepEqual(libraryRecords(empty.body, 'assets'), []);
    assert.deepEqual(libraryRecords(empty.body, 'varieties'), []);
    assert.deepEqual(libraryRecords(empty.body, 'grants'), []);
    assert.deepEqual(libraryRecords(empty.body, 'drafts'), []);

    const assetFields = {
      name: 'Harbor Notice',
      text: '<b>inert notice</b>',
      accountId: second.id,
      holder: 'https://foreign.test/actors/evil',
      endpoint: 'https://foreign.test/local/authoring/assets'
    };
    const createdAsset = await postJson(new URL('/api/drafts', opened.client.origin), { accountId: first.id, kind: 'asset', fields: assetFields });
    assert.ok([200, 201].includes(createdAsset.status), `creating a draft returned ${createdAsset.status}`);
    const assetDraft = draftFrom(createdAsset.body);
    assert.equal(assetDraft.kind, 'asset');
    assert.equal(assetDraft.accountId, first.id, 'draft fields cannot replace the owning account');
    assert.equal((assetDraft.fields as Record<string, unknown>).name, 'Harbor Notice');
    assert.equal((assetDraft.fields as Record<string, unknown>).text, '<b>inert notice</b>');
    assert.equal(typeof assetDraft.savedAt, 'string');
    const assetDraftId = assetDraft.id as string;

    const production = [
      { type: 'manufacture', duration: 2, ingredients: [{ variety: 'https://resources.test/ore', count: 3, data: { grade: 'a' } }], location: [{ id: 'https://places.test/workshop', name: 'Workshop', territory: 'https://places.test/territory' }], tool: 'https://tools.test/hammer', yield: [{ probability: 0.75, count: 2, data: { nested: { tag: 'kept' } } }] },
      { type: 'mine', duration: 1, ingredients: [{ id: 'https://items.test/one', variety: 'https://resources.test/ore', data: { tag: 'item' } }], yield: [{ probability: 1, count: 1, data: {} }] }
    ];
    const createdVariety = await postJson(new URL('/api/drafts', opened.client.origin), {
      accountId: first.id,
      kind: 'variety',
      fields: { name: 'Unfinished Alloy', mass: 2.5, version: '1', production }
    });
    assert.ok([200, 201].includes(createdVariety.status), `creating a draft returned ${createdVariety.status}`);
    const varietyDraft = draftFrom(createdVariety.body);
    assert.equal(varietyDraft.kind, 'variety');
    assert.deepEqual((varietyDraft.fields as Record<string, unknown>).production, production, 'incomplete production arrays are persisted without loss');
    const varietyDraftId = varietyDraft.id as string;

    const savedAsset = await postJson(new URL(`/api/drafts/${encodeURIComponent(assetDraftId)}`, opened.client.origin), {
      accountId: first.id,
      fields: { ...assetFields, text: '<b>revised notice</b>' }
    });
    assert.ok([200, 201].includes(savedAsset.status), `saving a draft returned ${savedAsset.status}`);
    assert.equal((draftFrom(savedAsset.body).fields as Record<string, unknown>).text, '<b>revised notice</b>');

    const detailCalls = opened.calls.length;
    const readAsset = await getJson(new URL(`/api/drafts/${encodeURIComponent(assetDraftId)}?accountId=${encodeURIComponent(first.id)}`, opened.client.origin));
    assert.equal(readAsset.status, 200);
    assert.equal(opened.calls.length, detailCalls, 'reading a draft must not perform world IO');
    assert.equal((draftFrom(readAsset.body).fields as Record<string, unknown>).text, '<b>revised notice</b>');

    const missingScope = await getJson(new URL(`/api/drafts/${encodeURIComponent(assetDraftId)}`, opened.client.origin));
    assert.equal(missingScope.status, 400);
    const wrongOwner = await getJson(new URL(`/api/drafts/${encodeURIComponent(assetDraftId)}?accountId=${encodeURIComponent(second.id)}`, opened.client.origin));
    assert.equal(wrongOwner.status, 404);
    assert.equal(JSON.stringify(wrongOwner.body).includes(assetDraftId), false);
    const wrongOwnerSave = await postJson(new URL(`/api/drafts/${encodeURIComponent(assetDraftId)}`, opened.client.origin), { accountId: second.id, fields: { name: 'Hijacked', text: 'x' } });
    assert.equal(wrongOwnerSave.status, 404);

    const signedOutId = 'account:task09-signed-out';
    await opened.application.state.transaction((state) => {
      state.accounts[signedOutId] = { ...first, id: signedOutId, handle: '@signed-out@example.test', login: { status: 'signed-out' } };
    });
    const signedOut = await postJson(new URL('/api/drafts', opened.client.origin), { accountId: signedOutId, kind: 'asset', fields: { name: 'No', text: 'No' } });
    assert.ok([401, 403].includes(signedOut.status), 'signed-out accounts cannot create drafts');

    const libraryCalls = opened.calls.length;
    const library = await getJson(libraryUrl(first.id));
    assert.equal(library.status, 200);
    assert.equal(opened.calls.length, libraryCalls, 'reading the retained library must not perform world IO');
    const drafts = libraryRecords(library.body, 'drafts');
    assert.ok(drafts.some((draft) => draft.id === assetDraftId));
    assert.ok(drafts.some((draft) => draft.id === varietyDraftId));

    const refreshed = await postJson(new URL('/api/library/refresh', opened.client.origin), { accountId: first.id });
    assert.equal(refreshed.status, 200);
    assert.ok(libraryRecords(refreshed.body, 'drafts').some((draft) => draft.id === varietyDraftId));
    assert.deepEqual(libraryRecords(refreshed.body, 'assets'), []);

    const secondLibrary = await getJson(libraryUrl(second.id));
    assert.equal(secondLibrary.status, 200);
    assert.equal(libraryRecords(secondLibrary.body, 'drafts').some((draft) => draft.id === assetDraftId || draft.id === varietyDraftId), false);
    const secondRefresh = await postJson(new URL('/api/library/refresh', opened.client.origin), { accountId: second.id });
    assert.equal(secondRefresh.status, 200);
    assert.equal(libraryRecords(secondRefresh.body, 'drafts').some((draft) => draft.id === assetDraftId || draft.id === varietyDraftId), false);

    for (const value of [createdAsset.body, createdVariety.body, savedAsset.body, readAsset.body, library.body, refreshed.body, secondRefresh.body]) {
      assertNoSecrets(value, [first.login.status === 'signed-in' ? first.login.nativeToken : '', second.login.status === 'signed-in' ? second.login.nativeToken : '']);
    }

    await opened.client.close();
    await opened.application.close();
    opened = await openProductionClient(storeFile, world);
    const reopened = await getJson(new URL(`/api/drafts/${encodeURIComponent(varietyDraftId)}?accountId=${encodeURIComponent(first.id)}`, opened.client.origin));
    assert.equal(reopened.status, 200);
    assert.deepEqual((draftFrom(reopened.body).fields as Record<string, unknown>).production, production);
    const reopenedSaved = await getJson(new URL(`/api/drafts/${encodeURIComponent(assetDraftId)}?accountId=${encodeURIComponent(first.id)}`, opened.client.origin));
    assert.equal((draftFrom(reopenedSaved.body).fields as Record<string, unknown>).text, '<b>revised notice</b>');
    const reopenedLibrary = await getJson(libraryUrl(first.id));
    assert.ok(libraryRecords(reopenedLibrary.body, 'drafts').some((draft) => draft.id === assetDraftId));
    assertNoSecrets(reopened.body, [first.login.status === 'signed-in' ? first.login.nativeToken : '']);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('draft publication creates signed Asset and multi-entry Variety evidence, then retains accepted references through failed read-back and restart', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task09-publication-'));
  const storeFile = join(directory, 'client.json');
  const world = await startProductionWorld(directory);
  const control: AuthoringFetchControl = {};
  let opened = await openAuthoringClient(storeFile, world, control);
  const first = world.accounts.first;
  const second = world.accounts.second;
  const origin = opened.client.origin;
  const publish = (draftId: string, accountId: string) => postJson(new URL(`/api/drafts/${encodeURIComponent(draftId)}/publish`, origin), { accountId });
  const draftUrl = (draftId: string, accountId: string) => new URL(`/api/drafts/${encodeURIComponent(draftId)}?accountId=${encodeURIComponent(accountId)}`, opened.client.origin);
  const readDocument = async (uri: string): Promise<Record<string, unknown>> => {
    const response = await fetch(uri);
    assert.equal(response.status, 200, `reading ${uri}`);
    const value = await response.json();
    assert.ok(isRecord(value));
    return value;
  };
  try {
    const attackerFields = {
      accountId: second.id,
      holder: 'https://foreign.test/actors/evil',
      endpoint: 'https://foreign.test/local/authoring/assets',
      target: 'https://foreign.test/actors/target'
    };
    const createdAsset = await postJson(new URL('/api/drafts', origin), {
      accountId: first.id,
      kind: 'asset',
      fields: { name: 'Signal Buoy', text: '<b>inert buoy notes</b>', ...attackerFields }
    });
    assert.ok([200, 201].includes(createdAsset.status), `creating a draft returned ${createdAsset.status}`);
    const assetDraft = draftFrom(createdAsset.body);
    const assetDraftId = assetDraft.id as string;

    const assetPublication = await publish(assetDraftId, first.id);
    assert.ok([200, 201].includes(assetPublication.status), JSON.stringify(assetPublication.body));
    const assetAction = actionFromBody(assetPublication.body);
    assert.equal(assetAction.submission.status, 'accepted');
    assert.equal(actionIsComplete(assetAction), false, 'HTTP acceptance alone is not publication completion');
    assert.equal(assetAction.accountId, first.id);
    const assetRef = publicationResourceRefs(assetAction)[0];
    assert.ok(assetRef, 'the accepted action retains the created resource identity immediately');
    const asset = await readDocument(assetRef.id);
    assert.equal(asset.type, 'Asset');
    assert.equal(asset.name, 'Signal Buoy');
    assert.equal(asset.holder, first.actorId, 'the authority retains the owning holder');
    assert.equal(JSON.stringify(asset).includes('foreign.test'), false);
    const media = Array.isArray(asset.media) ? asset.media.find(isRecord) : undefined;
    assert.ok(media && typeof media.url === 'string');

    const publishedAssetDraft = draftFrom(assetPublication.body);
    assert.equal(publishedAssetDraft.id, assetDraftId);
    assert.ok(JSON.stringify(publishedAssetDraft).includes(assetAction.id), 'the draft retains its publication action');
    assert.ok(JSON.stringify(publishedAssetDraft).includes(assetRef.id), 'the draft retains its publication resource');
    const publication = isRecord(publishedAssetDraft.publication) ? publishedAssetDraft.publication : undefined;
    assert.ok(publication, 'the draft retains publication state');
    assert.deepEqual(publication.publishedFields, assetDraft.fields, 'publication retains the fields used for the published resource');

    const assetReader = await postJson(new URL(`/api/resources/${encodeURIComponent(assetRef.id)}/refresh`, origin), { accountId: first.id });
    assert.equal(assetReader.status, 200);
    assert.match(JSON.stringify(assetReader.body), /Signal Buoy/);
    const publicAssetCalls = opened.calls.filter((call) => call.url === assetRef.id && call.method === 'GET');
    assert.ok(publicAssetCalls.length > 0);
    assert.ok(publicAssetCalls.every((call) => call.authorization === ''), 'public-first asset reads do not send credentials');
    const mediaReader = await postJson(new URL(`/api/resources/${encodeURIComponent(media.url as string)}/refresh`, origin), { accountId: first.id });
    assert.equal(mediaReader.status, 200);
    assert.match(JSON.stringify(mediaReader.body), /<b>inert buoy notes<\/b>/);

    const production = [
      { type: 'manufacture', duration: 2, ingredients: [{ variety: assetRef.id, count: 2, data: { grade: 'a' } }], location: [{ id: 'https://places.test/workshop', name: 'Workshop', territory: 'https://places.test/territory' }], tool: assetRef.id, yield: [{ probability: 0.75, count: 2, data: { nested: { tag: 'kept' } } }] },
      { type: 'mine', duration: 1, ingredients: [{ id: 'https://items.test/one', variety: assetRef.id, data: { tag: 'item' } }, { variety: assetRef.id, count: 1, data: { tag: 'stack' } }], yield: [{ probability: 1, count: 1, data: {} }] }
    ];
    const createdVariety = await postJson(new URL('/api/drafts', origin), {
      accountId: first.id,
      kind: 'variety',
      fields: { name: 'Signal Alloy', mass: 2.5, version: '1', asset: assetRef.id, production, ...attackerFields }
    });
    assert.ok([200, 201].includes(createdVariety.status), `creating a draft returned ${createdVariety.status}`);
    const varietyDraftId = draftFrom(createdVariety.body).id as string;
    const varietyPublication = await publish(varietyDraftId, first.id);
    assert.ok([200, 201].includes(varietyPublication.status), JSON.stringify(varietyPublication.body));
    const varietyAction = actionFromBody(varietyPublication.body);
    assert.equal(varietyAction.submission.status, 'accepted');
    assert.equal(actionIsComplete(varietyAction), false);

    let variety: Record<string, unknown> | undefined;
    let grant: Record<string, unknown> | undefined;
    for (const reference of publicationResourceRefs(varietyAction)) {
      const document = await readDocument(reference.id);
      if (document.type === 'Variety') variety = document;
      if (document.type === 'AssetGrant') grant = document;
    }
    assert.ok(variety, 'the accepted action retains the created Variety identity');
    assert.ok(grant, 'the accepted action retains the created grant identity');
    assert.equal(variety.asset, assetRef.id);
    assert.deepEqual(variety.production, production, 'multi-entry Production fields are preserved exactly');
    assert.equal(grant.asset, assetRef.id);
    assert.equal(grant.variety, variety.id);
    assert.equal(grant.grantee, first.actorId);
    const firstLibraryRefresh = await postJson(new URL('/api/library/refresh', origin), { accountId: first.id });
    assert.equal(firstLibraryRefresh.status, 200);
    const publishedVariety = libraryRecords(firstLibraryRefresh.body, 'varieties').find((record) => record.id === variety.id);
    assert.ok(publishedVariety, 'the Library retains the published Variety by its exact ID');
    assert.equal(publishedVariety.mass, 2.5, 'the Library Variety retains the submitted mass');
    assert.equal(publishedVariety.version, '1', 'the Library Variety retains the submitted version');
    const key = await fetch(`${world.origins.authority}/keys/player`).then((response) => response.json()) as Record<string, unknown>;
    const loader = createLocalDocumentLoader(new Map([[String(key.id), key]]));
    for (const value of [asset, variety, grant]) assert.equal((await verifyProofCryptography(value, loader)).verified, true, 'published evidence is signed');

    const descriptiveProduction = [
      { type: 'mine', duration: 0, ingredients: [{ variety: assetRef.id, count: 1, data: { note: 'reference only' } }], location: [{ id: 'https://places.test/descriptive', name: 'Desk', territory: 'https://places.test/territory' }], yield: [{ probability: 1, count: 0, data: {} }] }
    ];
    const descriptiveDraft = await postJson(new URL('/api/drafts', origin), {
      accountId: first.id,
      kind: 'variety',
      fields: { name: 'Reference Notes', mass: 1, version: '1', production: descriptiveProduction }
    });
    assert.ok([200, 201].includes(descriptiveDraft.status), `creating a draft returned ${descriptiveDraft.status}`);
    const descriptivePublication = await publish(draftFrom(descriptiveDraft.body).id as string, first.id);
    assert.ok([200, 201].includes(descriptivePublication.status), JSON.stringify(descriptivePublication.body));
    const descriptiveAction = actionFromBody(descriptivePublication.body);
    assert.equal(descriptiveAction.submission.status, 'accepted', 'descriptive references do not require an owned Asset');
    let descriptiveVariety: Record<string, unknown> | undefined;
    for (const reference of publicationResourceRefs(descriptiveAction)) {
      const document = await readDocument(reference.id);
      if (document.type === 'Variety') descriptiveVariety = document;
    }
    assert.ok(descriptiveVariety);
    assert.equal(descriptiveVariety.asset, undefined);
    assert.deepEqual(descriptiveVariety.production, descriptiveProduction);

    const secondBefore = await postJson(new URL('/api/library/refresh', origin), { accountId: second.id });
    assert.equal(secondBefore.status, 200);
    const secondVarietyCount = libraryRecords(secondBefore.body, 'varieties').length;
    const foreignDraft = await postJson(new URL('/api/drafts', origin), {
      accountId: second.id,
      kind: 'variety',
      fields: { name: 'Foreign Alloy', mass: 1, version: '1', asset: assetRef.id }
    });
    assert.ok([200, 201].includes(foreignDraft.status), `creating a draft returned ${foreignDraft.status}`);
    const foreignPublication = await publish(draftFrom(foreignDraft.body).id as string, second.id);
    if ([200, 201].includes(foreignPublication.status)) {
      const foreignAction = actionFromBody(foreignPublication.body);
      assert.notEqual(foreignAction.submission.status, 'accepted', 'another account cannot publish a Variety referencing a foreign Asset');
      assert.equal(actionIsComplete(foreignAction), false);
    } else {
      assert.ok(foreignPublication.status >= 400 && foreignPublication.status < 500);
    }
    const secondAfter = await postJson(new URL('/api/library/refresh', origin), { accountId: second.id });
    assert.equal(secondAfter.status, 200);
    assert.equal(libraryRecords(secondAfter.body, 'varieties').length, secondVarietyCount);
    assert.equal(libraryRecords(secondAfter.body, 'varieties').some((record) => record.name === 'Foreign Alloy'), false);

    const assetPosts = opened.calls.filter((call) => call.method === 'POST' && new URL(call.url).pathname === '/local/authoring/assets').length;
    assert.equal(assetPosts, 1);
    control.fail = (url) => url.pathname.includes('/objects/');
    const failedRead = await postJson(new URL(`/api/resources/${encodeURIComponent(assetRef.id)}/refresh`, origin), { accountId: first.id });
    assert.equal(failedRead.status, 200);
    const failedObservation = observationRecords(failedRead.body).find((record) => record.source === assetRef.id && (record.state === 'unavailable' || record.state === 'stale'));
    assert.ok(failedObservation, 'a failed read-back is a separate observation');
    assert.equal(typeof failedObservation.error, 'string');
    assert.equal(opened.calls.filter((call) => call.method === 'POST' && new URL(call.url).pathname === '/local/authoring/assets').length, 1, 'publication is not retried after a read-back failure');
    const retainedAction = await getJson(new URL(`/api/activity/${encodeURIComponent(assetAction.id)}?accountId=${encodeURIComponent(first.id)}`, origin));
    assert.equal(retainedAction.status, 200);
    const retained = findRecord(retainedAction.body, (record) => record.id === assetAction.id && isRecord(record.submission)) as unknown as ActionRecord;
    assert.equal(retained.submission.status, 'accepted');
    assert.deepEqual(retained.resultReferences, assetAction.resultReferences);
    const retainedDraft = await getJson(draftUrl(assetDraftId, first.id));
    assert.equal(retainedDraft.status, 200);
    assert.ok(JSON.stringify(retainedDraft.body).includes(assetAction.id));
    assert.ok(JSON.stringify(retainedDraft.body).includes(assetRef.id));

    for (const call of opened.calls.filter((candidate) => candidate.authorization !== '')) {
      assert.equal(new URL(call.url).origin, world.origins.authority, 'native credentials only go to the issuing Home origin');
    }
    const rendered = JSON.stringify([assetPublication.body, varietyPublication.body, descriptivePublication.body, retainedAction.body, retainedDraft.body, secondAfter.body]);
    assert.equal(rendered.includes('foreign.test'), false);
    assertNoSecrets(rendered, Object.values(world.nativeTokens));

    delete control.fail;
    await opened.client.close();
    await opened.application.close();
    opened = await openAuthoringClient(storeFile, world, control);
    const reopenedDraft = await getJson(draftUrl(assetDraftId, first.id));
    assert.equal(reopenedDraft.status, 200);
    assert.ok(JSON.stringify(reopenedDraft.body).includes(assetAction.id), 'draft publication references survive restart');
    assert.ok(JSON.stringify(reopenedDraft.body).includes(assetRef.id));
    const reopenedAction = await getJson(new URL(`/api/activity/${encodeURIComponent(assetAction.id)}?accountId=${encodeURIComponent(first.id)}`, opened.client.origin));
    assert.equal(reopenedAction.status, 200);
    const reopenedRecord = findRecord(reopenedAction.body, (record) => record.id === assetAction.id && isRecord(record.submission)) as unknown as ActionRecord;
    assert.equal(reopenedRecord.submission.status, 'accepted');
    assert.deepEqual(reopenedRecord.resultReferences, assetAction.resultReferences);
  } finally {
    delete control.fail;
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('publication reconciliation observes resources without resubmission and authoring respects the issuing Home', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authoring-boundaries-'));
  const world = await startProductionWorld(directory);
  const control: AuthoringFetchControl = {};
  const opened = await openAuthoringClient(join(directory, 'client.json'), world, control);
  const accountId = world.accounts.first.id;
  const url = (path: string) => new URL(path, opened.client.origin);
  try {
    const created = await postJson(url('/api/drafts'), { accountId, kind: 'asset', fields: { name: 'Evidence', text: 'Observed publication' } });
    const draftId = String(draftFrom(created.body).id);
    const published = await postJson(url(`/api/drafts/${encodeURIComponent(draftId)}/publish`), { accountId });
    const action = actionFromBody(published.body);
    assert.equal(action.submission.status, 'accepted');
    const postCount = () => opened.calls.filter((call) => call.method === 'POST' && new URL(call.url).pathname === '/local/authoring/assets').length;
    assert.equal(postCount(), 1);
    const reconciled = await postJson(url(`/api/activity/${encodeURIComponent(action.id)}/refresh`), { accountId });
    const completed = findRecord(reconciled.body, (record) => record.id === action.id && isRecord(record.submission)) as unknown as ActionRecord;
    assert.ok(completed);
    assert.equal(actionIsComplete(completed), true, 'explicit read-back establishes publication evidence');
    assert.equal(postCount(), 1);
    control.fail = (target) => target.pathname === '/actors/player';
    const refresh = await postJson(url('/api/library/refresh'), { accountId });
    assert.equal(refresh.status, 200);
    assert.ok(observationRecords(refresh.body).some((entry) => typeof entry.error === 'string' && (entry.state === 'unavailable' || entry.state === 'stale')), 'failed creations discovery remains observable');
    assert.ok(libraryRecords(refresh.body, 'assets').some((entry) => entry.name === 'Evidence'));
    delete control.fail;
    await opened.application.state.transaction((state) => {
      state.accounts[accountId]!.homeAuthority = 'https://foreign.test/actors/home';
    });
    const count = opened.calls.length;
    await postJson(url(`/api/drafts/${encodeURIComponent(draftId)}/publish`), { accountId });
    await postJson(url('/api/library/refresh'), { accountId });
    assert.equal(opened.calls.slice(count).some((call) => new URL(call.url).host === 'foreign.test'), false, 'native authoring credentials cannot follow a mismatched Home Actor');
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('library refresh isolates two account catalogs and retains stale evidence when the catalog source fails', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task09-library-isolation-'));
  const storeFile = join(directory, 'client.json');
  const world = await startProductionWorld(directory);
  const control: AuthoringFetchControl = {};
  const opened = await openAuthoringClient(storeFile, world, control);
  const first = world.accounts.first;
  const second = world.accounts.second;
  const refresh = (accountId: string) => postJson(new URL('/api/library/refresh', opened.client.origin), { accountId });
  try {
    const firstAsset = await seedAuthorityAsset(world, world.nativeTokens.first, 'First Island Chart', 'first text');
    const secondAsset = await seedAuthorityAsset(world, world.nativeTokens.second, 'Second Island Chart', 'second text');

    const firstLibrary = await refresh(first.id);
    assert.equal(firstLibrary.status, 200);
    assert.ok(libraryRecords(firstLibrary.body, 'assets').some((asset) => asset.id === firstAsset.id));
    assert.equal(JSON.stringify(firstLibrary.body).includes(String(secondAsset.id)), false);
    assert.equal(JSON.stringify(firstLibrary.body).includes('Second Island Chart'), false);

    const secondLibrary = await refresh(second.id);
    assert.equal(secondLibrary.status, 200);
    assert.ok(libraryRecords(secondLibrary.body, 'assets').some((asset) => asset.id === secondAsset.id));
    assert.equal(JSON.stringify(secondLibrary.body).includes(String(firstAsset.id)), false);
    assert.equal(JSON.stringify(secondLibrary.body).includes('First Island Chart'), false);

    const firstDraft = await postJson(new URL('/api/drafts', opened.client.origin), { accountId: first.id, kind: 'asset', fields: { name: 'Private Draft', text: 'draft text' } });
    assert.ok([200, 201].includes(firstDraft.status));
    const firstDraftId = draftFrom(firstDraft.body).id as string;
    const secondDrafts = await refresh(second.id);
    assert.equal(JSON.stringify(secondDrafts.body).includes(firstDraftId), false);
    const firstDrafts = await refresh(first.id);
    assert.ok(libraryRecords(firstDrafts.body, 'drafts').some((draft) => draft.id === firstDraftId));

    for (const call of opened.calls.filter((candidate) => candidate.authorization !== '')) {
      assert.equal(new URL(call.url).origin, world.origins.authority, 'catalog credentials only go to the issuing Home origin');
    }
    const catalogAuthCalls = opened.calls.filter((call) => call.authorization !== '' && new URL(call.url).pathname === '/local/authoring');
    assert.ok(catalogAuthCalls.length > 0, 'the catalog refresh authenticates only against /local/authoring');

    control.fail = (url) => url.pathname === '/local/authoring' || url.pathname.includes('/creations');
    const failed = await refresh(first.id);
    assert.equal(failed.status, 200, 'a failed catalog source does not erase the retained page');
    assert.match(JSON.stringify(failed.body), new RegExp(escapeRegExp(String(firstAsset.id))));
    assert.match(JSON.stringify(failed.body), /First Island Chart/);
    const stale = observationRecords(failed.body).find((record) => typeof record.source === 'string' && record.source.includes('/local/authoring'));
    assert.ok(stale, 'the failed catalog source keeps its observation');
    assert.equal(stale.state, 'stale', 'retained catalog evidence is stale rather than discarded');
    assert.equal(typeof stale.error, 'string');
    assert.match(JSON.stringify(stale.value), new RegExp(escapeRegExp(String(firstAsset.id))));

    delete control.fail;
    const recovered = await refresh(first.id);
    assert.equal(recovered.status, 200);
    assert.ok(libraryRecords(recovered.body, 'assets').some((asset) => asset.id === firstAsset.id));
    const recoveredObservation = observationRecords(recovered.body).find((record) => typeof record.source === 'string' && record.source.includes('/local/authoring'));
    assert.equal(recoveredObservation?.state, 'available');

    assertNoSecrets([firstLibrary.body, secondLibrary.body, firstDrafts.body, failed.body, recovered.body], Object.values(world.nativeTokens));
  } finally {
    delete control.fail;
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function administrationPageUrl(origin: string, accountId: string): URL {
  return new URL(`/api/administration?accountId=${encodeURIComponent(accountId)}`, origin);
}

function administrationRefresh(origin: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  return postJson(new URL('/api/administration/refresh', origin), body);
}

function administrationControl(origin: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  return postJson(new URL('/api/administration/controls', origin), body);
}

function administrationDecision(origin: string, requestId: string, decision: 'approve' | 'reject', body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  return postJson(new URL(`/api/administration/entry-requests/${encodeURIComponent(requestId)}/${decision}`, origin), body);
}

async function readActivityAction(origin: string, accountId: string, actionId: string): Promise<ActionRecord> {
  const response = await getJson(new URL(`/api/activity/${encodeURIComponent(actionId)}?accountId=${encodeURIComponent(accountId)}`, origin));
  assert.equal(response.status, 200);
  return (response.body as PageResponse<{ action: ActionRecord }>).data.action;
}

async function refreshActivityAction(origin: string, accountId: string, actionId: string): Promise<ActionRecord> {
  const response = await postJson(new URL(`/api/activity/${encodeURIComponent(actionId)}/refresh`, origin), { accountId });
  assert.equal(response.status, 200);
  return (response.body as PageResponse<{ action: ActionRecord }>).data.action;
}

test('administration page retains authorized targets without world IO and refresh isolates a failed source', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task10-admin-page-'));
  const world = await startProductionWorld(directory, { administratorNames: ['governor'] });
  const opened = await openProductionClient(join(directory, 'client.json'), world, {
    administratorBindings: [{ accountId: world.accounts.first.id, authorityActorIds: [world.policy.ids.actor, world.simulation.ids.actor, world.authority.ids.actor.registry], credentialSource: 'territory-admin' }],
    administratorCredentials: { 'territory-admin': world.adminSecret }
  });
  await opened.application.state.transaction((state) => { if (world.governor) state.accounts[world.governor.id] = world.governor; });
  const accountId = world.accounts.first.id;
  try {
    const readCalls = opened.calls.length;
    const before = await getJson(administrationPageUrl(opened.client.origin, accountId));
    assert.equal(before.status, 200);
    assert.equal(opened.calls.length, readCalls, 'retained administration reads must not perform world IO');
    const beforePage = before.body as PageResponse<Record<string, unknown>>;
    assert.equal(beforePage.context.accountId, accountId);
    const beforeText = JSON.stringify(beforePage.data);
    assert.match(beforeText, new RegExp(escapeRegExp(world.policy.ids.actor)));
    assert.match(beforeText, new RegExp(escapeRegExp(world.simulation.ids.actor)));
    assert.match(beforeText, /control|request|state/i);

    const missing = await getJson(new URL('/api/administration', opened.client.origin));
    assert.equal(missing.status, 400);
    const unknown = await getJson(administrationPageUrl(opened.client.origin, 'account:unknown'));
    assert.ok([401, 403, 404].includes(unknown.status));

    const refreshCalls = opened.calls.length;
    const refreshed = await administrationRefresh(opened.client.origin, { accountId, authorityId: world.policy.ids.actor });
    assert.equal(refreshed.status, 200);
    const newCalls = opened.calls.slice(refreshCalls);
    assert.ok(newCalls.some((call) => new URL(call.url).origin === world.origins.policy), 'refresh reads the selected target');
    assert.equal(newCalls.some((call) => new URL(call.url).origin === world.origins.simulation), false, 'refresh does not read an unselected target');
    assert.ok(opened.calls.some((call) => new URL(call.url).origin === world.origins.policy && call.url.includes('/local/admin/entry-requests')), 'refresh retains pending entry requests');
    assert.match(JSON.stringify(refreshed.body), new RegExp(escapeRegExp(world.policy.ids.actor)));
    assert.match(JSON.stringify(refreshed.body), /available|empty|stale|not-retrieved/i);

    const retainedCalls = opened.calls.length;
    const retained = await getJson(administrationPageUrl(opened.client.origin, accountId));
    assert.equal(retained.status, 200);
    assert.equal(opened.calls.length, retainedCalls, 'a retained read after refresh does not contact the world');
    assert.match(JSON.stringify(retained.body), new RegExp(escapeRegExp(world.policy.ids.actor)));

    const simulationRefresh = await administrationRefresh(opened.client.origin, { accountId, authorityId: world.simulation.ids.actor });
    assert.equal(simulationRefresh.status, 200);
    assert.match(JSON.stringify(simulationRefresh.body), new RegExp(escapeRegExp(world.simulation.ids.actor)));

    await world.simulation.host.close();
    const failedRefresh = await administrationRefresh(opened.client.origin, { accountId, authorityId: world.simulation.ids.actor });
    assert.equal(failedRefresh.status, 200, 'a failed target does not fail the retained page');
    const failedText = JSON.stringify(failedRefresh.body);
    assert.match(failedText, /stale|unavailable/i);
    assert.match(failedText, /error/i);
    assert.match(failedText, new RegExp(escapeRegExp(world.policy.ids.actor)), 'other retained targets are not erased');
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('administration controls use bound credentials, current values, and governor-native Home availability', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task10-admin-controls-'));
  const world = await startProductionWorld(directory, { administratorNames: ['governor'] });
  const opened = await openProductionClient(join(directory, 'client.json'), world, {
    administratorBindings: [{ accountId: world.accounts.first.id, authorityActorIds: [world.policy.ids.actor, world.simulation.ids.actor, world.authority.ids.actor.registry], credentialSource: 'territory-admin' }],
    administratorCredentials: { 'territory-admin': world.adminSecret }
  });
  await opened.application.state.transaction((state) => { if (world.governor) state.accounts[world.governor.id] = world.governor; });
  const first = world.accounts.first;
  const control = (authorityId: string, name: string, inputs: Record<string, unknown>, accountId = first.id) =>
    administrationControl(opened.client.origin, { accountId, authorityId, control: name, inputs });
  try {
    const admission = await control(world.policy.ids.actor, 'admission', { reviewMode: 'manual' });
    assert.equal(admission.status, 200);
    const admissionAction = actionFromBody(admission.body);
    assert.match(JSON.stringify(admissionAction.intent), /admission/i);
    assert.match(JSON.stringify(admissionAction.intent.inputs), /manual/i);
    assert.equal(admissionAction.submission.status, 'accepted');
    assert.equal(((await world.policy.territory.ledger).admission as unknown as Record<string, unknown>).reviewMode, 'manual');
    const policyRefresh = await administrationRefresh(opened.client.origin, { accountId: first.id, authorityId: world.policy.ids.actor });
    assert.equal(policyRefresh.status, 200);
    assert.match(JSON.stringify(policyRefresh.body), /manual/i, 'the retained page shows the applied current value');

    const facilities = await control(world.simulation.ids.actor, 'facilities', { mining: { enabled: false, capacity: 3 } });
    assert.equal(facilities.status, 200);
    const facilitiesAction = actionFromBody(facilities.body);
    assert.match(JSON.stringify(facilitiesAction.intent), /facilit/i);
    assert.match(JSON.stringify(facilitiesAction.intent.inputs), /mining/i);
    assert.match(JSON.stringify(facilitiesAction.intent.inputs), /false/);
    let simulation = await world.simulation.territory.state();
    assert.equal(simulation.simulation.config.miningEnabled, false);
    assert.equal(simulation.simulation.config.miningCapacity, 3);

    const tickBefore = simulation.simulation.tick;
    const tick = await control(world.simulation.ids.actor, 'tick', {});
    assert.equal(tick.status, 200);
    const tickAction = actionFromBody(tick.body);
    assert.match(JSON.stringify(tickAction.intent), /tick/i);
    assert.equal(tickAction.submission.status, 'accepted');
    simulation = await world.simulation.territory.state();
    assert.equal(simulation.simulation.tick, tickBefore + 1, 'the tick control advances the simulation');
    const tickRefresh = await refreshActivityAction(opened.client.origin, first.id, tickAction.id);
    assert.match(JSON.stringify(tickRefresh), /completed|evidence/i, 'tick completion is established by observed evidence');

    const adoption = await control(world.authority.ids.actor.registry, 'adoption', { vesselId: world.authority.ids.vessel, adoption: false });
    assert.equal(adoption.status, 200);
    const adoptionAction = actionFromBody(adoption.body);
    assert.match(JSON.stringify(adoptionAction.intent), /adoption/i);
    assert.match(JSON.stringify(adoptionAction.intent.inputs), /false/);
    assert.equal((await world.authority.registry.state(world.authority.ids.vessel)).adoption, false);

    const fleetPage = await administrationRefresh(opened.client.origin, { accountId: first.id, authorityId: world.authority.ids.actor.registry });
    assert.equal(fleetPage.status, 200);
    const fleetVessel = findRecord(fleetPage.body, (entry) => isRecord(entry.vessel) && entry.vessel.id === world.authority.ids.vessel && entry.adoption === false);
    assert.ok(fleetVessel, 'Registry administration reads the fleet and its current per-vessel adoption');
    const otherVessel = world.authority.ids.vessels.other!;
    const otherAdoption = await control(world.authority.ids.actor.registry, 'adoption', { vesselId: otherVessel, adoption: false });
    assert.equal(otherAdoption.status, 200);
    assert.equal((await world.authority.registry.state(otherVessel)).adoption, false, 'the selected vessel, not the default vessel, receives the adoption change');

    const governor = world.governor!;
    const governorToken = governor.login.status === 'signed-in' ? governor.login.nativeToken : '';
    const homeRefresh = await administrationRefresh(opened.client.origin, { accountId: governor.id, authorityId: world.authority.ids.actor.home });
    assert.equal(homeRefresh.status, 200);
    const homeText = JSON.stringify(homeRefresh.body);
    assert.match(homeText, /availability/i);
    assert.match(homeText, new RegExp(escapeRegExp(`@other@${new URL(world.origins.authority).host}`)));
    const homeCalls = opened.calls.filter((call) => new URL(call.url).origin === world.origins.authority && call.url.includes('/local/home/accounts'));
    assert.ok(homeCalls.length > 0);
    assert.ok(homeCalls.every((call) => call.authorization === `Bearer ${governorToken}`), 'Home availability uses the governor native token');
    assert.equal(homeCalls.some((call) => call.authorization === `Bearer ${world.adminSecret}`), false, 'Home availability never uses the administrator secret');

    const availability = await control(world.authority.ids.actor.home, 'availability', { handle: `@other@${new URL(world.origins.authority).host}`, available: false }, governor.id);
    assert.equal(availability.status, 200);
    const availabilityAction = actionFromBody(availability.body);
    assert.match(JSON.stringify(availabilityAction.intent), /availability/i);
    assert.match(JSON.stringify(availabilityAction.intent.inputs), /false/);
    const homeAccounts = await fetch(`${world.origins.authority}/local/home/accounts`, { headers: { Authorization: `Bearer ${governorToken}` } });
    assert.equal(homeAccounts.status, 200);
    const homeAccountsBody = await homeAccounts.json() as { accounts: Array<{ handle: string; available: boolean }> };
    assert.equal(homeAccountsBody.accounts.find((account) => account.handle === `@other@${new URL(world.origins.authority).host}`)?.available, false);

    const callsBeforeRejection = opened.calls.length;
    const unsupported = await control(world.policy.ids.actor, 'unknown-control', {});
    assert.ok(unsupported.status >= 400 && unsupported.status < 500);
    assert.equal(opened.calls.length, callsBeforeRejection, 'unsupported controls are rejected before any world request');
    const unknownTarget = await administrationRefresh(opened.client.origin, { accountId: first.id, authorityId: 'https://unknown.test/actors/territory' });
    assert.ok(unknownTarget.status >= 400 && unknownTarget.status < 500);
    assert.equal(opened.calls.length, callsBeforeRejection, 'unknown targets are rejected before any credential or world request');
    const unbound = await control(world.policy.ids.actor, 'admission', { reviewMode: 'automatic' }, world.accounts.second.id);
    assert.ok([403, 404].includes(unbound.status), 'an unbound account cannot execute a control');
    assert.equal(opened.calls.length, callsBeforeRejection, 'an unbound account cannot trigger a credentialed request');

    assertNoSecrets([admission.body, facilities.body, tick.body, adoption.body, homeRefresh.body, availability.body], [world.adminSecret, governorToken, ...Object.values(world.nativeTokens)]);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('administration approves and rejects manual entry requests with real Registry evidence and current rules', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task10-admin-requests-'));
  const world = await startProductionWorld(directory);
  const opened = await openProductionClient(join(directory, 'client.json'), world, {
    administratorBindings: [{ accountId: world.accounts.first.id, authorityActorIds: [world.policy.ids.actor, world.simulation.ids.actor], credentialSource: 'territory-admin' }],
    administratorCredentials: { 'territory-admin': world.adminSecret }
  });
  const accountId = world.accounts.first.id;
  const adminHeaders = { Authorization: `Bearer ${world.adminSecret}`, 'Content-Type': 'application/json' };
  try {
    for (const [origin, target] of [[world.origins.policy, world.policy], [world.origins.simulation, world.simulation]] as const) {
      const response = await fetch(`${origin}/local/admin/admission`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ reviewMode: 'manual' }) });
      assert.equal(response.status, 200, `manual review is configured for ${target.ids.actor}`);
    }
    const refreshAdministration = async (authorityId: string): Promise<unknown> => {
      const response = await administrationRefresh(opened.client.origin, { accountId, authorityId });
      assert.equal(response.status, 200);
      return response.body;
    };
    const decide = (requestId: string, decision: 'approve' | 'reject', authorityId: string, reason?: string) =>
      administrationDecision(opened.client.origin, requestId, decision, { accountId, authorityId, ...(reason === undefined ? {} : { reason }) });

    const rejectedEntry = await submitLogisticsEntry(opened.client.origin, world, 'policy');
    const rejectedReference = rejectedEntry.resultReferences.find((reference) => reference.kind === 'request');
    assert.ok(rejectedReference);
    await exchangeWorld(world.authority.authority.server, world.policy.host.server);
    const policyPage = await refreshAdministration(world.policy.ids.actor);
    assert.match(JSON.stringify(policyPage), new RegExp(escapeRegExp(rejectedReference.id)));
    assert.match(JSON.stringify(policyPage), /pending/i);
    const rejected = await decide(rejectedReference.id, 'reject', world.policy.ids.actor, 'harbor-closed');
    assert.equal(rejected.status, 200);
    const rejectedAction = actionFromBody(rejected.body);
    assert.equal(rejectedAction.submission.status, 'accepted');
    assert.match(JSON.stringify(rejectedAction.intent.inputs), /harbor-closed/);
    assert.ok(rejectedAction.resultReferences.some((reference) => reference.id === rejectedReference.id), 'the decision action retains the request reference');
    await exchangeWorld(world.policy.host.server, world.authority.authority.server);
    const rejectedRegistry = await world.authority.registry.state(world.authority.ids.vessel);
    assert.equal(rejectedRegistry.events.some((event) => event.type === 'EntryRejected' && event.request === rejectedReference.id), true, 'rejection produces real Registry EntryRejected evidence');
    const rejectedCompleted = await refreshActivityAction(opened.client.origin, accountId, rejectedAction.id);
    assert.equal(rejectedCompleted.outcome.status, 'failed', 'EntryRejected establishes a failed outcome');
    assert.ok(rejectedCompleted.outcome.evidence.length > 0);

    const approvedEntry = await submitLogisticsEntry(opened.client.origin, world, 'policy');
    const approvedReference = approvedEntry.resultReferences.find((reference) => reference.kind === 'request');
    assert.ok(approvedReference);
    await exchangeWorld(world.authority.authority.server, world.policy.host.server);
    const approvedPage = await refreshAdministration(world.policy.ids.actor);
    assert.match(JSON.stringify(approvedPage), new RegExp(escapeRegExp(approvedReference.id)));
    const approved = await decide(approvedReference.id, 'approve', world.policy.ids.actor);
    assert.equal(approved.status, 200);
    const approvedAction = actionFromBody(approved.body);
    assert.equal(approvedAction.submission.status, 'accepted');
    await exchangeWorld(world.policy.host.server, world.authority.authority.server);
    const approvedRegistry = await world.authority.registry.state(world.authority.ids.vessel);
    assert.equal(approvedRegistry.events.some((event) => event.type === 'BerthingEvent' && event.request === approvedReference.id), true, 'policy approval produces real Registry BerthingEvent evidence');
    const approvedCompleted = await refreshActivityAction(opened.client.origin, accountId, approvedAction.id);
    assert.equal(approvedCompleted.outcome.status, 'completed');
    assert.ok(approvedCompleted.outcome.evidence.length > 0);

    const repeated = await decide(approvedReference.id, 'approve', world.policy.ids.actor);
    assert.equal(repeated.status, 200);
    assert.equal((await world.authority.registry.state(world.authority.ids.vessel)).events.filter((event) => event.type === 'BerthingEvent' && event.request === approvedReference.id).length, 1, 'repeated approval never creates another visit');
    const ignored = await decide(approvedReference.id, 'reject', world.policy.ids.actor, 'late-rejection');
    assert.equal(ignored.status, 200);
    assert.equal((await world.authority.registry.state(world.authority.ids.vessel)).events.some((event) => event.type === 'EntryRejected' && event.request === approvedReference.id), false, 'a conflicting later decision never creates compensation');

    const simulationEntry = await submitLogisticsEntry(opened.client.origin, world, 'simulation');
    const simulationReference = simulationEntry.resultReferences.find((reference) => reference.kind === 'request');
    assert.ok(simulationReference);
    await exchangeWorld(world.authority.authority.server, world.simulation.host.server);
    const simulationPage = await refreshAdministration(world.simulation.ids.actor);
    assert.match(JSON.stringify(simulationPage), new RegExp(escapeRegExp(simulationReference.id)));
    const simulationApproved = await decide(simulationReference.id, 'approve', world.simulation.ids.actor);
    assert.equal(simulationApproved.status, 200);
    const simulationAction = actionFromBody(simulationApproved.body);
    await exchangeWorld(world.simulation.host.server, world.authority.authority.server);
    assert.equal((await world.authority.registry.state(world.authority.ids.vessel)).events.some((event) => event.type === 'BerthingEvent' && event.request === simulationReference.id), false, 'simulation approval waits for a tick');
    const beforeTick = await readActivityAction(opened.client.origin, accountId, simulationAction.id);
    assert.notEqual(beforeTick.outcome.status, 'completed', 'simulation approval is not berthing completion before the tick');
    const tick = await fetch(`${world.origins.simulation}/local/admin/tick`, { method: 'POST', headers: adminHeaders, body: '{}' });
    assert.equal(tick.status, 200);
    await exchangeWorld(world.simulation.host.server, world.authority.authority.server);
    assert.equal((await world.authority.registry.state(world.authority.ids.vessel)).events.some((event) => event.type === 'BerthingEvent' && event.request === simulationReference.id), true, 'the delayed simulation BerthingEvent is real Registry evidence');
    const simulationRefresh = await refreshAdministration(world.simulation.ids.actor);
    assert.match(JSON.stringify(simulationRefresh), /berth|event/i, 'the delayed simulation event becomes discoverable in the retained request data');
    const simulationCompleted = await refreshActivityAction(opened.client.origin, accountId, simulationAction.id);
    assert.equal(simulationCompleted.outcome.status, 'completed');

    const callsBeforeUnauthorized = opened.calls.length;
    const missingScope = await administrationDecision(opened.client.origin, approvedReference.id, 'approve', { authorityId: world.policy.ids.actor });
    assert.equal(missingScope.status, 400, 'account scope is mandatory');
    const unboundDecision = await administrationDecision(opened.client.origin, approvedReference.id, 'approve', { accountId: world.accounts.second.id, authorityId: world.policy.ids.actor });
    assert.ok([403, 404].includes(unboundDecision.status));
    assert.equal(opened.calls.length, callsBeforeUnauthorized, 'an unbound account cannot submit a decision to the world');
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('acknowledged administration control needs observed submitted values before completion', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-admin-unapplied-'));
  const world = await startProductionWorld(directory);
  const opened = await openProductionClient(join(directory, 'client.json'), world, {
    administratorBindings: [{ accountId: world.accounts.first.id, authorityActorIds: [world.policy.ids.actor], credentialSource: 'policy' }],
    administratorCredentials: { policy: world.adminSecret },
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === world.origins.policy && url.pathname === '/local/admin/admission' && init?.method === 'POST') return Response.json({ accepted: true });
      return fetch(input, init);
    }
  });
  try {
    const response = await administrationControl(opened.client.origin, { accountId: world.accounts.first.id, authorityId: world.policy.ids.actor, control: 'admission', inputs: { reviewMode: 'manual' } });
    assert.equal(response.status, 200);
    const action = actionFromBody(response.body);
    assert.equal(action.submission.status, 'accepted');
    const observed = await refreshActivityAction(opened.client.origin, world.accounts.first.id, action.id);
    assert.notEqual(observed.outcome.status, 'completed', 'an unchanged admission observation is not evidence the submitted setting was applied');
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Territory administrator reconciles another Player entry without native Registry access', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-admin-other-owner-'));
  const world = await startProductionWorld(directory);
  const administrator = world.accounts.second;
  const opened = await openProductionClient(join(directory, 'client.json'), world, {
    administratorBindings: [{ accountId: administrator.id, authorityActorIds: [world.policy.ids.actor], credentialSource: 'policy' }],
    administratorCredentials: { policy: world.adminSecret }
  });
  try {
    const configured = await administrationControl(opened.client.origin, { accountId: administrator.id, authorityId: world.policy.ids.actor, control: 'admission', inputs: { reviewMode: 'manual' } });
    assert.equal(configured.status, 200);
    const entry = await submitLogisticsEntry(opened.client.origin, world, 'policy');
    const request = entry.resultReferences.find((reference) => reference.kind === 'request')!;
    await exchangeWorld(world.authority.authority.server, world.policy.host.server);
    assert.equal((await administrationRefresh(opened.client.origin, { accountId: administrator.id, authorityId: world.policy.ids.actor })).status, 200);
    const decision = await administrationDecision(opened.client.origin, request.id, 'approve', { accountId: administrator.id, authorityId: world.policy.ids.actor });
    assert.equal(decision.status, 200);
    const action = actionFromBody(decision.body);
    const callsBefore = opened.calls.length;
    const reconciled = await refreshActivityAction(opened.client.origin, administrator.id, action.id);
    assert.equal(reconciled.outcome.status, 'completed', 'Territory evidence establishes berthing without administrator ownership of the vessel');
    assert.ok(reconciled.outcome.evidence.length > 0);
    assert.ok(reconciled.resultReferences.some((reference) => reference.kind === 'event'), 'decision action retains the resulting event reference');
    assert.equal(opened.calls.slice(callsBefore).some((call) => new URL(call.url).pathname.startsWith('/local/registry/')), false, 'decision reconciliation never sends administrator native credentials to a vessel Registry');
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function productionWorldOptionsWithJourney(): ProductionWorldOptions {
  return {
    additionalPolicyRoutes: ({ policyOrigin, simulationOrigin }) => [{
      id: `${policyOrigin}/objects/routes/outbound`, type: 'Route', name: 'Outbound Passage',
      from: `${policyOrigin}/objects/ports/west`, to: `${simulationOrigin}/objects/boundaries/east`, distance: 4
    }]
  };
}

test('traverse executes a saved connected route through actual local movement, signed exit evidence, and delayed simulation berthing', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task11-traverse-'));
  const world = await startProductionWorld(directory, productionWorldOptionsWithJourney());
  const storeFile = join(directory, 'client.json');
  const calls: ExploreCall[] = [];
  const control: { fail?: (url: URL, method: string) => boolean } = {};
  let opened = await openProductionClient(storeFile, world, { fetch: controllableJourneyFetch(calls, control) });
  const first = world.accounts.first;
  const vessel = world.authority.ids.vessel;
  const adminHeaders = task08AdminHeaders(world);
  const policyEast = world.policy.ids.ports[0]!;
  const policyWest = world.policy.ids.ports[1]!;
  const simulationMain = world.simulation.ids.ports[0]!;
  try {
    const admission = await fetch(`${world.origins.policy}/local/admin/admission`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ publicPorts: world.policy.ids.ports })
    });
    assert.equal(admission.status, 200, 'both policy ports are readable in the connected fixture');
    const refreshed = await refreshExplore(opened.client.origin);
    assert.equal(refreshed.status, 200);

    const plan = await saveJourneyPlan(opened.client.origin, first.id, policyEast, simulationMain);
    const planLegs = plan.legs as Array<Record<string, unknown>>;
    assert.deepEqual(planLegs.map((leg) => leg.routeId), [world.policy.ids.routes[1], journeyOutboundRouteId(world), world.simulation.ids.routes[0]], 'the saved plan uses only explicitly published directed routes');
    assert.deepEqual(planLegs.map((leg) => leg.from), [policyEast, policyWest, `${world.origins.simulation}/objects/boundaries/east`]);

    await submitLogisticsEntryFor(opened.client.origin, world, first.id, vessel, 'policy');
    await exchangeWorld(world.authority.authority.server, world.policy.host.server);
    assert.equal((await world.policy.territory.ledger).visits[vessel]?.port, policyEast);

    const foreign = await traverseJourney(opened.client.origin, world.accounts.second.id, world.authority.ids.vessels.other!, plan.id as string);
    assert.ok([400, 403, 404].includes(foreign.status), 'another account cannot traverse with a foreign or unowned vessel');
    const missingPlan = await traverseJourney(opened.client.origin, first.id, vessel, 'route-plan:missing');
    assert.ok([400, 403, 404].includes(missingPlan.status), 'an unknown saved plan is refused');

    const posted = await traverseJourney(opened.client.origin, first.id, vessel, plan.id as string, { legs: [{ routeId: 'https://tampered.test/route', from: policyEast, to: simulationMain }] });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    let action = posted.action!;
    assert.equal(action.intent.kind, 'traverse');
    assert.equal(action.intent.inputs.routePlanId, plan.id);
    assert.equal(action.intent.inputs.vesselId, vessel);
    assert.notEqual(action.outcome.status, 'completed', 'HTTP acceptance is not a completed journey');
    const initialLegs = actionJourneyLegs(action);
    assert.equal(initialLegs.length, 3, 'the tampered caller legs are ignored in favour of the saved plan');
    assert.deepEqual(initialLegs.map((leg) => leg.routeId), [world.policy.ids.routes[1], journeyOutboundRouteId(world), world.simulation.ids.routes[0]]);
    assert.ok(initialLegs.every((leg) => typeof leg.status === 'string'), 'every leg carries its step status');

    const callsBeforeRead = calls.length;
    await readActivityAction(opened.client.origin, first.id, action.id);
    assert.equal(calls.length, callsBeforeRead, 'GETs inspect retained journey progress without world IO');

    const concurrent = await Promise.all([
      refreshActivityAction(opened.client.origin, first.id, action.id),
      refreshActivityAction(opened.client.origin, first.id, action.id)
    ]);
    assert.equal(concurrent[0]?.id, action.id);
    assert.equal(concurrent[1]?.id, action.id);
    action = await refreshJourneyUntil(opened.client.origin, first.id, action.id, async () => (await world.policy.territory.ledger).visits[vessel]?.port === policyWest, 'actual local movement reaches West Haven');
    const voyageIds = new Set(collectRecords(await world.policy.territory.ledger)
      .filter((record) => record.type === 'VoyageEvent' && record.kind === 'local-movement' && record.vessel === vessel)
      .map((record) => record.id));
    assert.equal(voyageIds.size, 1, 'concurrent refresh never duplicates the local movement step and retains its event');
    assert.equal(actionJourneyLegs(action).length, 3);

    await opened.client.close();
    await opened.application.close();
    opened = await openProductionClient(storeFile, world, { fetch: controllableJourneyFetch(calls, control) });
    action = await readActivityAction(opened.client.origin, first.id, action.id);
    assert.equal(actionJourneyLegs(action).length, 3, 'journey progress survives restart');

    action = await refreshJourneyUntil(opened.client.origin, first.id, action.id, async () =>
      Object.values((await world.authority.registry.state(vessel)).requests).some((request) => isRecord(request) && request.type === 'DepartureRequest' && request.port === policyWest),
      'the journey submits a Registry departure request only after local movement');
    await world.authority.authority.server.processOutbox();
    await world.policy.host.server.processInbox();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const delivered = await world.policy.host.server.processOutbox(1);
      assert.ok(delivered > 0, 'the policy territory publishes departure evidence');
      await world.authority.authority.server.processInbox();
      if ((await registryEvents(world, vessel)).some((event) => event.type === 'DepartureEvent')) break;
    }
    const departureOnly = await registryEvents(world, vessel);
    assert.ok(departureOnly.some((event) => event.type === 'DepartureEvent'), 'the departure event is observed');
    assert.equal(departureOnly.some((event) => event.type === 'ExitEvent'), false, 'delivery is interrupted before the signed exit evidence');
    const entriesBeforeExit = (await registryEntryRequests(world, vessel, world.simulation.ids.actor)).length;
    action = await refreshActivityAction(opened.client.origin, first.id, action.id);
    assert.notEqual(action.outcome.status, 'completed');
    assert.equal((await registryEntryRequests(world, vessel, world.simulation.ids.actor)).length, entriesBeforeExit, 'departure alone cannot advance the dependent entry');

    await world.policy.host.server.processOutbox(10);
    await world.authority.authority.server.processInbox();
    const registryAfterExit = await registryEvents(world, vessel);
    const exit = registryAfterExit.find((event) => event.type === 'ExitEvent');
    assert.ok(exit, 'the signed ExitEvent is real Registry evidence');

    action = await refreshJourneyUntil(opened.client.origin, first.id, action.id, async () => (await registryEntryRequests(world, vessel, world.simulation.ids.actor)).length > entriesBeforeExit, 'the next entry is submitted after signed exit evidence');
    const simulationEntry = (await registryEntryRequests(world, vessel, world.simulation.ids.actor)).at(-1)!;
    const simulationRequest = simulationEntry as { id: string; journey?: { exitEvidence?: string } };
    assert.equal(simulationRequest.journey?.exitEvidence, exit.id, 'the next EntryRequest carries the real signed exit evidence');

    await exchangeWorld(world.authority.authority.server, world.simulation.host.server);
    action = await refreshActivityAction(opened.client.origin, first.id, action.id);
    assert.notEqual(action.outcome.status, 'completed', 'the simulation entry request is not itself berthing');
    let simulationState = await world.simulation.territory.state();
    const pendingVisit = simulationState.visits[simulationRequest.id];
    assert.equal(pendingVisit?.decision.accepted, true);
    assert.equal(simulationState.simulation.vessels.find((item) => item.id === pendingVisit?.simulationVessel)?.status, 'pending');
    assert.equal((await registryEvents(world, vessel)).some((event) => event.type === 'BerthingEvent' && event.request === simulationRequest.id), false);

    control.fail = (url, method) => url.origin === world.origins.simulation && method === 'GET' && url.pathname.startsWith('/local/');
    const retriesBefore = (await registryEntryRequests(world, vessel, world.simulation.ids.actor)).length;
    action = await refreshActivityAction(opened.client.origin, first.id, action.id);
    assert.notEqual(action.outcome.status, 'completed', 'an unavailable observation never becomes completion');
    assert.equal(actionJourneyLegs(action).length, 3, 'an unavailable observation retains journey progress');
    assert.equal((await registryEntryRequests(world, vessel, world.simulation.ids.actor)).length, retriesBefore, 'an unavailable observation never resubmits the child entry');
    delete control.fail;

    const tick = await fetch(`${world.origins.simulation}/local/admin/tick`, { method: 'POST', headers: adminHeaders, body: '{}' });
    assert.equal(tick.status, 200);
    await exchangeWorld(world.simulation.host.server, world.authority.authority.server);
    action = await refreshJourneyUntil(opened.client.origin, first.id, action.id, (candidate) => candidate.outcome.status === 'completed', 'the journey completes only after delayed berth evidence');
    assert.ok(action.outcome.evidence.length > 0);
    const berth = (await registryEvents(world, vessel)).find((event) => event.type === 'BerthingEvent' && event.request === simulationRequest.id);
    assert.ok(berth, 'the delayed simulation BerthingEvent is the completion evidence');
    simulationState = await world.simulation.territory.state();
    assert.equal(simulationState.simulation.vessels.find((item) => item.id === pendingVisit?.simulationVessel)?.status, 'berthed');
    assert.equal((await world.policy.territory.ledger).visits[vessel]?.departed, true);
    assert.ok(action.resultReferences.some((reference) => reference.kind === 'request'));
    assert.ok(action.resultReferences.some((reference) => reference.kind === 'event'));
    assert.equal(actionJourneyLegs(action).length, 3, 'per-leg progress remains readable after completion');
    assertNoSecrets([plan, action], [world.nativeTokens.first, world.nativeTokens.second]);
  } finally {
    delete control.fail;
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('traverse retains manual destination review, never resubmits on concurrent refresh, and stops after destination rejection', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-task11-traverse-manual-'));
  const world = await startProductionWorld(directory, productionWorldOptionsWithJourney());
  const opened = await openProductionClient(join(directory, 'client.json'), world);
  const first = world.accounts.first;
  const vessel = world.authority.ids.vessel;
  const adminHeaders = task08AdminHeaders(world);
  try {
    const admission = await fetch(`${world.origins.policy}/local/admin/admission`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ publicPorts: world.policy.ids.ports })
    });
    assert.equal(admission.status, 200);
    const manual = await fetch(`${world.origins.simulation}/local/admin/admission`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ reviewMode: 'manual' })
    });
    assert.equal(manual.status, 200);
    assert.equal((await refreshExplore(opened.client.origin)).status, 200);
    const plan = await saveJourneyPlan(opened.client.origin, first.id, world.policy.ids.ports[0]!, world.simulation.ids.ports[0]!);

    await submitLogisticsEntryFor(opened.client.origin, world, first.id, vessel, 'policy');
    await exchangeWorld(world.authority.authority.server, world.policy.host.server);
    const posted = await traverseJourney(opened.client.origin, first.id, vessel, plan.id as string);
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    let action = posted.action!;
    assert.notEqual(action.outcome.status, 'completed');

    let simulationEntry: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 20 && simulationEntry === undefined; attempt += 1) {
      action = await refreshActivityAction(opened.client.origin, first.id, action.id);
      await exchangeWorld(world.authority.authority.server, world.policy.host.server);
      await exchangeWorld(world.authority.authority.server, world.simulation.host.server);
      simulationEntry = (await registryEntryRequests(world, vessel, world.simulation.ids.actor)).at(-1);
    }
    assert.ok(simulationEntry, 'the journey reaches a destination entry request');
    const requestId = String(simulationEntry.id);

    let simulationState = await world.simulation.territory.state();
    assert.equal(simulationState.requests[requestId]?.status, 'pending', 'manual destination review keeps the entry pending');
    assert.equal((await registryEvents(world, vessel)).some((event) => event.type === 'BerthingEvent' && event.request === requestId), false);
    action = await readActivityAction(opened.client.origin, first.id, action.id);
    assert.notEqual(action.outcome.status, 'completed', 'a pending review does not complete a dependent step');
    assert.equal(actionJourneyLegs(action).length, 3);

    const countBefore = (await registryEntryRequests(world, vessel, world.simulation.ids.actor)).length;
    await Promise.all([
      refreshActivityAction(opened.client.origin, first.id, action.id),
      refreshActivityAction(opened.client.origin, first.id, action.id)
    ]);
    assert.equal((await registryEntryRequests(world, vessel, world.simulation.ids.actor)).length, countBefore, 'concurrent refresh never duplicates the pending entry step');
    action = await readActivityAction(opened.client.origin, first.id, action.id);
    assert.notEqual(action.outcome.status, 'completed');
    assert.equal(actionJourneyLegs(action).length, 3, 'pending review retains per-leg progress');

    const rejected = await fetch(`${world.origins.simulation}/local/admin/entry-requests/${encodeURIComponent(requestId)}/reject`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ reason: 'destination-rejected' })
    });
    assert.equal(rejected.status, 200);
    await exchangeWorld(world.simulation.host.server, world.authority.authority.server);
    action = await refreshJourneyUntil(opened.client.origin, first.id, action.id, (candidate) => candidate.outcome.status === 'failed', 'destination rejection stops the journey');
    assert.ok(action.outcome.evidence.length > 0);
    assert.match(JSON.stringify(action.outcome), /destination-rejected|reject|failed/i);
    simulationState = await world.simulation.territory.state();
    assert.equal(simulationState.requests[requestId]?.status, 'rejected');
    const registryAfterRejection = await registryEvents(world, vessel);
    assert.equal(registryAfterRejection.some((event) => event.type === 'BerthingEvent' && event.request === requestId), false, 'rejection never advances into berthing');
    assert.equal(registryAfterRejection.some((event) => event.type === 'EntryRejected' && event.request === requestId), true);
    const stoppedCount = (await registryEntryRequests(world, vessel, world.simulation.ids.actor)).length;
    action = await refreshActivityAction(opened.client.origin, first.id, action.id);
    assert.equal(action.outcome.status, 'failed', 'a rejected journey is not retried');
    assert.equal((await registryEntryRequests(world, vessel, world.simulation.ids.actor)).length, stoppedCount, 'rejection stops dependent advancement');
    assertNoSecrets([plan, action], [world.nativeTokens.first, world.nativeTokens.second]);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a boundary-start journey cannot enter another Territory while the vessel has an active visit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-journey-start-'));
  const world = await startProductionWorld(directory, productionWorldOptionsWithJourney());
  const opened = await openProductionClient(join(directory, 'client.json'), world);
  const accountId = world.accounts.first.id;
  const vessel = world.authority.ids.vessel;
  try {
    await refreshExplore(opened.client.origin);
    const plan = await saveJourneyPlan(opened.client.origin, accountId, `${world.origins.simulation}/objects/boundaries/east`, world.simulation.ids.ports[0]!);
    await submitLogisticsEntryFor(opened.client.origin, world, accountId, vessel, 'policy');
    await exchangeWorld(world.authority.authority.server, world.policy.host.server);
    const posted = await traverseJourney(opened.client.origin, accountId, vessel, String(plan.id));
    if (posted.action?.submission.status === 'accepted') await refreshActivityAction(opened.client.origin, accountId, posted.action.id);
    assert.equal((await registryEntryRequests(world, vessel, world.simulation.ids.actor)).length, 0, 'starting at an unrelated boundary cannot skip the existing visit departure');
    assert.equal((await world.policy.territory.ledger).visits[vessel]?.departed, false);
  } finally {
    await opened.client.close(); await opened.application.close(); await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('local journey completion requires observed movement rather than an acknowledged event-shaped response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-journey-readback-'));
  const world = await startProductionWorld(directory);
  let movementPosts = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === world.origins.policy && url.pathname === '/local/traverse' && init?.method === 'POST') {
      movementPosts += 1;
      return Response.json({ success: true, event: {
        id: `${world.origins.policy}/objects/policy/voyage/unapplied`, type: 'VoyageEvent', kind: 'local-movement',
        territory: world.policy.ids.actor, vessel: world.authority.ids.vessel,
        details: { from: world.policy.ids.ports[0], to: world.policy.ids.ports[1], route: world.policy.ids.routes[1] },
        effectiveAt: new Date().toISOString()
      } });
    }
    return fetch(input, init);
  };
  const opened = await openProductionClient(join(directory, 'client.json'), world, { fetch: fetcher });
  const accountId = world.accounts.first.id;
  const vessel = world.authority.ids.vessel;
  try {
    await fetch(`${world.origins.policy}/local/admin/admission`, { method: 'POST', headers: task08AdminHeaders(world), body: JSON.stringify({ publicPorts: world.policy.ids.ports }) });
    await refreshExplore(opened.client.origin);
    const plan = await saveJourneyPlan(opened.client.origin, accountId, world.policy.ids.ports[0]!, world.policy.ids.ports[1]!);
    await submitLogisticsEntryFor(opened.client.origin, world, accountId, vessel, 'policy');
    await exchangeWorld(world.authority.authority.server, world.policy.host.server);
    const posted = await traverseJourney(opened.client.origin, accountId, vessel, String(plan.id));
    assert.equal(posted.status, 200);
    let action = await refreshActivityAction(opened.client.origin, accountId, posted.action!.id);
    assert.notEqual(action.outcome.status, 'completed', 'response alone does not establish the reached destination');
    action = await refreshActivityAction(opened.client.origin, accountId, action.id);
    assert.notEqual(action.outcome.status, 'completed');
    assert.equal((await world.policy.territory.ledger).visits[vessel]?.port, world.policy.ids.ports[0]);
    assert.equal(movementPosts, 1, 'unconfirmed movement is observed, never blindly replayed');
  } finally {
    await opened.client.close(); await opened.application.close(); await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a lost Registry submission response remains uncertain across restart without replaying the request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-journey-lost-response-'));
  const world = await startProductionWorld(directory, productionWorldOptionsWithJourney());
  const storeFile = join(directory, 'client.json');
  let departurePosts = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = await fetch(input, init);
    if (url.origin === world.origins.authority && url.pathname === '/local/registry/departure' && init?.method === 'POST') {
      departurePosts += 1;
      await response.arrayBuffer();
      throw new TypeError('Registry response lost after submission');
    }
    return response;
  };
  let opened = await openProductionClient(storeFile, world, { fetch: fetcher });
  const accountId = world.accounts.first.id;
  const vessel = world.authority.ids.vessel;
  try {
    await fetch(`${world.origins.policy}/local/admin/admission`, { method: 'POST', headers: task08AdminHeaders(world), body: JSON.stringify({ publicPorts: world.policy.ids.ports }) });
    await refreshExplore(opened.client.origin);
    const plan = await saveJourneyPlan(opened.client.origin, accountId, world.policy.ids.ports[1]!, world.simulation.ids.ports[0]!);
    await submitLogisticsEntryFor(opened.client.origin, world, accountId, vessel, 'policy');
    await exchangeWorld(world.authority.authority.server, world.policy.host.server);
    const token = await deriveDiplomaticToken(world.nativeTokens.first, world.policy.ids.actor);
    assert.equal((await fetch(`${world.origins.policy}/local/traverse`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ vessel, route: world.policy.ids.routes[1] }) })).status, 200);
    const posted = await traverseJourney(opened.client.origin, accountId, vessel, String(plan.id));
    assert.equal(posted.status, 200);
    let action = await refreshActivityAction(opened.client.origin, accountId, posted.action!.id);
    assert.equal(action.outcome.status, 'unverified');
    assert.equal(departurePosts, 1);
    await opened.client.close(); await opened.application.close();
    opened = await openProductionClient(storeFile, world, { fetch: fetcher });
    action = await refreshActivityAction(opened.client.origin, accountId, action.id);
    assert.equal(action.outcome.status, 'unverified');
    assert.equal(departurePosts, 1);
    const departures = Object.values((await world.authority.registry.state(vessel)).requests).filter((request) => isRecord(request) && request.type === 'DepartureRequest');
    assert.equal(departures.length, 1);
  } finally {
    await opened.client.close(); await opened.application.close(); await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

interface ClientLoginBody {
  status: 'signed-in';
  account: PublicAccountRecord;
  clientToken: string;
}

async function loginClient(origin: string, account: FixtureHomeAccount): Promise<ClientLoginBody> {
  const response = await fetch(new URL('/api/accounts/login', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: account.handle, password: account.password })
  });
  assert.equal(response.status, 200);
  const body = await response.json() as ClientLoginBody;
  assert.equal(body.status, 'signed-in');
  assert.equal(typeof body.clientToken, 'string');
  assert.ok(body.clientToken.length >= 32);
  return body;
}

function authorization(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

async function readClientSessions(storeFile: string): Promise<{ raw: string; sessions: Record<string, Record<string, unknown>> }> {
  const raw = await readFile(storeFile, 'utf8');
  const stored: unknown = JSON.parse(raw);
  assert.ok(isRecord(stored) && isRecord(stored.domain) && isRecord(stored.domain.client));
  const sessions = stored.domain.client.clientSessions;
  assert.ok(isRecord(sessions));
  return {
    raw,
    sessions: Object.fromEntries(Object.entries(sessions).map(([digest, record]) => {
      assert.ok(isRecord(record));
      return [digest, record];
    }))
  };
}

test('login issues independent client tokens and persists only their digests across reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-sessions-'));
  const storeFile = join(directory, 'client.store.json');
  const fixture = createFixtureFetch(fixtureHomes(), []);
  let opened = await openFixtureApplication(storeFile, fixture.fetch);
  try {
    const first = await loginClient(opened.client.origin, firstLoginAccount);
    const second = await loginClient(opened.client.origin, firstLoginAccount);
    assert.notEqual(first.clientToken, second.clientToken);
    assert.equal(first.account.id, second.account.id);
    for (const body of [first, second]) {
      assert.equal(JSON.stringify(body).includes(firstLoginAccount.nativeToken), false);
      assert.equal(JSON.stringify(body).includes(firstLoginAccount.password), false);
    }

    const stored = await readClientSessions(storeFile);
    assert.equal(stored.sessions[createHash('sha256').update(first.clientToken).digest('base64url')]?.accountId, first.account.id);
    assert.equal(stored.sessions[createHash('sha256').update(second.clientToken).digest('base64url')]?.accountId, first.account.id);
    assert.equal(stored.raw.includes(first.clientToken), false);
    assert.equal(stored.raw.includes(second.clientToken), false);
    assert.deepEqual(Object.keys(stored.sessions).sort(), [
      createHash('sha256').update(first.clientToken).digest('base64url'),
      createHash('sha256').update(second.clientToken).digest('base64url')
    ].sort());

    await opened.client.close();
    await opened.application.close();
    opened = await openFixtureApplication(storeFile, fixture.fetch);
    for (const token of [first.clientToken, second.clientToken]) {
      const response = await fetch(new URL('/api/accounts', opened.client.origin), { headers: authorization(token) });
      assert.equal(response.status, 200);
      const body = await response.json() as { accounts: PublicAccountRecord[] };
      assert.deepEqual(body.accounts.map((account) => account.id), [first.account.id]);
    }

    const third = await loginClient(opened.client.origin, firstLoginAccount);
    assert.notEqual(third.clientToken, first.clientToken);
    assert.notEqual(third.clientToken, second.clientToken);
    const earlier = await fetch(new URL('/api/accounts', opened.client.origin), { headers: authorization(first.clientToken) });
    assert.equal(earlier.status, 200, 'a later successful login does not revoke an earlier session');
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('logout revokes only the requesting client session and signs out the account on its final session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-logout-sessions-'));
  const storeFile = join(directory, 'client.store.json');
  const fixture = createFixtureFetch(fixtureHomes(), []);
  const opened = await openFixtureApplication(storeFile, fixture.fetch);
  try {
    const first = await loginClient(opened.client.origin, firstLoginAccount);
    const second = await loginClient(opened.client.origin, firstLoginAccount);
    const callsAfterLogin = fixture.calls.length;
    const logoutUrl = new URL(`/api/accounts/${encodeURIComponent(first.account.id)}/logout`, opened.client.origin);

    const firstLogout = await fetch(logoutUrl, { method: 'POST', headers: authorization(first.clientToken) });
    assert.equal(firstLogout.status, 200);
    const firstLogoutBody = await firstLogout.json() as { account: PublicAccountRecord };
    assert.equal(firstLogoutBody.account.id, first.account.id);
    assert.equal(firstLogoutBody.account.login.status, 'signed-in');
    assert.equal(JSON.stringify(firstLogoutBody).includes(firstLoginAccount.nativeToken), false);
    assert.equal(fixture.calls.length, callsAfterLogin, 'logout does not contact the Home server');

    assert.equal((await fetch(new URL('/api/accounts', opened.client.origin), { headers: authorization(first.clientToken) })).status, 401);
    assert.equal((await fetch(new URL('/api/accounts', opened.client.origin), { headers: authorization(second.clientToken) })).status, 200);

    const finalLogout = await fetch(logoutUrl, { method: 'POST', headers: authorization(second.clientToken) });
    assert.equal(finalLogout.status, 200);
    const finalBody = await finalLogout.json() as { account: PublicAccountRecord };
    assert.equal(finalBody.account.login.status, 'signed-out');
    assert.equal(fixture.calls.length, callsAfterLogin);
    assert.equal((await fetch(new URL('/api/accounts', opened.client.origin), { headers: authorization(second.clientToken) })).status, 401);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('client authentication rejects missing, native and cross-account credentials before IO', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-auth-'));
  const storeFile = join(directory, 'client.store.json');
  const fixture = createFixtureFetch(fixtureHomes(), []);
  const opened = await openFixtureApplication(storeFile, fixture.fetch);
  try {
    const first = await loginClient(opened.client.origin, firstLoginAccount);
    const second = await loginClient(opened.client.origin, secondLoginAccount);
    const callsAfterLogin = fixture.calls.length;
    const accountsUrl = new URL('/api/accounts', opened.client.origin);
    const libraryUrl = new URL(`/api/library?accountId=${encodeURIComponent(first.account.id)}`, opened.client.origin);

    assert.equal((await unauthenticatedFetch(accountsUrl)).status, 401);
    assert.equal((await unauthenticatedFetch(accountsUrl, { headers: authorization(firstLoginAccount.nativeToken) })).status, 401, 'native Home credentials are not client tokens');
    assert.equal((await unauthenticatedFetch(accountsUrl, { headers: authorization('not-a-client-token') })).status, 401);
    const firstAccounts = await fetch(accountsUrl, { headers: authorization(first.clientToken) });
    assert.equal(firstAccounts.status, 200);
    assert.deepEqual(((await firstAccounts.json()) as { accounts: PublicAccountRecord[] }).accounts.map((account) => account.id), [first.account.id]);
    const secondAccounts = await fetch(accountsUrl, { headers: authorization(second.clientToken) });
    assert.equal(secondAccounts.status, 200);
    assert.deepEqual(((await secondAccounts.json()) as { accounts: PublicAccountRecord[] }).accounts.map((account) => account.id), [second.account.id]);

    assert.equal((await unauthenticatedFetch(libraryUrl)).status, 401);
    assert.equal(fixture.calls.length, callsAfterLogin, 'authorization rejects before a private read performs world IO');
    assert.equal((await unauthenticatedFetch(libraryUrl, { headers: authorization(second.clientToken) })).status, 403);
    assert.equal((await unauthenticatedFetch(libraryUrl, { headers: authorization(first.clientToken) })).status, 200);

    const duplicate = new URL(`/api/library?accountId=${encodeURIComponent(first.account.id)}&accountId=${encodeURIComponent(second.account.id)}`, opened.client.origin);
    assert.equal((await unauthenticatedFetch(duplicate, { headers: authorization(first.clientToken) })).status, 400);
    const conflicting = new URL(`/api/library/refresh?accountId=${encodeURIComponent(second.account.id)}`, opened.client.origin);
    const conflictingResponse = await unauthenticatedFetch(conflicting, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...authorization(first.clientToken) },
      body: JSON.stringify({ accountId: first.account.id })
    });
    assert.equal(conflictingResponse.status, 400);
    assert.equal(fixture.calls.length, callsAfterLogin, 'a conflicting scope is rejected before refresh IO');
    const unauthenticatedRefresh = await unauthenticatedFetch(new URL('/api/library/refresh', opened.client.origin), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: first.account.id })
    });
    assert.equal(unauthenticatedRefresh.status, 401);
    assert.equal(fixture.calls.length, callsAfterLogin);

    const publicPlaces = new URL('/api/explore/places', opened.client.origin);
    assert.equal((await unauthenticatedFetch(publicPlaces)).status, 200);
    assert.equal((await unauthenticatedFetch(publicPlaces, { headers: authorization('invalid-client-token') })).status, 401, 'invalid credentials do not silently downgrade to anonymous');
    assert.equal((await unauthenticatedFetch(new URL(`${publicPlaces.pathname}?accountId=${encodeURIComponent(first.account.id)}`, opened.client.origin))).status, 401);
    assert.equal((await unauthenticatedFetch(new URL(`${publicPlaces.pathname}?accountId=${encodeURIComponent(first.account.id)}`, opened.client.origin), { headers: authorization(second.clientToken) })).status, 403);
    assert.equal((await unauthenticatedFetch(new URL(`${publicPlaces.pathname}?accountId=${encodeURIComponent(first.account.id)}`, opened.client.origin), { headers: authorization(first.clientToken) })).status, 200);

    const publicResource = new URL(`/api/resources/${encodeURIComponent('https://resources.test/public')}`, opened.client.origin);
    assert.equal((await unauthenticatedFetch(publicResource)).status, 200);
    assert.equal((await unauthenticatedFetch(new URL(`${publicResource.pathname}?accountId=${encodeURIComponent(first.account.id)}`, opened.client.origin))).status, 401);

    const logoutUrl = new URL(`/api/accounts/${encodeURIComponent(first.account.id)}/logout`, opened.client.origin);
    assert.equal((await unauthenticatedFetch(logoutUrl, { method: 'POST' })).status, 401);
    assert.equal((await unauthenticatedFetch(logoutUrl, { method: 'POST', headers: authorization(second.clientToken) })).status, 403);
    assert.equal((await unauthenticatedFetch(new URL('/api/accounts', opened.client.origin), { headers: authorization(first.clientToken) })).status, 200);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy retained login state without client sessions never authorizes by itself', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-legacy-sessions-'));
  const storeFile = join(directory, 'client.store.json');
  const legacyClient = {
    servers: {},
    authorities: {},
    accounts: { [firstAccount.id]: firstAccount },
    observations: {},
    drafts: {},
    routePlans: {},
    actions: {},
    followedRequests: {},
    followedJobs: {}
  };
  await writeFile(storeFile, JSON.stringify({ domain: { client: legacyClient } }), 'utf8');
  const application = await createClientApplication({ storeFile });
  const client = await startClientServer({ port: 0, application });
  try {
    assert.deepEqual(await application.state.read((state) => state.clientSessions), {});
    assert.equal((await fetch(new URL('/api/accounts', client.origin))).status, 401);
    assert.equal((await fetch(new URL('/api/accounts', client.origin), { headers: authorization('first-native-token') })).status, 401);
    assert.equal((await fetch(new URL(`/api/library?accountId=${encodeURIComponent(firstAccount.id)}`, client.origin))).status, 401);
  } finally {
    await client.close();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('published and library resource documents are packed for the reader without an extra refresh', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-packed-resources-'));
  const storeFile = join(directory, 'client.store.json');
  const world = await startProductionWorld(directory);
  const opened = await openAuthoringClient(storeFile, world, {});
  const first = world.accounts.first;
  const second = world.accounts.second;
  const resourceUrl = (accountId: string, resourceId: string): URL => {
    const url = new URL(`/api/resources/${encodeURIComponent(resourceId)}`, opened.client.origin);
    url.searchParams.set('accountId', accountId);
    return url;
  };
  const resourceData = (body: unknown): Record<string, unknown> => bodyRecord(bodyRecord(body).data);
  const resourceObservations = (body: unknown): Record<string, unknown> => bodyRecord(bodyRecord(body).observations);
  const mediaObservation = (body: unknown, url: string): Record<string, unknown> | undefined =>
    Object.values(resourceObservations(body)).find((value): value is Record<string, unknown> => isRecord(value) && value.source === url);
  try {
    const nativeToken = first.login.status === 'signed-in' ? first.login.nativeToken : '';
    const seeded = await seedAuthorityAsset(world, nativeToken, 'Library Asset', 'Library asset text');
    const seededId = typeof seeded.id === 'string' ? seeded.id : '';
    assert.ok(seededId, 'the seeded Asset has an exact identity');
    const refreshed = await postJson(new URL('/api/library/refresh', opened.client.origin), { accountId: first.id });
    assert.equal(refreshed.status, 200);
    const libraryAsset = libraryRecords(refreshed.body, 'assets').find((entry) => entry.id === seededId);
    assert.ok(libraryAsset, 'the Library retains the seeded Asset');
    const seededCreators = Array.isArray(seeded.creator) ? seeded.creator : [];
    assert.ok(seededCreators.length > 0, 'the seeded Asset declares its creator');
    assert.deepEqual(libraryAsset.creator, seededCreators, 'the Library entry preserves the exact seeded Asset creator');
    const libraryEntryMedia = (Array.isArray(libraryAsset.media) ? libraryAsset.media : []).filter(isRecord)[0];
    assert.ok(libraryEntryMedia, 'the Library entry exposes its media descriptor');
    assert.equal(typeof libraryEntryMedia.url, 'string');
    assert.equal(libraryEntryMedia.mediaType, 'text/plain');
    assert.equal(libraryEntryMedia.state, 'available');
    assert.equal(libraryEntryMedia.value, 'Library asset text');

    const libraryRead = await getJson(resourceUrl(first.id, seededId));
    assert.equal(libraryRead.status, 200);
    const libraryValue = bodyRecord(resourceData(libraryRead.body).value);
    assert.equal(libraryValue.type, 'Asset', 'the Library refresh packs the Asset document for the reader');
    const libraryMedia = (Array.isArray(libraryValue.media) ? libraryValue.media : []).filter(isRecord)[0];
    assert.ok(libraryMedia && typeof libraryMedia.url === 'string', 'the Asset publishes a media reference');
    const libraryMediaObservation = mediaObservation(libraryRead.body, libraryMedia.url);
    assert.equal(libraryMediaObservation?.state, 'available', 'the Library refresh packs Asset media for the reader');
    assert.equal(libraryMediaObservation?.value, 'Library asset text');

    const created = await postJson(new URL('/api/drafts', opened.client.origin), {
      accountId: first.id,
      kind: 'asset',
      fields: { name: 'Published Asset', text: 'Published asset text' }
    });
    assert.ok([200, 201].includes(created.status));
    const draftId = String(draftFrom(created.body).id);
    const published = await postJson(new URL(`/api/drafts/${encodeURIComponent(draftId)}/publish`, opened.client.origin), { accountId: first.id });
    assert.ok([200, 201].includes(published.status));
    const action = bodyRecord(bodyRecord(published.body).action);
    assert.equal(bodyRecord(action.submission).status, 'accepted');
    const reference = (Array.isArray(action.resultReferences) ? action.resultReferences : [])
      .filter(isRecord)
      .find((candidate) => candidate.kind === 'resource');
    assert.ok(reference && typeof reference.id === 'string', 'publication returns the exact resource reference');

    const immediateRead = await getJson(resourceUrl(first.id, reference.id));
    assert.equal(immediateRead.status, 200);
    const immediateValue = bodyRecord(resourceData(immediateRead.body).value);
    assert.equal(immediateValue.type, 'Asset', 'publication packs the returned Asset document before any readback');
    const immediateMedia = (Array.isArray(immediateValue.media) ? immediateValue.media : []).filter(isRecord)[0];
    assert.ok(immediateMedia && typeof immediateMedia.url === 'string');
    const immediateMediaObservation = mediaObservation(immediateRead.body, immediateMedia.url);
    assert.equal(immediateMediaObservation?.state, 'available', 'publication packs the Asset media before any readback');
    assert.equal(immediateMediaObservation?.value, 'Published asset text');

    const publishedLibrary = await postJson(new URL('/api/library/refresh', opened.client.origin), { accountId: first.id });
    assert.equal(publishedLibrary.status, 200);
    const publishedAsset = libraryRecords(publishedLibrary.body, 'assets').find((entry) => entry.id === reference.id);
    assert.ok(publishedAsset, 'the refreshed Library retains the published Asset');
    const publishedMedia = (Array.isArray(publishedAsset.media) ? publishedAsset.media : []).filter(isRecord)[0];
    assert.ok(publishedMedia, 'the refreshed Library exposes the published Asset media');
    assert.equal(publishedMedia.state, 'available');
    assert.equal(publishedMedia.value, 'Published asset text');

    const otherAccountRead = await getJson(resourceUrl(second.id, reference.id));
    assert.equal(otherAccountRead.status, 200);
    assert.equal(resourceData(otherAccountRead.body).value, undefined, 'packed resources remain account-scoped');
    const otherObservation = Object.values(resourceObservations(otherAccountRead.body)).find((value): value is Record<string, unknown> => isRecord(value) && value.source === reference.id);
    assert.equal(isRecord(otherObservation) ? otherObservation.state : undefined, 'not-retrieved');
  } finally {
    await opened.client.close();
    await opened.application.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});
