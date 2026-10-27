import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveDiplomaticToken, createTokenDigest } from '@fctp/auth';
import type { URI, Vessel } from '@fctp/protocol';
import { createHost } from '@fctp/server-base';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';
import { discoverSimulationActions, previewSimulationAction } from '../apps/territory-sim/src/actions.js';
import { admitVessel, createSimulationState, scheduleHandling, type SimulationState } from '../apps/territory-sim/src/domain.js';

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No allocated port');
  const value = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return value;
}

test('simulation action discovery authorizes owned vessels and previews without mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sim-actions-'));
  const authorityOrigin = `http://127.0.0.1:${await port()}`;
  const origin = `http://127.0.0.1:${await port()}`;
  const authority = await createHost({ origin: authorityOrigin, storeFile: join(directory, 'authority.json'), actors: [{ name: 'registry', role: 'registry' }, { name: 'home', role: 'home' }, { name: 'player', role: 'player' }] });
  let owned!: Vessel;
  const app = await createSimulationApp({ origin, storeFile: join(directory, 'simulation.json'), authorityOrigin, peerOrigin: 'https://policy.example', adminSecret: 'admin', fetcher: async (input, init) => {
    if (String(input) === owned.id) return new Response(JSON.stringify(owned), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return fetch(input, init);
  } });
  const player = authority.actor('player').id as URI;
  const token = await deriveDiplomaticToken(new Uint8Array(32).fill(9), app.ids.actor);
  owned = { id: 'https://registry.example/vessels/owned', registry: `${authorityOrigin}/actors/registry`, possessor: player, capacity: 10 };
  try {
    await authority.listen(Number(new URL(authorityOrigin).port));
    await app.host.listen(Number(new URL(origin).port));
    const digest = await createTokenDigest(player, 1, token);
    const declaration = await authority.sign('home', { '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'], id: `${authority.actor('home').id}/token-digest/1`, type: 'Create', actor: authority.actor('home').id, to: [app.ids.actor], object: digest } as never);
    await app.host.server.receive(app.ids.actor, declaration);
    await app.host.server.processInbox();
    const url = `${origin}/local/actions?vessel=${encodeURIComponent(owned.id)}`;
    assert.equal((await fetch(`${origin}/local/actions?vessel=${encodeURIComponent(owned.id)}`, { headers: { Authorization: 'Bearer admin' } })).status, 403);
    assert.equal((await fetch(`${origin}/local/actions`, { headers: { Authorization: `Bearer ${token}` } })).status, 400);
    const before = await app.territory.state();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const discovery = await response.json() as { state: Record<string, unknown>; actions: Array<{ id: string; request?: { href: string; body?: Record<string, unknown> } }> };
    assert.equal(discovery.actions.find((action) => action.id === 'mine')?.request?.body?.count, 1);
    assert.equal(discovery.actions.find((action) => action.id === 'entry')?.request?.href, `${authorityOrigin}/local/registry/entry`);
    assert.ok(((await (await fetch(`${origin}/local/info`)).json()) as { endpoints: string[] }).endpoints.includes('/local/actions'));
    assert.deepEqual(await app.territory.state(), before);
    owned = { ...owned, possessor: 'https://other.example/actors/player' };
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 403);
  } finally {
    await app.host.close();
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('simulation discovery offers each rich stock identity and retains the vessel Registry', () => {
  const simulation = createSimulationState({ commodities: { ore: 'ore', nativeMetal: 'metal', importedMetal: 'imported', refinedProduct: 'refined' }, commodityMasses: { ore: 1, metal: 1, imported: 1, refined: 1 }, depositAmount: 10, miningCapacity: 2, miningEnabled: true, manufacturingSlots: 2, manufacturingTime: 1, portCapacity: 10, berthCapacity: 1 });
  simulation.rawStock.push({ commodity: 'ore', count: 1, quantityKind: 'Stack', data: { grade: 'low' } }, { commodity: 'imported', count: 1, quantityKind: 'Item', id: 'item-1', data: { origin: 'trade' } });
  admitVessel(simulation, 'sim-vessel', 10);
  simulation.vessels[0]!.status = 'berthed';
  const vessel = { id: 'https://registry-two.example/vessels/v', registry: 'https://registry-two.example/actors/registry', possessor: 'https://home.example/player', capacity: 10 };
  const result = discoverSimulationActions({ simulation, actor: 'https://sim.example/actors/territory', player: vessel.possessor, vesselId: vessel.id, vessel, origin: 'https://sim.example', visit: { request: { id: 'https://registry-two.example/requests/entry', vessel }, possessor: vessel.possessor, simulationVessel: 'sim-vessel', port: 'https://sim.example/ports/main', route: 'https://sim.example/routes/r', exited: false } });
  const loads = result.actions.filter((action) => action.id.startsWith('load:'));
  assert.equal(loads.length, 2);
  const itemLoad = loads.find((action) => action.id.includes('item-1'))!;
  assert.deepEqual(itemLoad.request?.body?.cargo, { entries: [{ variety: 'imported', id: 'item-1', data: { origin: 'trade' } }] });
  assert.equal(result.actions.find((action) => action.id === 'entry')?.request?.href, 'https://registry-two.example/local/registry/entry');
  assert.equal(result.actions.find((action) => action.id === 'departure')?.available, true);
});

test('known production rejection is an unavailable preview and unexpected errors propagate', () => {
  const simulation = {} as SimulationState;
  const action = previewSimulationAction(simulation, 'preview', 'Preview', { method: 'POST', href: 'https://sim.example/local/manufacture' }, 'effect', () => { throw new Error('production only supports homogeneous empty-data Stack ingredients'); });
  assert.equal(action.available, false);
  assert.throws(() => previewSimulationAction(simulation, 'preview', 'Preview', { method: 'POST', href: 'https://sim.example/local/manufacture' }, 'effect', () => { throw new Error('unexpected'); }), /unexpected/);
});

test('pending berth and reserved handling expose blockers without hiding cargo choices', () => {
  const simulation = createSimulationState({ commodities: { ore: 'ore', nativeMetal: 'metal', importedMetal: 'imported', refinedProduct: 'refined' }, commodityMasses: { ore: 1, metal: 1, imported: 1, refined: 1 }, depositAmount: 10, miningCapacity: 2, miningEnabled: true, manufacturingSlots: 2, manufacturingTime: 1, portCapacity: 1, berthCapacity: 1 });
  simulation.rawStock.push({ commodity: 'ore', count: 1, data: { grade: 'high' } });
  admitVessel(simulation, 'sim-vessel', 2);
  const vessel = { id: 'https://registry.example/vessels/v', registry: 'https://registry.example/actors/registry', possessor: 'https://home.example/player', capacity: 2 };
  const visit = { request: { id: 'https://registry.example/requests/entry', vessel }, possessor: vessel.possessor, simulationVessel: 'sim-vessel', port: 'https://sim.example/ports/main', route: 'https://sim.example/routes/r', exited: false };
  const pending = discoverSimulationActions({ simulation, actor: 'https://sim.example/actors/territory', player: vessel.possessor, vesselId: vessel.id, vessel, origin: 'https://sim.example', visit });
  assert.equal(pending.actions.find((action) => action.id === 'departure')?.reason, 'Vessel is waiting for a berth.');
  assert.equal(pending.actions.find((action) => action.id.startsWith('load:'))?.reason, 'vessel is not berthed');
  simulation.vessels[0]!.status = 'berthed';
  simulation.vessels[0]!.cargo.push({ commodity: 'metal', count: 1, data: {} });
  scheduleHandling(simulation, 'sim-vessel', 'load', [{ commodity: 'ore', count: 1, data: { grade: 'high' } }], 1);
  const queued = discoverSimulationActions({ simulation, actor: 'https://sim.example/actors/territory', player: vessel.possessor, vesselId: vessel.id, vessel, origin: 'https://sim.example', visit });
  assert.equal(queued.actions.find((action) => action.id === 'departure')?.reason, 'Cargo handling is pending.');
  assert.equal(queued.actions.find((action) => action.id.startsWith('load:'))?.available, false);
  assert.equal(queued.actions.find((action) => action.id.startsWith('load:'))?.reason, 'insufficient unreserved product stock: ore');
  assert.equal(queued.actions.find((action) => action.id.startsWith('unload:'))?.reason, 'port capacity exceeded');
});
