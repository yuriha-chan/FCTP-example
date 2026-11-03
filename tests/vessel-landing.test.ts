import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveDiplomaticToken } from '@fctp/auth';
import { validateModel, type DepartureRequest, type EntryRequest, type Route, type URI, type Vessel, type VesselCreationRequest } from '@fctp/protocol';
import { createHost, resolveExitEvidence, type FctpServer, type Host } from '@fctp/server-base';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';

const ADMIN = 'vessel-landing-admin';

type AuthorityApp = Awaited<ReturnType<typeof createAuthorityApp>>;
type PolicyApp = Awaited<ReturnType<typeof createPolicyApp>>;
type SimulationApp = Awaited<ReturnType<typeof createSimulationApp>>;
type AdmissionList = { mode: 'allowlist' | 'denylist'; allowlist: URI[]; denylist: URI[] };

interface CreationRegistration { vessel: Vessel; request: VesselCreationRequest }
interface EventRecord { id: URI; type: string; vessel: URI; territory: URI; request?: URI; port?: URI; route?: URI; entryRequest?: URI }

function admission(mode: 'allowlist' | 'denylist', allowlist: URI[] = [], denylist: URI[] = []): AdmissionList {
  return { mode, allowlist, denylist };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function adminPost(origin: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function adminJson<T>(origin: string, path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${ADMIN}` } });
  assert.equal(response.status, 200);
  return await response.json() as T;
}

async function login(origin: string, name: string, password: string): Promise<string> {
  const response = await fetch(`${origin}/local/home/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: `@${name}@${new URL(origin).host}`, password })
  });
  assert.equal(response.status, 200);
  const result = await response.json() as { status: string; nativeToken: string };
  assert.equal(result.status, 'signed-in');
  return result.nativeToken;
}

function playerId(authority: AuthorityApp, name: string): URI {
  const id = authority.ids.players[name];
  assert.ok(id, `expected a Player id for ${name}`);
  return id;
}

function configuredVessel(authority: AuthorityApp, name: string): URI {
  const id = authority.ids.vessels[name];
  assert.ok(id, `expected a configured vessel id for ${name}`);
  return id;
}

