import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import type { FctpServer } from '@fctp/server-base';
import { createClientApplication, type ClientApplication } from '../apps/client-server/src/app.js';
import { startClientServer } from '../apps/demo/src/client-server.js';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';

const ADMIN = 'client-onboarding-admin';

type AuthorityApp = Awaited<ReturnType<typeof createAuthorityApp>>;
type PolicyApp = Awaited<ReturnType<typeof createPolicyApp>>;
type SimulationApp = Awaited<ReturnType<typeof createSimulationApp>>;

interface UpstreamCall {
  url: string;
  method: string;
  authorization: string;
  cache: RequestCache | undefined;
  credentials: RequestCredentials | undefined;
  redirect: RequestRedirect | undefined;
  body?: string;
}

interface CallTracker {
  calls: UpstreamCall[];
  failUrls: Set<string>;
  failRegistrationResponse: boolean;
  reset(): void;
}

interface Sourced<T> {
  state: 'available' | 'empty' | 'stale' | 'not-retrieved' | 'unavailable';
  source: string;
  observedAt?: string;
  value?: T;
  error?: string;
}

interface InitialVesselOffer {
  available: boolean;
  registry: string;
  capacity: number;
  startingPorts: string[];
}

interface StartingPortPayload {
  id: string;
  name?: string;
  territory: string;
}

interface TerritoryPayload {
  id: string;
  role: string;
  name?: string;
}

interface StartingPort {
  portId: string;
  port: Sourced<StartingPortPayload>;
  authority?: Sourced<TerritoryPayload>;
}

interface CandidatesData {
  accountId: string;
  candidates: Array<{ id: string; name?: string; state?: string }>;
  blockers: string[];
  initialVessel?: Sourced<InitialVesselOffer>;
  startingPorts?: StartingPort[];
}

interface CandidatePage {
  context: { accountId?: string };
  data: CandidatesData;
  observations: Record<string, Sourced<unknown>>;
  actions: Array<Record<string, unknown>>;
}

interface ActionRecordShape {
  id: string;
  statusUrl: string;
  accountId: string;
  targetId: string;
  intent: { kind: string; inputs: Record<string, unknown> };
  resultReferences: Array<{ kind: string; id: string }>;
  submission: { status: string; result?: string; error?: string };
  outcome: { status: string; evidence: Array<{ source: string; observedAt: string; changes?: Record<string, unknown> }>; error?: string };
}

interface EventRecord {
  id: string;
  type: string;
  vessel?: string;
  request?: string;
  entryRequest?: string;
  territory?: string;
  port?: string;
  reason?: string;
}

interface Session {
  application: ClientApplication;
  client: Awaited<ReturnType<typeof startClientServer>>;
  close(): Promise<void>;
}

interface PolicyWorld {
  authority: AuthorityApp;
  policy: PolicyApp;
  origins: { authority: string; policy: string };
  portId: string;
  close(): Promise<void>;
}

interface SimulationWorld {
  authority: AuthorityApp;
  simulation: SimulationApp;
  origins: { authority: string; simulation: string };
  portId: string;
  close(): Promise<void>;
}

const unauthenticatedFetch: typeof fetch = globalThis.fetch.bind(globalThis);

function admission(mode: 'allowlist' | 'denylist', allowlist: string[] = [], denylist: string[] = []): Record<string, unknown> {
  return { mode, allowlist, denylist };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function adminPost(origin: string, path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, origin), {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function expectStatus(response: Response, expected: number, label: string): Promise<void> {
  if (response.status === expected) return;
  const text = await response.text();
  assert.equal(response.status, expected, `${label}: ${text}`);
}

async function adminJson<T>(origin: string, path: string): Promise<T> {
  const response = await fetch(new URL(path, origin), { headers: { Authorization: `Bearer ${ADMIN}` } });
  await expectStatus(response, 200, path);
  return await response.json() as T;
}

function createTracker(): { tracker: CallTracker; fetcher: typeof fetch } {
  const tracker: CallTracker = {
    calls: [],
    failUrls: new Set<string>(),
    failRegistrationResponse: false,
    reset() { this.calls.length = 0; }
  };
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : String(input);
    const method = init?.method ?? request?.method ?? 'GET';
    const headers = new Headers(init?.headers ?? request?.headers);
    const serialized = typeof init?.body === 'string' ? init.body : undefined;
    tracker.calls.push({
      url,
      method,
      authorization: headers.get('authorization') ?? '',
      cache: init?.cache ?? request?.cache,
      credentials: init?.credentials ?? request?.credentials,
      redirect: init?.redirect ?? request?.redirect,
      ...(serialized === undefined ? {} : { body: serialized })
    });
    if (tracker.failUrls.has(url)) throw new TypeError(`simulated public fetch failure for ${url}`);
    const response = await unauthenticatedFetch(input, init);
    if (tracker.failRegistrationResponse && method === 'POST' && new URL(url).pathname === '/local/registry/vessels') {
      throw new TypeError('simulated lost registration response');
    }
    return response;
  };
  return { tracker, fetcher };
}

async function openSession(storeFile: string, fetcher: typeof fetch): Promise<Session> {
  const application = await createClientApplication({
    storeFile,
    fetch: fetcher,
    observationTimeoutMs: 3_000,
    actionTimeoutMs: 3_000
  });
  const client = await startClientServer({ port: 0, application });
  return {
    application,
    client,
    close: async () => {
      await client.close();
      await application.close();
    }
  };
}

async function login(session: Session, handle: string, password: string): Promise<{ accountId: string; token: string; nativeToken: string; actorId: string }> {
  const response = await fetch(new URL('/api/accounts/login', session.client.origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, password })
  });
  const text = await response.text();
  assert.equal(response.status, 200, `login ${handle}: ${text}`);
  const body = JSON.parse(text) as { status: string; account: { id: string }; clientToken: string };
  assert.equal(body.status, 'signed-in');
  const account = await session.application.state.read((state) => state.accounts[body.account.id]);
  assert.ok(account && account.login.status === 'signed-in' && account.actorId, `expected a signed-in account for ${handle}`);
  return { accountId: body.account.id, token: body.clientToken, nativeToken: account.login.nativeToken, actorId: account.actorId };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function readCandidates(session: Session, accountId: string, token: string): Promise<CandidatePage> {
  const response = await fetch(new URL(`/api/logistics/vessels?accountId=${encodeURIComponent(accountId)}`, session.client.origin), {
    headers: bearer(token)
  });
  await expectStatus(response, 200, 'retained candidates');
  return await response.json() as CandidatePage;
}

