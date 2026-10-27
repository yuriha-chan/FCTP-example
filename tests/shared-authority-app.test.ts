import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveDiplomaticToken } from '@fctp/auth';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';

const players = ['player', 'player-2', 'player-3', 'player-4', 'player-5'];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('one shared Authority serves five Players and a vessel-isolated Registry to both real Territory factories', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-shared-authority-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const policyOrigin = `http://127.0.0.1:${await freePort()}`;
  const simulationOrigin = `http://127.0.0.1:${await freePort()}`;
  const admin = 'shared-authority-admin';
  const authority = await createAuthorityApp({ origin: authorityOrigin, storeFile: join(directory, 'authority.json'), adminSecret: admin, playerNames: players });
  const policy = await createPolicyApp({ origin: policyOrigin, storeFile: join(directory, 'policy.json'), authorityOrigin, playerNames: players, peerOrigin: simulationOrigin, adminSecret: admin });
  const simulation = await createSimulationApp({ origin: simulationOrigin, storeFile: join(directory, 'simulation.json'), authorityOrigin, playerNames: players, peerOrigin: policyOrigin, adminSecret: admin });
  t.after(async () => {
    await simulation.host.close();
    await policy.host.close();
    await authority.authority.close();
    await rm(directory, { recursive: true, force: true });
  });
  await authority.authority.listen(Number(new URL(authorityOrigin).port));
  await policy.host.listen(Number(new URL(policyOrigin).port));
  await simulation.host.listen(Number(new URL(simulationOrigin).port));

  assert.deepEqual(Object.keys(authority.ids.players), players);
  assert.deepEqual(Object.keys(authority.ids.vessels), players);
  assert.ok(Object.values(await authority.registry.fleet()).every((state) => state.adoption));
  assert.equal(authority.ids.vessels.player, `${authorityOrigin}/objects/vessels/demo`);
  for (const name of players.slice(1)) assert.equal(authority.ids.vessels[name], `${authorityOrigin}/objects/vessels/${name}`);
  for (const id of Object.values(authority.ids.players)) assert.equal((await fetch(id)).status, 200);
  for (const id of Object.values(authority.ids.vessels)) assert.equal((await fetch(id)).status, 200);

  const adminHeaders = { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' };
  const tokens = new Map<string, string>();
  for (const name of players) {
    const response = await fetch(`${authorityOrigin}/local/home/issue`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: authority.ids.players[name] }) });
    assert.equal(response.status, 200);
    const { nativeToken } = await response.json() as { nativeToken: string };
    tokens.set(name, nativeToken);
    for (const territory of [policy, simulation]) {
      const inbox = territory === policy ? policy.host.actor('territory').inbox : simulation.host.actor('territory').inbox;
      await authority.home.requestDigest(authority.ids.players[name]!, { id: territory.ids.actor, inbox });
      assert.equal(await authority.authority.server.processOutbox(), 1);
      assert.equal(await territory.host.server.processInbox(), 1);
    }
  }
  const native = (name: string) => ({ Authorization: `Bearer ${tokens.get(name)!}`, 'Content-Type': 'application/json' });
  for (const name of players) {
    const policyToken = await deriveDiplomaticToken(tokens.get(name)!, policy.ids.actor);
    const simToken = await deriveDiplomaticToken(tokens.get(name)!, simulation.ids.actor);
    assert.equal(await policy.host.server.authenticateDiplomaticToken(policy.ids.actor, policyToken), authority.ids.players[name]);
    assert.equal(await simulation.host.server.authenticateDiplomaticToken(simulation.ids.actor, simToken), authority.ids.players[name]);
    const vessel = authority.ids.vessels[name]!;
    assert.equal((await fetch(`${authorityOrigin}/local/registry/state?vessel=${encodeURIComponent(vessel)}`, { headers: native(name) })).status, 200);
    assert.equal((await fetch(`${authorityOrigin}/local/registry/state?vessel=${encodeURIComponent(authority.ids.vessels.player)}`, { headers: native(name) })).status, name === 'player' ? 200 : 403);
  }
  assert.equal((await fetch(`${authorityOrigin}/local/registry/fleet`, { headers: native('player') })).status, 403);
  assert.equal((await fetch(`${authorityOrigin}/local/registry/fleet`, { headers: adminHeaders })).status, 200);
  assert.equal((await (await fetch(`${authorityOrigin}/local/info`)).text()).includes(admin), false);

  const [entryOne, entryTwo] = await Promise.all([
    authority.registry.sendEntry({ territory: policy.ids.actor, port: policy.ids.ports[0]!, route: policy.ids.routes[0]!, vessel: authority.ids.vessels.player! }),
    authority.registry.sendEntry({ territory: policy.ids.actor, port: policy.ids.ports[0]!, route: policy.ids.routes[0]!, vessel: authority.ids.vessels['player-2']! })
  ]);
  assert.equal(await authority.authority.server.processOutbox(), 2);
  assert.equal(await policy.host.server.processInbox(), 2);
  const policyToken = await deriveDiplomaticToken(tokens.get('player')!, policy.ids.actor);
  const policyHeaders = { Authorization: `Bearer ${policyToken}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${policyOrigin}/local/mine`, { method: 'POST', headers: policyHeaders, body: JSON.stringify({ variety: policy.ids.varieties.ore, count: 2 }) })).status, 200);
  assert.equal((await fetch(`${policyOrigin}/local/transfer`, { method: 'POST', headers: policyHeaders, body: JSON.stringify({ variety: policy.ids.varieties.ore, count: 2, direction: 'to-port' }) })).status, 200);
  const load = await fetch(`${policyOrigin}/local/load`, { method: 'POST', headers: policyHeaders, body: JSON.stringify({ vessel: authority.ids.vessels.player, variety: policy.ids.varieties.ore, count: 1 }) });
  assert.equal(load.status, 200);
  const playerTwoToken = await deriveDiplomaticToken(tokens.get('player-2')!, policy.ids.actor);
  const secondLoad = await fetch(`${policyOrigin}/local/load`, { method: 'POST', headers: { Authorization: `Bearer ${playerTwoToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ vessel: authority.ids.vessels['player-2'], variety: policy.ids.varieties.ore, count: 1 }) });
  assert.equal(secondLoad.status, 200);
  await policy.host.server.processOutbox();
  assert.ok(await authority.authority.server.processInbox() >= 2);
  const fleet = await authority.registry.fleet();
  assert.equal(fleet[authority.ids.vessels.player]!.events.filter((event) => event.type === 'CargoOperationEvent').length, 1);
  assert.equal(fleet[authority.ids.vessels['player-2']!]!.events.filter((event) => event.type === 'CargoOperationEvent').length, 1);
  assert.equal(fleet[authority.ids.vessels.player]!.requests[entryOne.id]!.type, 'EntryRequest');
  assert.equal(fleet[authority.ids.vessels['player-2']!]!.requests[entryTwo.id]!.type, 'EntryRequest');
  assert.equal(Object.keys(await authority.registry.fleet()).length, 5);
});
