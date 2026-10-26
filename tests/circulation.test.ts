import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveDiplomaticToken } from '@fctp/auth';
import { resolveExitEvidence } from '@fctp/server-base';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';

const admin = 'circulation-test-admin';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function json<T>(response: Response): Promise<T> {
  const value = await response.json() as T;
  assert.ok(response.ok, `HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

test('actual HTTP circulation keeps Territory decisions, Registry adoption, and signed evidence independent', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-circulation-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const policyOrigin = `http://127.0.0.1:${await freePort()}`;
  const simOrigin = `http://127.0.0.1:${await freePort()}`;
  const authority = await createAuthorityApp({ origin: authorityOrigin, storeFile: join(directory, 'authority.json'), adminSecret: admin });
  const policy = await createPolicyApp({ origin: policyOrigin, storeFile: join(directory, 'policy.json'), authorityOrigin, peerOrigin: simOrigin, adminSecret: admin });
  const simulation = await createSimulationApp({ origin: simOrigin, storeFile: join(directory, 'simulation.json'), authorityOrigin, peerOrigin: policyOrigin, adminSecret: admin });
  await authority.authority.listen(Number(new URL(authorityOrigin).port));
  await policy.host.listen(Number(new URL(policyOrigin).port));
  await simulation.host.listen(Number(new URL(simOrigin).port));
  t.after(async () => {
    await simulation.host.close();
    await policy.host.close();
    await authority.authority.close();
    await rm(directory, { recursive: true, force: true });
  });

  const registryAuth = { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' };
  const artifacts: { activityWrappers: unknown[]; objects: unknown[]; verification: unknown[]; localDecisions: unknown[] } = {
    activityWrappers: [], objects: [], verification: [], localDecisions: []
  };
  const archivedActivities = async (server: typeof authority.authority.server | typeof policy.host.server | typeof simulation.host.server, objectType: string) =>
    server.store.read((store) => store.outboxArchive.map((entry) => entry.activity).filter((activity) =>
      !!activity.object && typeof activity.object === 'object' && (activity.object as Record<string, unknown>).type === objectType));
  const playerTokens = new Map<string, string>();
  const { nativeToken } = await json<{ nativeToken: string }>(await fetch(`${authorityOrigin}/local/home/issue`, { method: 'POST', headers: registryAuth, body: JSON.stringify({}) }));
  for (const app of [policy, simulation]) {
    playerTokens.set(app.ids.actor, await deriveDiplomaticToken(nativeToken, app.ids.actor));
    const digest = await fetch(`${authorityOrigin}/local/home/digest-request`, { method: 'POST', headers: registryAuth, body: JSON.stringify({ resourceActor: app.ids.actor }) });
    assert.equal(digest.status, 202, `Home queues token digest for ${app.ids.actor}`);
    assert.equal(await authority.authority.server.processOutbox(), 1, 'Home signed digest delivered over HTTP');
    assert.equal(await app.host.server.processInbox(), 1, 'Territory verified and applied Home digest');
  }
  const playerHeaders = (actor: string) => ({ Authorization: `Bearer ${playerTokens.get(actor)!}`, 'Content-Type': 'application/json' });
  const operate = (origin: string, path: string, headers: HeadersInit, body?: unknown) => fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const authorityState = async () => json<Record<string, unknown>>(await fetch(`${authorityOrigin}/local/registry/state`, { headers: registryAuth }));
  const policyState = async () => json<{ state: { rawInventory: Record<string, number>; portInventory: Record<string, number>; vessels: Record<string, { manifest: { entries: unknown[] } }> }; decisions: Record<string, unknown> }>(await fetch(`${policyOrigin}/local/state`, { headers: playerHeaders(policy.ids.actor) }));
  const simulationState = async () => json<{ simulation: { tick: number; rawStock: Array<{ commodity: string; count: number }>; productStock: Array<{ commodity: string; count: number }>; productionJobs: Array<{ kind: string; inputs: Array<{ commodity: string; count: number }> }>; handlingJobs: Array<{ operation: string; cargo: Array<{ commodity: string; count: number }> }>; vessels: Array<{ status: string; cargo: Array<{ commodity: string; count: number }> }> }; visits: Record<string, { decision: { accepted: boolean; reason: string }; evidenceVerification?: unknown }> }>(await fetch(`${simOrigin}/local/state`, { headers: playerHeaders(simulation.ids.actor) }));
  const pump = async (server: { processInbox(): Promise<number>; processOutbox(): Promise<number> }) => {
    const count = await server.processInbox();
    const sent = await server.processOutbox();
    return { count, sent };
  };
  const tick = async (count: number) => {
    for (let index = 0; index < count; index++) {
      await json(await operate(simOrigin, '/local/admin/tick', registryAuth, {}));
      await pump(simulation.host.server);
      await pump(authority.authority.server);
    }
  };
  const requestEntry = async (territory: string, port: string, route: string, cargo?: unknown) => json<Record<string, unknown>>(await fetch(`${authorityOrigin}/local/registry/entry`, {
    method: 'POST', headers: registryAuth, body: JSON.stringify({ territory, port, route, ...(cargo ? { cargo } : {}) })
  }));
  const requestExit = async (territory: string, port: string) => json<Record<string, unknown>>(await fetch(`${authorityOrigin}/local/registry/departure`, {
    method: 'POST', headers: registryAuth, body: JSON.stringify({ territory, port })
  }));

  await t.test('A produces ore and metal, transfers to port, loads, and publishes adopted cargo operation', async () => {
    assert.equal((await operate(policyOrigin, '/local/mine', playerHeaders(policy.ids.actor), { count: 2 })).status, 200, 'A mining succeeds using Player credentials');
    assert.equal((await operate(policyOrigin, '/local/manufacture', playerHeaders(policy.ids.actor), { count: 1, recipe: 'ore-to-metal' })).status, 200, 'A consumes two ore into one metal');
    assert.equal((await operate(policyOrigin, '/local/transfer', playerHeaders(policy.ids.actor), { direction: 'to-port', variety: policy.ids.varieties.metal, count: 1 })).status, 200, 'A transfers produced metal to port inventory');
    const before = await policyState();
    assert.equal(before.state.rawInventory[policy.ids.varieties.ore], 0);
    assert.equal(before.state.rawInventory[policy.ids.varieties.metal], 0);
    assert.equal(before.state.portInventory[policy.ids.varieties.metal], 1);
    const entry = await requestEntry(policy.ids.actor, policy.ids.ports[0]!, policy.ids.routes[0]!);
    await pump(authority.authority.server);
    const received = await pump(policy.host.server);
    assert.equal(received.count, 1, 'A receives Registry EntryRequest via HTTP Inbox');
    await pump(policy.host.server);
    await pump(authority.authority.server);
    const entryId = String(entry.id);
    assert.equal((await policyState()).state.vessels[authority.ids.vessel]!.manifest.entries.length, 0, 'initial Registry vessel is locally empty');
    assert.equal((await operate(policyOrigin, '/local/load', playerHeaders(policy.ids.actor), { vessel: authority.ids.vessel, variety: policy.ids.varieties.metal, count: 1 })).status, 200, 'active possessor loads through actual Player-authenticated endpoint');
    const loaded = await policyState();
    assert.equal(loaded.state.portInventory[policy.ids.varieties.metal], 0);
    assert.deepEqual(loaded.state.vessels[authority.ids.vessel]!.manifest.entries, [{ variety: policy.ids.varieties.metal, count: 1, data: {} }]);
    await pump(policy.host.server);
    await pump(authority.authority.server);
    artifacts.activityWrappers.push((await archivedActivities(policy.host.server, 'CargoOperationEvent')).at(-1));
    const registry = await authorityState() as { cargo: { entries: Array<{ variety: string; count: number }> }; events: Array<{ type: string }> };
    assert.equal(registry.cargo.entries.find((item) => item.variety === policy.ids.varieties.metal)?.count, 1, 'Registry explicitly adopts A CargoOperationEvent');
    assert.ok(registry.events.some((event) => event.type === 'CargoOperationEvent'));
    assert.ok(entryId.length > 0);
  });

  let aExitId = '';
  let bEntryId = '';
  await t.test('A signed ExitEvent independently resolves and verifies before exact-evidence B entry', async () => {
    await requestExit(policy.ids.actor, policy.ids.ports[0]!);
    await pump(authority.authority.server);
    await pump(policy.host.server);
    await pump(authority.authority.server);
    const registry = await authorityState() as { exitEvidence: string[]; requests: Record<string, { journey?: { exitEvidence?: string }; cargo?: unknown }> };
    aExitId = registry.exitEvidence.at(-1)!;
    assert.ok(aExitId, 'Registry stores A ExitEvent reference');
    const fetchedExit = await json<Record<string, unknown>>(await fetch(aExitId));
    artifacts.objects.push(fetchedExit);
    assert.equal(fetchedExit.type, 'ExitEvent');
    const resolved = await resolveExitEvidence(aExitId, { vessel: authority.ids.vessel, registry: authority.ids.actor.registry });
    assert.equal(resolved.verification.cryptographic.verified, true, 'real HTTP proof verification');
    assert.equal(resolved.verification.attribution.attributed, true, 'key belongs to A Territory');
    assert.equal(resolved.verification.expectedIssuer.matches, true, 'A is expected evidence publisher');
    assert.equal(resolved.binding.bound, true, 'evidence binds Registry vessel and original EntryRequest');
    assert.equal(resolved.entry?.id, fetchedExit.entryRequest, 'A evidence resolves its original Registry-issued EntryRequest');
    artifacts.verification.push(resolved.verification, resolved.binding);
    artifacts.activityWrappers.push((await archivedActivities(policy.host.server, 'ExitEvent')).at(-1));
    const bEntry = await requestEntry(simulation.ids.actor, simulation.ids.ports[0]!, simulation.ids.routes[0]!);
    bEntryId = String(bEntry.id);
    const request = (await authorityState() as { requests: Record<string, { journey: { exitEvidence?: string }; cargo: { entries: unknown[] } }> }).requests[bEntryId]!;
    assert.equal(request.journey.exitEvidence, aExitId, 'Registry supplies exact A ExitEvent reference');
    assert.deepEqual(request.cargo, fetchedExit.cargo, 'B request manifest exactly corresponds to exit evidence');
    artifacts.activityWrappers.push((await archivedActivities(authority.authority.server, 'EntryRequest')).find((activity) => (activity.object as Record<string, unknown>).id === bEntryId));
    await pump(authority.authority.server);
    assert.equal((await pump(simulation.host.server)).count, 1, 'B receives actual signed Registry request');
    const waiting = await simulationState();
    assert.equal(waiting.visits[bEntryId]?.decision.accepted, true, 'B accepts after checking signed evidence and binding');
    assert.equal(waiting.simulation.vessels[0]?.status, 'pending', 'entry does not immediately imply berth');
    assert.equal((await operate(simOrigin, '/local/unload', registryAuth, { entryRequest: bEntryId, cargo: { entries: [{ variety: policy.ids.varieties.metal, count: 1, data: {} }] }, duration: 2 })).status, 403, 'admin credential cannot impersonate the Player possessor');
    await tick(1);
    const berthed = await simulationState();
    assert.equal(berthed.simulation.vessels[0]?.status, 'berthed', 'B completes berthing only on a simulation tick');
    const possessorAuth = playerHeaders(simulation.ids.actor);
    const unload = await operate(simOrigin, '/local/unload', possessorAuth, { entryRequest: bEntryId, cargo: { entries: [{ variety: policy.ids.varieties.metal, count: 1, data: {} }] }, duration: 2 });
    assert.equal(unload.status, 200, `B schedules timed unload: ${await unload.clone().text()}`);
    const pendingUnload = await simulationState();
    assert.equal(pendingUnload.simulation.handlingJobs[0]?.operation, 'unload', 'cargo remains reserved while unload is incomplete');
    assert.equal(pendingUnload.simulation.rawStock.length, 0, 'uncompleted unload has not fabricated imported stock');
    assert.equal((await fetch(`${authorityOrigin}/local/registry/adoption`, { method: 'POST', headers: registryAuth, body: JSON.stringify({ adoption: false }) })).status, 200);
    await tick(1);
    assert.equal((await simulationState()).simulation.rawStock.length, 0, 'one of two unload ticks is incomplete');
    await tick(1);
    const unloaded = await simulationState();
    assert.equal(unloaded.simulation.rawStock[0]?.commodity, policy.ids.varieties.metal, 'completed unload puts A metal identity into B raw stock');
    assert.equal(unloaded.simulation.rawStock[0]?.count, 1);
    await pump(authority.authority.server);
    artifacts.activityWrappers.push((await archivedActivities(simulation.host.server, 'CargoOperationEvent')).filter((activity) => (activity.object as Record<string, unknown>).operation === 'unload').at(-1));
    assert.equal((await operate(simOrigin, '/local/manufacture', possessorAuth, { count: 1, recipe: 'imported' })).status, 200, 'B schedules imported-metal reprocessing');
    const reserved = await simulationState();
    assert.equal(reserved.simulation.rawStock.length, 0, 'manufacturing immediately reserves and removes imported input');
    assert.deepEqual(reserved.simulation.productionJobs[0]?.inputs, [{ commodity: policy.ids.varieties.metal, count: 1 }]);
    await tick(2);
    const refined = await simulationState();
    assert.equal(refined.simulation.productStock[0]?.commodity, simulation.ids.varieties.refined);
    assert.equal(refined.simulation.productStock[0]?.count, 1);
    assert.equal((await operate(simOrigin, '/local/load', possessorAuth, { entryRequest: bEntryId, cargo: { entries: [{ variety: simulation.ids.varieties.refined, count: 1, data: {} }] }, duration: 1 })).status, 200, 'B schedules refined output for reload');
    await tick(1);
    const reloaded = await simulationState();
    assert.equal(reloaded.simulation.productStock.length, 0);
    assert.equal(reloaded.simulation.vessels[0]?.cargo[0]?.commodity, simulation.ids.varieties.refined);
    await pump(authority.authority.server);
    const ignored = await authorityState() as { cargo: { entries: Array<{ variety: string }> }; events: Array<{ type: string; operation?: string }> };
    assert.ok(ignored.events.some((event) => event.type === 'CargoOperationEvent' && event.operation === 'unload'));
    assert.ok(ignored.cargo.entries.some((item) => item.variety === policy.ids.varieties.metal), 'Registry ignored unload while B retained the completed import');
    assert.equal((await fetch(`${authorityOrigin}/local/registry/adoption`, { method: 'POST', headers: registryAuth, body: JSON.stringify({ adoption: true }) })).status, 200);
    await requestExit(simulation.ids.actor, simulation.ids.ports[0]!);
    await pump(authority.authority.server);
    await pump(simulation.host.server);
    await tick(1);
    await pump(authority.authority.server);
    const afterExit = await authorityState() as { exitEvidence: string[] };
    const bExitId = afterExit.exitEvidence.at(-1)!;
    const bExit = await json<Record<string, unknown>>(await fetch(bExitId));
    artifacts.objects.push(bExit);
    assert.equal(bExit.type, 'ExitEvent');
    const independentlyVerified = await resolveExitEvidence(bExitId, { vessel: authority.ids.vessel, registry: authority.ids.actor.registry });
    assert.equal(independentlyVerified.verification.cryptographic.verified, true, 'B ExitEvent proof independently verifies');
    assert.equal(independentlyVerified.verification.attribution.attributed, true);
    assert.equal(independentlyVerified.verification.expectedIssuer.matches, true);
    assert.equal(independentlyVerified.binding.bound, true, 'B evidence binds original B EntryRequest');
    assert.equal(independentlyVerified.entry?.id, bEntryId, 'B evidence resolves the exact original Registry-issued B EntryRequest');
    artifacts.verification.push(independentlyVerified.verification, independentlyVerified.binding);
    artifacts.activityWrappers.push((await archivedActivities(simulation.host.server, 'ExitEvent')).at(-1));
    assert.deepEqual((bExit.cargo as { entries: Array<{ variety: string }> }).entries.map((item) => item.variety), [simulation.ids.varieties.refined]);
  });

  await t.test('B-native production demonstrates shortage, reservations, and completed output on ticks', async () => {
    const auth = playerHeaders(simulation.ids.actor);
    const shortage = await operate(simOrigin, '/local/manufacture', auth, { count: 1, recipe: 'native' });
    assert.equal(shortage.status, 400, 'manufacture without ore is rejected as an invalid domain operation');
    const before = await simulationState();
    assert.equal(before.simulation.productionJobs.length, 0);
    assert.equal((await operate(simOrigin, '/local/mine', auth, { count: 1, duration: 2 })).status, 200, 'B-native mine job starts');
    const mining = await simulationState();
    assert.equal(mining.simulation.rawStock.length, 0, 'reserved mine output is not available before completion');
    assert.equal(mining.simulation.productionJobs[0]?.kind, 'mine');
    await tick(2);
    assert.equal((await simulationState()).simulation.rawStock[0]?.commodity, simulation.ids.varieties.ore);
    assert.equal((await operate(simOrigin, '/local/manufacture', auth, { count: 1, recipe: 'native' })).status, 200, 'local ore can be reserved by B-native manufacture');
    const manufacturing = await simulationState();
    assert.equal(manufacturing.simulation.rawStock.length, 0, 'reserved ore cannot be reused');
    assert.deepEqual(manufacturing.simulation.productionJobs[0]?.inputs, [{ commodity: simulation.ids.varieties.ore, count: 1 }]);
    await tick(2);
    assert.equal((await simulationState()).simulation.productStock[0]?.commodity, simulation.ids.varieties.metal);
  });

  await t.test('cargo mismatch remains a visible Territory decision and is not reconciled by baseware', async () => {
    assert.ok(aExitId && bEntryId);
    const mismatch = await requestEntry(policy.ids.actor, policy.ids.ports[0]!, policy.ids.routes[0]!, { entries: [] });
    await pump(authority.authority.server);
    assert.equal((await pump(policy.host.server)).count, 1);
    const decision = (await policyState()).decisions[String(mismatch.id)] as { accepted: boolean; reason?: string; evidence?: { verification: unknown; difference: unknown } };
    assert.equal(decision.accepted, false);
    assert.equal(decision.reason, 'cargo-mismatch', 'A exposes its local mismatch rule as the decision fact');
    assert.ok(decision.evidence?.verification && decision.evidence.difference, 'decision retains real evidence verification and descriptive cargo difference');
    artifacts.localDecisions.push(decision);
    assert.deepEqual((mismatch as { cargo: unknown }).cargo, { entries: [] }, 'Registry declaration remains unmodified');
    assert.ok((await policyState()).state.vessels[authority.ids.vessel] === undefined, 'rejected manifest was not installed as a vessel');
  });

  console.log(`CIRCULATION_ARTIFACT ${JSON.stringify({ format: 'sanitized-circulation-observation', evidence: { aExitId, bEntryId }, ...artifacts })}`);
});
