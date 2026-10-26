import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveDiplomaticToken } from '@fctp/auth';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';

const admin = 'delivery-outage-test-admin';

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

test('completed Territory load survives Registry outage and its durable signed delta is replayed exactly once', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-delivery-outage-'));
  let authority: Awaited<ReturnType<typeof createAuthorityApp>> | undefined;
  let policy: Awaited<ReturnType<typeof createPolicyApp>> | undefined;
  t.after(async () => {
    await policy?.host.close();
    await authority?.authority.close();
    await rm(directory, { recursive: true, force: true });
  });

  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const policyOrigin = `http://127.0.0.1:${await freePort()}`;
  const authorityStore = join(directory, 'authority.json');
  const authorityKeys = join(directory, 'authority.keys.json');
  const policyStore = join(directory, 'policy.json');
  const captures: Array<{ url: string; payload: string }> = [];
  const captureTransport: typeof fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST' && typeof init.body === 'string') captures.push({ url, payload: init.body });
    return fetch(input, init);
  };

  authority = await createAuthorityApp({ origin: authorityOrigin, storeFile: authorityStore, keyFile: authorityKeys, adminSecret: admin });
  policy = await createPolicyApp({
    origin: policyOrigin, storeFile: policyStore, authorityOrigin, peerOrigin: policyOrigin,
    adminSecret: admin, fetcher: captureTransport
  });
  await authority.authority.listen(Number(new URL(authorityOrigin).port));
  await policy.host.listen(Number(new URL(policyOrigin).port));

  const registryAuth = { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' };
  const { nativeToken } = await json<{ nativeToken: string }>(await fetch(`${authorityOrigin}/local/home/issue`, {
    method: 'POST', headers: registryAuth, body: JSON.stringify({})
  }));
  const playerToken = await deriveDiplomaticToken(nativeToken, policy.ids.actor);
  assert.equal((await fetch(`${authorityOrigin}/local/home/digest-request`, {
    method: 'POST', headers: registryAuth, body: JSON.stringify({ resourceActor: policy.ids.actor })
  })).status, 202);
  assert.equal(await authority.authority.server.processOutbox(), 1);
  assert.equal(await policy.host.server.processInbox(), 1);
  const playerAuth = { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' };
  const operate = (path: string, body: unknown) => fetch(`${policyOrigin}${path}`, {
    method: 'POST', headers: playerAuth, body: JSON.stringify(body)
  });

  assert.equal((await operate('/local/mine', { count: 2 })).status, 200);
  assert.equal((await operate('/local/manufacture', { count: 1, recipe: 'ore-to-metal' })).status, 200);
  assert.equal((await operate('/local/transfer', { direction: 'to-port', variety: policy.ids.varieties.metal, count: 1 })).status, 200);
  assert.equal((await fetch(`${authorityOrigin}/local/registry/entry`, {
    method: 'POST', headers: registryAuth,
    body: JSON.stringify({ territory: policy.ids.actor, port: policy.ids.ports[0], route: policy.ids.routes[0] })
  })).status, 202);
  assert.equal(await authority.authority.server.processOutbox(), 1);
  assert.equal(await policy.host.server.processInbox(), 1);
  await policy.host.server.processInbox();
  await policy.host.server.processOutbox();
  await authority.authority.server.processInbox();

  const policyBeforeOutage = await json<{ state: { portInventory: Record<string, number>; vessels: Record<string, { manifest: { entries: unknown[] } }> } }>(await fetch(`${policyOrigin}/local/state`, { headers: playerAuth }));
  assert.equal(policyBeforeOutage.state.portInventory[policy.ids.varieties.metal], 1);
  assert.equal(policyBeforeOutage.state.vessels[authority.ids.vessel]!.manifest.entries.length, 0);

  const registryInbox = `${authorityOrigin}/actors/registry/inbox`;
  await authority.authority.close();
  authority = undefined;
  const captureStart = captures.length;
  assert.equal((await operate('/local/load', { vessel: `${authorityOrigin}/objects/vessels/demo`, variety: policy.ids.varieties.metal, count: 1 })).status, 200);
  const completedLoad = await json<{ state: { portInventory: Record<string, number>; vessels: Record<string, { manifest: { entries: unknown[] } }> } }>(await fetch(`${policyOrigin}/local/state`, { headers: playerAuth }));
  assert.equal(completedLoad.state.portInventory[policy.ids.varieties.metal], 0);
  assert.deepEqual(completedLoad.state.vessels[`${authorityOrigin}/objects/vessels/demo`]!.manifest.entries, [{ variety: policy.ids.varieties.metal, count: 1, data: {} }]);
  assert.equal(await policy.host.server.processOutbox(), 0, 'Registry outage leaves delivery queued');
  const queued = await policy.host.server.store.read((store) => store.outbox.map((item) => structuredClone(item)));
  assert.equal(queued.length, 1);
  assert.equal(queued[0]!.inbox, registryInbox);
  const captured = captures.slice(captureStart).find((item) => item.url === registryInbox);
  assert.ok(captured, 'capture wrapper observed the actual outgoing HTTP payload');
  assert.equal(queued[0]!.payload, captured.payload);
  const signedActivity = JSON.parse(captured.payload) as { id: string; object: { id: string; type: string; operation: string } };
  assert.equal(signedActivity.object.type, 'CargoOperationEvent');
  assert.equal(signedActivity.object.operation, 'load');
  assert.ok(signedActivity.id);
  const durableIdentity = { id: queued[0]!.id, activityId: signedActivity.id, objectId: signedActivity.object.id, payload: queued[0]!.payload };

  authority = await createAuthorityApp({ origin: authorityOrigin, storeFile: authorityStore, keyFile: authorityKeys, adminSecret: admin });
  await authority.authority.listen(Number(new URL(authorityOrigin).port));
  await policy.host.server.store.transaction((store) => {
    const item = store.outbox.find((candidate) => candidate.id === durableIdentity.id);
    assert.ok(item);
    item.nextAttemptAt = 0;
  });
  assert.equal(await policy.host.server.processOutbox(), 1, 'queued signed Activity is delivered after Registry restart');
  assert.equal(await authority.authority.server.processInbox(), 1, 'Registry processes the delivered inbox item');
  const delivered = await json<{ cargo: { entries: Array<{ variety: string; count: number }> }; events: Array<{ id: string; type: string }> }>(await fetch(`${authorityOrigin}/local/registry/state`, { headers: registryAuth }));
  assert.deepEqual(delivered.cargo.entries, [{ variety: policy.ids.varieties.metal, count: 1, data: {} }]);
  assert.equal(delivered.events.filter((event) => event.id === durableIdentity.objectId && event.type === 'CargoOperationEvent').length, 1);

  const duplicateOne = await fetch(registryInbox, { method: 'POST', headers: { 'Content-Type': 'application/activity+json' }, body: captured.payload });
  const duplicateTwo = await fetch(registryInbox, { method: 'POST', headers: { 'Content-Type': 'application/activity+json' }, body: captured.payload });
  assert.equal(duplicateOne.status, 202);
  assert.equal(duplicateTwo.status, 202);
  assert.equal(await authority.authority.server.processInbox(), 0, 'duplicate POSTs do not add an accepted inbox item');
  await authority.authority.close();
  authority = undefined;
  const restarted = await createAuthorityApp({ origin: authorityOrigin, storeFile: authorityStore, keyFile: authorityKeys, adminSecret: admin });
  authority = restarted;
  await authority.authority.listen(Number(new URL(authorityOrigin).port));
  const persisted = await json<{ cargo: { entries: Array<{ variety: string; count: number }> }; events: Array<{ id: string; type: string }> }>(await fetch(`${authorityOrigin}/local/registry/state`, { headers: registryAuth }));
  assert.deepEqual(persisted.cargo, delivered.cargo);
  assert.equal(persisted.events.filter((event) => event.id === durableIdentity.objectId && event.type === 'CargoOperationEvent').length, 1);
  assert.deepEqual(await policy.host.server.store.read((store) => {
    const item = store.outbox.find((candidate) => candidate.id === durableIdentity.id);
    return item && { id: item.id, payload: item.payload, activityId: (item.activity as { id: string }).id };
  }), undefined, 'successful delivery removes only the acknowledged outbox item');
  const territoryAfterRestart = await json<{ state: { vessels: Record<string, { manifest: { entries: unknown[] } }> } }>(await fetch(`${policyOrigin}/local/state`, { headers: playerAuth }));
  assert.deepEqual(territoryAfterRestart.state.vessels[`${authorityOrigin}/objects/vessels/demo`]!.manifest.entries, completedLoad.state.vessels[`${authorityOrigin}/objects/vessels/demo`]!.manifest.entries);
  await policy.host.close();
  policy = await createPolicyApp({
    origin: policyOrigin, storeFile: policyStore, authorityOrigin, peerOrigin: policyOrigin,
    adminSecret: admin, fetcher: captureTransport
  });
  await policy.host.listen(Number(new URL(policyOrigin).port));
  assert.equal((await fetch(`${policyOrigin}/local/state`, { headers: playerAuth })).status, 200, 'enrolled token state survives Territory restart');
  assert.equal(await policy.host.server.store.read((store) => store.remoteActors[`${authorityOrigin}/actors/registry`]?.inbox), registryInbox, 'recipient route cache survives Territory restart');
  assert.deepEqual(durableIdentity, { id: queued[0]!.id, activityId: signedActivity.id, objectId: signedActivity.object.id, payload: captured.payload });
});
