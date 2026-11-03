import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAuthorityApp, type CreateAuthorityAppOptions } from '../apps/test-authority/src/app.js';

interface PortDocument {
  id: string;
  type: 'Port';
  name: string;
  territory: string;
  area: string;
  listings: string;
}

interface TerritoryActorDocument {
  id: string;
  role: string;
  inbox: string;
  outbox: string;
  publicKeys: string[];
}

interface RemoteRequest { url: string; authorization: string | undefined }

interface RemoteTerritory {
  readonly origin: string;
  readonly portId: string;
  readonly otherPortId: string;
  readonly mismatchPortId: string;
  readonly wrongActorPortId: string;
  readonly territoryId: string;
  readonly requests: RemoteRequest[];
  setResponse(uri: string, body: unknown): void;
  close(): Promise<void>;
}

interface HomeVessel { id: string; registry: string; possessor: string; capacity: number }
interface HomeOffer { available: boolean; registry: string; capacity: number; startingPorts: string[] }
interface HomeVessels { actor: string; vessels: HomeVessel[]; initialVessel: HomeOffer }
interface VesselDocument { id: string; registry: string; possessor: string; capacity: number; name?: string }
interface CreationRequest {
  id: string;
  type: string;
  vessel: VesselDocument;
  cargo: { entries: unknown[] };
  destination: { territory: string; port: string; route?: string };
  [key: string]: unknown;
}
interface Registration { vessel: VesselDocument; request: CreationRequest }