async function refreshCandidates(session: Session, accountId: string, token: string): Promise<CandidatePage> {
  const response = await fetch(new URL('/api/logistics/vessels/refresh', session.client.origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(token) },
    body: JSON.stringify({ accountId })
  });
  await expectStatus(response, 200, 'refresh candidates');
  return await response.json() as CandidatePage;
}

function submitInitialVessel(session: Session, token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(new URL('/api/logistics/vessels', session.client.origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(token) },
    body: JSON.stringify(body)
  });
}

function actionOf(body: unknown): ActionRecordShape {
  assert.ok(body && typeof body === 'object' && 'action' in body, `expected an action response: ${JSON.stringify(body)}`);
  return (body as { action: ActionRecordShape }).action;
}

async function readAction(session: Session, accountId: string, token: string, actionId: string): Promise<ActionRecordShape> {
  const response = await fetch(new URL(`/api/activity/${encodeURIComponent(actionId)}?accountId=${encodeURIComponent(accountId)}`, session.client.origin), {
    headers: bearer(token)
  });
  await expectStatus(response, 200, 'read action');
  const body = await response.json() as { data: { action: ActionRecordShape } };
  return body.data.action;
}

async function checkAction(session: Session, accountId: string, token: string, actionId: string): Promise<ActionRecordShape> {
  const response = await fetch(new URL(`/api/activity/${encodeURIComponent(actionId)}/refresh`, session.client.origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(token) },
    body: JSON.stringify({ accountId })
  });
  await expectStatus(response, 200, 'check action');
  const body = await response.json() as { data: { action: ActionRecordShape } };
  return body.data.action;
}

function observationFor(page: CandidatePage, source: string): Sourced<unknown> | undefined {
  return page.observations[source] ?? Object.values(page.observations).find((observation) => observation.source === source);
}

function valueOf<T>(observation: Sourced<T> | undefined): T | undefined {
  return observation && 'value' in observation ? observation.value : undefined;
}

function registrationCalls(tracker: CallTracker): UpstreamCall[] {
  return tracker.calls.filter((call) => call.method === 'POST' && new URL(call.url).pathname === '/local/registry/vessels');
}

function stateCalls(tracker: CallTracker): UpstreamCall[] {
  return tracker.calls.filter((call) => {
    const pathname = new URL(call.url).pathname;
    return /^\/local\/registry\/(?:state|actions)$/.test(pathname);
  });
}

function tickCalls(tracker: CallTracker): UpstreamCall[] {
  return tracker.calls.filter((call) => call.method === 'POST' && new URL(call.url).pathname === '/local/territory/admin/tick');
}

function eventsOf(state: unknown, type: string): EventRecord[] {
  const events = (state as { events?: unknown }).events;
  return Array.isArray(events) ? events.filter((event): event is EventRecord => !!event && typeof event === 'object' && (event as EventRecord).type === type) : [];
}

async function settle(servers: readonly FctpServer[], rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const server of servers) {
      await server.processInbox();
      await server.processOutbox();
    }
  }
}

async function startPolicyWorld(directory: string, input: {
  playerNames: string[];
  accountPasswords: Record<string, string>;
  vesselNames: Record<string, string>;
}): Promise<PolicyWorld> {
  const policyPort = await freePort();
  const policyOrigin = `http://127.0.0.1:${policyPort}`;
  const policy = await createPolicyApp({ origin: policyOrigin, storeFile: join(directory, 'policy.store.json'), adminSecret: ADMIN });
  await policy.host.listen(policyPort, '127.0.0.1');
  const authorityPort = await freePort();
  const authorityOrigin = `http://127.0.0.1:${authorityPort}`;
  const authority = await createAuthorityApp({
    origin: authorityOrigin,
    storeFile: join(directory, 'authority.store.json'),
    adminSecret: ADMIN,
    playerNames: input.playerNames,
    accountPasswords: input.accountPasswords,
    vesselNames: input.vesselNames,
    startingPorts: [policy.ids.ports[0]!]
  });
  await authority.authority.listen(authorityPort, '127.0.0.1');
  const configured = await adminPost(policyOrigin, '/local/territory/admin/admission', {
    vesselBuildingRegistry: admission('allowlist', [authority.ids.actor.registry])
  });
  assert.equal(configured.status, 200);
  return {
    authority,
    policy,
    origins: { authority: authorityOrigin, policy: policyOrigin },
    portId: policy.ids.ports[0]!,
    close: async () => {
      const results = await Promise.allSettled([authority.authority.close(), policy.host.close()]);
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, 'fixture failed to close');
    }
  };
}

async function startSimulationWorld(directory: string, input: {
  playerNames: string[];
  accountPasswords: Record<string, string>;
  vesselNames?: Record<string, string>;
}): Promise<SimulationWorld> {
  const simulationPort = await freePort();
  const simulationOrigin = `http://127.0.0.1:${simulationPort}`;
  const simulation = await createSimulationApp({
    origin: simulationOrigin,
    storeFile: join(directory, 'simulation.store.json'),
    peerOrigin: 'https://peer.example',
    adminSecret: ADMIN
  });
  await simulation.host.listen(simulationPort, '127.0.0.1');
  const authorityPort = await freePort();
  const authorityOrigin = `http://127.0.0.1:${authorityPort}`;
  const authority = await createAuthorityApp({
    origin: authorityOrigin,
    storeFile: join(directory, 'authority.store.json'),
    adminSecret: ADMIN,
    playerNames: input.playerNames,
    accountPasswords: input.accountPasswords,
    vesselNames: input.vesselNames ?? {},
    startingPorts: [simulation.ids.ports[0]!]
  });
  await authority.authority.listen(authorityPort, '127.0.0.1');
  return {
    authority,
    simulation,
    origins: { authority: authorityOrigin, simulation: simulationOrigin },
    portId: simulation.ids.ports[0]!,
    close: async () => {
      const results = await Promise.allSettled([authority.authority.close(), simulation.host.close()]);
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, 'fixture failed to close');
    }
  };
}

