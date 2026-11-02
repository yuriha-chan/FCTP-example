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

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port allocated');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('Territory factories accept independent authorities and enforce their Player identities over HTTP', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-multiplayer-'));
  const origins = await Promise.all(Array.from({ length: 6 }, async () => `http://127.0.0.1:${await freePort()}`));
  const policyOrigin = `http://127.0.0.1:${await freePort()}`;
  const simulationOrigin = `http://127.0.0.1:${await freePort()}`;
  const admin = 'multiplayer-test-admin';
  const authorities = await Promise.all(origins.map((origin, index) => createAuthorityApp({ origin, storeFile: join(directory, `authority-${index}.json`), adminSecret: admin })));
  const policy = await createPolicyApp({ origin: policyOrigin, storeFile: join(directory, 'policy.json'), adminSecret: admin });
  const simulation = await createSimulationApp({ origin: simulationOrigin, storeFile: join(directory, 'simulation.json'), peerOrigin: policyOrigin, adminSecret: admin });
  const apps = [policy, simulation];
  const close = async () => {
    await Promise.all(apps.map((app) => app.host.close()));
    await Promise.all(authorities.map((app) => app.authority.close()));
    await rm(directory, { recursive: true, force: true });
  };
  t.after(close);
  for (let index = 0; index < authorities.length; index++) await authorities[index]!.authority.listen(Number(new URL(origins[index]!).port));
  await policy.host.listen(Number(new URL(policyOrigin).port));
  await simulation.host.listen(Number(new URL(simulationOrigin).port));
  await policy.territory.updateAdmissionPolicy({ trustedRegistry: { mode: 'allowlist', allowlist: [authorities[0]!.authority.actor('registry').id], denylist: [] } });
  await simulation.territory.updateAdmission({ trustedRegistry: { mode: 'allowlist', allowlist: [authorities[0]!.authority.actor('registry').id], denylist: [] } });

  const headers = { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' };
  const nativeTokens: string[] = [];
  for (const authority of authorities) {
    const issueResponse = await fetch(`${new URL(authority.ids.actor.home).origin}/local/home/issue`, { method: 'POST', headers, body: '{}' });
    assert.equal(issueResponse.status, 200);
    const { nativeToken } = await issueResponse.json() as { nativeToken: string };
    nativeTokens.push(nativeToken);
    const resourceTokens = await Promise.all(apps.map(async (app) => deriveDiplomaticToken(nativeToken, app.ids.actor)));
    for (const app of apps) {
      const authorityOrigin = new URL(authority.ids.actor.home).origin;
      const digestResponse = await fetch(`${authorityOrigin}/local/home/digest-request`, { method: 'POST', headers, body: JSON.stringify({ resourceActor: app.ids.actor }) });
      assert.equal(digestResponse.status, 202);
      assert.equal(await authority.authority.server.processOutbox(), 1);
      assert.equal(await app.host.server.processInbox(), 1, 'every namespace-valid Home declaration is accepted');
    }
    assert.ok(resourceTokens[1]);
  }

  for (const [index, app] of apps.entries()) {
    const origin = index === 0 ? policyOrigin : simulationOrigin;
    for (let playerIndex = 0; playerIndex < 5; playerIndex++) {
      const playerToken = await deriveDiplomaticToken(nativeTokens[playerIndex]!, app.ids.actor);
      const authorization = { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' };
      assert.equal((await fetch(`${origin}/local/mine`, { method: 'POST', headers: authorization, body: JSON.stringify({ count: 1 }) })).status, 200);
      assert.equal((await fetch(`${origin}/local/state`, { headers: authorization })).status, 200);
    }
    const sixthAuthorityToken = await deriveDiplomaticToken(nativeTokens[5]!, app.ids.actor);
    assert.equal((await fetch(`${origin}/local/mine`, { method: 'POST', headers: { Authorization: `Bearer ${sixthAuthorityToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1 }) })).status, 200);
  }

  for (const [index, app] of apps.entries()) {
    const territoryOrigin = index === 0 ? policyOrigin : simulationOrigin;
    const vesselAuthority = authorities[0]!;
    const entryResponse = await fetch(`${origins[0]}/local/registry/entry`, {
      method: 'POST', headers,
      body: JSON.stringify({ territory: app.ids.actor, port: app.ids.ports[0], route: app.ids.routes[0] })
    });
    assert.equal(entryResponse.status, 202);
    assert.equal(await vesselAuthority.authority.server.processOutbox(), 1);
    assert.equal(await app.host.server.processInbox(), 1);
    const playerTwo = await deriveDiplomaticToken(nativeTokens[1]!, app.ids.actor);
    const cargoRequest = index === 0
      ? { vessel: vesselAuthority.ids.vessel, variety: policy.ids.varieties.ore, count: 1 }
      : { entryRequest: (await entryResponse.json() as { id: string }).id, cargo: { entries: [{ variety: simulation.ids.varieties.ore, count: 1, data: {} }] }, duration: 1 };
    assert.equal((await fetch(`${territoryOrigin}/local/${index === 0 ? 'load' : 'unload'}`, { method: 'POST', headers: { Authorization: `Bearer ${playerTwo}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cargoRequest) })).status, 403);
  }
});
