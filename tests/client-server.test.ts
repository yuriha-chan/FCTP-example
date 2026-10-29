import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deriveDiplomaticToken } from '@fctp/auth';
import type { URI } from '@fctp/protocol';
import { actionIsComplete } from '@fctp/client-sdk';
import type { AccountRecord, ActionRecord, AuthorityRecord, PageResponse, PublicAccountRecord, ServerRecord, SourcedObservation } from '@fctp/client-sdk';
import type { ActionHandler } from '../apps/client-server/src/actions.js';
import { createClientApplication, type ClientApplication, type CreateClientApplicationOptions } from '../apps/client-server/src/app.js';
import { startClientServer } from '../apps/demo/src/client-server.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';

test('serves the existing browser client and public config on an isolated port', async () => {
  const config = {
    origins: { authority: 'http://authority.example', policy: 'http://policy.example', simulation: 'http://simulation.example' },
    actors: { registry: 'https://authority.example/registry', home: 'https://authority.example/home', player: 'https://authority.example/player', policy: 'https://policy.example/actor', simulation: 'https://simulation.example/actor' }
  };
  const client = await startClientServer({ port: 0, config });
  try {
    const html = await fetch(client.origin);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /href=["']\/styles\.css["']/);
    const stylesheet = await fetch(new URL('/styles.css', client.origin));
    assert.equal(stylesheet.status, 200);
    assert.ok((await stylesheet.text()).length > 0);
    const bundle = await fetch(new URL('/dist/client/main.js', client.origin));
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type') ?? '', /javascript/);
    assert.ok((await bundle.text()).length > 0);
    const configResponse = await fetch(new URL('/config.json', client.origin));
    assert.equal(configResponse.status, 200);
    assert.equal(configResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await configResponse.json(), config);
    assert.equal((await fetch(new URL('/package.json', client.origin))).status, 404);
    assert.equal((await fetch(new URL('/../../package.json', client.origin))).status, 404);
  } finally {
    await client.close();
  }
  await assert.rejects(fetch(new URL('/config.json', client.origin)));
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
  const config = {
    origins: { authority: 'http://authority.example', policy: 'http://policy.example', simulation: 'http://simulation.example' },
    actors: { registry: 'https://authority.example/registry', home: 'https://authority.example/home', player: 'https://authority.example/player', policy: 'https://policy.example/actor', simulation: 'https://simulation.example/actor' }
  };
  const client = await startClientServer({ port: 0, config, application });
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
    assert.match(await html.text(), /href=["']\/styles\.css["']/);
    assert.equal((await fetch(new URL('/styles.css', client.origin))).status, 200);
    const configResponse = await fetch(new URL('/config.json', client.origin));
    assert.equal(configResponse.status, 200);
    assert.deepEqual(await configResponse.json(), config);

    assert.equal((await fetch(new URL('/api/unknown', client.origin))).status, 404);
    assert.equal((await fetch(new URL('/styles.css', client.origin), { method: 'POST' })).status, 405);
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

const fixtureClientConfig = {
  origins: { authority: 'http://authority.example', policy: 'http://policy.example', simulation: 'http://simulation.example' },
  actors: { registry: 'https://authority.example/registry', home: 'https://authority.example/home', player: 'https://authority.example/player', policy: 'https://policy.example/actor', simulation: 'https://simulation.example/actor' }
};

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
  origin: 'http://first.test:4200',
  homeActorId: firstAccount.homeAuthority!,
  accounts: [firstLoginAccount]
};

const secondHome: FixtureHome = {
  origin: 'http://second.test:4200',
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
  const client = await startClientServer({ port: 0, config: fixtureClientConfig, application });
  return { application, client };
}

async function readAccounts(origin: string): Promise<{ accounts: PublicAccountRecord[] }> {
  const response = await fetch(new URL('/api/accounts', origin));
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
      fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: firstLoginAccount.handle, password: firstLoginAccount.password, homeOrigin: firstHome.origin }) }),
      fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: secondLoginAccount.handle, password: secondLoginAccount.password, homeOrigin: secondHome.origin }) })
    ]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    const firstBody = await firstResponse.json() as { account: PublicAccountRecord; status: string };
    const secondBody = await secondResponse.json() as { account: PublicAccountRecord; status: string };
    assert.equal(firstBody.status, 'signed-in');
    assert.equal(secondBody.status, 'signed-in');
    assert.equal(firstBody.account.handle, firstLoginAccount.handle);
    assert.equal(secondBody.account.handle, secondLoginAccount.handle);
    assert.equal(firstBody.account.login.status, 'signed-in');
    assert.equal(secondBody.account.login.status, 'signed-in');
    assert.notEqual(firstBody.account.id, secondBody.account.id);
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

    const listed = await readAccounts(opened.client.origin);
    assert.deepEqual(listed.accounts.map((account) => account.id).sort(), [firstBody.account.id, secondBody.account.id].sort());
    assert.equal(listed.accounts.every((account) => account.login.status === 'signed-in'), true);

    const firstId = firstBody.account.id;
    const secondId = secondBody.account.id;
    await opened.client.close();
    await opened.application.close();
    opened = await openFixtureApplication(storeFile, fixture.fetch);
    const reopened = await readAccounts(opened.client.origin);
    assert.deepEqual(reopened.accounts.map((account) => account.id).sort(), [firstId, secondId].sort());
    assert.equal(reopened.accounts.every((account) => account.login.status === 'signed-in'), true);

    const logoutResponse = await fetch(new URL(`/api/accounts/${encodeURIComponent(firstId)}/logout`, opened.client.origin), { method: 'POST' });
    assert.equal(logoutResponse.status, 200);
    const logoutBody = await logoutResponse.json() as { account: PublicAccountRecord };
    assert.equal(logoutBody.account.id, firstId);
    assert.equal(logoutBody.account.handle, firstLoginAccount.handle);
    assert.equal(logoutBody.account.login.status, 'signed-out');
    assert.equal(JSON.stringify(logoutBody).includes(firstLoginAccount.nativeToken), false);
    const afterLogout = await readAccounts(opened.client.origin);
    assert.equal(afterLogout.accounts.find((account) => account.id === firstId)?.login.status, 'signed-out');
    assert.equal(afterLogout.accounts.find((account) => account.id === secondId)?.login.status, 'signed-in');
    assert.equal(afterLogout.accounts.some((account) => account.handle === firstLoginAccount.handle), true);
    assert.equal(afterLogout.accounts.some((account) => account.handle === secondLoginAccount.handle), true);
  } finally {
    await opened.client.close();
    await opened.application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejected and unavailable logins return client errors without retaining signed-in tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-login-errors-'));
  const storeFile = join(directory, 'client.store.json');
  const blocked: FixtureHomeAccount = { handle: '@blocked@blocked.test', actorId: 'http://blocked.test/actors/blocked', password: 'blocked-password', nativeToken: 'blocked-native-token', unavailable: true };
  const home = fixtureHomes()[0]!;
  const fixture = createFixtureFetch([home, { origin: 'http://blocked.test', homeActorId: 'http://blocked.test/actors/home', accounts: [blocked] }], []);
  const opened = await openFixtureApplication(storeFile, fixture.fetch);
  try {
    const rejectedResponse = await fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: firstLoginAccount.handle, password: 'wrong-password', homeOrigin: home.origin }) });
    assert.ok(rejectedResponse.status >= 400 && rejectedResponse.status < 500);
    const rejectedBody = await rejectedResponse.json() as { account?: PublicAccountRecord; status?: string };
    assert.equal(rejectedBody.status, 'rejected');
    assert.notEqual(rejectedBody.account?.login.status, 'signed-in');
    assert.equal(JSON.stringify(rejectedBody).includes(firstLoginAccount.nativeToken), false);
    assert.equal(JSON.stringify(rejectedBody).includes('wrong-password'), false);

    const unavailableResponse = await fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: blocked.handle, password: blocked.password, homeOrigin: 'http://blocked.test' }) });
    assert.ok(unavailableResponse.status >= 400 && unavailableResponse.status < 500);
    const unavailableBody = await unavailableResponse.json() as { account?: PublicAccountRecord; status?: string };
    assert.equal(unavailableBody.status, 'unavailable');
    assert.notEqual(unavailableBody.account?.login.status, 'signed-in');
    assert.equal(JSON.stringify(unavailableBody).includes(blocked.nativeToken), false);

    const listed = await readAccounts(opened.client.origin);
    assert.equal(listed.accounts.some((account) => account.login.status === 'signed-in'), false);
    assert.equal(JSON.stringify(listed).includes(firstLoginAccount.nativeToken), false);
    assert.equal(JSON.stringify(listed).includes(blocked.nativeToken), false);
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
      fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: firstLoginAccount.handle, password: firstLoginAccount.password, homeOrigin: firstHome.origin }) }),
      fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: secondLoginAccount.handle, password: secondLoginAccount.password, homeOrigin: secondHome.origin }) })
    ]);
    const bodies = await Promise.all(logins.map(async (response) => { assert.equal(response.status, 200); return await response.json() as { account: PublicAccountRecord } }));
    const ids = bodies.map((body) => body.account.id).sort();

    const failure = await fetch(new URL('/api/servers', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: 'http://broken.test:4300' }) });
    assert.ok(failure.status >= 400);
    const failureText = await failure.text();
    assert.ok(failureText.length > 0 && failureText.length < 2000);
    const failureBody = bodyRecord(JSON.parse(failureText) as unknown);
    assert.equal(typeof (failureBody.error ?? failureBody.reason), 'string');
    assert.equal(failureText.includes(firstLoginAccount.nativeToken), false);
    assert.equal(failureText.includes(secondLoginAccount.nativeToken), false);

    const listed = await readAccounts(opened.client.origin);
    assert.deepEqual(listed.accounts.map((account) => account.id).sort(), ids);
    assert.equal(listed.accounts.every((account) => account.login.status === 'signed-in'), true);
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
      { handle: '@harbor.player@harbor.test:4200', actorId: 'http://harbor.test:4200/actors/player', role: 'player' }
    ]
  };
  const fixture = createFixtureFetch([], [authority]);
  let opened = await openFixtureApplication(storeFile, fixture.fetch);
  try {
    assert.deepEqual((await readAccounts(opened.client.origin)).accounts, []);
    const response = await fetch(new URL('/api/servers', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: authority.origin }) });
    assert.equal(response.status, 200);
    const body = await response.json() as { servers: ServerRecord[]; authorities: AuthorityRecord[] };
    const server = body.servers.find((candidate) => candidate.origin === authority.origin);
    assert.ok(server);
    assert.equal(server.server, authority.server);
    const registry = body.authorities.find((candidate) => candidate.actorId === authority.actors[0]!.actorId);
    const home = body.authorities.find((candidate) => candidate.actorId === authority.actors[1]!.actorId);
    assert.ok(registry);
    assert.ok(home);
    assert.equal(registry.handle, undefined, 'Actor paths do not establish a discoverable handle');
    assert.equal(home.handle, undefined, 'An unadvertised handle remains unknown');
    assert.ok(registry.roles.includes('registry'));
    assert.ok(home.roles.includes('home'));
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
    assert.deepEqual((await readAccounts(opened.client.origin)).accounts, []);
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
    const login = await fetch(new URL('/api/accounts/login', opened.client.origin), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: firstLoginAccount.handle, password: firstLoginAccount.password, homeOrigin: firstHome.origin }) });
    assert.equal(login.status, 200);
    const loginBody = await login.json() as { account: PublicAccountRecord };
    const accountId = loginBody.account.id;
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

    const accountsText = await (await fetch(new URL('/api/accounts', opened.client.origin))).text();
    const serversText = await (await fetch(new URL('/api/servers', opened.client.origin))).text();
    const configText = await (await fetch(new URL('/config.json', opened.client.origin))).text();
    for (const text of [accountsText, serversText, configText]) {
      assert.equal(text.includes('registry-administrator-secret'), false);
      assert.equal(text.includes('missing-source'), false);
    }

    const logout = await fetch(new URL(`/api/accounts/${encodeURIComponent(accountId)}/logout`, opened.client.origin), { method: 'POST' });
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
  close(): Promise<void>;
}

async function startProductionWorld(directory: string): Promise<ProductionWorld> {
  const [authorityPort, policyPort, simulationPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const origins = {
    authority: `http://127.0.0.1:${authorityPort}`,
    policy: `http://127.0.0.1:${policyPort}`,
    simulation: `http://127.0.0.1:${simulationPort}`
  };
  const adminSecret = 'task08-production-admin';
  const playerNames = ['player', 'other'];
  const authority = await createAuthorityApp({ origin: origins.authority, storeFile: join(directory, 'authority.json'), adminSecret, playerNames });
  const policy = await createPolicyApp({ origin: origins.policy, storeFile: join(directory, 'policy.json'), authorityOrigin: origins.authority, playerNames, peerOrigin: origins.simulation, adminSecret });
  const simulation = await createSimulationApp({ origin: origins.simulation, storeFile: join(directory, 'simulation.json'), authorityOrigin: origins.authority, playerNames, peerOrigin: origins.policy, adminSecret });
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
  return {
    origins, adminSecret, authority, policy, simulation, accounts, nativeTokens,
    async close() {
      await Promise.allSettled([simulation.host.close(), policy.host.close(), authority.authority.close()]);
    }
  };
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
    assert.ok([403, 404].includes(unknownAccount.status));
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
