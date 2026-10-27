import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveDiplomaticToken } from '@fctp/auth';
import type { LocalActionDiscovery } from '@fctp/server-base';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createTerritoryState } from '../apps/territory-policy/src/domain.js';
import { discoverPolicyActions } from '../apps/territory-policy/src/actions.js';
import type { PolicyTerritoryLedger } from '../apps/territory-policy/src/territory.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('policy action discovery previews exact local rules without exposing or mutating live state', async () => {
  const origin = 'https://a.example';
  const actor = `${origin}/actors/territory`;
  const player = 'https://registry.example/actors/player';
  const vessel = 'https://registry.example/objects/vessels/one';
  const registry = 'https://registry.example/actors/registry';
  const ore = { id: `${origin}/objects/varieties/ore`, name: 'Ore', holder: actor, mass: 2, version: '1', production: [{ type: 'mine' as const, duration: 0, yield: [{ probability: 1, count: 1, data: {} }] }] };
  const metal = { id: `${origin}/objects/varieties/metal`, name: 'Metal', holder: actor, mass: 1, version: '1' };
  const policy = { miningPermitted: true, miningQuota: 0, oreReserve: 0, manufacturePermits: ['ore-to-metal'], recipes: [{ id: 'ore-to-metal', ingredients: { [ore.id]: 2 }, output: metal.id, outputCount: 1 }], warehouseLimits: {}, portLimits: {}, decisions: {} };
  const live = createTerritoryState(policy, [{ variety: ore, mass: 2 }, { variety: metal, mass: 1 }]);
  live.rawInventory[ore.id] = 1;
  live.portInventory[ore.id] = 1;
  live.vessels[vessel] = { capacity: 1, manifest: { entries: [] } };
  const ledger: PolicyTerritoryLedger = {
    state: live, admission: { registryAcceptance: [registry], territoryAcceptance: [], mismatchPolicy: 'reject', publicPorts: [] },
    visits: { [vessel]: { vessel, possessor: player, registry, entryRequest: `${origin}/entry/1`, port: `${origin}/objects/ports/east`, route: `${origin}/objects/routes/approach`, departed: false, cargo: { entries: [] } } },
    decisions: {}, processed: []
  };
  const territory = { get ledger() { return Promise.resolve(structuredClone(ledger)); } } as never;
  const before = structuredClone(live);
  const fetcher = async () => { throw new Error('persisted visit should avoid fetch'); };
  const result = await discoverPolicyActions({ actor, player, vessel, origin, ids: { actor, ports: [`${origin}/objects/ports/east`, `${origin}/objects/ports/west`], routes: [`${origin}/objects/routes/approach`, `${origin}/objects/routes/coastal`], areas: [], map: `${origin}/map`, varieties: { ore: ore.id, metal: metal.id }, assets: [] }, territory, fetcher });
  assert.equal(result.actions.find((action) => action.id === 'mine-ore')?.available, false);
  assert.equal(result.actions.find((action) => action.id === 'load-ore')?.available, false);
  assert.equal(result.actions.find((action) => action.id === 'unload-ore')?.available, false);
  const departure = result.actions.find((action) => action.id === 'depart-current-visit');
  assert.equal(departure?.request?.href, 'https://registry.example/local/registry/departure');
  assert.deepEqual(departure?.request?.body, { vessel, territory: actor, port: `${origin}/objects/ports/east`, route: `${origin}/objects/routes/approach` });
  assert.match(result.actions.find((action) => action.id === 'mine-ore')?.reason ?? '', /quota|reserve/i);
  assert.match(result.actions.find((action) => action.id === 'load-ore')?.reason ?? '', /capacity/i);
  assert.equal(result.state.visits && Object.keys(result.state.visits).length, 1);
  assert.deepEqual(live, before);
  await assert.rejects(discoverPolicyActions({ actor, player: 'https://registry.example/actors/other', vessel, origin, ids: { actor, ports: [], routes: [], areas: [], map: `${origin}/map`, varieties: { ore: ore.id, metal: metal.id }, assets: [] }, territory, fetcher }), { status: 403 });
});

