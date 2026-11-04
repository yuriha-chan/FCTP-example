import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveDiplomaticToken } from '@fctp/auth';
import type { URI } from '@fctp/protocol';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

interface TerritoryDependency {
  ids: { actor: URI };
  host: {
    actor(name: string): { inbox: URI };
    server: { processInbox(): Promise<number> };
  };
}

async function declareTerritoryTokens(
  authority: Awaited<ReturnType<typeof createAuthorityApp>>,
  territory: TerritoryDependency,
  actorIds: URI[]
): Promise<void> {
  for (const actorId of actorIds) {
    await authority.home.requestDigest(actorId, { id: territory.ids.actor, inbox: territory.host.actor('territory').inbox });
  }
  assert.equal(await authority.authority.server.processOutbox(), actorIds.length, 'token declarations are queued to the territory');
}

async function settleTerritoryDeclarations(territory: TerritoryDependency): Promise<unknown> {
  try {
    await territory.host.server.processInbox();
    return undefined;
  } catch (error) {
    return error;
  }
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

test('a configured administrator diplomatic token authorizes Policy admin operations as an ordinary account', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-admin-diplomatic-policy-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const policyOrigin = `http://127.0.0.1:${await freePort()}`;
  const adminSecret = 'policy-admin-secret';
  const authority = await createAuthorityApp({
    origin: authorityOrigin, storeFile: join(directory, 'authority.json'), adminSecret: 'authority-admin-secret',
    playerNames: ['player'], administratorNames: ['governor']
  });
  const policy = await createPolicyApp({
    origin: policyOrigin, storeFile: join(directory, 'policy.json'), administrator: `@governor@${new URL(authorityOrigin).host}`, adminSecret
  });
  t.after(async () => {
    await policy.host.close();
    await authority.authority.close();
    await rm(directory, { recursive: true, force: true });
  });
  await authority.authority.listen(Number(new URL(authorityOrigin).port));
  await policy.host.listen(Number(new URL(policyOrigin).port));

  const governorId = authority.ids.players.governor!;
  const playerId = authority.ids.players.player!;
  const governorNative = await authority.home.issueNativeToken(governorId);
  const playerNative = await authority.home.issueNativeToken(playerId);
  await declareTerritoryTokens(authority, policy, [governorId, playerId]);
  const declarationError = await settleTerritoryDeclarations(policy);

  const governorToken = await deriveDiplomaticToken(governorNative, policy.ids.actor);
  const playerToken = await deriveDiplomaticToken(playerNative, policy.ids.actor);
  const territoryHandle = policy.host.actor('territory').webfinger;
  assert.equal(typeof territoryHandle, 'string');
  const governorPermissions = await fetch(`${policyOrigin}/local/territory/permissions`, { headers: bearer(governorToken) });
  assert.equal(governorPermissions.status, 200);
  assert.deepEqual(await governorPermissions.json(), { [territoryHandle as string]: ['admin'] });
  const playerPermissions = await fetch(`${policyOrigin}/local/territory/permissions`, { headers: bearer(playerToken) });
  assert.equal(playerPermissions.status, 200);
  assert.deepEqual(await playerPermissions.json(), { [territoryHandle as string]: [] });
  assert.equal((await fetch(`${policyOrigin}/local/territory/permissions`)).status, 401);
  const admissionBody = JSON.stringify({ reviewMode: 'manual' });

  const playerState = await fetch(`${policyOrigin}/local/territory/state`, { headers: bearer(playerToken) });
  assert.equal(playerState.status, 200, 'the ordinary player diplomatic token is valid for player access');

  const governorAdmission = await fetch(`${policyOrigin}/local/territory/admin/admission`, { method: 'POST', headers: bearer(governorToken), body: admissionBody });
  assert.equal(governorAdmission.status, 200, 'the configured administrator diplomatic token authorizes a Policy Admin-tab operation');
  assert.equal((await policy.territory.ledger).admission.reviewMode, 'manual', 'the authorized Policy operation takes effect');

  const playerAdmission = await fetch(`${policyOrigin}/local/territory/admin/admission`, { method: 'POST', headers: bearer(playerToken), body: admissionBody });
  assert.equal(playerAdmission.status, 401, 'a normal player diplomatic token does not authorize Policy administration');

  const randomSecretAdmission = await fetch(`${policyOrigin}/local/territory/admin/admission`, { method: 'POST', headers: bearer('not-the-policy-secret'), body: admissionBody });
  assert.equal(randomSecretAdmission.status, 401, 'an arbitrary secret is not accepted as a Policy administrator');

  const governorMine = await fetch(`${policyOrigin}/local/territory/mine`, { method: 'POST', headers: bearer(governorToken), body: JSON.stringify({ count: 1 }) });
  assert.equal(governorMine.status, 200, 'the configured administrator is also an ordinary authenticated account');

  assert.equal(declarationError, undefined, 'the configured administrator token declaration is accepted by Policy');
});

