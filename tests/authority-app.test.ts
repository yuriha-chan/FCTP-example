import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveDiplomaticToken, type HomeLoginResult } from '@fctp/auth';
import { FctpClient } from '@fctp/client-sdk';
import { createLocalDocumentLoader, verifyProofCryptography } from '@fctp/identity';
import { createInboundVerifier } from '@fctp/server-base';
import { createAuthority } from '../apps/test-authority/src/bootstrap.js';
import { createAuthorityApp, type CreateAuthorityAppOptions } from '../apps/test-authority/src/app.js';

test('authority app discovers Actors, issues native credentials, and publishes a signed Registry entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-app-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let published: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) === 'https://territory.test/inbox' && init?.method === 'POST') {
      published = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response('{}', { status: 202 });
    }
    if (String(input) === 'https://territory.test/actors/territory') {
      return Response.json({ id: 'https://territory.test/actors/territory', inbox: 'https://territory.test/inbox' });
    }
    return fetch(input, init);
  };
  const app = await createAuthorityApp({ origin, storeFile: join(directory, 'authority.json'), adminSecret: 'local-admin-secret', fetcher });
  try {
    await app.authority.listen(port);
    const actorResponse = await fetch(app.ids.actor.registry);
    assert.equal(actorResponse.status, 200);
    assert.equal((await actorResponse.json() as { id: string }).id, app.ids.actor.registry);

    const infoResponse = await fetch(`${origin}/local/info`);
    assert.equal(infoResponse.status, 200);
    const info = await infoResponse.json() as Record<string, unknown>;
    assert.equal(info.kind, 'authority');
    assert.equal(JSON.stringify(info).includes('local-admin-secret'), false);

    const vesselResponse = await fetch(app.ids.vessel);
    assert.equal(vesselResponse.status, 200);
    assert.equal((await vesselResponse.json() as { id: string }).id, app.ids.vessel);

    const issueDenied = await fetch(`${origin}/local/home/issue`, { method: 'POST' });
    assert.equal(issueDenied.status, 401);
    const issueResponse = await fetch(`${origin}/local/home/issue`, { method: 'POST', headers: { Authorization: 'Bearer local-admin-secret', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(issueResponse.status, 200);
    assert.equal(typeof (await issueResponse.json() as { nativeToken: unknown }).nativeToken, 'string');

    const entryResponse = await fetch(`${origin}/local/registry/entry`, {
      method: 'POST',
      headers: { Authorization: 'Bearer local-admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ territory: 'https://territory.test/actors/territory', port: 'https://territory.test/objects/ports/main', route: 'https://territory.test/objects/routes/approach' })
    });
    assert.equal(entryResponse.status, 202);
    assert.equal(await app.authority.server.processOutbox(), 1);
    assert.ok(published);
    const keyId = app.authority.key('registry').keyPair.id;
    const key = await fetch(keyId).then((response) => response.json()) as Record<string, unknown>;
    const verification = await verifyProofCryptography(published, createLocalDocumentLoader(new Map([[keyId, key]])));
    assert.equal(verification.verified, true);
    const envelope = published as { object?: { type?: string; vessel?: { id?: string } } };
    assert.equal(envelope.object?.type, 'EntryRequest');
    assert.equal(envelope.object?.vessel?.id, app.ids.vessel);
  } finally {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Home lists only the vessels owned by the authenticated account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-home-vessels-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const app = await createAuthorityApp({
    origin,
    storeFile: join(directory, 'authority.json'),
    adminSecret: 'local-admin-secret',
    playerNames: ['alice', 'bob'],
    accountPasswords: { alice: 'alice-secret', bob: 'bob-secret' }
  });
  try {
    await app.authority.listen(port);
    const host = new URL(origin).host;
    const alice = await successfulLogin(origin, `@alice@${host}`, 'alice-secret');
    const bob = await successfulLogin(origin, `@bob@${host}`, 'bob-secret');
    const read = async (token: string): Promise<{ actor: string; vessels: Array<{ id: string; possessor: string }> }> => {
      const response = await fetch(`${origin}/local/home/vessels`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
      return await response.json() as { actor: string; vessels: Array<{ id: string; possessor: string }> };
    };
    const aliceVessels = await read(alice.nativeToken);
    assert.equal(aliceVessels.actor, app.ids.players.alice);
    assert.deepEqual(aliceVessels.vessels.map((vessel) => vessel.id), [app.ids.vessels.alice]);
    assert.equal(aliceVessels.vessels[0]?.possessor, app.ids.players.alice);
    const bobVessels = await read(bob.nativeToken);
    assert.equal(bobVessels.actor, app.ids.players.bob);
    assert.deepEqual(bobVessels.vessels.map((vessel) => vessel.id), [app.ids.vessels.bob]);
    assert.equal(bobVessels.vessels[0]?.possessor, app.ids.players.bob);
    assert.equal((await fetch(`${origin}/local/home/vessels`)).status, 401);
  } finally {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority app publishes vessel and creation IDs under the canonical origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-canonical-'));
  const port = await availablePort();
  const app = await createAuthorityApp({
    origin: 'http://127.0.0.1:80',
    storeFile: join(directory, 'authority.json'),
    adminSecret: 'local-admin-secret'
  });
  try {
    assert.equal(app.ids.vessel, 'http://127.0.0.1/objects/vessels/demo');
    await app.authority.listen(port);
    const vesselResponse = await fetch(`http://127.0.0.1:${port}/objects/vessels/demo`);
    assert.equal(vesselResponse.status, 200);
    const actorResponse = await fetch(`http://127.0.0.1:${port}/actors/player`);
    assert.equal(actorResponse.status, 200);
    const actor = await actorResponse.json() as { creations?: string };
    assert.equal(actor.creations, 'http://127.0.0.1/objects/players/player/creations');
  } finally {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority app preserves persisted Registry adoption when restarted without an option', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-adoption-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const storeFile = join(directory, 'authority.json');
  let app = await createAuthorityApp({ origin, storeFile, adminSecret: 'local-admin-secret' });
  try {
    assert.equal((await app.registry.state()).adoption, true);
    await app.registry.switchAdoption(false);
    await app.authority.close();
    app = await createAuthorityApp({ origin, storeFile, adminSecret: 'local-admin-secret' });
    assert.equal((await app.registry.state()).adoption, false);
  } finally {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Home password login signs in a provisioned Player and preserves its native token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-login-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const storeFile = join(directory, 'authority.json');
  const app = await createAuthorityApp({
    origin,
    storeFile,
    adminSecret: 'local-admin-secret',
    playerNames: ['alice', 'carol'],
    accountPasswords: { alice: 'alice-login-secret' }
  });
  try {
    await app.authority.listen(port);
    const host = new URL(origin).host;
    const handle = `@alice@${host}`;
    const first = await successfulLogin(origin, handle, 'alice-login-secret');
    assert.equal(first.actorId, app.ids.players.alice);
    assert.equal(await app.home.authenticateNativeToken(first.nativeToken), app.ids.players.alice);
    assert.equal(typeof await app.home.deriveToken(app.ids.players.alice!, 'https://territory.test/actors/one'), 'string');

    const repeat = await successfulLogin(origin, handle, 'alice-login-secret');
    assert.ok(repeat.nativeToken === first.nativeToken, 'repeat login must return the current native token');

    await assertRejectedLogin(await postHomeLogin(origin, { handle, password: 'wrong-password' }));
    await assertRejectedLogin(await postHomeLogin(origin, { handle: `@nobody@${host}`, password: 'alice-login-secret' }));
    await assertRejectedLogin(await postHomeLogin(origin, { handle: `@home.home@${host}`, password: 'alice-login-secret' }));
    await assertRejectedLogin(await postHomeLogin(origin, { handle: `@carol@${host}`, password: 'carol-login-secret' }));

    const invalidResponse = await postHomeLogin(origin, '{');
    assert.ok(invalidResponse.status >= 400 && invalidResponse.status < 500, 'invalid login bodies must not crash the server');

    const stored = await readFile(storeFile, 'utf8');
    assert.equal(stored.includes('alice-login-secret'), false, 'the store must not contain the plaintext password');
  } finally {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('SDK Home login token reads a Home-digested private resource through the resource server', async () => {
  const fixture = await createDiplomaticFixture('fctp-authority-sdk-public-first-');
  const { directory, homeOrigin, host, resource, resourceActorId, resourceUri, homeApp } = fixture;
  try {
    const client = new FctpClient();
    const login = await client.login({ handle: `@alice@${host}`, password: 'alice-login-secret' }, homeOrigin);
    assert.equal(login.status, 'signed-in');
    if (login.status !== 'signed-in') throw new Error('Expected a signed-in login result');

    assert.equal((await fetch(resourceUri)).status, 401);
    const value = await client.getPublicFirst<{ value: string }>(resourceUri, { nativeToken: login.nativeToken, resourceServer: resourceActorId });
    assert.equal(value.value, 'permitted');
  } finally {
    try {
      await homeApp.authority.close();
    } finally {
      try {
        await resource.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test('Home password login retrieves an administrator-issued native token without rotating it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-login-existing-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const storeFile = join(directory, 'authority.json');
  const app = await createAuthorityApp({
    origin,
    storeFile,
    adminSecret: 'local-admin-secret',
    playerNames: ['alice'],
    accountPasswords: { alice: 'alice-login-secret' }
  });
  try {
    await app.authority.listen(port);
    const issuedResponse = await fetch(`${origin}/local/home/issue`, {
      method: 'POST',
      headers: { Authorization: 'Bearer local-admin-secret', 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(issuedResponse.status, 200);
    const issued = await issuedResponse.json() as { nativeToken: string };
    assert.equal(typeof issued.nativeToken, 'string');

    const login = await successfulLogin(origin, `@alice@${new URL(origin).host}`, 'alice-login-secret');
    assert.ok(login.nativeToken === issued.nativeToken, 'password login must retrieve the current native token');
  } finally {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Home password login persists tokens across restart and scopes identity by Home origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-login-scope-'));
  const port = await availablePort();
  const secondPort = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const secondOrigin = `http://127.0.0.1:${secondPort}`;
  const storeFile = join(directory, 'authority.json');
  const secondStoreFile = join(directory, 'second-authority.json');
  const options = {
    origin,
    storeFile,
    adminSecret: 'local-admin-secret',
    playerNames: ['alice', 'bob'],
    accountPasswords: { alice: 'alice-login-secret', bob: 'bob-login-secret' }
  };
  let app = await createAuthorityApp(options);
  let secondApp: Awaited<ReturnType<typeof createAuthorityApp>> | undefined;
  try {
    await app.authority.listen(port);
    const host = new URL(origin).host;
    const alice = await successfulLogin(origin, `@alice@${host}`, 'alice-login-secret');
    const bob = await successfulLogin(origin, `@bob@${host}`, 'bob-login-secret');
    assert.equal(alice.actorId, app.ids.players.alice);
    assert.equal(bob.actorId, app.ids.players.bob);
    assert.ok(alice.nativeToken !== bob.nativeToken, 'each configured Player must have its own native token');

    await app.authority.close();
    app = await createAuthorityApp(options);
    await app.authority.listen(port);
    const restartedAlice = await successfulLogin(origin, `@alice@${host}`, 'alice-login-secret');
    const restartedBob = await successfulLogin(origin, `@bob@${host}`, 'bob-login-secret');
    assert.ok(restartedAlice.nativeToken === alice.nativeToken, 'restart must preserve the current native token');
    assert.ok(restartedBob.nativeToken === bob.nativeToken, 'restart must preserve the current native token');

    secondApp = await createAuthorityApp({
      origin: secondOrigin,
      storeFile: secondStoreFile,
      adminSecret: 'local-admin-secret',
      playerNames: ['alice'],
      accountPasswords: { alice: 'alice-login-secret' }
    });
    await secondApp.authority.listen(secondPort);
    const secondAlice = await successfulLogin(secondOrigin, `@alice@${new URL(secondOrigin).host}`, 'alice-login-secret');
    assert.equal(secondAlice.actorId, secondApp.ids.players.alice);
    assert.ok(secondAlice.actorId !== alice.actorId, 'the same local name at a different Home origin must resolve to a distinct Actor');
  } finally {
    try {
      await app.authority.close();
    } finally {
      if (secondApp) await secondApp.authority.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('configured Home governor logs in as a Player Actor distinct from the Home Actor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-governor-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const storeFile = join(directory, 'authority.json');
  const app = await createAuthorityApp({
    origin,
    storeFile,
    adminSecret: 'local-admin-secret',
    playerNames: ['alice'],
    administratorNames: ['orla'],
    accountPasswords: { alice: 'alice-login-secret', orla: 'orla-login-secret' }
  });
  try {
    await app.authority.listen(port);
    const host = new URL(origin).host;
    const governor = await successfulLogin(origin, `@orla@${host}`, 'orla-login-secret');
    assert.equal(governor.actorId, app.ids.players.orla);
    assert.notEqual(governor.actorId, app.ids.actor.home, 'the governor account Actor must not be the Home Actor');
    assert.equal(await app.home.authenticateNativeToken(governor.nativeToken), governor.actorId);

    const webfinger = new URL('/.well-known/webfinger', origin);
    webfinger.searchParams.set('resource', `acct:@orla@${host}`);
    const discoveryResponse = await fetch(webfinger);
    assert.equal(discoveryResponse.status, 200);
    const discovery = await discoveryResponse.json() as { subject: string; links: Array<{ rel: string; href: string }> };
    assert.equal(discovery.subject.replace(/^acct:/, ''), `@orla@${host}`);
    const self = discovery.links.find((link) => link.rel === 'self');
    assert.ok(self, 'the governor handle must resolve to a public Actor document');
    assert.equal(self!.href, governor.actorId);
    const governorActor = await fetch(self!.href).then((response) => response.json()) as { id: string; role: string };
    assert.equal(governorActor.id, governor.actorId);
    assert.equal(governorActor.role, 'player');

    assert.equal(Object.hasOwn(app.ids.vessels, 'orla'), false, 'a governing account must not receive an automatic vessel');
    const aliceVessel = app.ids.vessels.alice;
    assert.equal(typeof aliceVessel, 'string');
    assert.equal((await fetch(aliceVessel!)).status, 200);

    const assetResponse = await fetch(`${origin}/local/authoring/assets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${governor.nativeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Governor asset', text: 'governed text' })
    });
    assert.equal(assetResponse.status, 201);
    const published = await assetResponse.json() as { asset: { creator: string[]; holder: string } };
    assert.deepEqual(published.asset.creator, [governor.actorId]);
    assert.equal(published.asset.holder, governor.actorId);
  } finally {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Home governor lists accounts without credentials while other callers are denied', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-accounts-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const storeFile = join(directory, 'authority.json');
  const app = await createAuthorityApp({
    origin,
    storeFile,
    adminSecret: 'local-admin-secret',
    playerNames: ['alice'],
    administratorNames: ['orla'],
    accountPasswords: { alice: 'alice-login-secret', orla: 'orla-login-secret' }
  });
  try {
    await app.authority.listen(port);
    const host = new URL(origin).host;
    const governor = await successfulLogin(origin, `@orla@${host}`, 'orla-login-secret');
    const regular = await successfulLogin(origin, `@alice@${host}`, 'alice-login-secret');

    const listResponse = await fetch(`${origin}/local/home/accounts`, { headers: { Authorization: `Bearer ${governor.nativeToken}` } });
    assert.equal(listResponse.status, 200);
    const text = await listResponse.text();
    assert.equal(text.includes('alice-login-secret'), false, 'the account list must not expose passwords');
    assert.equal(text.includes('orla-login-secret'), false, 'the account list must not expose passwords');
    assert.equal(text.includes(regular.nativeToken), false, 'the account list must not expose native tokens');
    assert.equal(text.includes(governor.nativeToken), false, 'the account list must not expose native tokens');
    const list = JSON.parse(text) as { accounts: Array<{ handle: string; actorId: string; available: boolean }> };
    const byHandle = new Map(list.accounts.map((account) => [account.handle, account]));
    const governorAccount = byHandle.get(`@orla@${host}`);
    const regularAccount = byHandle.get(`@alice@${host}`);
    assert.ok(governorAccount, 'the governor account must appear in the list');
    assert.ok(regularAccount, 'regular Player accounts must appear in the list');
    assert.equal(governorAccount!.actorId, governor.actorId);
    assert.equal(regularAccount!.actorId, regular.actorId);
    assert.equal(governorAccount!.available, true);
    assert.equal(regularAccount!.available, true);
    for (const account of list.accounts) {
      for (const key of ['password', 'passwordHash', 'hash', 'salt', 'nativeToken', 'token']) {
        assert.equal(Object.hasOwn(account, key), false, `the account list must not expose ${key}`);
      }
    }

    const regularDenied = await fetch(`${origin}/local/home/accounts`, { headers: { Authorization: `Bearer ${regular.nativeToken}` } });
    assert.ok(regularDenied.status >= 400 && regularDenied.status < 500, 'an ordinary Player must not list accounts');
    const deniedText = await regularDenied.text();
    assert.equal(deniedText.includes(`@alice@${host}`), false);
    assert.equal(deniedText.includes(`@orla@${host}`), false);

    const missing = await fetch(`${origin}/local/home/accounts`);
    assert.ok(missing.status >= 400 && missing.status < 500, 'an unauthenticated caller must not list accounts');

  } finally {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Home availability disable blocks native and diplomatic access and revokes known resources', async () => {
  const fixture = await createDiplomaticFixture('fctp-authority-availability-disable-');
  const { directory, homeOrigin, host, resource, resourceActorId, resourceUri, governor, alice } = fixture;
  const homeApp = fixture.homeApp;
  try {
    const adminHeaders = { Authorization: 'Bearer local-admin-secret', 'Content-Type': 'application/json' };

    const rotatedResponse = await fetch(`${homeOrigin}/local/home/rotate`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: alice.actorId }) });
    assert.ok(rotatedResponse.status >= 200 && rotatedResponse.status < 300, 'admin provisioning must keep working while the account is available');
    const rotated = await rotatedResponse.json() as { nativeToken: string };
    assert.notEqual(rotated.nativeToken, alice.nativeToken);
    assert.equal(await homeApp.authority.server.processOutbox(), 1);
    assert.equal(await resource.server.processInbox(), 1);
    const currentDiplomaticToken = await deriveDiplomaticToken(rotated.nativeToken, resourceActorId);
    assert.equal((await fetch(resourceUri, { headers: { Authorization: `Bearer ${currentDiplomaticToken}` } })).status, 200);

    await expectAvailabilitySuccess(await postAvailability(homeOrigin, { handle: `@alice@${host}`, available: false }, governor.nativeToken));

    const accounts = await listAccounts(homeOrigin, governor.nativeToken);
    assert.equal(accounts.get(`@alice@${host}`)?.available, false, 'the governor listing must report the disabled account');
    assert.equal(accounts.get(`@orla@${host}`)?.available, true);

    const unavailableResponse = await postHomeLogin(homeOrigin, { handle: `@alice@${host}`, password: 'alice-login-secret' });
    const unavailableBody = await unavailableResponse.json() as HomeLoginResult;
    assert.equal(unavailableBody.status, 'unavailable');
    assert.equal(Object.hasOwn(unavailableBody, 'nativeToken'), false, 'an unavailable login must not issue a native token');
    assert.equal(JSON.stringify(unavailableBody).includes('alice-login-secret'), false, 'an unavailable login must not expose credentials');

    assert.equal(await homeApp.home.authenticateNativeToken(rotated.nativeToken), undefined, 'the existing native token must be blocked immediately');
    const proxyUri = `${homeOrigin}/local/home/proxy?uri=${encodeURIComponent(resourceUri)}&resourceActor=${encodeURIComponent(resourceActorId)}`;
    await expectClientError(await fetch(proxyUri, { headers: { Authorization: `Bearer ${rotated.nativeToken}` } }));

    await expectClientError(await fetch(`${homeOrigin}/local/home/rotate`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: alice.actorId }) }));
    await expectClientError(await fetch(`${homeOrigin}/local/home/issue`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: alice.actorId }) }));
    await expectClientError(await requestDigest(homeOrigin, alice.actorId, resourceActorId));

    assert.ok(await homeApp.authority.server.processOutbox() >= 1, 'disabling must queue a resource revocation');
    assert.ok(await resource.server.processInbox() >= 1, 'the resource must process the queued revocation');
    assert.ok((await fetch(resourceUri, { headers: { Authorization: `Bearer ${currentDiplomaticToken}` } })).status >= 400, 'the old diplomatic token must be denied after revocation');
  } finally {
    try {
      await homeApp.authority.close();
    } finally {
      try {
        await resource.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test('Home availability re-enable requires a fresh login token and redistributes digests', async () => {
  const fixture = await createDiplomaticFixture('fctp-authority-availability-enable-');
  const { directory, homeOptions, homePort, homeOrigin, host, resource, resourceActorId, resourceUri, governor, alice } = fixture;
  let homeApp = fixture.homeApp;
  try {
    await expectAvailabilitySuccess(await postAvailability(homeOrigin, { handle: `@alice@${host}`, available: false }, governor.nativeToken));
    assert.ok(await homeApp.authority.server.processOutbox() >= 1, 'disabling must queue a revocation');
    assert.ok(await resource.server.processInbox() >= 1, 'the resource must process the revocation');
    assert.ok((await fetch(resourceUri, { headers: { Authorization: `Bearer ${await deriveDiplomaticToken(alice.nativeToken, resourceActorId)}` } })).status >= 400);

    await homeApp.authority.close();
    homeApp = await createAuthorityApp(homeOptions);
    await homeApp.authority.listen(homePort);

    const restartedGovernor = await successfulLogin(homeOrigin, `@orla@${host}`, 'orla-login-secret');
    assert.equal(restartedGovernor.actorId, governor.actorId);
    assert.equal((await listAccounts(homeOrigin, restartedGovernor.nativeToken)).get(`@alice@${host}`)?.available, false, 'disablement must survive restart');
    assert.equal((await (await postHomeLogin(homeOrigin, { handle: `@alice@${host}`, password: 'alice-login-secret' })).json() as HomeLoginResult).status, 'unavailable');

    await expectAvailabilitySuccess(await postAvailability(homeOrigin, { handle: `@alice@${host}`, available: true }, restartedGovernor.nativeToken));
    assert.equal((await listAccounts(homeOrigin, restartedGovernor.nativeToken)).get(`@alice@${host}`)?.available, true);

    assert.equal(await homeApp.home.authenticateNativeToken(alice.nativeToken), undefined, 're-enabling must not resurrect the old native token');
    assert.ok((await fetch(resourceUri, { headers: { Authorization: `Bearer ${await deriveDiplomaticToken(alice.nativeToken, resourceActorId)}` } })).status >= 400, 're-enabling must not resurrect the old diplomatic token');

    const fresh = await successfulLogin(homeOrigin, `@alice@${host}`, 'alice-login-secret');
    assert.notEqual(fresh.nativeToken, alice.nativeToken, 'the next login after re-enabling must issue a fresh native token');
    assert.ok(await homeApp.authority.server.processOutbox() >= 1, 'the fresh login must queue new digests for known resources');
    assert.ok(await resource.server.processInbox() >= 1);

    const freshDiplomaticToken = await deriveDiplomaticToken(fresh.nativeToken, resourceActorId);
    assert.equal((await fetch(resourceUri, { headers: { Authorization: `Bearer ${freshDiplomaticToken}` } })).status, 200, 'the client-derived fresh diplomatic token must access the resource');
    assert.ok((await fetch(resourceUri, { headers: { Authorization: `Bearer ${await deriveDiplomaticToken(alice.nativeToken, resourceActorId)}` } })).status >= 400, 'the old diplomatic token must remain denied');

    const repeat = await successfulLogin(homeOrigin, `@alice@${host}`, 'alice-login-secret');
    assert.equal(repeat.nativeToken, fresh.nativeToken, 'repeat login while available must keep the current token');

    await homeApp.authority.close();
    homeApp = await createAuthorityApp(homeOptions);
    await homeApp.authority.listen(homePort);
    const restartedAlice = await successfulLogin(homeOrigin, `@alice@${host}`, 'alice-login-secret');
    assert.equal(restartedAlice.nativeToken, fresh.nativeToken, 'the fresh token must survive restart');
    const restartedGovernorAgain = await successfulLogin(homeOrigin, `@orla@${host}`, 'orla-login-secret');
    assert.equal((await listAccounts(homeOrigin, restartedGovernorAgain.nativeToken)).get(`@alice@${host}`)?.available, true);
  } finally {
    try {
      await homeApp.authority.close();
    } finally {
      try {
        await resource.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test('Home availability rejects unauthorized and invalid targets without mutating accounts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-availability-guard-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const storeFile = join(directory, 'authority.json');
  const app = await createAuthorityApp({
    origin,
    storeFile,
    adminSecret: 'local-admin-secret',
    playerNames: ['alice'],
    administratorNames: ['orla'],
    accountPasswords: { alice: 'alice-login-secret', orla: 'orla-login-secret' }
  });
  try {
    await app.authority.listen(port);
    const host = new URL(origin).host;
    const handle = `@alice@${host}`;
    const governor = await successfulLogin(origin, `@orla@${host}`, 'orla-login-secret');
    const alice = await successfulLogin(origin, handle, 'alice-login-secret');

    await expectClientError(await postAvailability(origin, { handle, available: false }, alice.nativeToken));
    assert.equal((await listAccounts(origin, governor.nativeToken)).get(handle)?.available, true, 'a non-governor request must not change availability');
    await expectClientError(await postAvailability(origin, { handle, available: false }));
    assert.equal((await listAccounts(origin, governor.nativeToken)).get(handle)?.available, true, 'an unauthenticated request must not change availability');
    await expectClientError(await postAvailability(origin, { handle: '@alice@other.example:9999', available: false }, governor.nativeToken));
    await expectClientError(await postAvailability(origin, { handle: `@nobody@${host}`, available: false }, governor.nativeToken));
    await expectClientError(await postAvailability(origin, { handle, available: 'false' }, governor.nativeToken));
    await expectClientError(await postAvailability(origin, { handle, available: null }, governor.nativeToken));
    await expectClientError(await postAvailability(origin, { available: false }, governor.nativeToken));
    await expectClientError(await postAvailability(origin, '{', governor.nativeToken));
    assert.equal((await listAccounts(origin, governor.nativeToken)).get(handle)?.available, true, 'invalid requests must not change a known account');

    await expectAvailabilitySuccess(await postAvailability(origin, { handle, available: false }, governor.nativeToken));
    const listResponse = await fetch(`${origin}/local/home/accounts`, { headers: { Authorization: `Bearer ${governor.nativeToken}` } });
    const listText = await listResponse.text();
    assert.equal(listText.includes('alice-login-secret'), false, 'the account list must not expose passwords');
    assert.equal(listText.includes(alice.nativeToken), false, 'the account list must not expose native tokens');
    assert.equal((JSON.parse(listText) as { accounts: Array<{ handle: string; available: boolean }> }).accounts.find((account) => account.handle === handle)?.available, false);

    await expectClientError(await postAvailability(origin, { handle, available: true }, alice.nativeToken));
    await expectClientError(await postAvailability(origin, { handle, available: true }));
    await expectClientError(await postAvailability(origin, { handle: '@alice@other.example:9999', available: true }, governor.nativeToken));
    await expectClientError(await postAvailability(origin, { handle, available: 'true' }, governor.nativeToken));
    assert.equal((await listAccounts(origin, governor.nativeToken)).get(handle)?.available, false, 'rejected requests must not re-enable the account');

    const unavailable = await postHomeLogin(origin, { handle, password: 'alice-login-secret' });
    const unavailableBody = await unavailable.json() as HomeLoginResult;
    assert.equal(unavailableBody.status, 'unavailable');
    assert.equal(Object.hasOwn(unavailableBody, 'nativeToken'), false);
    assert.equal(JSON.stringify(unavailableBody).includes(alice.nativeToken), false, 'a rejected login must not return token material');
  } finally {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Home governor can disable and re-enable another governor with the ordinary credential lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-governor-availability-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const storeFile = join(directory, 'authority.json');
  const options: CreateAuthorityAppOptions = {
    origin,
    storeFile,
    adminSecret: 'local-admin-secret',
    playerNames: ['alice'],
    administratorNames: ['orla', 'mirela'],
    accountPasswords: {
      alice: 'alice-login-secret',
      orla: 'orla-login-secret',
      mirela: 'mirela-login-secret'
    }
  };
  let app = await createAuthorityApp(options);
  try {
    await app.authority.listen(port);
    const host = new URL(origin).host;
    const orla = await successfulLogin(origin, `@orla@${host}`, 'orla-login-secret');
    const mirela = await successfulLogin(origin, `@mirela@${host}`, 'mirela-login-secret');
    await successfulLogin(origin, `@alice@${host}`, 'alice-login-secret');

    assert.notEqual(mirela.actorId, app.ids.actor.home);
    assert.equal((await listAccounts(origin, mirela.nativeToken)).get(`@orla@${host}`)?.available, true);

    await expectAvailabilitySuccess(await postAvailability(origin, { handle: `@mirela@${host}`, available: false }, orla.nativeToken));
    const disabled = await listAccounts(origin, orla.nativeToken);
    assert.equal(disabled.get(`@mirela@${host}`)?.available, false, 'the governor listing must report the disabled governor');
    assert.equal(disabled.get(`@orla@${host}`)?.available, true);
    assert.equal(disabled.get(`@alice@${host}`)?.available, true);

    assert.equal(await app.home.authenticateNativeToken(mirela.nativeToken), undefined, 'the disabled governor native token must block immediately');
    await expectClientError(await fetch(`${origin}/local/home/accounts`, { headers: { Authorization: `Bearer ${mirela.nativeToken}` } }));
    const unavailableResponse = await postHomeLogin(origin, { handle: `@mirela@${host}`, password: 'mirela-login-secret' });
    const unavailableBody = await unavailableResponse.json() as HomeLoginResult;
    assert.equal(unavailableBody.status, 'unavailable');
    assert.equal(Object.hasOwn(unavailableBody, 'nativeToken'), false, 'an unavailable governor login must not issue a native token');
    assert.equal(JSON.stringify(unavailableBody).includes('mirela-login-secret'), false, 'an unavailable governor login must not expose credentials');

    await app.authority.close();
    app = await createAuthorityApp(options);
    await app.authority.listen(port);

    const restartedOrla = await successfulLogin(origin, `@orla@${host}`, 'orla-login-secret');
    assert.equal(restartedOrla.actorId, orla.actorId);
    const restartedDisabled = await listAccounts(origin, restartedOrla.nativeToken);
    assert.equal(restartedDisabled.get(`@mirela@${host}`)?.available, false, 'governor disablement must survive restart');
    assert.equal(restartedDisabled.get(`@orla@${host}`)?.available, true);
    assert.equal(await app.home.authenticateNativeToken(mirela.nativeToken), undefined, 'the old governor token must stay invalid across restart');
    assert.equal(((await (await postHomeLogin(origin, { handle: `@mirela@${host}`, password: 'mirela-login-secret' })).json()) as HomeLoginResult).status, 'unavailable');

    await expectAvailabilitySuccess(await postAvailability(origin, { handle: `@mirela@${host}`, available: true }, restartedOrla.nativeToken));
    assert.equal((await listAccounts(origin, restartedOrla.nativeToken)).get(`@mirela@${host}`)?.available, true);
    assert.equal(await app.home.authenticateNativeToken(mirela.nativeToken), undefined, 're-enabling must not resurrect the old governor token');
    await expectClientError(await fetch(`${origin}/local/home/accounts`, { headers: { Authorization: `Bearer ${mirela.nativeToken}` } }));

    const freshMirela = await successfulLogin(origin, `@mirela@${host}`, 'mirela-login-secret');
    assert.notEqual(freshMirela.nativeToken, mirela.nativeToken, 'the next governor login after re-enabling must issue a fresh native token');
    assert.equal(await app.home.authenticateNativeToken(freshMirela.nativeToken), freshMirela.actorId);
    assert.equal((await listAccounts(origin, freshMirela.nativeToken)).get(`@orla@${host}`)?.available, true);

    await expectAvailabilitySuccess(await postAvailability(origin, { handle: `@alice@${host}`, available: false }, freshMirela.nativeToken));
    assert.equal((await listAccounts(origin, freshMirela.nativeToken)).get(`@alice@${host}`)?.available, false, 'a re-enabled governor must be able to govern another account');
  } finally {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Home availability forbids a sole governor from disabling their own account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-governor-self-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const storeFile = join(directory, 'authority.json');
  const app = await createAuthorityApp({
    origin,
    storeFile,
    adminSecret: 'local-admin-secret',
    playerNames: ['alice'],
    administratorNames: ['orla'],
    accountPasswords: { alice: 'alice-login-secret', orla: 'orla-login-secret' }
  });
  try {
    await app.authority.listen(port);
    const handle = `@orla@${new URL(origin).host}`;
    const orla = await successfulLogin(origin, handle, 'orla-login-secret');

    await expectClientError(await postAvailability(origin, { handle, available: false }, orla.nativeToken));
    assert.equal((await listAccounts(origin, orla.nativeToken)).get(handle)?.available, true, 'self-disable must not change the sole governor account');
    assert.equal(await app.home.authenticateNativeToken(orla.nativeToken), orla.actorId, 'the sole governor token must remain valid after a rejected self-disable');
  } finally {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Home availability forbids self-disable with another governor and rejects non-governor callers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-governor-self-two-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const storeFile = join(directory, 'authority.json');
  const app = await createAuthorityApp({
    origin,
    storeFile,
    adminSecret: 'local-admin-secret',
    playerNames: ['alice'],
    administratorNames: ['orla', 'mirela'],
    accountPasswords: { alice: 'alice-login-secret', orla: 'orla-login-secret', mirela: 'mirela-login-secret' }
  });
  try {
    await app.authority.listen(port);
    const host = new URL(origin).host;
    const orlaHandle = `@orla@${host}`;
    const mirelaHandle = `@mirela@${host}`;
    const orla = await successfulLogin(origin, orlaHandle, 'orla-login-secret');
    const mirela = await successfulLogin(origin, mirelaHandle, 'mirela-login-secret');
    const alice = await successfulLogin(origin, `@alice@${host}`, 'alice-login-secret');

    await expectClientError(await postAvailability(origin, { handle: orlaHandle, available: false }, orla.nativeToken));
    await expectClientError(await postAvailability(origin, { handle: mirelaHandle, available: false }, mirela.nativeToken));
    const afterSelf = await listAccounts(origin, orla.nativeToken);
    assert.equal(afterSelf.get(orlaHandle)?.available, true, 'self-disable must be rejected even when another governor exists');
    assert.equal(afterSelf.get(mirelaHandle)?.available, true, 'self-disable must be rejected even when another governor exists');

    await expectClientError(await postAvailability(origin, { handle: orlaHandle, available: false }, alice.nativeToken));
    await expectClientError(await postAvailability(origin, { handle: mirelaHandle, available: false }, alice.nativeToken));
    await expectClientError(await postAvailability(origin, { handle: orlaHandle, available: false }));
    await expectClientError(await postAvailability(origin, { handle: mirelaHandle, available: false }));
    const afterOthers = await listAccounts(origin, orla.nativeToken);
    assert.equal(afterOthers.get(orlaHandle)?.available, true, 'an ordinary Player or anonymous caller must not disable a governor');
    assert.equal(afterOthers.get(mirelaHandle)?.available, true, 'an ordinary Player or anonymous caller must not disable a governor');
    assert.equal(await app.home.authenticateNativeToken(orla.nativeToken), orla.actorId);
    assert.equal(await app.home.authenticateNativeToken(mirela.nativeToken), mirela.actorId);
  } finally {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Home governor disable revokes a governing Actor and re-enable requires a higher-revision digest', async () => {
  let inboxUri: string | undefined;
  const declarations: Array<{ type: string; actor: string; revision: number }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    if (inboxUri && String(input) === inboxUri && init?.method === 'POST' && typeof init.body === 'string') {
      const activity = JSON.parse(init.body) as { object?: { type?: string; actor?: string; revision?: number } };
      const object = activity.object;
      if (object && (object.type === 'TokenDigest' || object.type === 'TokenRevoke') && typeof object.actor === 'string' && typeof object.revision === 'number') {
        declarations.push({ type: object.type, actor: object.actor, revision: object.revision });
      }
    }
    return fetch(input, init);
  };
  const fixture = await createDiplomaticFixture('fctp-authority-governor-availability-resource-', {
    administratorNames: ['orla', 'mirela'],
    accountPasswords: { alice: 'alice-login-secret', orla: 'orla-login-secret', mirela: 'mirela-login-secret' },
    enrolledName: 'mirela',
    fetcher
  });
  const { directory, homeOrigin, host, resource, resourceActorId, resourceUri, governor, enrolled } = fixture;
  const homeApp = fixture.homeApp;
  try {
    inboxUri = `${resourceActorId}/inbox`;
    const oldDiplomaticToken = await deriveDiplomaticToken(enrolled.nativeToken, resourceActorId);
    assert.equal((await fetch(resourceUri, { headers: { Authorization: `Bearer ${oldDiplomaticToken}` } })).status, 200);

    await expectAvailabilitySuccess(await postAvailability(homeOrigin, { handle: `@mirela@${host}`, available: false }, governor.nativeToken));
    assert.equal((await listAccounts(homeOrigin, governor.nativeToken)).get(`@mirela@${host}`)?.available, false);
    assert.equal(await homeApp.home.authenticateNativeToken(enrolled.nativeToken), undefined, 'the disabled governing Actor token must block immediately');
    assert.equal(await homeApp.authority.server.processOutbox(), 1, 'disabling must queue one resource revocation');
    assert.equal(await resource.server.processInbox(), 1, 'the resource must process the queued revocation');
    assert.ok((await fetch(resourceUri, { headers: { Authorization: `Bearer ${oldDiplomaticToken}` } })).status >= 400, 'the old governing diplomatic token must be denied after revocation');
    const revocation = declarations.find((declaration) => declaration.type === 'TokenRevoke' && declaration.actor === enrolled.actorId);
    assert.ok(revocation, 'disabling must send a revocation for the governing Actor');

    await expectAvailabilitySuccess(await postAvailability(homeOrigin, { handle: `@mirela@${host}`, available: true }, governor.nativeToken));
    const fresh = await successfulLogin(homeOrigin, `@mirela@${host}`, 'mirela-login-secret');
    assert.notEqual(fresh.nativeToken, enrolled.nativeToken, 'the next governing login after re-enabling must issue a fresh token');
    assert.equal(await homeApp.authority.server.processOutbox(), 1, 'the fresh governing login must queue one digest');
    assert.equal(await resource.server.processInbox(), 1);
    const digest = declarations.find((declaration) => declaration.type === 'TokenDigest' && declaration.actor === enrolled.actorId);
    assert.ok(digest, 'the fresh governing login must send a digest');
    assert.ok(digest!.revision > revocation!.revision, 'the fresh digest must carry a higher revision than the revocation');
    assert.equal((await fetch(resourceUri, { headers: { Authorization: `Bearer ${await deriveDiplomaticToken(fresh.nativeToken, resourceActorId)}` } })).status, 200, 'the fresh governing token must access the resource');
    assert.ok((await fetch(resourceUri, { headers: { Authorization: `Bearer ${oldDiplomaticToken}` } })).status >= 400, 'the old governing diplomatic token must remain denied');
  } finally {
    try {
      await homeApp.authority.close();
    } finally {
      try {
        await resource.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test('authority setup rejects a governor name duplicated from a Player name', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-duplicate-account-'));
  const storeFile = join(directory, 'authority.json');
  try {
    await assert.rejects(
      createAuthorityApp({
        origin: 'http://duplicate-account.test',
        storeFile,
        adminSecret: 'local-admin-secret',
        playerNames: ['alice'],
        administratorNames: ['alice'],
        accountPasswords: { alice: 'alice-login-secret' }
      }),
      /unique|distinct|duplicate|already/i
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

interface DiplomaticFixtureOptions {
  administratorNames?: string[];
  accountPasswords?: Record<string, string>;
  enrolledName?: string;
  fetcher?: typeof fetch;
}

interface DiplomaticFixture {
  directory: string;
  homeOptions: CreateAuthorityAppOptions;
  homePort: number;
  homeOrigin: string;
  host: string;
  homeApp: Awaited<ReturnType<typeof createAuthorityApp>>;
  resource: Awaited<ReturnType<typeof createAuthority>>;
  resourceActorId: string;
  resourceUri: string;
  governor: Extract<HomeLoginResult, { status: 'signed-in' }>;
  alice: Extract<HomeLoginResult, { status: 'signed-in' }>;
  enrolled: Extract<HomeLoginResult, { status: 'signed-in' }>;
}

async function createDiplomaticFixture(prefix: string, options: DiplomaticFixtureOptions = {}): Promise<DiplomaticFixture> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const homePort = await availablePort();
  const resourcePort = await availablePort();
  const homeOrigin = `http://127.0.0.1:${homePort}`;
  const resourceOrigin = `http://127.0.0.1:${resourcePort}`;
  const host = new URL(homeOrigin).host;
  const accountPasswords = options.accountPasswords ?? { alice: 'alice-login-secret', orla: 'orla-login-secret' };
  const homeOptions: CreateAuthorityAppOptions = {
    origin: homeOrigin,
    storeFile: join(directory, 'authority.json'),
    adminSecret: 'local-admin-secret',
    playerNames: ['alice'],
    administratorNames: options.administratorNames ?? ['orla'],
    accountPasswords,
    ...(options.fetcher ? { fetcher: options.fetcher } : {})
  };
  const homeApp = await createAuthorityApp(homeOptions);
  const resource = await createAuthority({
    origin: resourceOrigin,
    storeFile: join(directory, 'resource.json'),
    verifyInbound: createInboundVerifier({ resolveExpectedIssuer: async (_localActorId, senderActorId) => senderActorId }),
    authorizeResource: async () => ({ allowed: true })
  });
  try {
    await homeApp.authority.listen(homePort);
    await resource.listen(resourcePort);
    const resourceActorId = resource.actor('registry').id;
    const logins = new Map<string, Extract<HomeLoginResult, { status: 'signed-in' }>>();
    for (const [name, password] of Object.entries(accountPasswords)) logins.set(name, await successfulLogin(homeOrigin, `@${name}@${host}`, password));
    const governor = logins.get('orla');
    const alice = logins.get('alice');
    assert.ok(governor, 'the fixture requires an orla governor login');
    assert.ok(alice, 'the fixture requires an alice Player login');
    const enrolledName = options.enrolledName ?? 'alice';
    const enrolled = logins.get(enrolledName);
    assert.ok(enrolled, `the fixture requires an ${enrolledName} login`);
    const enrolledActorId = homeApp.ids.players[enrolledName];
    assert.ok(enrolledActorId, `the fixture requires an ${enrolledName} Actor`);
    await resource.server.enrollPlayer(enrolledActorId, homeApp.ids.actor.home);
    const resourceUri = `${resourceOrigin}/objects/private`;
    resource.server.registerResource(resourceUri, { value: 'permitted' }, { public: false, actorId: resourceActorId });
    assert.equal((await requestDigest(homeOrigin, enrolledActorId, resourceActorId)).status, 202);
    assert.equal(await homeApp.authority.server.processOutbox(), 1);
    assert.equal(await resource.server.processInbox(), 1);
    assert.equal((await fetch(resourceUri, { headers: { Authorization: `Bearer ${await deriveDiplomaticToken(enrolled.nativeToken, resourceActorId)}` } })).status, 200);
    return { directory, homeOptions, homePort, homeOrigin, host, homeApp, resource, resourceActorId, resourceUri, governor, alice, enrolled };
  } catch (error) {
    await homeApp.authority.close();
    await resource.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function postAvailability(origin: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${origin}/local/home/accounts/availability`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

function requestDigest(origin: string, actorId: string, resourceActorId: string): Promise<Response> {
  return fetch(`${origin}/local/home/digest-request`, {
    method: 'POST',
    headers: { Authorization: 'Bearer local-admin-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor: actorId, resourceActor: resourceActorId })
  });
}

async function listAccounts(origin: string, token: string): Promise<Map<string, { actorId: string; available: boolean }>> {
  const response = await fetch(`${origin}/local/home/accounts`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const body = await response.json() as { accounts: Array<{ handle: string; actorId: string; available: boolean }> };
  return new Map(body.accounts.map((account) => [account.handle, account]));
}

function expectAvailabilitySuccess(response: Response): void {
  assert.ok(response.status >= 200 && response.status < 300, `expected an accepted availability change, got ${response.status}`);
}

function expectClientError(response: Response): void {
  assert.ok(response.status >= 400 && response.status < 500, `expected a client error, got ${response.status}`);
}

function postHomeLogin(origin: string, body: unknown): Promise<Response> {
  return fetch(`${origin}/local/home/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

async function successfulLogin(origin: string, handle: string, password: string): Promise<Extract<HomeLoginResult, { status: 'signed-in' }>> {
  const response = await postHomeLogin(origin, { handle, password });
  assert.equal(response.status, 200);
  const result = await response.json() as HomeLoginResult;
  assert.equal(result.status, 'signed-in');
  if (result.status !== 'signed-in') throw new Error('Expected signed-in login result');
  assert.equal(result.handle, handle);
  assert.equal(typeof result.nativeToken, 'string');
  return result;
}

async function assertRejectedLogin(response: Response): Promise<void> {
  assert.ok(response.status >= 400 && response.status < 500, 'a rejected login must be a client error');
  const body = await response.json() as HomeLoginResult;
  assert.equal(body.status, 'rejected');
  assert.equal(Object.hasOwn(body, 'nativeToken'), false, 'a rejected login must not issue a native token');
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