async function registerVessel(origin: string, token: string, body: { id: string; name: string; port: URI }): Promise<CreationRegistration> {
  const response = await fetch(`${origin}/local/registry/vessels`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  assert.equal(response.status, 202, `initial vessel registration: ${text}`);
  return JSON.parse(text) as CreationRegistration;
}

async function registeredVessel(authority: AuthorityApp, origin: string, name: string, vesselId: string, port: URI): Promise<CreationRegistration> {
  const token = await login(origin, name, `${name}-password`);
  return registerVessel(origin, token, { id: vesselId, name: vesselId, port });
}

async function sendEntry(origin: string, body: { vessel: URI; territory: URI; port: URI; route: URI }): Promise<EntryRequest> {
  const response = await fetch(`${origin}/local/registry/entry`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  assert.equal(response.status, 202, `registry entry: ${text}`);
  return JSON.parse(text) as EntryRequest;
}

async function sendDeparture(origin: string, body: { vessel: URI; territory: URI; port: URI; route: URI }): Promise<DepartureRequest> {
  const response = await fetch(`${origin}/local/registry/departure`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  assert.equal(response.status, 202, `registry departure: ${text}`);
  return JSON.parse(text) as DepartureRequest;
}

async function settle(servers: FctpServer[], rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    for (const server of servers) {
      await server.processInbox();
      await server.processOutbox();
    }
  }
}

async function processTolerant(server: FctpServer): Promise<unknown> {
  try {
    await server.processInbox();
    await server.processOutbox();
    return undefined;
  } catch (error) {
    return error;
  }
}

async function playerToken(authority: AuthorityApp, origin: string, name: string, resourceActor: URI, resourceServer: FctpServer): Promise<string> {
  const nativeToken = await login(origin, name, `${name}-password`);
  const response = await adminPost(origin, '/local/home/digest-request', { actor: playerId(authority, name), resourceActor });
  assert.equal(response.status, 202);
  await authority.authority.server.processOutbox();
  await resourceServer.processInbox();
  return deriveDiplomaticToken(nativeToken, resourceActor);
}

async function policyEvents(policy: PolicyApp, type: string): Promise<EventRecord[]> {
  return policy.host.server.store.read((store) => store.outboxArchive
    .map((entry) => entry.activity.object as unknown)
    .filter((object): object is EventRecord => !!object && typeof object === 'object' && (object as { type?: unknown }).type === type)
    .map((object) => structuredClone(object)));
}

function creation(issuerOrigin: string, registry: URI, vesselId: string, destination: { territory: URI; port: URI; route?: URI }, extras: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `${issuerOrigin}/objects/vessel-creation-requests/${vesselId}`,
    type: 'VesselCreationRequest',
    vessel: { id: `${issuerOrigin}/objects/vessels/${vesselId}`, registry, possessor: `${issuerOrigin}/actors/player`, capacity: 100, name: vesselId },
    cargo: { entries: [] },
    destination,
    ...extras
  };
}

async function deliverSigned(host: Host, actorName: string, object: Record<string, unknown>, recipient: URI, target: FctpServer): Promise<void> {
  const activity = await host.sign(actorName, {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
    id: `${String(object.id)}/activity`, type: 'Create', actor: host.actor(actorName).id, object, to: [recipient]
  } as never);
  await target.receive(recipient, activity);
}

test('policy creation lands under vesselBuildingRegistry while ordinary entry still follows trustedRegistry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-landing-policy-accept-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const policyOrigin = `http://127.0.0.1:${await freePort()}`;
  let authority: AuthorityApp | undefined;
  let policy: PolicyApp | undefined;
  try {
    policy = await createPolicyApp({ origin: policyOrigin, storeFile: join(directory, 'policy.json'), adminSecret: ADMIN });
    await policy.host.listen(Number(new URL(policyOrigin).port));
    const chosenPort = policy.ids.ports[0]!;
    authority = await createAuthorityApp({
      origin: authorityOrigin,
      storeFile: join(directory, 'authority.json'),
      adminSecret: ADMIN,
      playerNames: ['alice', 'bob'],
      accountPasswords: { alice: 'alice-password', bob: 'bob-password' },
      vesselNames: { bob: 'bob-vessel' },
      startingPorts: [chosenPort]
    });
    await authority.authority.listen(Number(new URL(authorityOrigin).port));
    const registry = authority.ids.actor.registry;

    assert.equal((await adminPost(policyOrigin, '/local/territory/admin/admission', {
      trustedRegistry: admission('allowlist', []),
      vesselBuildingRegistry: admission('allowlist', [registry])
    })).status, 200);

    const { vessel, request } = await registeredVessel(authority, authorityOrigin, 'alice', 'swift', chosenPort);
    await settle([authority.authority.server, policy.host.server]);

    const ledger = await policy.territory.ledger;
    assert.equal(ledger.decisions[request.id]?.accepted, true, 'building admission is independent of trustedRegistry');
    const visit = ledger.visits[vessel.id];
    assert.ok(visit, 'an accepted creation lands the vessel');
    assert.equal(visit.port, chosenPort);
    assert.equal(visit.entryRequest, request.id);
    assert.equal(visit.possessor, playerId(authority, 'alice'));
    assert.equal(visit.departed, false);

    const registryState = await authority.registry.state(vessel.id);
    const berthing = registryState.events.find((candidate) => candidate.type === 'BerthingEvent' && (candidate as EventRecord).request === request.id) as EventRecord | undefined;
    assert.ok(berthing, 'Registry receives the correlated BerthingEvent');
    assert.equal(berthing.vessel, vessel.id);
    assert.equal(berthing.port, chosenPort);
    assert.equal(berthing.territory, policy.ids.actor);
    assert.equal(registryState.events.some((candidate) => candidate.type === 'EntryRejected' && (candidate as EventRecord).request === request.id), false);

    const persisted = registryState.requests[request.id]!;
    assert.equal(persisted.type, 'VesselCreationRequest');
    assert.equal(Object.hasOwn(persisted, 'journey'), false);
    assert.equal(Object.hasOwn(persisted, 'route'), false);
    assert.equal(Object.hasOwn(persisted.destination as Record<string, unknown>, 'route'), false);
    assert.equal(Object.hasOwn(request, 'journey'), false);
    assert.equal(Object.hasOwn(request.destination as Record<string, unknown>, 'route'), false);

    const bobVessel = configuredVessel(authority, 'bob');
    const ordinary = await sendEntry(authorityOrigin, {
      vessel: bobVessel,
      territory: policy.ids.actor,
      port: chosenPort,
      route: policy.ids.routes[0]!
    });
    await settle([authority.authority.server, policy.host.server]);
    const after = await policy.territory.ledger;
    assert.equal(after.decisions[ordinary.id]?.accepted, false, 'ordinary entry remains governed by trustedRegistry');
    assert.equal(after.decisions[ordinary.id]?.reason, 'trusted-registry-not-accepted');
    assert.equal(after.visits[bobVessel], undefined);
    const bobState = await authority.registry.state(bobVessel);
    assert.ok(bobState.events.some((candidate) => candidate.type === 'EntryRejected' && (candidate as EventRecord).request === ordinary.id));
    assert.equal(bobState.events.some((candidate) => candidate.type === 'BerthingEvent' && (candidate as EventRecord).request === ordinary.id), false);
  } finally {
    await policy?.host.close();
    await authority?.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('policy building decisions reject, accept denylist-empties, never replay, and reject forged creation senders', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-landing-policy-decisions-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const policyOrigin = `http://127.0.0.1:${await freePort()}`;
  const wrongOrigin = `http://127.0.0.1:${await freePort()}`;
  let authority: AuthorityApp | undefined;
  let policy: PolicyApp | undefined;
  let wrong: Host | undefined;
  try {
    policy = await createPolicyApp({ origin: policyOrigin, storeFile: join(directory, 'policy.json'), adminSecret: ADMIN });
    await policy.host.listen(Number(new URL(policyOrigin).port));
    const chosenPort = policy.ids.ports[0]!;
    authority = await createAuthorityApp({
      origin: authorityOrigin,
      storeFile: join(directory, 'authority.json'),
      adminSecret: ADMIN,
      playerNames: ['alice', 'bob'],
      accountPasswords: { alice: 'alice-password', bob: 'bob-password' },
      vesselNames: {},
      startingPorts: [chosenPort]
    });
    await authority.authority.listen(Number(new URL(authorityOrigin).port));
    const registry = authority.ids.actor.registry;

    assert.equal((await adminPost(policyOrigin, '/local/territory/admin/admission', {
      trustedRegistry: admission('allowlist', [registry]),
      vesselBuildingRegistry: admission('allowlist', [])
    })).status, 200);
    const denied = await registeredVessel(authority, authorityOrigin, 'alice', 'denied', chosenPort);
    await settle([authority.authority.server, policy.host.server]);
    const deniedLedger = await policy.territory.ledger;
    assert.equal(deniedLedger.decisions[denied.request.id]?.accepted, false, 'default building admission rejects despite trustedRegistry');
    assert.equal(deniedLedger.visits[denied.vessel.id], undefined);
    const deniedRegistry = await authority.registry.state(denied.vessel.id);
    assert.ok(deniedRegistry.events.some((candidate) => candidate.type === 'EntryRejected' && (candidate as EventRecord).request === denied.request.id));
    assert.equal(deniedRegistry.events.some((candidate) => candidate.type === 'BerthingEvent' && (candidate as EventRecord).request === denied.request.id), false);

    assert.equal((await adminPost(policyOrigin, '/local/territory/admin/admission', {
      vesselBuildingRegistry: admission('denylist', [], [`${policyOrigin}/registries/other`])
    })).status, 200);
    const accepted = await registeredVessel(authority, authorityOrigin, 'bob', 'accepted', chosenPort);
    await settle([authority.authority.server, policy.host.server]);
    assert.equal((await policy.territory.ledger).decisions[accepted.request.id]?.accepted, true, 'a denylist omitting the building Registry accepts');

    const archived = await authority.authority.server.store.read((store) => store.outboxArchive.find((entry) => {
      const object = entry.activity.object as { id?: string } | undefined;
      return object?.id === accepted.request.id;
    })?.activity);
    assert.ok(archived, 'the accepted creation activity remains archived');
    const replay = await policy.host.server.receive(policy.ids.actor, archived as never);
    assert.equal(replay, 'duplicate');
    await settle([policy.host.server]);
    const replayLedger = await policy.territory.ledger;
    assert.equal(Object.values(replayLedger.visits).filter((visit) => visit.vessel === accepted.vessel.id).length, 1);
    const replayBerthings = (await policyEvents(policy, 'BerthingEvent')).filter((candidate) => candidate.request === accepted.request.id);
    assert.equal(replayBerthings.length, 1, 'replaying the exact accepted creation never duplicates the berth');

    wrong = await createHost({
      origin: wrongOrigin,
      storeFile: join(directory, 'wrong.json'),
      actors: [{ name: 'registry', role: 'registry' }]
    });
    await wrong.listen(Number(new URL(wrongOrigin).port));
    const forged = creation(wrongOrigin, registry, 'forged', { territory: policy.ids.actor, port: chosenPort });
    await deliverSigned(wrong, 'registry', forged, policy.ids.actor, policy.host.server);
    await processTolerant(policy.host.server);
    const forgedLedger = await policy.territory.ledger;
    assert.equal(forgedLedger.visits[`${wrongOrigin}/objects/vessels/forged`], undefined, 'a wrong signed sender cannot allocate a local visit');
    assert.equal(forgedLedger.decisions[String(forged.id)], undefined);
    assert.equal((await policyEvents(policy, 'BerthingEvent')).some((candidate) => candidate.request === forged.id), false);
  } finally {
    await wrong?.close();
    await policy?.host.close();
    await authority?.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('policy manual creation review survives restart, applies updated building admission, and keeps terminal results immutable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-landing-policy-manual-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const policyOrigin = `http://127.0.0.1:${await freePort()}`;
  const port = Number(new URL(policyOrigin).port);
  let authority: AuthorityApp | undefined;
  let policy: PolicyApp | undefined;
  try {
    policy = await createPolicyApp({ origin: policyOrigin, storeFile: join(directory, 'policy.json'), adminSecret: ADMIN });
    await policy.host.listen(port);
    const chosenPort = policy.ids.ports[0]!;
    authority = await createAuthorityApp({
      origin: authorityOrigin,
      storeFile: join(directory, 'authority.json'),
      adminSecret: ADMIN,
      playerNames: ['alice', 'bob'],
      accountPasswords: { alice: 'alice-password', bob: 'bob-password' },
      vesselNames: {},
      startingPorts: [chosenPort]
    });
    await authority.authority.listen(Number(new URL(authorityOrigin).port));
    const registry = authority.ids.actor.registry;

    assert.equal((await adminPost(policyOrigin, '/local/territory/admin/admission', {
      reviewMode: 'manual',
      vesselBuildingRegistry: admission('allowlist', [registry])
    })).status, 200);

    const first = await registeredVessel(authority, authorityOrigin, 'alice', 'manual-one', chosenPort);
    const second = await registeredVessel(authority, authorityOrigin, 'bob', 'manual-two', chosenPort);
    await settle([authority.authority.server, policy.host.server]);

    const listRequests = async (): Promise<Array<{ requestId: string; request: { id: string; type: string }; sender: string; status: string }>> =>
      (await adminJson<{ requests: Array<{ requestId: string; request: { id: string; type: string }; sender: string; status: string }> }>(policyOrigin, '/local/territory/admin/entry-requests')).requests;
    let requests = await listRequests();
    const firstPending = requests.find((candidate) => candidate.requestId === first.request.id);
    const secondPending = requests.find((candidate) => candidate.requestId === second.request.id);
    assert.equal(firstPending?.request.type, 'VesselCreationRequest');
    assert.equal(firstPending?.sender, registry);
    assert.equal(firstPending?.status, 'pending');
    assert.equal(secondPending?.status, 'pending');
    assert.equal((await policy.territory.ledger).visits[first.vessel.id], undefined);
    assert.equal((await policy.territory.ledger).visits[second.vessel.id], undefined);
    assert.equal((await policyEvents(policy, 'BerthingEvent')).some((candidate) => candidate.request === first.request.id), false);

    await policy.host.close();
    policy = await createPolicyApp({ origin: policyOrigin, storeFile: join(directory, 'policy.json'), adminSecret: ADMIN });
    await policy.host.listen(port);
    requests = await listRequests();
    assert.equal(requests.find((candidate) => candidate.requestId === first.request.id)?.request.type, 'VesselCreationRequest', 'pending creation type survives restart');
    assert.equal(requests.find((candidate) => candidate.requestId === second.request.id)?.status, 'pending');

    const decide = (id: URI, action: 'approve' | 'reject', body: Record<string, unknown> = {}): Promise<Response> => adminPost(policyOrigin, `/local/territory/admin/entry-requests/${encodeURIComponent(id)}/${action}`, body);

    const firstApproval = await decide(first.request.id, 'approve');
    assert.equal(firstApproval.status, 200);
    assert.equal((await firstApproval.json() as { accepted?: boolean }).accepted, true);
    await settle([policy.host.server, authority.authority.server]);
    assert.equal((await policy.territory.ledger).decisions[first.request.id]?.accepted, true);
    assert.ok((await policy.territory.ledger).visits[first.vessel.id]);
    assert.equal((await policyEvents(policy, 'BerthingEvent')).filter((candidate) => candidate.request === first.request.id).length, 1);

    const reversed = await decide(first.request.id, 'reject', { reason: 'late-rejection' });
    assert.equal(reversed.status, 200);
    assert.equal((await reversed.json() as { accepted?: boolean }).accepted, true);
    assert.equal((await policy.territory.ledger).decisions[first.request.id]?.accepted, true);
    assert.ok((await policy.territory.ledger).visits[first.vessel.id]);
    assert.equal((await policyEvents(policy, 'EntryRejected')).filter((candidate) => candidate.request === first.request.id).length, 0);

    assert.equal((await adminPost(policyOrigin, '/local/territory/admin/admission', {
      vesselBuildingRegistry: admission('allowlist', [])
    })).status, 200);
    const secondApproval = await decide(second.request.id, 'approve');
    assert.equal(secondApproval.status, 200);
    assert.equal((await secondApproval.json() as { accepted?: boolean }).accepted, false, 'processing uses the updated building admission');
    await settle([policy.host.server, authority.authority.server]);
    assert.equal((await policy.territory.ledger).visits[second.vessel.id], undefined);
    assert.equal((await policyEvents(policy, 'EntryRejected')).filter((candidate) => candidate.request === second.request.id).length, 1);

    const repeatedApproval = await decide(second.request.id, 'approve');
    assert.equal(repeatedApproval.status, 200);
    assert.equal((await repeatedApproval.json() as { accepted?: boolean }).accepted, false);
    assert.equal((await policy.territory.ledger).visits[second.vessel.id], undefined);
    assert.equal((await policyEvents(policy, 'BerthingEvent')).filter((candidate) => candidate.request === second.request.id).length, 0);
  } finally {
    await policy?.host.close();
    await authority?.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('simulation creation uses vesselBuildingRegistry, waits for an explicit tick, and rejects by default independently of entry rules', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-landing-sim-auto-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const simulationOrigin = `http://127.0.0.1:${await freePort()}`;
  let authority: AuthorityApp | undefined;
  let simulation: SimulationApp | undefined;
  try {
    simulation = await createSimulationApp({ origin: simulationOrigin, storeFile: join(directory, 'simulation.json'), peerOrigin: 'https://peer.example', adminSecret: ADMIN });
    await simulation.host.listen(Number(new URL(simulationOrigin).port));
    const chosenPort = simulation.ids.ports[0]!;
    authority = await createAuthorityApp({
      origin: authorityOrigin,
      storeFile: join(directory, 'authority.json'),
      adminSecret: ADMIN,
      playerNames: ['alice', 'bob'],
      accountPasswords: { alice: 'alice-password', bob: 'bob-password' },
      vesselNames: {},
      startingPorts: [chosenPort]
    });
    await authority.authority.listen(Number(new URL(authorityOrigin).port));
    const registry = authority.ids.actor.registry;

    assert.equal((await adminPost(simulationOrigin, '/local/territory/admin/admission', {
      trustedRegistry: admission('allowlist', []),
      vesselBuildingRegistry: admission('allowlist', [registry]),
      requireExitEvidence: true,
      manifestPolicy: 'evidence',
      reviewMode: 'automatic'
    })).status, 200);

    const accepted = await registeredVessel(authority, authorityOrigin, 'alice', 'sim-accepted', chosenPort);
    await settle([authority.authority.server, simulation.host.server]);
    const admitted = await simulation.territory.state();
    assert.equal(admitted.visits[accepted.request.id]?.decision.accepted, true, 'creation uses building admission despite entry evidence rules');
    const pendingVessel = admitted.simulation.vessels.find((candidate) => candidate.id === admitted.visits[accepted.request.id]?.simulationVessel);
    assert.equal(pendingVessel?.status, 'pending');
    const beforeTick = await authority.registry.state(accepted.vessel.id);
    assert.equal(beforeTick.events.some((candidate) => candidate.type === 'BerthingEvent' && (candidate as EventRecord).request === accepted.request.id), false, 'no Registry berth exists before a simulation tick');

    assert.equal((await adminPost(simulationOrigin, '/local/territory/admin/tick', {})).status, 200);
    await settle([simulation.host.server, authority.authority.server]);
    const berthed = await simulation.territory.state();
    const berthedVessel = berthed.simulation.vessels.find((candidate) => candidate.id === berthed.visits[accepted.request.id]?.simulationVessel);
    assert.equal(berthedVessel?.status, 'berthed');
    const afterTick = await authority.registry.state(accepted.vessel.id);
    assert.ok(afterTick.events.some((candidate) => candidate.type === 'BerthingEvent' && (candidate as EventRecord).request === accepted.request.id));
    assert.equal((afterTick.events.find((candidate) => candidate.type === 'BerthingEvent' && (candidate as EventRecord).request === accepted.request.id) as EventRecord).port, chosenPort);

    assert.equal((await adminPost(simulationOrigin, '/local/territory/admin/admission', {
      trustedRegistry: admission('allowlist', [registry]),
      vesselBuildingRegistry: admission('allowlist', []),
      requireExitEvidence: false,
      manifestPolicy: 'request'
    })).status, 200);
    const denied = await registeredVessel(authority, authorityOrigin, 'bob', 'sim-denied', chosenPort);
    await settle([authority.authority.server, simulation.host.server]);
    const deniedState = await simulation.territory.state();
    assert.equal(deniedState.visits[denied.request.id], undefined);
    assert.equal(deniedState.decisions.find((candidate) => candidate.request === denied.request.id)?.accepted, false, 'default building admission rejects independently of trustedRegistry');
    const deniedRegistry = await authority.registry.state(denied.vessel.id);
    assert.ok(deniedRegistry.events.some((candidate) => candidate.type === 'EntryRejected' && (candidate as EventRecord).request === denied.request.id));
    assert.equal(deniedRegistry.events.some((candidate) => candidate.type === 'BerthingEvent' && (candidate as EventRecord).request === denied.request.id), false);
  } finally {
    await simulation?.host.close();
    await authority?.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('simulation manual landing retains original creation across restart and approval still waits for tick', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-landing-sim-manual-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const simulationOrigin = `http://127.0.0.1:${await freePort()}`;
  const simulationOptions = { origin: simulationOrigin, storeFile: join(directory, 'simulation.json'), peerOrigin: 'https://peer.example', adminSecret: ADMIN };
  let authority: AuthorityApp | undefined;
  let simulation: SimulationApp | undefined;
  try {
    simulation = await createSimulationApp(simulationOptions);
    await simulation.host.listen(Number(new URL(simulationOrigin).port));
    const chosenPort = simulation.ids.ports[0]!;
    authority = await createAuthorityApp({
      origin: authorityOrigin, storeFile: join(directory, 'authority.json'), adminSecret: ADMIN,
      playerNames: ['alice', 'bob'], accountPasswords: { alice: 'alice-password', bob: 'bob-password' },
      vesselNames: {}, startingPorts: [chosenPort]
    });
    await authority.authority.listen(Number(new URL(authorityOrigin).port));
    const registry = authority.ids.actor.registry;
    assert.equal((await adminPost(simulationOrigin, '/local/territory/admin/admission', {
      reviewMode: 'manual', vesselBuildingRegistry: admission('allowlist', [registry])
    })).status, 200);
    const first = await registeredVessel(authority, authorityOrigin, 'alice', 'manual-accepted', chosenPort);
    const second = await registeredVessel(authority, authorityOrigin, 'bob', 'manual-rejected', chosenPort);
    await settle([authority.authority.server, simulation.host.server]);
    const pending = await simulation.territory.entryRequests();
    assert.equal(pending.find((item) => item.requestId === first.request.id)?.status, 'pending');
    assert.equal((await simulation.territory.state()).visits[first.request.id], undefined);

    await simulation.host.close();
    simulation = await createSimulationApp(simulationOptions);
    await simulation.host.listen(Number(new URL(simulationOrigin).port));
    const retained = (await simulation.territory.entryRequests()).find((item) => item.requestId === first.request.id);
    assert.equal((retained?.request as { type?: string })?.type, 'VesselCreationRequest');
    assert.equal(retained?.sender, registry);
    const decide = (id: URI, action: 'approve' | 'reject'): Promise<Response> => adminPost(simulationOrigin, `/local/territory/admin/entry-requests/${encodeURIComponent(id)}/${action}`, {});
    const approval = await decide(first.request.id, 'approve');
    assert.equal(approval.status, 200);
    assert.equal((await approval.json() as { accepted: boolean }).accepted, true);
    const reversal = await decide(first.request.id, 'reject');
    assert.equal(reversal.status, 200);
    assert.equal((await reversal.json() as { accepted: boolean }).accepted, true);
    await settle([simulation.host.server, authority.authority.server]);
    const beforeTick = await authority.registry.state(first.vessel.id);
    assert.equal(beforeTick.events.some((item) => item.type === 'BerthingEvent' && (item as EventRecord).request === first.request.id), false);
    assert.equal(beforeTick.events.some((item) => item.type === 'EntryRejected' && (item as EventRecord).request === first.request.id), false);
    assert.equal((await adminPost(simulationOrigin, '/local/territory/admin/admission', {
      vesselBuildingRegistry: admission('allowlist', [])
    })).status, 200);
    const rejected = await decide(second.request.id, 'approve');
    assert.equal(rejected.status, 200);
    assert.equal((await rejected.json() as { accepted: boolean }).accepted, false);
    assert.equal((await adminPost(simulationOrigin, '/local/territory/admin/tick', {})).status, 200);
    await settle([simulation.host.server, authority.authority.server]);
    const afterTick = await authority.registry.state(first.vessel.id);
    assert.ok(afterTick.events.some((item) => item.type === 'BerthingEvent' && (item as EventRecord).request === first.request.id));
    const denied = await authority.registry.state(second.vessel.id);
    assert.ok(denied.events.some((item) => item.type === 'EntryRejected' && (item as EventRecord).request === second.request.id));
    assert.equal((await simulation.territory.state()).visits[second.request.id], undefined);
  } finally {
    await simulation?.host.close();
    await authority?.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('policy landing supports local movement, real outgoing departure, signed exit binding, and ordinary simulation entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-landing-policy-travel-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const policyOrigin = `http://127.0.0.1:${await freePort()}`;
  const simulationOrigin = `http://127.0.0.1:${await freePort()}`;
  const east = `${policyOrigin}/objects/ports/east` as URI;
  const west = `${policyOrigin}/objects/ports/west` as URI;
  const returnRoute = `${policyOrigin}/objects/routes/outbound` as URI;
  let authority: AuthorityApp | undefined;
  let policy: PolicyApp | undefined;
  let simulation: SimulationApp | undefined;
  try {
    const additionalRoutes: Route[] = [{ id: returnRoute, type: 'Route', name: 'Eastern Passage', from: west, to: `${simulationOrigin}/objects/boundaries/east` }];
    policy = await createPolicyApp({ origin: policyOrigin, storeFile: join(directory, 'policy.json'), adminSecret: ADMIN, additionalRoutes });
    await policy.host.listen(Number(new URL(policyOrigin).port));
    simulation = await createSimulationApp({ origin: simulationOrigin, storeFile: join(directory, 'simulation.json'), peerOrigin: policyOrigin, adminSecret: ADMIN });
    await simulation.host.listen(Number(new URL(simulationOrigin).port));
    authority = await createAuthorityApp({
      origin: authorityOrigin,
      storeFile: join(directory, 'authority.json'),
      adminSecret: ADMIN,
      playerNames: ['alice'],
      accountPasswords: { alice: 'alice-password' },
      vesselNames: {},
      startingPorts: [east]
    });
    await authority.authority.listen(Number(new URL(authorityOrigin).port));
    const registry = authority.ids.actor.registry;

    assert.equal(policy.ids.ports[0], east);
    assert.equal(policy.ids.ports[1], west);
    assert.equal(policy.ids.routes.includes(returnRoute), true);
    assert.equal((await adminPost(policyOrigin, '/local/territory/admin/admission', {
      vesselBuildingRegistry: admission('allowlist', [registry])
    })).status, 200);
    assert.equal((await adminPost(simulationOrigin, '/local/territory/admin/admission', {
      trustedRegistry: admission('allowlist', []),
      acceptedRegistry: admission('allowlist', [registry]),
      acceptedTerritory: admission('allowlist', [policy.ids.actor]),
      vesselBuildingRegistry: admission('allowlist', []),
      requireExitEvidence: true,
      manifestPolicy: 'reject-difference'
    })).status, 200);

    const { vessel, request } = await registeredVessel(authority, authorityOrigin, 'alice', 'traveler', east);
    await settle([authority.authority.server, policy.host.server]);
    assert.equal((await policy.territory.ledger).visits[vessel.id]?.port, east);

    const token = await playerToken(authority, authorityOrigin, 'alice', policy.ids.actor, policy.host.server);
    const traversed = await fetch(`${policyOrigin}/local/territory/traverse`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vessel: vessel.id, route: policy.ids.routes[1]! })
    });
    assert.equal(traversed.status, 200, `local movement: ${await traversed.text()}`);
    const moved = await policy.territory.ledger;
    assert.equal(moved.visits[vessel.id]?.port, west);
    assert.equal(moved.visits[vessel.id]?.route, policy.ids.routes[1]);
    assert.ok(moved.movements?.some((movement) => movement.vessel === vessel.id && movement.details?.from === east && movement.details?.to === west));

    const invalidDeparture = await sendDeparture(authorityOrigin, { vessel: vessel.id, territory: policy.ids.actor, port: west, route: policy.ids.routes[1]! });
    await settle([authority.authority.server, policy.host.server]);
    assert.equal((await policy.territory.ledger).visits[vessel.id]?.departed, false, 'a landed vessel cannot depart along an inbound route after local movement');
    assert.equal((await authority.registry.state(vessel.id)).events.some((candidate) => candidate.type === 'DepartureEvent' && (candidate as EventRecord).request === invalidDeparture.id), false);

    const departure = await sendDeparture(authorityOrigin, { vessel: vessel.id, territory: policy.ids.actor, port: west, route: returnRoute });
    assert.equal(departure.type, 'DepartureRequest');
    assert.equal(departure.route, returnRoute);
    await settle([authority.authority.server, policy.host.server]);
    assert.equal((await policy.territory.ledger).visits[vessel.id]?.departed, true);

    const exitedState = await authority.registry.state(vessel.id);
    const exitId = exitedState.exitEvidence.at(-1);
    assert.ok(exitId, 'Registry adopts the signed ExitEvent');
    assert.ok(exitedState.events.some((candidate) => candidate.type === 'ExitEvent' && candidate.id === exitId));
    assert.ok(exitedState.events.some((candidate) => candidate.type === 'DepartureEvent' && (candidate as EventRecord).request === departure.id));
    const resolved = await resolveExitEvidence(exitId, { vessel: vessel.id, registry });
    assert.equal(resolved.verification.cryptographic.verified, true);
    assert.equal(resolved.verification.attribution.attributed, true);
    assert.equal(resolved.verification.expectedIssuer.matches, true);
    assert.equal(resolved.binding.bound, true, 'exit binds the original creation request');
    assert.equal(resolved.entry?.id, request.id);
    assert.equal(resolved.entry?.type, 'VesselCreationRequest');
    assert.equal(resolved.exit?.route, returnRoute);
    const creationRequest = exitedState.requests[request.id]!;
    assert.equal(Object.hasOwn(creationRequest, 'journey'), false);
    assert.equal(Object.hasOwn(creationRequest, 'route'), false);
    assert.equal(Object.hasOwn(creationRequest.destination as Record<string, unknown>, 'route'), false);

    const simulationEntry = await sendEntry(authorityOrigin, {
      vessel: vessel.id,
      territory: simulation.ids.actor,
      port: simulation.ids.ports[0]!,
      route: simulation.ids.routes[0]!
    });
    assert.equal(simulationEntry.journey.exitEvidence, exitId, 'ordinary entry carries the exact signed exit');
    await settle([authority.authority.server, simulation.host.server]);
    const admitted = await simulation.territory.state();
    assert.equal(admitted.visits[simulationEntry.id]?.decision.accepted, true);
    assert.equal(admitted.visits[simulationEntry.id]?.evidence?.id, exitId);
    const pending = admitted.simulation.vessels.find((candidate) => candidate.id === admitted.visits[simulationEntry.id]?.simulationVessel);
    assert.equal(pending?.status, 'pending', 'ordinary simulation entry still waits for a tick');
    assert.equal((await adminPost(simulationOrigin, '/local/territory/admin/tick', {})).status, 200);
    await settle([simulation.host.server, authority.authority.server]);
    const berthed = await simulation.territory.state();
    const berthedVessel = berthed.simulation.vessels.find((candidate) => candidate.id === berthed.visits[simulationEntry.id]?.simulationVessel);
    assert.equal(berthedVessel?.status, 'berthed');
    const afterEntry = await authority.registry.state(vessel.id);
    assert.ok(afterEntry.events.some((candidate) => candidate.type === 'BerthingEvent' && (candidate as EventRecord).request === simulationEntry.id));
  } finally {
    await simulation?.host.close();
    await policy?.host.close();
    await authority?.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('simulation landing departs through a real additional outgoing route and signs an exit bound to creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-landing-sim-depart-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const simulationOrigin = `http://127.0.0.1:${await freePort()}`;
  const mainPort = `${simulationOrigin}/objects/ports/main` as URI;
  const eastBoundary = `${simulationOrigin}/objects/boundaries/east` as URI;
  const departureRoute = `${simulationOrigin}/objects/routes/departure` as URI;
  let authority: AuthorityApp | undefined;
  let simulation: SimulationApp | undefined;
  try {
    const additionalRoutes: Route[] = [{ id: departureRoute, type: 'Route', name: 'Eastern Departure', from: mainPort, to: eastBoundary }];
    simulation = await createSimulationApp({ origin: simulationOrigin, storeFile: join(directory, 'simulation.json'), peerOrigin: 'https://peer.example', adminSecret: ADMIN, additionalRoutes });
    await simulation.host.listen(Number(new URL(simulationOrigin).port));
    authority = await createAuthorityApp({
      origin: authorityOrigin,
      storeFile: join(directory, 'authority.json'),
      adminSecret: ADMIN,
      playerNames: ['alice'],
      accountPasswords: { alice: 'alice-password' },
      vesselNames: {},
      startingPorts: [mainPort]
    });
    await authority.authority.listen(Number(new URL(authorityOrigin).port));
    const registry = authority.ids.actor.registry;
    assert.equal(simulation.ids.routes.includes(departureRoute), true);
    assert.equal((await adminPost(simulationOrigin, '/local/territory/admin/admission', {
      vesselBuildingRegistry: admission('allowlist', [registry])
    })).status, 200);

    const { vessel, request } = await registeredVessel(authority, authorityOrigin, 'alice', 'sim-traveler', mainPort);
    await settle([authority.authority.server, simulation.host.server]);
    assert.equal((await simulation.territory.state()).visits[request.id]?.decision.accepted, true);
    assert.equal((await adminPost(simulationOrigin, '/local/territory/admin/tick', {})).status, 200);
    await settle([simulation.host.server, authority.authority.server]);

    const departure = await sendDeparture(authorityOrigin, { vessel: vessel.id, territory: simulation.ids.actor, port: mainPort, route: departureRoute });
    assert.equal(departure.route, departureRoute);
    await authority.authority.server.processOutbox();
    const departureFailure = await processTolerant(simulation.host.server);
    assert.equal(departureFailure, undefined, `simulation must accept a real outgoing departure route: ${departureFailure instanceof Error ? departureFailure.message : ''}`);
    assert.equal((await simulation.territory.state()).visits[request.id]?.exited, false, 'departure is not an instant exit');

    assert.equal((await adminPost(simulationOrigin, '/local/territory/admin/tick', {})).status, 200);
    await settle([simulation.host.server, authority.authority.server]);
    const exited = await simulation.territory.state();
    assert.equal(exited.visits[request.id]?.exited, true);
    const exitId = (await authority.registry.state(vessel.id)).exitEvidence.at(-1);
    assert.ok(exitId);
    const exitDocument = await fetch(exitId);
    assert.equal(exitDocument.status, 200);
    const exit = await exitDocument.json() as { entryRequest: URI; route: URI; vessel: URI };
    assert.equal(exit.entryRequest, request.id);
    assert.equal(exit.route, departureRoute);
    assert.equal(exit.vessel, vessel.id);
    const resolved = await resolveExitEvidence(exitId, { vessel: vessel.id, registry });
    assert.equal(resolved.verification.cryptographic.verified, true);
    assert.equal(resolved.verification.expectedIssuer.matches, true);
    assert.equal(resolved.binding.bound, true);
    assert.equal(resolved.entry?.id, request.id);
    assert.equal(resolved.entry?.type, 'VesselCreationRequest');
  } finally {
    await simulation?.host.close();
    await authority?.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('creation validator rejects goods, journey and route carriers while wrong destination ownership never berths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-landing-invalid-'));
  const policyOrigin = `http://127.0.0.1:${await freePort()}`;
  const wrongOrigin = `http://127.0.0.1:${await freePort()}`;
  let policy: PolicyApp | undefined;
  let issuer: Host | undefined;
  try {
    policy = await createPolicyApp({ origin: policyOrigin, storeFile: join(directory, 'policy.json'), adminSecret: ADMIN });
    await policy.host.listen(Number(new URL(policyOrigin).port));
    issuer = await createHost({ origin: wrongOrigin, storeFile: join(directory, 'issuer.json'), actors: [{ name: 'registry', role: 'registry' }] });
    await issuer.listen(Number(new URL(wrongOrigin).port));
    const registry = issuer.actor('registry').id as URI;
    const chosenPort = policy.ids.ports[0]!;
    assert.equal((await adminPost(policyOrigin, '/local/territory/admin/admission', {
      vesselBuildingRegistry: admission('allowlist', [registry])
    })).status, 200);

    const valid = creation(wrongOrigin, registry, 'valid', { territory: policy.ids.actor, port: chosenPort });
    assert.equal(validateModel(valid, 'VesselCreationRequest').success, true);
    await deliverSigned(issuer, 'registry', valid, policy.ids.actor, policy.host.server);
    assert.equal(await processTolerant(policy.host.server), undefined);
    assert.ok((await policy.territory.ledger).visits[`${wrongOrigin}/objects/vessels/valid`], 'a valid creation from an allowed building Registry lands');

    const invalid: Array<{ name: string; object: Record<string, unknown> }> = [
      {
        name: 'goods',
        object: creation(wrongOrigin, registry, 'with-goods', { territory: policy.ids.actor, port: chosenPort }, {
          cargo: { entries: [{ variety: `${wrongOrigin}/objects/varieties/ore`, count: 1, data: {} }] }
        })
      },
      {
        name: 'journey',
        object: creation(wrongOrigin, registry, 'with-journey', { territory: policy.ids.actor, port: chosenPort }, {
          journey: { events: [] }
        })
      },
      {
        name: 'route',
        object: creation(wrongOrigin, registry, 'with-route', { territory: policy.ids.actor, port: chosenPort, route: policy.ids.routes[0]! })
      },
      {
        name: 'foreign-port',
        object: creation(wrongOrigin, registry, 'foreign-port', { territory: policy.ids.actor, port: `${wrongOrigin}/objects/ports/elsewhere` })
      },
      {
        name: 'foreign-territory',
        object: creation(wrongOrigin, registry, 'foreign-territory', { territory: `${wrongOrigin}/actors/territory`, port: chosenPort })
      }
    ];
    for (const candidate of invalid) {
      const validation = validateModel(candidate.object, 'VesselCreationRequest');
      assert.equal(validation.success, candidate.name === 'foreign-port' || candidate.name === 'foreign-territory', `${candidate.name} model validation`);
      await deliverSigned(issuer, 'registry', candidate.object, policy.ids.actor, policy.host.server);
      await processTolerant(policy.host.server);
      const targetVessel = (candidate.object.vessel as { id: URI }).id;
      assert.equal((await policy.territory.ledger).visits[targetVessel], undefined, `${candidate.name} must not allocate a local visit`);
      assert.equal((await policyEvents(policy, 'BerthingEvent')).some((event) => event.request === candidate.object.id), false, `${candidate.name} must not berth`);
    }
  } finally {
    await issuer?.close();
    await policy?.host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