test('policy HTTP action examples execute through an authenticated Player and real Registry', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-policy-actions-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const territoryOrigin = `http://127.0.0.1:${await freePort()}`;
  const admin = 'policy-actions-admin';
  const authority = await createAuthorityApp({ origin: authorityOrigin, storeFile: join(directory, 'authority.json'), adminSecret: admin, playerNames: ['player', 'other'] });
  const territory = await createPolicyApp({ origin: territoryOrigin, storeFile: join(directory, 'territory.json'), authorityOrigin, peerOrigin: 'https://peer.example', adminSecret: admin, playerNames: ['player', 'other'] });
  await authority.authority.listen(Number(new URL(authorityOrigin).port));
  await territory.host.listen(Number(new URL(territoryOrigin).port));
  t.after(async () => {
    await territory.host.close();
    await authority.authority.close();
    await rm(directory, { recursive: true, force: true });
  });

  const adminHeaders = { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' };
  const tokens = new Map<string, { native: string; diplomatic: string }>();
  for (const player of ['player', 'other']) {
    const playerId = authority.ids.players[player]!;
    const issued = await fetch(`${authorityOrigin}/local/home/issue`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: playerId }) });
    assert.equal(issued.status, 200);
    const { nativeToken } = await issued.json() as { nativeToken: string };
    const digest = await fetch(`${authorityOrigin}/local/home/digest-request`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: playerId, resourceActor: territory.ids.actor }) });
    assert.equal(digest.status, 202);
    assert.equal(await authority.authority.server.processOutbox(), 1);
    assert.equal(await territory.host.server.processInbox(), 1);
    tokens.set(player, { native: nativeToken, diplomatic: await deriveDiplomaticToken(nativeToken, territory.ids.actor) });
  }
  const playerToken = tokens.get('player')!.diplomatic;
  const nativeToken = tokens.get('player')!.native;
  const otherToken = tokens.get('other')!.diplomatic;
  const vessel = authority.ids.vessel;
  const discoveryUrl = `${territoryOrigin}/local/actions?vessel=${encodeURIComponent(vessel)}`;
  const discover = (token: string) => fetch(discoveryUrl, { headers: { Authorization: `Bearer ${token}` } });
  const execute = (request: { method: 'GET' | 'POST'; href: string; body?: Record<string, unknown> }, token = playerToken) => fetch(request.href, {
    method: request.method,
    headers: { Authorization: `Bearer ${token}`, ...(request.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(request.body ? { body: JSON.stringify(request.body) } : {})
  });
  const storesBeforeDiscovery = await Promise.all([
    territory.host.server.store.read((store) => structuredClone({ domain: store.domain, outbox: store.outbox, outboxArchive: store.outboxArchive })),
    authority.authority.server.store.read((store) => structuredClone({ domain: store.domain, outbox: store.outbox, outboxArchive: store.outboxArchive }))
  ]);

  assert.equal((await discover('invalid-credential')).status, 401);
  assert.equal((await discover(admin)).status, 401);
  assert.equal((await fetch(`${territoryOrigin}/local/actions`, { headers: { Authorization: `Bearer ${playerToken}` } })).status, 400);
  const otherVessel = authority.ids.vessels.other!;
  assert.equal((await fetch(`${territoryOrigin}/local/actions?vessel=${encodeURIComponent(otherVessel)}`, { headers: { Authorization: `Bearer ${playerToken}` } })).status, 403);

  const initialResponse = await discover(playerToken);
  assert.equal(initialResponse.status, 200);
  assert.equal(initialResponse.headers.get('cache-control'), 'no-store');
  const initial = await initialResponse.json() as LocalActionDiscovery;
  const action = (id: string) => initial.actions.find((item) => item.id === id)!;
  assert.equal(action('mine-ore').available, true);
  assert.equal(action('manufacture-metal').available, false, 'manufacture previews current empty stock');
  assert.equal(action('load-ore').available, false, 'cargo operations require an accepted local visit');
  const entry = action('request-entry-east').request!;
  assert.equal(entry.href, `${authorityOrigin}/local/registry/entry`);
  assert.deepEqual(entry.body, { vessel, territory: territory.ids.actor, port: territory.ids.ports[0], route: territory.ids.routes[0] });
  const unchanged = await Promise.all([
    territory.host.server.store.read((store) => ({ domain: store.domain, outbox: store.outbox, outboxArchive: store.outboxArchive })),
    authority.authority.server.store.read((store) => ({ domain: store.domain, outbox: store.outbox, outboxArchive: store.outboxArchive }))
  ]);
  assert.deepEqual(unchanged, storesBeforeDiscovery);

  const mine = action('mine-ore').request!;
  assert.equal((await execute(mine)).status, 200);
  let currentResponse = await discover(playerToken);
  let current = await currentResponse.json() as typeof initial;
  assert.equal(current.actions.find((item) => item.id === 'manufacture-metal')?.available, false, 'one mined ore is below recipe stock');
  const secondMine = current.actions.find((item) => item.id === 'mine-ore')!.request!;
  assert.equal((await execute(secondMine)).status, 200);
  currentResponse = await discover(playerToken);
  current = await currentResponse.json() as typeof initial;
  assert.equal((await execute(current.actions.find((item) => item.id === 'manufacture-metal')!.request!)).status, 200);
  currentResponse = await discover(playerToken);
  current = await currentResponse.json() as typeof initial;
  const transfer = current.actions.find((item) => item.id === 'to-port-metal')!.request!;
  assert.equal((await execute(transfer)).status, 200);
  currentResponse = await discover(playerToken);
  current = await currentResponse.json() as typeof initial;
  const registryEntry = current.actions.find((item) => item.id === 'request-entry-east')!.request!;
  const entryResponse = await execute(registryEntry, nativeToken);
  assert.equal(entryResponse.status, 202);
  assert.equal(await authority.authority.server.processOutbox(), 1);
  assert.equal(await territory.host.server.processInbox(), 1);
  await territory.host.server.processOutbox();
  await authority.authority.server.processInbox();

  currentResponse = await discover(playerToken);
  current = await currentResponse.json() as typeof initial;
  assert.equal(current.actions.find((item) => item.id === 'load-metal')?.available, true);
  const load = current.actions.find((item) => item.id === 'load-metal')!.request!;
  assert.deepEqual(load.body, { vessel, variety: territory.ids.varieties.metal, count: 1 });
  assert.equal((await execute(load)).status, 200);
  assert.equal(await territory.host.server.processOutbox(), 1);
  assert.equal(await authority.authority.server.processInbox(), 1);
  const registryAfterLoad = await authority.registry.state(vessel);
  assert.deepEqual(registryAfterLoad.cargo?.entries, [{ variety: territory.ids.varieties.metal, count: 1, data: {} }]);
  currentResponse = await discover(playerToken);
  current = await currentResponse.json() as typeof initial;
  const departure = current.actions.find((item) => item.id === 'depart-current-visit')!;
  assert.equal(departure.available, true);
  assert.equal(departure.request?.href, `${authorityOrigin}/local/registry/departure`);
  assert.deepEqual(departure.request?.body, { vessel, territory: territory.ids.actor, port: territory.ids.ports[0], route: territory.ids.routes[0] });
  const departureResponse = await execute(departure.request!, nativeToken);
  assert.equal(departureResponse.status, 202);
  assert.equal(await authority.authority.server.processOutbox(), 1);
  assert.equal(await territory.host.server.processInbox(), 1);
  assert.equal(await territory.host.server.processOutbox(), 2);
  await authority.authority.server.processInbox();

  assert.equal((await discover(otherToken)).status, 403);
  const policyState = await territory.territory.ledger;
  assert.equal(policyState.visits[vessel]?.departed, true);
  assert.equal(policyState.state.vessels[vessel], undefined);
  assert.deepEqual(policyState.visits[vessel]?.cargo.entries, [{ variety: territory.ids.varieties.metal, count: 1, data: {} }]);
  const registryState = await authority.registry.state(vessel);
  assert.equal(registryState.events.some((event) => event.type === 'DepartureEvent'), true);
  assert.deepEqual(registryState.cargo?.entries, [{ variety: territory.ids.varieties.metal, count: 1, data: {} }]);

  const blockedPolicy = structuredClone(policyState.state.policy);
  blockedPolicy.miningQuota = 0;
  const policyUpdate = await fetch(`${territoryOrigin}/local/admin/policy`, { method: 'POST', headers: adminHeaders, body: JSON.stringify(blockedPolicy) });
  assert.equal(policyUpdate.status, 200);
  const quotaDiscovery = await (await discover(playerToken)).json() as typeof initial;
  assert.equal(quotaDiscovery.actions.find((item) => item.id === 'mine-ore')?.available, false, 'availability reflects the current mining quota');
});