async function startRemoteTerritory(): Promise<RemoteTerritory> {
  const responses = new Map<string, unknown>();
  const requests: RemoteRequest[] = [];
  let origin = '';
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? '/', origin || 'http://127.0.0.1');
    requests.push({ url: url.href, authorization: request.headers.authorization });
    const body = responses.get(url.href);
    if (body === undefined) {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'not-found' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/ld+json' });
    response.end(JSON.stringify(body));
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Expected a TCP listen address'));
        return;
      }
      resolve(address.port);
    });
  });
  origin = `http://127.0.0.1:${port}`;
  const portId = `${origin}/objects/ports/main`;
  const otherPortId = `${origin}/objects/ports/other`;
  const mismatchPortId = `${origin}/objects/ports/mismatch`;
  const wrongActorPortId = `${origin}/objects/ports/wrong-actor`;
  const territoryId = `${origin}/actors/territory`;
  const wrongActorId = `${origin}/actors/wrong`;
  const portDocument = (id: string, territory: string): PortDocument => ({
    id, type: 'Port', name: 'Haven', territory,
    area: `${origin}/objects/areas/island`, listings: `${id}/listings`
  });
  const actorDocument = (id: string, role: string): TerritoryActorDocument => ({
    id, role, inbox: `${id}/inbox`, outbox: `${id}/outbox`, publicKeys: [`${id}/keys/main`]
  });
  responses.set(portId, portDocument(portId, territoryId));
  responses.set(otherPortId, portDocument(otherPortId, territoryId));
  responses.set(mismatchPortId, { ...portDocument(mismatchPortId, territoryId), id: otherPortId });
  responses.set(wrongActorPortId, portDocument(wrongActorPortId, wrongActorId));
  responses.set(territoryId, actorDocument(territoryId, 'territory'));
  responses.set(wrongActorId, actorDocument(wrongActorId, 'home'));
  return {
    origin, portId, otherPortId, mismatchPortId, wrongActorPortId, territoryId, requests,
    setResponse(uri, body) { responses.set(uri, body); },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

function createInitialVesselApp(options: CreateAuthorityAppOptions): ReturnType<typeof createAuthorityApp> {
  return createAuthorityApp(options);
}

function playerId(app: Awaited<ReturnType<typeof createAuthorityApp>>, name: string): string {
  const id = app.ids.players[name];
  assert.ok(id, `expected a Player id for ${name}`);
  return id;
}

async function login(origin: string, name: string, password: string): Promise<string> {
  const response = await fetch(`${origin}/local/home/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: `@${name}@${new URL(origin).host}`, password })
  });
  assert.equal(response.status, 200);
  const result = await response.json() as { status: string; actorId: string; nativeToken: string };
  assert.equal(result.status, 'signed-in');
  return result.nativeToken;
}

async function readHome(origin: string, token: string): Promise<HomeVessels> {
  const response = await fetch(`${origin}/local/home/vessels`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return await response.json() as HomeVessels;
}

function postRegistration(origin: string, token: string | undefined, body: unknown): Promise<Response> {
  return fetch(`${origin}/local/registry/vessels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
}

async function assertNoAllocation(origin: string, token: string, message: string): Promise<void> {
  const home = await readHome(origin, token);
  assert.deepEqual(home.vessels, [], message);
  assert.equal(home.initialVessel.available, true, message);
}

function assertClientError(response: Response, message: string): void {
  assert.ok(response.status >= 400 && response.status < 500, `${message}: expected a client error, got ${response.status}`);
}

test('fresh authenticated account receives the Home initial-vessel offer without remote IO', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-initial-home-'));
  const remote = await startRemoteTerritory();
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = await createInitialVesselApp({
    origin,
    storeFile: join(directory, 'authority.json'),
    adminSecret: 'initial-admin-secret',
    playerNames: ['alice'],
    accountPasswords: { alice: 'alice-password' },
    vesselNames: {},
    startingPorts: [remote.portId]
  });
  try {
    await app.authority.listen(port);
    const requestsBefore = remote.requests.length;
    assert.equal((await fetch(`${origin}/local/home/vessels`)).status, 401);
    assert.equal(remote.requests.length, requestsBefore, 'an unauthenticated listing must not perform remote IO');
    const token = await login(origin, 'alice', 'alice-password');
    const home = await readHome(origin, token);
    assert.equal(home.actor, playerId(app, 'alice'));
    assert.deepEqual(home.vessels, []);
    assert.deepEqual(home.initialVessel, {
      available: true,
      registry: app.ids.actor.registry,
      capacity: 100,
      startingPorts: [remote.portId]
    });
    assert.equal(remote.requests.length, requestsBefore, 'the listing itself must not perform remote IO');
  } finally {
    await app.authority.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('partial preallocation seeds only mapped accounts and makes their Home offer unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-initial-partial-'));
  const remote = await startRemoteTerritory();
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = await createInitialVesselApp({
    origin,
    storeFile: join(directory, 'authority.json'),
    adminSecret: 'initial-admin-secret',
    playerNames: ['alice', 'bob'],
    accountPasswords: { alice: 'alice-password', bob: 'bob-password' },
    vesselNames: { alice: 'alice-vessel' },
    startingPorts: [remote.portId]
  });
  try {
    await app.authority.listen(port);
    const aliceToken = await login(origin, 'alice', 'alice-password');
    const bobToken = await login(origin, 'bob', 'bob-password');
    const aliceHome = await readHome(origin, aliceToken);
    assert.deepEqual(aliceHome.vessels.map((vessel) => vessel.id), [`${origin}/objects/vessels/alice-vessel`]);
    assert.equal(aliceHome.initialVessel.available, false);
    assert.deepEqual(aliceHome.initialVessel.startingPorts, [remote.portId]);
    const bobHome = await readHome(origin, bobToken);
    assert.deepEqual(bobHome.vessels, []);
    assert.equal(bobHome.initialVessel.available, true);
    assertClientError(
      await postRegistration(origin, aliceToken, { id: 'swift', name: 'Swift', port: remote.portId }),
      'an account with a preallocated vessel must not receive another initial vessel'
    );
    await assertNoAllocation(origin, bobToken, 'rejecting the preallocated account must not allocate to another account');
  } finally {
    await app.authority.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('explicitly empty vessel preallocation keeps an empty fleet and Home listing across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-initial-empty-'));
  const remote = await startRemoteTerritory();
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const options: CreateAuthorityAppOptions = {
    origin,
    storeFile: join(directory, 'authority.json'),
    adminSecret: 'initial-admin-secret',
    playerNames: ['alice'],
    accountPasswords: { alice: 'alice-password' },
    vesselNames: {},
    startingPorts: [remote.portId]
  };
  let app = await createInitialVesselApp(options);
  try {
    await app.authority.listen(port);
    assert.equal(app.ids.vessel, undefined);
    const firstToken = await login(origin, 'alice', 'alice-password');
    const firstHome = await readHome(origin, firstToken);
    assert.deepEqual(firstHome.vessels, []);
    assert.equal(firstHome.initialVessel.available, true);
    const fleet = await fetch(`${origin}/local/registry/fleet`, { headers: { Authorization: 'Bearer initial-admin-secret' } });
    assert.equal(fleet.status, 200);
    assert.deepEqual(await fleet.json(), {});
    await app.authority.close();
    app = await createInitialVesselApp(options);
    await app.authority.listen(port);
    const restartedToken = await login(origin, 'alice', 'alice-password');
    const restartedHome = await readHome(origin, restartedToken);
    assert.deepEqual(restartedHome.vessels, []);
    assert.equal(restartedHome.initialVessel.available, true);
    assert.deepEqual(restartedHome.initialVessel.startingPorts, [remote.portId]);
    const restartedFleet = await fetch(`${origin}/local/registry/fleet`, { headers: { Authorization: 'Bearer initial-admin-secret' } });
    assert.equal(restartedFleet.status, 200);
    assert.deepEqual(await restartedFleet.json(), {});
  } finally {
    await app.authority.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('omitted vesselNames preserves the legacy fixture preallocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-initial-legacy-'));
  const remote = await startRemoteTerritory();
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = await createInitialVesselApp({
    origin,
    storeFile: join(directory, 'authority.json'),
    adminSecret: 'initial-admin-secret',
    playerNames: ['alice'],
    accountPasswords: { alice: 'alice-password' },
    startingPorts: [remote.portId]
  });
  try {
    await app.authority.listen(port);
    const token = await login(origin, 'alice', 'alice-password');
    const home = await readHome(origin, token);
    assert.deepEqual(home.vessels.map((vessel) => vessel.id), [`${origin}/objects/vessels/demo`]);
    assert.equal(home.initialVessel.available, false);
  } finally {
    await app.authority.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('valid initial vessel registration allocates an unlocated vessel and creation request atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-initial-register-'));
  const remote = await startRemoteTerritory();
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = await createInitialVesselApp({
    origin,
    storeFile: join(directory, 'authority.json'),
    adminSecret: 'initial-admin-secret',
    playerNames: ['alice'],
    accountPasswords: { alice: 'alice-password' },
    vesselNames: {},
    startingPorts: [remote.portId]
  });
  try {
    await app.authority.listen(port);
    const token = await login(origin, 'alice', 'alice-password');
    const response = await postRegistration(origin, token, { id: 'swift', name: 'Swift', port: remote.portId });
    assert.equal(response.status, 202);
    const { vessel, request } = await response.json() as Registration;
    assert.equal(vessel.id, `${origin}/objects/vessels/swift`);
    assert.equal(vessel.registry, app.ids.actor.registry);
    assert.equal(vessel.possessor, playerId(app, 'alice'));
    assert.equal(vessel.capacity, 100);
    assert.equal(vessel.name, 'Swift');
    assert.equal(request.type, 'VesselCreationRequest');
    assert.deepEqual(request.vessel, vessel);
    assert.deepEqual(request.cargo, { entries: [] });
    assert.deepEqual(request.destination, { territory: remote.territoryId, port: remote.portId });
    assert.equal(Object.hasOwn(request, 'journey'), false);
    assert.equal(Object.hasOwn(request, 'exitEvidence'), false);
    assert.equal(Object.hasOwn(request, 'route'), false);
    assert.equal(Object.hasOwn(request.destination, 'route'), false);

    const requested = remote.requests.map((entry) => entry.url);
    assert.equal(requested.includes(remote.portId), true, 'registration must resolve the exact published Port');
    assert.equal(requested.includes(remote.territoryId), true, 'registration must resolve the exact Territory Actor');
    assert.equal(remote.requests.every((entry) => entry.authorization === undefined), true, 'public resolution must not send credentials');

    const vesselDocument = await fetch(vessel.id);
    assert.equal(vesselDocument.status, 200);
    assert.deepEqual(await vesselDocument.json(), vessel);
    const requestDocument = await fetch(request.id);
    assert.equal(requestDocument.status, 200);
    assert.deepEqual(await requestDocument.json(), request);

    const stateResponse = await fetch(`${origin}/local/registry/state?vessel=${encodeURIComponent(vessel.id)}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json() as { vessel?: VesselDocument; cargo?: { entries: unknown[] }; events: Array<{ type: string }>; requests: Record<string, CreationRequest> };
    assert.deepEqual(state.vessel, vessel);
    assert.deepEqual(state.cargo, { entries: [] });
    assert.equal(state.events.some((event) => event.type === 'BerthingEvent'), false);
    assert.deepEqual(state.requests[request.id], request);

    const actionsResponse = await fetch(`${origin}/local/registry/actions?vessel=${encodeURIComponent(vessel.id)}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(actionsResponse.status, 200);
    const actions = await actionsResponse.json() as { state: { location?: { status?: string } } };
    assert.notEqual(actions.state.location?.status, 'berthed');

    const durable = await app.authority.server.store.read((store) => ({
      objects: store.objects,
      outbox: store.outbox.map((item) => ({ inbox: item.inbox, activity: item.activity }))
    }));
    assert.deepEqual(durable.objects[vessel.id], vessel);
    assert.deepEqual(durable.objects[request.id], request);
    const queued = durable.outbox.filter((item) => {
      const activity = item.activity as { object?: { id?: string } };
      return activity.object?.id === request.id;
    });
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.inbox, `${remote.territoryId}/inbox`);
  } finally {
    await app.authority.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('registration rejects unauthenticated, malformed, nonrecommended, mismatched and overriding requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-initial-invalid-'));
  const remote = await startRemoteTerritory();
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const names = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan'];
  const app = await createInitialVesselApp({
    origin,
    storeFile: join(directory, 'authority.json'),
    adminSecret: 'initial-admin-secret',
    playerNames: names,
    accountPasswords: Object.fromEntries(names.map((name) => [name, `${name}-password`])),
    vesselNames: {},
    startingPorts: [remote.portId, remote.mismatchPortId, remote.wrongActorPortId]
  });
  try {
    await app.authority.listen(port);
    const tokens = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await login(origin, name, `${name}-password`)] as const)));

    const cases: Array<{ name: string; body: Record<string, unknown>; message: string }> = [
      { name: 'alice', body: { name: 'Swift', port: remote.portId }, message: 'a missing id must be rejected' },
      { name: 'bob', body: { id: '../swift', name: 'Swift', port: remote.portId }, message: 'a malformed id must be rejected' },
      { name: 'carol', body: { id: 'https://evil.example/objects/vessels/swift', name: 'Swift', port: remote.portId }, message: 'an absolute id URI must be rejected' },
      { name: 'dave', body: { id: 'swift', port: remote.portId }, message: 'a missing name must be rejected' },
      { name: 'erin', body: { id: 'swift', name: '   ', port: remote.portId }, message: 'a blank trimmed name must be rejected' },
      { name: 'frank', body: { id: 'swift', name: 'Swift', port: remote.otherPortId }, message: 'a nonrecommended port must be rejected' },
      { name: 'grace', body: { id: 'swift', name: 'Swift', port: remote.mismatchPortId }, message: 'a Port document whose id does not match must be rejected' },
      { name: 'heidi', body: { id: 'swift', name: 'Swift', port: remote.wrongActorPortId }, message: 'a mismatched Territory Actor must be rejected' },
      { name: 'ivan', body: { id: 'swift', name: 'Swift', port: remote.portId, possessor: 'https://evil.example/actors/player', capacity: 9999, registry: 'https://evil.example/actors/registry', cargo: { entries: [] } }, message: 'caller overrides must be rejected' }
    ];
    for (const attempt of cases) {
      const token = tokens[attempt.name];
      assert.ok(token);
      assertClientError(await postRegistration(origin, token, attempt.body), attempt.message);
      await assertNoAllocation(origin, token, attempt.message);
    }

    assertClientError(await postRegistration(origin, undefined, { id: 'swift', name: 'Swift', port: remote.portId }), 'an unauthenticated caller must not allocate');
    assertClientError(await postRegistration(origin, 'initial-admin-secret', { id: 'swift', name: 'Swift', port: remote.portId }), 'the admin secret must not bypass caller identity');
    await assertNoAllocation(origin, tokens.alice!, 'rejected attempts must not allocate');
    assert.equal(remote.requests.every((entry) => entry.authorization === undefined), true, 'public resolution must not send credentials');
  } finally {
    await app.authority.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('concurrent and cross-account registration allocates at most one initial vessel and survives restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-initial-concurrent-'));
  const remote = await startRemoteTerritory();
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const options: CreateAuthorityAppOptions = {
    origin,
    storeFile: join(directory, 'authority.json'),
    adminSecret: 'initial-admin-secret',
    playerNames: ['alice', 'bob'],
    accountPasswords: { alice: 'alice-password', bob: 'bob-password' },
    vesselNames: {},
    startingPorts: [remote.portId]
  };
  let app = await createInitialVesselApp(options);
  try {
    await app.authority.listen(port);
    const aliceToken = await login(origin, 'alice', 'alice-password');
    const bobToken = await login(origin, 'bob', 'bob-password');
    const body = { id: 'swift', name: 'Swift', port: remote.portId };
    const attempts = await Promise.all([
      postRegistration(origin, aliceToken, body),
      postRegistration(origin, aliceToken, body)
    ]);
    const statuses = attempts.map((response) => response.status);
    assert.equal(statuses.filter((status) => status === 202).length, 1, 'exactly one concurrent submission may allocate');
    assert.equal(statuses.filter((status) => status >= 400 && status < 500).length, 1, 'the other concurrent submission must be rejected');

    const aliceHome = await readHome(origin, aliceToken);
    assert.deepEqual(aliceHome.vessels.map((vessel) => vessel.id), [`${origin}/objects/vessels/swift`]);
    assert.equal(aliceHome.initialVessel.available, false);

    assertClientError(await postRegistration(origin, bobToken, body), 'another account must not claim a colliding vessel ID');
    await assertNoAllocation(origin, bobToken, 'a colliding ID must not allocate to another account');

    const fleet = await fetch(`${origin}/local/registry/fleet`, { headers: { Authorization: 'Bearer initial-admin-secret' } });
    assert.equal(fleet.status, 200);
    assert.equal(Object.keys(await fleet.json() as Record<string, unknown>).length, 1);

    await app.authority.close();
    app = await createInitialVesselApp(options);
    await app.authority.listen(port);
    const restartedAlice = await login(origin, 'alice', 'alice-password');
    const restartedBob = await login(origin, 'bob', 'bob-password');
    const restartedHome = await readHome(origin, restartedAlice);
    assert.deepEqual(restartedHome.vessels.map((vessel) => vessel.id), [`${origin}/objects/vessels/swift`]);
    assert.equal(restartedHome.initialVessel.available, false);
    assert.equal((await readHome(origin, restartedBob)).initialVessel.available, true);
    const restartedFleet = await fetch(`${origin}/local/registry/fleet`, { headers: { Authorization: 'Bearer initial-admin-secret' } });
    assert.equal(restartedFleet.status, 200);
    assert.equal(Object.keys(await restartedFleet.json() as Record<string, unknown>).length, 1, 'restart must not allocate another vessel');
    const outbox = await app.authority.server.store.read((store) => store.outbox);
    assert.equal(outbox.length, 1, 'the queued creation request must survive restart');
    const activity = outbox[0]?.activity as { object?: { type?: string; vessel?: { id?: string } } } | undefined;
    assert.equal(activity?.object?.type, 'VesselCreationRequest');
    assert.equal(activity?.object?.vessel?.id, `${origin}/objects/vessels/swift`);
  } finally {
    await app.authority.close();
    await remote.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
