import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveDiplomaticToken } from '@fctp/auth';
import type { URI } from '@fctp/protocol';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';

const adminSecret = 'authority-admin-secret';

interface AdminFixture {
  directory: string;
  origin: string;
  host: string;
  app: Awaited<ReturnType<typeof createAuthorityApp>>;
  governorId: URI;
  playerId: URI;
  governorNative: string;
  playerNative: string;
  registryActorId: URI;
  homeActorId: URI;
  governorHandle: string;
  playerHandle: string;
  registryAdminToken: string;
  homeAdminToken: string;
  playerRegistryToken: string;
  playerHomeToken: string;
  declarationError: unknown;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function createAdminFixture(prefix: string): Promise<AdminFixture> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const host = new URL(origin).host;
  const app = await createAuthorityApp({
    origin,
    storeFile: join(directory, 'authority.json'),
    adminSecret,
    playerNames: ['player'],
    administratorNames: ['governor'],
    administrator: `@governor@${host}`
  });
  try {
    await app.authority.listen(port);
    const governorId = app.ids.players.governor!;
    const playerId = app.ids.players.player!;
    const governorNative = await app.home.issueNativeToken(governorId);
    const playerNative = await app.home.issueNativeToken(playerId);
    const registryActorId = app.ids.actor.registry;
    const homeActorId = app.ids.actor.home;
    const registryInbox = app.authority.actor('registry').inbox as URI;
    await app.home.requestDigest(governorId, { id: registryActorId, inbox: registryInbox });
    await app.home.requestDigest(playerId, { id: registryActorId, inbox: registryInbox });
    assert.equal(await app.authority.server.processOutbox(), 2, 'both Registry token declarations are delivered to the Authority inbox');
    let declarationError: unknown;
    try {
      await app.authority.server.processInbox();
    } catch (error) {
      declarationError = error;
    }
    return {
      directory,
      origin,
      host,
      app,
      governorId,
      playerId,
      governorNative,
      playerNative,
      registryActorId,
      homeActorId,
      governorHandle: `@governor@${host}`,
      playerHandle: `@player@${host}`,
      registryAdminToken: await deriveDiplomaticToken(governorNative, registryActorId),
      homeAdminToken: await deriveDiplomaticToken(governorNative, homeActorId),
      playerRegistryToken: await deriveDiplomaticToken(playerNative, registryActorId),
      playerHomeToken: await deriveDiplomaticToken(playerNative, homeActorId),
      declarationError
    };
  } catch (error) {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function closeFixture(fixture: AdminFixture): Promise<void> {
  await fixture.app.authority.close();
  await rm(fixture.directory, { recursive: true, force: true });
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function postAvailability(origin: string, body: unknown, token: string): Promise<Response> {
  return fetch(`${origin}/local/home/accounts/availability`, {
    method: 'POST',
    headers: bearer(token),
    body: JSON.stringify(body)
  });
}

async function listAccounts(origin: string, token: string): Promise<Array<{ handle: string; actorId: string; available: boolean }>> {
  const response = await fetch(`${origin}/local/home/accounts`, { headers: bearer(token) });
  assert.equal(response.status, 200);
  const body = await response.json() as { accounts: Array<{ handle: string; actorId: string; available: boolean }> };
  return body.accounts;
}

test('the configured administrator diplomatic token authorizes Registry fleet reads and adoption', async () => {
  const fixture = await createAdminFixture('fctp-authority-admin-registry-');
  try {
    const fleetResponse = await fetch(`${fixture.origin}/local/registry/fleet`, { headers: bearer(fixture.registryAdminToken) });
    assert.equal(fleetResponse.status, 200, 'the configured administrator diplomatic token authorizes the Registry fleet read');
    const fleet = await fleetResponse.json() as Record<string, unknown>;
    const primaryVessel = fixture.app.ids.vessel;
    assert.ok(primaryVessel, 'the configured authority provides a primary vessel');
    assert.ok(Object.hasOwn(fleet, primaryVessel), 'the fleet read returns the configured vessel');

    const adoptionResponse = await fetch(`${fixture.origin}/local/registry/adoption`, {
      method: 'POST',
      headers: bearer(fixture.registryAdminToken),
      body: JSON.stringify({ adoption: false })
    });
    assert.equal(adoptionResponse.status, 200, 'the configured administrator diplomatic token authorizes Registry adoption');
    assert.equal((await fixture.app.registry.state()).adoption, false, 'the authorized adoption change takes effect');

    assert.equal(fixture.declarationError, undefined, 'the Registry accepts the administrator token declaration');
  } finally {
    await closeFixture(fixture);
  }
});

test('the configured administrator diplomatic token authorizes Home account listing and availability', async () => {
  const fixture = await createAdminFixture('fctp-authority-admin-home-');
  try {
    const accounts = await listAccounts(fixture.origin, fixture.homeAdminToken);
    const governorAccount = accounts.find((account) => account.handle === fixture.governorHandle);
    assert.ok(governorAccount, 'the account list includes the configured administrator');
    assert.equal(governorAccount!.actorId, fixture.governorId);

    const availabilityResponse = await postAvailability(fixture.origin, { handle: fixture.playerHandle, available: false }, fixture.homeAdminToken);
    assert.equal(availabilityResponse.status, 200, 'the configured administrator diplomatic token authorizes an availability change');

    const updated = await listAccounts(fixture.origin, fixture.homeAdminToken);
    assert.equal(updated.find((account) => account.handle === fixture.playerHandle)?.available, false, 'the authorized availability change takes effect');
  } finally {
    await closeFixture(fixture);
  }
});

test('permission maps list the authority actor with the requester roles', async () => {
  const fixture = await createAdminFixture('fctp-authority-permissions-');
  try {
    const homeHandle = fixture.app.authority.actor('home').webfinger;
    const registryHandle = fixture.app.authority.actor('registry').webfinger;
    assert.equal(typeof homeHandle, 'string');
    assert.equal(typeof registryHandle, 'string');

    const homeAdmin = await fetch(`${fixture.origin}/local/home/permissions`, { headers: bearer(fixture.governorNative) });
    assert.equal(homeAdmin.status, 200);
    assert.deepEqual(await homeAdmin.json(), { [homeHandle as string]: ['admin'] });

    const homePlayer = await fetch(`${fixture.origin}/local/home/permissions`, { headers: bearer(fixture.playerNative) });
    assert.equal(homePlayer.status, 200);
    assert.deepEqual(await homePlayer.json(), { [homeHandle as string]: [] });

    const registryAdmin = await fetch(`${fixture.origin}/local/registry/permissions`, { headers: bearer(fixture.registryAdminToken) });
    assert.equal(registryAdmin.status, 200);
    assert.deepEqual(await registryAdmin.json(), { [registryHandle as string]: ['admin'] });

    const registryPlayer = await fetch(`${fixture.origin}/local/registry/permissions`, { headers: bearer(fixture.playerRegistryToken) });
    assert.equal(registryPlayer.status, 200);
    assert.deepEqual(await registryPlayer.json(), { [registryHandle as string]: [] });

    assert.equal((await fetch(`${fixture.origin}/local/home/permissions`)).status, 401);
    assert.equal((await fetch(`${fixture.origin}/local/registry/permissions`)).status, 401);
  } finally {
    await closeFixture(fixture);
  }
});

test('Home stores verified administration entries in the account storage', async () => {
  const fixture = await createAdminFixture('fctp-authority-administration-storage-');
  try {
    const registryHandle = fixture.app.authority.actor('registry').webfinger;
    assert.equal(typeof registryHandle, 'string');

    const added = await fetch(`${fixture.origin}/local/home/administration`, {
      method: 'POST', headers: bearer(fixture.governorNative), body: JSON.stringify({ authorityId: fixture.registryActorId })
    });
    assert.equal(added.status, 200);
    const addedBody = await added.json() as { entry: Record<string, unknown> };
    assert.equal(addedBody.entry.authorityId, fixture.registryActorId);
    assert.equal(addedBody.entry.authorityHandle, registryHandle);
    assert.deepEqual(addedBody.entry.roles, ['registry']);
    assert.deepEqual(addedBody.entry.permissions, ['admin']);

    const listed = await fetch(`${fixture.origin}/local/home/administration`, { headers: bearer(fixture.governorNative) });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as { entries: Array<Record<string, unknown>> };
    assert.equal(listedBody.entries.length, 1);
    assert.equal(listedBody.entries[0]!.authorityId, fixture.registryActorId);

    const playerAdd = await fetch(`${fixture.origin}/local/home/administration`, {
      method: 'POST', headers: bearer(fixture.playerNative), body: JSON.stringify({ authorityId: fixture.registryActorId })
    });
    assert.equal(playerAdd.status, 403);
    const playerList = await fetch(`${fixture.origin}/local/home/administration`, { headers: bearer(fixture.playerNative) });
    assert.equal(playerList.status, 200);
    assert.deepEqual(await playerList.json(), { actor: fixture.playerId, entries: [] });
  } finally {
    await closeFixture(fixture);
  }
});

test('Home distinguishes a missing target credential from verified non-administration', async () => {
  const fixture = await createAdminFixture('fctp-authority-administration-credential-');
  try {
    const registryInbox = fixture.app.authority.actor('registry').inbox as URI;
    await fixture.app.home.revoke(fixture.playerId, { id: fixture.registryActorId, inbox: registryInbox });
    assert.equal(await fixture.app.authority.server.processOutbox(), 1);
    await fixture.app.authority.server.processInbox();

    const response = await fetch(`${fixture.origin}/local/home/administration`, {
      method: 'POST',
      headers: bearer(fixture.playerNative),
      body: JSON.stringify({ authorityId: fixture.registryActorId })
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'target-unauthorized' });
  } finally {
    await closeFixture(fixture);
  }
});

test('a normal player Registry diplomatic token is rejected from Registry administration', async () => {
  const fixture = await createAdminFixture('fctp-authority-admin-registry-player-');
  try {
    const fleetResponse = await fetch(`${fixture.origin}/local/registry/fleet`, { headers: bearer(fixture.playerRegistryToken) });
    assert.equal(fleetResponse.status, 403, 'an ordinary player diplomatic token does not authorize the Registry fleet read');

    assert.equal(await fixture.app.authority.server.authenticateDiplomaticToken(fixture.registryActorId, fixture.playerRegistryToken), fixture.playerId, 'the ordinary player token is a valid Registry diplomatic token');
  } finally {
    await closeFixture(fixture);
  }
});

test('a normal player Home token does not authorize Home administration', async () => {
  const fixture = await createAdminFixture('fctp-authority-admin-home-player-');
  try {
    const before = await listAccounts(fixture.origin, fixture.governorNative);
    assert.equal(before.find((account) => account.handle === fixture.playerHandle)?.available, true);

    const listResponse = await fetch(`${fixture.origin}/local/home/accounts`, { headers: bearer(fixture.playerHomeToken) });
    assert.equal(listResponse.status, 401, 'an ordinary player diplomatic token does not authorize the Home account list');

    const availabilityResponse = await postAvailability(fixture.origin, { handle: fixture.playerHandle, available: false }, fixture.playerHomeToken);
    assert.equal(availabilityResponse.status, 401, 'an ordinary player diplomatic token does not authorize Home availability');

    const nativeResponse = await fetch(`${fixture.origin}/local/home/accounts`, { headers: bearer(fixture.playerNative) });
    assert.equal(nativeResponse.status, 401, 'an ordinary player native token does not authorize the Home account list');

    const after = await listAccounts(fixture.origin, fixture.governorNative);
    assert.equal(after.find((account) => account.handle === fixture.playerHandle)?.available, true, 'the rejected availability change does not take effect');
  } finally {
    await closeFixture(fixture);
  }
});

test('the configured administrator diplomatic token is rejected by secret-only provisioning routes', async () => {
  const fixture = await createAdminFixture('fctp-authority-admin-provisioning-');
  try {
    for (const path of ['/local/home/issue', '/local/home/rotate', '/local/home/revoke', '/local/home/digest-request']) {
      const response = await fetch(`${fixture.origin}${path}`, {
        method: 'POST',
        headers: bearer(fixture.homeAdminToken),
        body: JSON.stringify({ actor: fixture.governorId, resourceActor: fixture.registryActorId })
      });
      assert.equal(response.status, 401, `${path} remains secret-only`);
    }
  } finally {
    await closeFixture(fixture);
  }
});

const invalidAdministrators: Array<{ label: string; handle: (host: string) => string }> = [
  { label: 'an authority-role handle', handle: (host) => `@home.home@${host}` },
  { label: 'an account on an untrusted server', handle: () => '@governor@untrusted.example' },
  { label: 'a local account that does not exist', handle: (host) => `@nobody@${host}` }
];

async function expectConstructionRejects(label: string, administrator: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-admin-invalid-'));
  const origin = `http://127.0.0.1:${await freePort()}`;
  try {
    let app: Awaited<ReturnType<typeof createAuthorityApp>> | undefined;
    try {
      app = await createAuthorityApp({
        origin,
        storeFile: join(directory, 'authority.json'),
        adminSecret,
        playerNames: ['player'],
        administratorNames: ['governor'],
        administrator
      });
    } catch (error) {
      assert.ok(error instanceof TypeError, `${label} administrator configuration throws TypeError`);
      return;
    }
    await app.authority.close();
    assert.fail(`${label} administrator configuration is rejected when the Authority app is constructed`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

for (const candidate of invalidAdministrators) {
  test(`Authority rejects ${candidate.label} as the configured administrator`, async () => {
    const origin = `http://127.0.0.1:${await freePort()}`;
    await expectConstructionRejects(candidate.label, candidate.handle(new URL(origin).host));
  });
}