test('a configured administrator diplomatic token authorizes Simulation admin operations as an ordinary account', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-admin-diplomatic-simulation-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const simulationOrigin = `http://127.0.0.1:${await freePort()}`;
  const adminSecret = 'simulation-admin-secret';
  const authority = await createAuthorityApp({
    origin: authorityOrigin, storeFile: join(directory, 'authority.json'), adminSecret: 'authority-admin-secret',
    playerNames: ['player'], administratorNames: ['governor']
  });
  const simulation = await createSimulationApp({
    origin: simulationOrigin, storeFile: join(directory, 'simulation.json'), administrator: `@governor@${new URL(authorityOrigin).host}`, peerOrigin: 'https://peer.example', adminSecret
  });
  t.after(async () => {
    await simulation.host.close();
    await authority.authority.close();
    await rm(directory, { recursive: true, force: true });
  });
  await authority.authority.listen(Number(new URL(authorityOrigin).port));
  await simulation.host.listen(Number(new URL(simulationOrigin).port));

  const governorId = authority.ids.players.governor!;
  const playerId = authority.ids.players.player!;
  const governorNative = await authority.home.issueNativeToken(governorId);
  const playerNative = await authority.home.issueNativeToken(playerId);
  await declareTerritoryTokens(authority, simulation, [governorId, playerId]);
  const declarationError = await settleTerritoryDeclarations(simulation);

  const governorToken = await deriveDiplomaticToken(governorNative, simulation.ids.actor);
  const playerToken = await deriveDiplomaticToken(playerNative, simulation.ids.actor);
  const territoryHandle = simulation.host.actor('territory').webfinger;
  assert.equal(typeof territoryHandle, 'string');
  const governorPermissions = await fetch(`${simulationOrigin}/local/territory/permissions`, { headers: bearer(governorToken) });
  assert.equal(governorPermissions.status, 200);
  assert.deepEqual(await governorPermissions.json(), { [territoryHandle as string]: ['admin'] });
  const playerPermissions = await fetch(`${simulationOrigin}/local/territory/permissions`, { headers: bearer(playerToken) });
  assert.equal(playerPermissions.status, 200);
  assert.deepEqual(await playerPermissions.json(), { [territoryHandle as string]: [] });
  assert.equal((await fetch(`${simulationOrigin}/local/territory/permissions`)).status, 401);
  const facilitiesBody = JSON.stringify({ mining: { enabled: true, capacity: 5 } });

  const playerState = await fetch(`${simulationOrigin}/local/territory/state`, { headers: bearer(playerToken) });
  assert.equal(playerState.status, 200, 'the ordinary player diplomatic token is valid for player access');

  const governorFacilities = await fetch(`${simulationOrigin}/local/territory/admin/facilities`, { method: 'POST', headers: bearer(governorToken), body: facilitiesBody });
  assert.equal(governorFacilities.status, 200, 'the configured administrator diplomatic token authorizes a Simulation Admin-tab operation');
  const facilities = (await simulation.territory.state()).simulation.config;
  assert.equal(facilities.miningEnabled, true, 'the authorized Simulation operation takes effect');
  assert.equal(facilities.miningCapacity, 5, 'the authorized Simulation operation applies its values');

  const playerFacilities = await fetch(`${simulationOrigin}/local/territory/admin/facilities`, { method: 'POST', headers: bearer(playerToken), body: facilitiesBody });
  assert.equal(playerFacilities.status, 403, 'an enrolled player diplomatic token is rejected from Simulation administration');

  const randomSecretFacilities = await fetch(`${simulationOrigin}/local/territory/admin/facilities`, { method: 'POST', headers: bearer('not-the-simulation-secret'), body: facilitiesBody });
  assert.equal(randomSecretFacilities.status, 401, 'an arbitrary secret is not accepted as a Simulation administrator');

  const governorMine = await fetch(`${simulationOrigin}/local/territory/mine`, { method: 'POST', headers: bearer(governorToken), body: JSON.stringify({ count: 1 }) });
  assert.equal(governorMine.status, 200, 'the configured administrator is also an ordinary authenticated account');

  assert.equal(declarationError, undefined, 'the configured administrator token declaration is accepted by Simulation');
});

const invalidAdministrators: Array<{ label: string; handle: (authorityHost: string) => string }> = [
  { label: 'an authority-role handle', handle: (authorityHost) => `@system.home@${authorityHost}` }
];

async function expectPolicyConstructionRejects(label: string, administrator: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-admin-diplomatic-invalid-policy-'));
  const origin = `http://127.0.0.1:${await freePort()}`;
  try {
    let policy: Awaited<ReturnType<typeof createPolicyApp>> | undefined;
    try {
      policy = await createPolicyApp({
        origin, storeFile: join(directory, 'policy.json'), administrator,
        adminSecret: 'policy-admin-secret'
      });
    } catch (error) {
      assert.ok(error instanceof TypeError, `${label} administrator configuration throws TypeError`);
      return;
    }
    await policy.host.close();
    assert.fail(`${label} administrator configuration is rejected when the Policy app is constructed`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectSimulationConstructionRejects(label: string, administrator: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-admin-diplomatic-invalid-simulation-'));
  const origin = `http://127.0.0.1:${await freePort()}`;
  try {
    let simulation: Awaited<ReturnType<typeof createSimulationApp>> | undefined;
    try {
      simulation = await createSimulationApp({
        origin, storeFile: join(directory, 'simulation.json'), administrator,
        peerOrigin: 'https://peer.example', adminSecret: 'simulation-admin-secret'
      });
    } catch (error) {
      assert.ok(error instanceof TypeError, `${label} administrator configuration throws TypeError`);
      return;
    }
    await simulation.host.close();
    assert.fail(`${label} administrator configuration is rejected when the Simulation app is constructed`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const candidate of invalidAdministrators) {
  test(`Policy rejects ${candidate.label} as the configured administrator`, async () => {
    const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
    await expectPolicyConstructionRejects(candidate.label, candidate.handle(new URL(authorityOrigin).host));
  });

  test(`Simulation rejects ${candidate.label} as the configured administrator`, async () => {
    const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
    await expectSimulationConstructionRejects(candidate.label, candidate.handle(new URL(authorityOrigin).host));
  });
}