test('retained reads expose no initial-vessel eligibility, explicit refresh observes the Home offer and public recommendations, and partial failures stay honest', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-onboarding-refresh-'));
  const world = await startPolicyWorld(directory, {
    playerNames: ['alice', 'bob'],
    accountPasswords: { alice: 'alice-password', bob: 'bob-password' },
    vesselNames: {}
  });
  const { tracker, fetcher } = createTracker();
  let session: Session | undefined;
  try {
    session = await openSession(join(directory, 'client.store.json'), fetcher);
    const host = new URL(world.origins.authority).host;
    const alice = await login(session, `@alice@${host}`, 'alice-password');
    tracker.reset();

    const retained = await readCandidates(session, alice.accountId, alice.token);
    assert.ok(retained.data.initialVessel === undefined || retained.data.initialVessel.state === 'not-retrieved', 'a retained read must not claim a current initial-vessel offer');
    assert.equal(valueOf(retained.data.initialVessel)?.available, undefined, 'a retained read must not claim eligibility');
    assert.deepEqual(retained.data.candidates, []);
    assert.equal(tracker.calls.length, 0, 'a retained read must perform no world IO');

    const homeSource = new URL('/local/home/vessels', world.origins.authority).href;
    const refreshed = await refreshCandidates(session, alice.accountId, alice.token);
    const offerObservation = refreshed.data.initialVessel;
    assert.ok(offerObservation, 'explicit refresh must expose the Home initial-vessel observation');
    assert.equal(offerObservation.state, 'available');
    assert.equal(offerObservation.source, homeSource);
    assert.equal(typeof offerObservation.observedAt, 'string');
    const offer = valueOf(offerObservation);
    assert.deepEqual(offer, {
      available: true,
      registry: world.authority.ids.actor.registry,
      capacity: 100,
      startingPorts: [world.portId]
    });
    assert.equal(observationFor(refreshed, homeSource)?.state, 'available', 'the Home observation is exposed in the page observations');

    const ports = refreshed.data.startingPorts;
    assert.ok(ports && ports.length === 1, 'refresh must expose the recommended starting Port');
    const east = ports[0]!;
    assert.equal(east.portId, world.portId);
    assert.equal(east.port.state, 'available');
    assert.equal(east.port.source, world.portId);
    assert.equal(valueOf(east.port)?.id, world.portId);
    assert.equal(valueOf(east.port)?.name, 'East Haven');
    assert.equal(valueOf(east.port)?.territory, world.policy.ids.actor);
    assert.equal(east.authority?.state, 'available');
    assert.equal(east.authority.source, world.policy.ids.actor);
    assert.equal(valueOf(east.authority)?.id, world.policy.ids.actor);
    assert.equal(valueOf(east.authority)?.role, 'territory');
    assert.equal(observationFor(refreshed, world.portId)?.state, 'available');
    assert.equal(observationFor(refreshed, world.policy.ids.actor)?.state, 'available');

    const homeCalls = tracker.calls.filter((call) => call.url === homeSource);
    assert.equal(homeCalls.length, 1, 'refresh reads the Home listing once');
    assert.equal(homeCalls[0]?.method, 'GET');
    assert.equal(homeCalls[0]?.authorization, `Bearer ${alice.nativeToken}`);
    const portCalls = tracker.calls.filter((call) => call.url === world.portId);
    const authorityCalls = tracker.calls.filter((call) => call.url === world.policy.ids.actor);
    assert.equal(portCalls.length, 1, 'refresh resolves the exact recommended Port once');
    assert.ok(authorityCalls.length >= 1, 'refresh resolves the responsible Territory Actor; normal response identity enrichment may also read it');
    assert.equal(portCalls[0]?.authorization, '', 'public Port resolution must be credential-free');
    assert.equal(authorityCalls[0]?.authorization, '', 'public Actor resolution must be credential-free');
    for (const call of [...portCalls, ...authorityCalls]) {
      assert.equal(call.authorization, '', 'public resolution and identity enrichment must not forward credentials');
    }
    for (const calls of [portCalls, authorityCalls]) {
      assert.ok(calls.some((call) => call.cache === 'no-store' && call.credentials === 'omit' && call.redirect === 'error'), 'recommendation resolution is credential-free and rejects redirects independently of normal identity enrichment');
    }
    assert.equal(tracker.calls.some((call) => call.authorization === `Bearer ${alice.nativeToken}` && call.url !== homeSource), false, 'the native token is sent only to the exact Home listing');

    const directoryResponse = await fetch(new URL('/api/servers', session.client.origin));
    assert.equal(directoryResponse.status, 200);
    const directoryPage = await directoryResponse.json() as { authorities: Array<{ actorId: string; roles: string[] }> };
    const remembered = directoryPage.authorities.find((authority) => authority.actorId === world.policy.ids.actor);
    assert.ok(remembered, 'refresh remembers the resolved Territory Actor in the shared directory');
    assert.deepEqual(remembered.roles, ['territory']);

    tracker.reset();
    const again = await readCandidates(session, alice.accountId, alice.token);
    assert.deepEqual(valueOf(again.data.initialVessel), offer, 'retained reads keep the observed offer');
    assert.equal(again.data.startingPorts?.length, 1);
    assert.equal(tracker.calls.length, 0, 'retained reads after refresh perform no world IO');

    tracker.failUrls.add(world.policy.ids.actor);
    const actorFailure = await refreshCandidates(session, alice.accountId, alice.token);
    assert.deepEqual(valueOf(actorFailure.data.initialVessel), offer, 'a failed Actor fetch must not erase the Home offer');
    assert.equal(actorFailure.data.startingPorts?.[0]?.port.state, 'available', 'the Port recommendation stays current when the Actor fetch fails');
    assert.equal(valueOf(actorFailure.data.startingPorts?.[0]?.port)?.id, world.portId);
    assert.equal(actorFailure.data.startingPorts?.[0]?.authority?.state, 'stale');
    assert.equal(valueOf(actorFailure.data.startingPorts?.[0]?.authority)?.id, world.policy.ids.actor);
    assert.equal(typeof actorFailure.data.startingPorts?.[0]?.authority?.error, 'string');
    assert.equal(observationFor(actorFailure, world.policy.ids.actor)?.state, 'stale', 'the failed Actor observation retains its prior value as stale');

    tracker.failUrls.delete(world.policy.ids.actor);
    tracker.failUrls.add(world.portId);
    const portFailure = await refreshCandidates(session, alice.accountId, alice.token);
    assert.deepEqual(valueOf(portFailure.data.initialVessel), offer, 'a failed Port fetch must not erase the Home offer');
    assert.equal(portFailure.data.startingPorts?.[0]?.port.state, 'stale', 'the failed Port observation retains its prior value as stale');
    assert.equal(valueOf(portFailure.data.startingPorts?.[0]?.port)?.id, world.portId);
    assert.equal(typeof portFailure.data.startingPorts?.[0]?.port.error, 'string');
    assert.equal(portFailure.data.startingPorts?.[0]?.authority?.state, 'available', 'the Actor recommendation stays current when the Port fetch fails');

    tracker.failUrls.delete(world.portId);
    tracker.failUrls.add(homeSource);
    const homeFailure = await refreshCandidates(session, alice.accountId, alice.token);
    assert.equal(homeFailure.data.initialVessel?.state, 'stale', 'the offer inherits Home listing failure rather than retaining a separate current copy');
    assert.deepEqual(valueOf(homeFailure.data.initialVessel), offer);
    assert.equal(typeof homeFailure.data.initialVessel?.error, 'string');
    tracker.failUrls.delete(homeSource);

    tracker.reset();
    const bob = await login(session, `@bob@${host}`, 'bob-password');
    tracker.reset();
    const bobRetained = await readCandidates(session, bob.accountId, bob.token);
    assert.equal(valueOf(bobRetained.data.initialVessel)?.available, undefined, 'another account cannot see a retained offer before its own refresh');
    assert.deepEqual(bobRetained.data.candidates, []);
    assert.equal(tracker.calls.length, 0, 'another account retained read performs no world IO');

    const crossAccount = await fetch(new URL(`/api/logistics/vessels?accountId=${encodeURIComponent(alice.accountId)}`, session.client.origin), { headers: bearer(bob.token) });
    assert.equal(crossAccount.status, 403, 'another client session cannot read the first account scope');
    assert.equal(tracker.calls.length, 0, 'cross-account scope rejection precedes world IO');

    const bobRefreshed = await refreshCandidates(session, bob.accountId, bob.token);
    assert.equal(valueOf(bobRefreshed.data.initialVessel)?.available, true, 'each account refresh owns its own offer');
    assert.deepEqual(bobRefreshed.data.candidates, [], 'another account does not inherit the first account vessels');
  } finally {
    await session?.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a fresh account registers the recommended port through the application and an explicit Check observes the correlated berth', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-onboarding-register-'));
  const world = await startPolicyWorld(directory, {
    playerNames: ['alice', 'bob'],
    accountPasswords: { alice: 'alice-password', bob: 'bob-password' },
    vesselNames: { bob: 'bob-vessel' }
  });
  const { tracker, fetcher } = createTracker();
  let session: Session | undefined;
  try {
    session = await openSession(join(directory, 'client.store.json'), fetcher);
    const host = new URL(world.origins.authority).host;
    const alice = await login(session, `@alice@${host}`, 'alice-password');
    await refreshCandidates(session, alice.accountId, alice.token);
    tracker.reset();

    const invalid: Array<{ label: string; body: Record<string, unknown> }> = [
      { label: 'override fields', body: { accountId: alice.accountId, vesselId: 'swift', name: 'Swift', portId: world.portId, registry: 'https://evil.example/actors/registry', possessor: 'https://evil.example/actors/player', capacity: 9999 } },
      { label: 'absolute local id', body: { accountId: alice.accountId, vesselId: 'https://evil.example/objects/vessels/swift', name: 'Swift', portId: world.portId } },
      { label: 'malformed local id', body: { accountId: alice.accountId, vesselId: '../swift', name: 'Swift', portId: world.portId } },
      { label: 'blank name', body: { accountId: alice.accountId, vesselId: 'swift', name: '   ', portId: world.portId } },
      { label: 'missing name', body: { accountId: alice.accountId, vesselId: 'swift', portId: world.portId } },
      { label: 'missing port', body: { accountId: alice.accountId, vesselId: 'swift', name: 'Swift' } },
      { label: 'nonrecommended port', body: { accountId: alice.accountId, vesselId: 'swift', name: 'Swift', portId: world.policy.ids.ports[1] } },
      { label: 'caller registry input', body: { accountId: alice.accountId, vesselId: 'swift', name: 'Swift', portId: world.portId, registryId: 'https://evil.example/actors/registry' } }
    ];
    for (const attempt of invalid) {
      const before = registrationCalls(tracker).length;
      const response = await submitInitialVessel(session, alice.token, attempt.body);
      if (response.status >= 200 && response.status < 300) {
        const action = actionOf(await response.json());
        assert.equal(action.submission.status, 'rejected', `${attempt.label}: expected a rejected action, got ${action.submission.status}`);
      } else {
        assert.ok(response.status >= 400 && response.status < 500, `${attempt.label}: expected a client error, got ${response.status}`);
      }
      assert.equal(registrationCalls(tracker).length, before, `${attempt.label}: registration must not be sent`);
    }

    const crossBefore = registrationCalls(tracker).length;
    const crossScope = await submitInitialVessel(session, alice.token, {
      accountId: world.authority.ids.players.bob,
      vesselId: 'swift',
      name: 'Swift',
      portId: world.portId
    });
    assert.equal(crossScope.status, 403, 'a client session cannot submit for a foreign account scope');
    assert.equal(registrationCalls(tracker).length, crossBefore, 'foreign account scope rejection precedes registration');

    const bob = await login(session, `@bob@${host}`, 'bob-password');
    const bobRefreshed = await refreshCandidates(session, bob.accountId, bob.token);
    assert.equal(valueOf(bobRefreshed.data.initialVessel)?.available, false, 'an existing fleet has no available initial-vessel offer');
    const bobBefore = registrationCalls(tracker).length;
    const bobSubmit = await submitInitialVessel(session, bob.token, { accountId: bob.accountId, vesselId: 'second-bob', name: 'Second Bob', portId: world.portId });
    if (bobSubmit.status === 200) {
      const bobAction = actionOf(await bobSubmit.json());
      assert.equal(bobAction.submission.status, 'rejected', 'an existing fleet cannot receive another initial vessel');
    } else {
      assert.ok(bobSubmit.status >= 400 && bobSubmit.status < 500, `an existing fleet rejection must be a client error, got ${bobSubmit.status}`);
    }
    assert.equal(registrationCalls(tracker).length, bobBefore, 'an existing fleet rejection precedes registration');

    tracker.reset();
    const response = await submitInitialVessel(session, alice.token, { accountId: alice.accountId, vesselId: 'swift', name: 'Swift', portId: world.portId });
    const responseText = await response.text();
    assert.equal(response.status, 200, `initial-vessel submission: ${responseText}`);
    assert.equal(responseText.includes(alice.nativeToken), false, 'the native token must not appear in returned data');
    assert.equal(responseText.includes(alice.token), false, 'the caller client session token must not appear in returned data');
    const action = actionOf(JSON.parse(responseText));
    assert.equal(action.intent.kind, 'initial-vessel');
    assert.equal(action.intent.inputs.localId, 'swift');
    assert.equal(action.intent.inputs.name, 'Swift');
    assert.equal(action.intent.inputs.portId, world.portId);
    assert.equal(action.intent.inputs.registryId, world.authority.ids.actor.registry);
    assert.equal(Object.hasOwn(action.intent.inputs, 'vesselId'), false, 'the persisted intent must not label the local ID as vesselId');
    assert.equal(action.targetId, world.authority.ids.actor.registry);
    assert.equal(action.submission.status, 'accepted');
    assert.equal(action.outcome.status, 'pending');
    const vesselId = `${world.origins.authority}/objects/vessels/swift`;
    const resourceReference = action.resultReferences.find((reference) => reference.kind === 'resource');
    const requestReference = action.resultReferences.find((reference) => reference.kind === 'request');
    assert.equal(resourceReference?.id, vesselId, 'the accepted action retains the actual resource reference');
    assert.ok(requestReference, 'the accepted action retains the creation request reference');
    assert.match(requestReference.id, new RegExp(`^${world.origins.authority.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/objects/vessel-creation-requests/`));

    const registrations = registrationCalls(tracker);
    assert.equal(registrations.length, 1, 'the application sends one registration to the guarded Home origin');
    assert.equal(registrations[0]?.url, `${world.origins.authority}/local/registry/vessels`);
    assert.equal(registrations[0]?.authorization, `Bearer ${alice.nativeToken}`);
    assert.deepEqual(JSON.parse(registrations[0]?.body ?? '{}'), { id: 'swift', name: 'Swift', port: world.portId });
    assert.equal(stateCalls(tracker).length, 0, 'accepting the submission does not read back Registry state');

    const beforeDelivery = await world.authority.registry.state(vesselId);
    assert.equal(eventsOf(beforeDelivery, 'BerthingEvent').length, 0, 'the acceptance does not berth the vessel');
    assert.deepEqual((beforeDelivery.requests as Record<string, { type: string }>)[requestReference.id]?.type, 'VesselCreationRequest');

    await settle([world.authority.authority.server, world.policy.host.server]);
    const landed = await world.authority.registry.state(vesselId);
    const berthing = eventsOf(landed, 'BerthingEvent').find((event) => event.request === requestReference.id);
    assert.ok(berthing, 'the drained signed creation produces the correlated BerthingEvent');
    assert.equal(berthing.vessel, vesselId);
    assert.equal(berthing.port, world.portId);
    assert.equal(berthing.territory, world.policy.ids.actor);
    assert.equal(eventsOf(landed, 'EntryRejected').some((event) => event.request === requestReference.id), false);
    const visit = (await world.policy.territory.ledger).visits[vesselId];
    assert.ok(visit, 'the actual Policy visit is retained');
    assert.equal(visit.port, world.portId);

    const stillPending = await readAction(session, alice.accountId, alice.token, action.id);
    assert.equal(stillPending.outcome.status, 'pending', 'delivery does not reconcile the application action automatically');

    tracker.reset();
    const checked = await checkAction(session, alice.accountId, alice.token, action.id);
    assert.equal(checked.outcome.status, 'completed');
    assert.ok(checked.outcome.evidence.length > 0);
    const berthEvidence = checked.outcome.evidence.find((evidence) => {
      const event = evidence.changes?.event as EventRecord | undefined;
      return event?.type === 'BerthingEvent' && event.request === requestReference.id;
    });
    assert.ok(berthEvidence, 'the explicit Check proves the exact correlated BerthingEvent');
    assert.equal(registrationCalls(tracker).length, 0, 'Check does not resend registration');

    tracker.reset();
    const afterAllocation = await readCandidates(session, alice.accountId, alice.token);
    assert.notEqual(valueOf(afterAllocation.data.initialVessel)?.available, true, 'the retained offer no longer claims eligibility after a known allocation');
    assert.equal(tracker.calls.length, 0, 'the known allocation update uses retained data without a speculative refresh');

    const secondBefore = registrationCalls(tracker).length;
    const second = await submitInitialVessel(session, alice.token, { accountId: alice.accountId, vesselId: 'swift-two', name: 'Swift Two', portId: world.portId });
    if (second.status === 200) {
      const secondAction = actionOf(await second.json());
      assert.equal(secondAction.submission.status, 'rejected', 'a second initial vessel is refused');
    } else {
      assert.ok(second.status >= 400 && second.status < 500, `a second initial vessel must be a client error, got ${second.status}`);
    }
    assert.equal(registrationCalls(tracker).length, secondBefore, 'a second initial vessel is refused before registration');
  } finally {
    await session?.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a manually reviewed simulation landing stays pending through approval and unrelated events until an explicit tick', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-onboarding-sim-manual-'));
  const world = await startSimulationWorld(directory, {
    playerNames: ['alice'],
    accountPasswords: { alice: 'alice-password' }
  });
  const { tracker, fetcher } = createTracker();
  let session: Session | undefined;
  try {
    session = await openSession(join(directory, 'client.store.json'), fetcher);
    const host = new URL(world.origins.authority).host;
    const alice = await login(session, `@alice@${host}`, 'alice-password');
    await refreshCandidates(session, alice.accountId, alice.token);

    const configured = await adminPost(world.origins.simulation, '/local/territory/admin/admission', {
      reviewMode: 'manual',
      vesselBuildingRegistry: admission('allowlist', [world.authority.ids.actor.registry]),
      trustedRegistry: admission('allowlist', [])
    });
    assert.equal(configured.status, 200);

    tracker.reset();
    const response = await submitInitialVessel(session, alice.token, { accountId: alice.accountId, vesselId: 'swift', name: 'Swift', portId: world.portId });
    const text = await response.text();
    assert.equal(response.status, 200, `simulation initial-vessel submission: ${text}`);
    const action = actionOf(JSON.parse(text));
    const requestReference = action.resultReferences.find((reference) => reference.kind === 'request');
    assert.ok(requestReference, 'the accepted action retains the creation request reference');
    const vesselId = `${world.origins.authority}/objects/vessels/swift`;

    await settle([world.authority.authority.server, world.simulation.host.server]);
    let pending = await checkAction(session, alice.accountId, alice.token, action.id);
    assert.equal(pending.outcome.status, 'pending', 'a manually reviewed landing is still pending after signed delivery');
    assert.equal(eventsOf(await world.authority.registry.state(vesselId), 'BerthingEvent').length, 0);
    assert.equal(tickCalls(tracker).length, 0, 'Check never ticks the simulation');

    const changed = await adminPost(world.origins.simulation, '/local/territory/admin/admission', {
      reviewMode: 'automatic',
      vesselBuildingRegistry: admission('allowlist', [world.authority.ids.actor.registry]),
      trustedRegistry: admission('allowlist', [])
    });
    assert.equal(changed.status, 200);
    const unrelated = await adminPost(world.origins.authority, '/local/registry/entry', {
      vessel: vesselId,
      territory: world.simulation.ids.actor,
      port: world.portId,
      route: world.simulation.ids.routes[0]
    });
    await expectStatus(unrelated, 202, 'unrelated Registry entry');
    const unrelatedRequest = (await unrelated.json() as { id: string }).id;
    await settle([world.authority.authority.server, world.simulation.host.server]);
    const withUnrelated = await world.authority.registry.state(vesselId);
    assert.ok(eventsOf(withUnrelated, 'EntryRejected').some((event) => event.request === unrelatedRequest), 'the unrelated request is rejected by exact evidence');
    pending = await checkAction(session, alice.accountId, alice.token, action.id);
    assert.equal(pending.outcome.status, 'pending', 'an unrelated EntryRejected cannot fail the initial-vessel action');

    const requests = await adminJson<{ requests: Array<{ requestId: string; status: string }> }>(world.origins.simulation, '/local/territory/admin/entry-requests');
    assert.equal(requests.requests.find((request) => request.requestId === requestReference.id)?.status, 'pending');
    const approved = await adminPost(world.origins.simulation, `/local/territory/admin/entry-requests/${encodeURIComponent(requestReference.id)}/approve`, {});
    assert.equal(approved.status, 200);
    await settle([world.simulation.host.server, world.authority.authority.server]);
    pending = await checkAction(session, alice.accountId, alice.token, action.id);
    assert.equal(pending.outcome.status, 'pending', 'approval alone does not berth the vessel before a tick');
    assert.equal(eventsOf(await world.authority.registry.state(vesselId), 'BerthingEvent').length, 0);
    assert.equal(tickCalls(tracker).length, 0, 'Check never ticks the simulation');

    const tick = await adminPost(world.origins.simulation, '/local/territory/admin/tick', {});
    assert.equal(tick.status, 200);
    await settle([world.simulation.host.server, world.authority.authority.server]);
    const completed = await checkAction(session, alice.accountId, alice.token, action.id);
    assert.equal(completed.outcome.status, 'completed', 'the explicit tick makes the correlated berth observable');
    const berth = eventsOf(await world.authority.registry.state(vesselId), 'BerthingEvent').find((event) => event.request === requestReference.id);
    assert.ok(berth, 'the Registry receives the correlated BerthingEvent after the tick');
    assert.equal(berth.port, world.portId);
    assert.equal(registrationCalls(tracker).length, 1, 'the action never resends registration');
    assert.equal(tickCalls(tracker).length, 0, 'the application never ticks the simulation');
  } finally {
    await session?.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a rejected building admission fails the initial-vessel action only after the exact EntryRejected', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-onboarding-sim-reject-'));
  const world = await startSimulationWorld(directory, {
    playerNames: ['alice'],
    accountPasswords: { alice: 'alice-password' }
  });
  const { tracker, fetcher } = createTracker();
  let session: Session | undefined;
  try {
    session = await openSession(join(directory, 'client.store.json'), fetcher);
    const host = new URL(world.origins.authority).host;
    const alice = await login(session, `@alice@${host}`, 'alice-password');
    await refreshCandidates(session, alice.accountId, alice.token);

    const denied = await adminPost(world.origins.simulation, '/local/territory/admin/admission', {
      reviewMode: 'automatic',
      vesselBuildingRegistry: admission('allowlist', []),
      trustedRegistry: admission('allowlist', [])
    });
    assert.equal(denied.status, 200);

    tracker.reset();
    const response = await submitInitialVessel(session, alice.token, { accountId: alice.accountId, vesselId: 'swift', name: 'Swift', portId: world.portId });
    const text = await response.text();
    assert.equal(response.status, 200, `simulation initial-vessel submission: ${text}`);
    const action = actionOf(JSON.parse(text));
    const requestReference = action.resultReferences.find((reference) => reference.kind === 'request');
    assert.ok(requestReference);

    await world.authority.authority.server.processOutbox();
    const pending = await checkAction(session, alice.accountId, alice.token, action.id);
    assert.equal(pending.outcome.status, 'pending', 'no rejection is invented before the Territory decides');

    await world.simulation.host.server.processInbox();
    await world.simulation.host.server.processOutbox();
    await world.authority.authority.server.processInbox();
    const rejected = await checkAction(session, alice.accountId, alice.token, action.id);
    assert.equal(rejected.outcome.status, 'failed', 'the exact EntryRejected fails the action');
    const rejection = rejected.outcome.evidence.find((evidence) => {
      const event = evidence.changes?.event as EventRecord | undefined;
      return event?.type === 'EntryRejected' && event.request === requestReference.id;
    });
    assert.ok(rejection, 'failure is proven by the correlated EntryRejected');
    assert.equal(eventsOf(await world.authority.registry.state(`${world.origins.authority}/objects/vessels/swift`), 'EntryRejected').some((event) => event.request === requestReference.id), true);
    assert.equal(registrationCalls(tracker).length, 1, 'a failed allocation never exposes a retry or reallocation');
    assert.equal(tickCalls(tracker).length, 0);
  } finally {
    await session?.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an accepted initial-vessel action survives an application restart without resending registration', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-onboarding-restart-'));
  const world = await startPolicyWorld(directory, {
    playerNames: ['alice'],
    accountPasswords: { alice: 'alice-password' },
    vesselNames: {}
  });
  const { tracker, fetcher } = createTracker();
  const storeFile = join(directory, 'client.store.json');
  let first: Session | undefined;
  let second: Session | undefined;
  try {
    first = await openSession(storeFile, fetcher);
    const host = new URL(world.origins.authority).host;
    const alice = await login(first, `@alice@${host}`, 'alice-password');
    await refreshCandidates(first, alice.accountId, alice.token);
    tracker.reset();
    const response = await submitInitialVessel(first, alice.token, { accountId: alice.accountId, vesselId: 'swift', name: 'Swift', portId: world.portId });
    const text = await response.text();
    assert.equal(response.status, 200, `initial-vessel submission: ${text}`);
    const action = actionOf(JSON.parse(text));
    assert.equal(action.submission.status, 'accepted');
    const requestReference = action.resultReferences.find((reference) => reference.kind === 'request');
    assert.ok(requestReference);
    assert.equal(registrationCalls(tracker).length, 1);

    await first.close();
    first = undefined;
    second = await openSession(storeFile, fetcher);
    tracker.reset();

    const retained = await readAction(second, alice.accountId, alice.token, action.id);
    assert.equal(retained.submission.status, 'accepted');
    assert.equal(retained.outcome.status, 'pending');
    assert.equal(tracker.calls.length, 0, 'a retained action read does not reconcile');
    await readCandidates(second, alice.accountId, alice.token);
    assert.equal(tracker.calls.length, 0, 'a retained candidate read after restart performs no world IO');

    const pending = await checkAction(second, alice.accountId, alice.token, action.id);
    assert.equal(pending.outcome.status, 'pending', 'the retained creation request is still pending before delivery');
    assert.equal(registrationCalls(tracker).length, 0, 'explicit Check cannot resend registration');

    await settle([world.authority.authority.server, world.policy.host.server]);
    const completed = await checkAction(second, alice.accountId, alice.token, action.id);
    assert.equal(completed.outcome.status, 'completed');
    assert.ok(completed.outcome.evidence.some((evidence) => {
      const event = evidence.changes?.event as EventRecord | undefined;
      return event?.type === 'BerthingEvent' && event.request === requestReference.id;
    }));
    assert.equal(registrationCalls(tracker).length, 0, 'reconciliation uses the retained references and never reallocates');
  } finally {
    await first?.close();
    await second?.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a lost registration response remains unverified across restart and repeated Checks never allocate by guessed ID', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-onboarding-lost-'));
  const world = await startPolicyWorld(directory, {
    playerNames: ['alice'],
    accountPasswords: { alice: 'alice-password' },
    vesselNames: {}
  });
  const { tracker, fetcher } = createTracker();
  const storeFile = join(directory, 'client.store.json');
  let first: Session | undefined;
  let second: Session | undefined;
  try {
    first = await openSession(storeFile, fetcher);
    const host = new URL(world.origins.authority).host;
    const alice = await login(first, `@alice@${host}`, 'alice-password');
    await refreshCandidates(first, alice.accountId, alice.token);
    tracker.reset();
    tracker.failRegistrationResponse = true;
    const response = await submitInitialVessel(first, alice.token, { accountId: alice.accountId, vesselId: 'swift', name: 'Swift', portId: world.portId });
    const text = await response.text();
    assert.equal(response.status, 200, `lost registration submission: ${text}`);
    const action = actionOf(JSON.parse(text));
    assert.equal(action.submission.status, 'unverified', 'a lost response cannot claim the registration was accepted');
    assert.equal(action.outcome.status, 'unverified');
    assert.deepEqual(action.resultReferences, [], 'a lost response retains no guessed references');
    assert.equal(registrationCalls(tracker).length, 1);

    const vesselId = `${world.origins.authority}/objects/vessels/swift`;
    assert.equal((await world.authority.registry.owned(alice.actorId)).length, 1, 'the real Registry effect happened despite the lost response');
    tracker.failRegistrationResponse = false;

    await first.close();
    first = undefined;
    second = await openSession(storeFile, fetcher);
    tracker.reset();

    const retained = await readAction(second, alice.accountId, alice.token, action.id);
    assert.equal(retained.outcome.status, 'unverified');
    assert.deepEqual(retained.resultReferences, []);
    assert.equal(tracker.calls.length, 0, 'restart retained read does not infer a reference');

    await settle([world.authority.authority.server, world.policy.host.server]);
    const state = await world.authority.registry.state(vesselId);
    assert.equal(eventsOf(state, 'BerthingEvent').length, 1, 'the retained vessel is actually berthed');

    const firstCheck = await checkAction(second, alice.accountId, alice.token, action.id);
    assert.equal(firstCheck.outcome.status, 'unverified', 'the missing reference cannot be guessed from the local ID');
    const secondCheck = await checkAction(second, alice.accountId, alice.token, action.id);
    assert.equal(secondCheck.outcome.status, 'unverified');
    assert.equal(registrationCalls(tracker).length, 0, 'repeated Checks send no allocation after restart');
    assert.equal((await world.authority.registry.owned(alice.actorId)).length, 1, 'no second vessel is allocated');
  } finally {
    await first?.close();
    await second?.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent same-account registration leaves exactly one real initial vessel', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-onboarding-concurrent-'));
  const world = await startPolicyWorld(directory, {
    playerNames: ['alice'],
    accountPasswords: { alice: 'alice-password' },
    vesselNames: {}
  });
  const { tracker, fetcher } = createTracker();
  let session: Session | undefined;
  try {
    session = await openSession(join(directory, 'client.store.json'), fetcher);
    const host = new URL(world.origins.authority).host;
    const alice = await login(session, `@alice@${host}`, 'alice-password');
    await refreshCandidates(session, alice.accountId, alice.token);
    tracker.reset();

    const body = { accountId: alice.accountId, vesselId: 'swift', name: 'Swift', portId: world.portId };
    const responses = await Promise.all([
      submitInitialVessel(session, alice.token, body),
      submitInitialVessel(session, alice.token, body)
    ]);
    const bodies = await Promise.all(responses.map(async (response) => response.status === 200 ? await response.json() : { status: response.status }));
    const accepted = bodies.filter((body) => 'action' in (body as Record<string, unknown>))
      .map((body) => actionOf(body))
      .filter((action) => action.submission.status === 'accepted');
    assert.ok(accepted.length >= 1, 'at least one concurrent submission is accepted');

    await settle([world.authority.authority.server, world.policy.host.server]);
    const owned = await world.authority.registry.owned(alice.actorId);
    assert.equal(owned.length, 1, 'the Registry atomic rule leaves exactly one real initial vessel');
    assert.equal(owned[0]?.id, `${world.origins.authority}/objects/vessels/swift`);
    const state = await world.authority.registry.state(`${world.origins.authority}/objects/vessels/swift`);
    const berthings = eventsOf(state, 'BerthingEvent');
    assert.equal(berthings.length, 1, 'the single real vessel berths once');
    assert.equal(registrationCalls(tracker).length >= 1, true);
  } finally {
    await session?.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('served browser receives its initial vessel, checks the real landing and explores the recommended port', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-onboarding-browser-'));
  const world = await startPolicyWorld(directory, {
    playerNames: ['alice'], accountPasswords: { alice: 'alice-password' }, vesselNames: {}
  });
  const { tracker, fetcher } = createTracker();
  const session = await openSession(join(directory, 'client.store.json'), fetcher);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(new URL('/logistics', session.client.origin).href);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign in', exact: true });
    await dialog.getByLabel('Handle', { exact: true }).fill(`@alice@${new URL(world.origins.authority).host}`);
    await dialog.getByLabel('Password', { exact: true }).fill('alice-password');
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });

    const travel = page.getByRole('region', { name: 'Vessel travel', exact: true });
    await travel.getByRole('button', { name: 'Refresh owned vessels', exact: true }).click();
    await travel.getByLabel('Vessel ID', { exact: true }).fill('first-skiff');
    await travel.getByLabel('Vessel name', { exact: true }).fill('First Skiff');
    await travel.getByLabel('Starting port', { exact: true }).selectOption({ label: 'East Haven' });
    const [response] = await Promise.all([
      page.waitForResponse((result) => new URL(result.url()).pathname === '/api/logistics/vessels' && result.request().method() === 'POST'),
      travel.getByRole('button', { name: 'Receive initial vessel', exact: true }).click()
    ]);
    assert.equal(response.status(), 200);
    const action = actionOf(await response.json());
    assert.equal(action.submission.status, 'accepted');
    assert.equal(action.outcome.status, 'pending');
    const vessel = action.resultReferences.find((reference) => reference.kind === 'resource');
    const request = action.resultReferences.find((reference) => reference.kind === 'request');
    assert.ok(vessel && request);
    assert.equal(eventsOf(await world.authority.registry.state(vessel.id), 'BerthingEvent').length, 0, 'registration itself does not establish landing');
    await travel.getByText('Outcome: Pending', { exact: true }).waitFor();

    await settle([world.authority.authority.server, world.policy.host.server]);
    await travel.getByRole('button', { name: 'Check outcome', exact: true }).click();
    await travel.getByText('Outcome: Completed', { exact: true }).waitFor();
    const visit = (await world.policy.territory.ledger).visits[vessel.id];
    assert.equal(visit?.port, world.portId, 'the browser action caused a real Territory visit at the selected starting port');
    assert.ok(eventsOf(await world.authority.registry.state(vessel.id), 'BerthingEvent').some((event) => event.request === request.id));
    assert.equal(registrationCalls(tracker).length, 1, 'browser checking never resubmits registration');

    await travel.getByRole('button', { name: 'Open Explore', exact: true }).click();
    assert.equal(new URL(page.url()).pathname, '/explore');
    const explore = page.getByRole('region', { name: 'Explore', exact: true });
    await explore.getByRole('button', { name: 'Refresh places', exact: true }).click();
    await explore.getByRole('button', { name: 'Open East Haven', exact: true }).waitFor();
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
    await session.close();
    await world.close();
    await rm(directory, { recursive: true, force: true });
  }
});
