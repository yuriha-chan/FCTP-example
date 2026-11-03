import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTokenDigest, createTokenRevoke, deriveDiplomaticToken } from '@fctp/auth';
import type { Activity } from '@fctp/federation';
import { createHost, FctpServer } from '@fctp/server-base';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';

const context = ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'];
const NODEINFO_SCHEMA = 'http://nodeinfo.diaspora.software/ns/schema/2.1';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port allocated');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function nativeToken(seed: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256);
}

async function startHome(origin: string, storeFile: string): Promise<Awaited<ReturnType<typeof createHost>>> {
  const host = await createHost({
    origin,
    storeFile,
    actors: [{ name: 'home', role: 'home' }],
    nodeInfo: { name: 'fixture-home' },
    homeAccountName: 'system.home'
  });
  await host.listen(Number(new URL(origin).port));
  return host;
}

function playerDiscoveryFetcher(playerOrigin: string, homeActorId: string): typeof fetch {
  const player = new URL(playerOrigin);
  return async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === player.origin && url.pathname === '/.well-known/nodeinfo') {
      return Response.json({ links: [{ rel: NODEINFO_SCHEMA, href: `${player.origin}/nodeinfo/2.1` }] });
    }
    if (url.origin === player.origin && url.pathname === '/nodeinfo/2.1') {
      return Response.json({ version: '2.1', metadata: { homeAccountName: 'system.home' } });
    }
    if (url.origin === player.origin && url.pathname === '/.well-known/webfinger') {
      const resource = url.searchParams.get('resource');
      return Response.json({ subject: resource, links: [{ rel: 'self', href: homeActorId }] });
    }
    return fetch(request);
  };
}

async function queueTokenDigest(
  signer: Awaited<ReturnType<typeof createHost>>,
  territory: { host: { server: { receive(localActorId: string, activity: Activity): Promise<string> } }; ids: { actor: string } },
  playerId: string,
  token: string,
  id: string
): Promise<void> {
  const homeId = signer.actor('home').id;
  const activity = await signer.sign('home', {
    '@context': context,
    id,
    type: 'Create',
    actor: homeId,
    object: await createTokenDigest(playerId, 1, token),
    to: [territory.ids.actor]
  } as never);
  await territory.host.server.receive(territory.ids.actor, activity);
}

async function deliverTokenDigest(
  authority: Awaited<ReturnType<typeof createHost>>,
  territory: { host: { server: { receive(localActorId: string, activity: Activity): Promise<string>; processInbox(): Promise<number> } }; ids: { actor: string } },
  playerId: string,
  token: string,
  id: string
): Promise<void> {
  await queueTokenDigest(authority, territory, playerId, token, id);
  try {
    await territory.host.server.processInbox();
  } catch (error) {
    if (!(error instanceof AggregateError)) throw error;
  }
}

test('a server without enrollment accepts a declaration from the delegated Home discovered for the Player origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-server-'));
  const homeOrigin = `http://127.0.0.1:${await freePort()}`;
  const playerOrigin = 'https://players.example';
  const authority = await startHome(homeOrigin, join(directory, 'authority.json'));
  try {
    const home = authority.actor('home').id;
    const player = `${playerOrigin}/actors/alice`;
    const resource = 'https://resource.example/actors/territory';
    const token = await deriveDiplomaticToken(nativeToken(1), resource);
    const server = new FctpServer({ storeFile: join(directory, 'state.json'), fetcher: playerDiscoveryFetcher(playerOrigin, home) });
    await server.open();
    await server.applyTokenDeclaration(resource, home, await createTokenDigest(player, 1, token));
    assert.equal(await server.authenticateDiplomaticToken(resource, token), player);
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('guessed Home namespaces and enrolled wrong Homes cannot authenticate declarations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-foreign-home-'));
  const homeOrigin = `http://127.0.0.1:${await freePort()}`;
  const playerOrigin = 'https://players.example';
  const authority = await startHome(homeOrigin, join(directory, 'authority.json'));
  try {
    const player = `${playerOrigin}/actors/alice`;
    const home = authority.actor('home').id;
    const guessedHome = `${playerOrigin}/actors/home`;
    const enrolledWrongHome = 'https://enrolled.example/actors/home';
    const resource = 'https://resource.example/actors/territory';
    const server = new FctpServer({ storeFile: join(directory, 'state.json'), fetcher: playerDiscoveryFetcher(playerOrigin, home) });
    await server.open();
    await server.enrollPlayer(player, enrolledWrongHome);

    const guessedToken = await deriveDiplomaticToken(nativeToken(33), resource);
    await assert.rejects(server.applyTokenDeclaration(resource, guessedHome, await createTokenDigest(player, 1, guessedToken)));
    assert.equal(await server.authenticateDiplomaticToken(resource, guessedToken), undefined);

    const enrolledToken = await deriveDiplomaticToken(nativeToken(49), resource);
    await assert.rejects(server.applyTokenDeclaration(resource, enrolledWrongHome, await createTokenDigest(player, 1, enrolledToken)));
    assert.equal(await server.authenticateDiplomaticToken(resource, enrolledToken), undefined);

    const discoveredToken = await deriveDiplomaticToken(nativeToken(17), resource);
    assert.equal(await server.applyTokenDeclaration(resource, home, await createTokenDigest(player, 1, discoveredToken)), 'applied');
    assert.equal(await server.authenticateDiplomaticToken(resource, discoveredToken), player);
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed Home discovery writes no credential and a later discovery applies the declaration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-recovery-'));
  const homeOrigin = `http://127.0.0.1:${await freePort()}`;
  const playerOrigin = 'https://players.example';
  const authority = await startHome(homeOrigin, join(directory, 'authority.json'));
  try {
    const home = authority.actor('home').id;
    const player = `${playerOrigin}/actors/alice`;
    const resource = 'https://resource.example/actors/territory';
    const token = await deriveDiplomaticToken(nativeToken(81), resource);
    const discovery = playerDiscoveryFetcher(playerOrigin, home);
    let unavailable = true;
    const fetcher: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      if (unavailable && url.origin === new URL(playerOrigin).origin && url.pathname === '/.well-known/nodeinfo') {
        throw new Error('discovery unavailable');
      }
      return discovery(request);
    };
    const server = new FctpServer({ storeFile: join(directory, 'state.json'), fetcher });
    await server.open();

    await assert.rejects(server.applyTokenDeclaration(resource, home, await createTokenDigest(player, 1, token)));
    assert.equal(await server.authenticateDiplomaticToken(resource, token), undefined);

    unavailable = false;
    assert.equal(await server.applyTokenDeclaration(resource, home, await createTokenDigest(player, 1, token)), 'applied');
    assert.equal(await server.authenticateDiplomaticToken(resource, token), player);
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a TokenRevoke from the discovered Home revokes the Player credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-revoke-'));
  const homeOrigin = `http://127.0.0.1:${await freePort()}`;
  const playerOrigin = 'https://players.example';
  const authority = await startHome(homeOrigin, join(directory, 'authority.json'));
  try {
    const home = authority.actor('home').id;
    const player = `${playerOrigin}/actors/alice`;
    const resource = 'https://resource.example/actors/territory';
    const token = await deriveDiplomaticToken(nativeToken(113), resource);
    const server = new FctpServer({ storeFile: join(directory, 'state.json'), fetcher: playerDiscoveryFetcher(playerOrigin, home) });
    await server.open();
    assert.equal(await server.applyTokenDeclaration(resource, home, await createTokenDigest(player, 1, token)), 'applied');
    assert.equal(await server.authenticateDiplomaticToken(resource, token), player);
    assert.equal(await server.applyTokenDeclaration(resource, home, createTokenRevoke(player, 2)), 'applied');
    assert.equal(await server.authenticateDiplomaticToken(resource, token), undefined);
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('token declaration revisions are ordered independently of arrival order, equal revisions conflict, and restart preserves state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-revisions-'));
  const homeOrigin = `http://127.0.0.1:${await freePort()}`;
  const playerOrigin = 'https://players.example';
  const authority = await startHome(homeOrigin, join(directory, 'authority.json'));
  try {
    const home = authority.actor('home').id;
    const player = `${playerOrigin}/actors/alice`;
    const storeFile = join(directory, 'state.json');
    const fetcher = playerDiscoveryFetcher(playerOrigin, home);
    const server = new FctpServer({ storeFile, fetcher });
    const resource = 'https://resource.example/actors/territory';
    const reverseResource = 'https://resource.example/actors/other';
    const token1 = await deriveDiplomaticToken(nativeToken(65), resource);
    const token2 = await deriveDiplomaticToken(nativeToken(97), resource);
    const token3 = await deriveDiplomaticToken(nativeToken(129), resource);
    const reverseToken1 = await deriveDiplomaticToken(nativeToken(161), reverseResource);
    const reverseToken2 = await deriveDiplomaticToken(nativeToken(193), reverseResource);
    await server.open();

    assert.equal(await server.applyTokenDeclaration(resource, home, await createTokenDigest(player, 2, token2)), 'applied');
    assert.equal(await server.applyTokenDeclaration(resource, home, await createTokenDigest(player, 1, token1)), 'stale');
    assert.equal(await server.authenticateDiplomaticToken(resource, token2), player);
    assert.equal(await server.authenticateDiplomaticToken(resource, token1), undefined);

    assert.equal(await server.applyTokenDeclaration(reverseResource, home, await createTokenDigest(player, 1, reverseToken1)), 'applied');
    assert.equal(await server.applyTokenDeclaration(reverseResource, home, await createTokenDigest(player, 2, reverseToken2)), 'applied');
    assert.equal(await server.authenticateDiplomaticToken(reverseResource, reverseToken2), player);
    assert.equal(await server.authenticateDiplomaticToken(reverseResource, reverseToken1), undefined);

    const restarted = new FctpServer({ storeFile, fetcher });
    await restarted.open();
    assert.equal(await restarted.authenticateDiplomaticToken(resource, token2), player);
    assert.equal(await restarted.authenticateDiplomaticToken(reverseResource, reverseToken2), player);
    assert.equal(await restarted.applyTokenDeclaration(resource, home, await createTokenDigest(player, 1, token1)), 'stale');

    assert.equal(await restarted.applyTokenDeclaration(resource, home, await createTokenDigest(player, 2, token3)), 'conflict');
    assert.equal(await restarted.authenticateDiplomaticToken(resource, token2), undefined);
    assert.equal(await restarted.authenticateDiplomaticToken(resource, token3), undefined);
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a Policy app accepts a declaration from the delegated Home discovered for the Player origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-policy-'));
  const homeOrigin = `http://127.0.0.1:${await freePort()}`;
  const playerOrigin = 'https://players.example';
  const origin = `http://127.0.0.1:${await freePort()}`;
  const authority = await startHome(homeOrigin, join(directory, 'authority.json'));
  const home = authority.actor('home').id;
  const app = await createPolicyApp({
    origin,
    storeFile: join(directory, 'policy.json'),
    adminSecret: 'open-federation-policy-secret',
    fetcher: playerDiscoveryFetcher(playerOrigin, home)
  });
  try {
    await app.host.listen(Number(new URL(origin).port));
    const player = `${playerOrigin}/actors/alice`;
    const token = await deriveDiplomaticToken(nativeToken(225), app.ids.actor);
    await deliverTokenDigest(authority, app, player, token, `${home}/token-digest/delegated-player`);

    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${origin}/local/territory/state`, { headers })).status, 200);
    const mined = await fetch(`${origin}/local/territory/mine`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 1 })
    });
    assert.equal(mined.status, 200);
  } finally {
    await app.host.close();
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a Simulation app accepts a declaration from the delegated Home discovered for the Player origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-simulation-'));
  const homeOrigin = `http://127.0.0.1:${await freePort()}`;
  const playerOrigin = 'https://players.example';
  const origin = `http://127.0.0.1:${await freePort()}`;
  const authority = await startHome(homeOrigin, join(directory, 'authority.json'));
  const home = authority.actor('home').id;
  const app = await createSimulationApp({
    origin,
    storeFile: join(directory, 'simulation.json'),
    peerOrigin: 'https://peer.example',
    adminSecret: 'open-federation-simulation-secret',
    fetcher: playerDiscoveryFetcher(playerOrigin, home)
  });
  try {
    await app.host.listen(Number(new URL(origin).port));
    const player = `${playerOrigin}/actors/alice`;
    const token = await deriveDiplomaticToken(nativeToken(250), app.ids.actor);
    await deliverTokenDigest(authority, app, player, token, `${home}/token-digest/delegated-player`);

    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${origin}/local/territory/state`, { headers })).status, 200);
    const mined = await fetch(`${origin}/local/territory/mine`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ count: 1 })
    });
    assert.equal(mined.status, 200);
  } finally {
    await app.host.close();
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a Policy app rejects a declaration signed by the guessed namespace Home instead of the discovered Home', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-policy-wrong-home-'));
  const homeOrigin = `http://127.0.0.1:${await freePort()}`;
  const playerOrigin = `http://127.0.0.1:${await freePort()}`;
  const origin = `http://127.0.0.1:${await freePort()}`;
  const authority = await startHome(homeOrigin, join(directory, 'authority.json'));
  const guessed = await startHome(playerOrigin, join(directory, 'guessed.json'));
  const app = await createPolicyApp({
    origin,
    storeFile: join(directory, 'policy.json'),
    adminSecret: 'open-federation-policy-wrong-home-secret',
    fetcher: playerDiscoveryFetcher(playerOrigin, authority.actor('home').id)
  });
  try {
    await app.host.listen(Number(new URL(origin).port));
    const player = `${playerOrigin}/actors/alice`;
    const token = await deriveDiplomaticToken(nativeToken(137), app.ids.actor);
    await queueTokenDigest(guessed, app, player, token, `${guessed.actor('home').id}/token-digest/guessed-player`);
    await assert.rejects(app.host.server.processInbox(), /Inbox processing failed/);
    assert.equal((await fetch(`${origin}/local/territory/state`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  } finally {
    await app.host.close();
    await guessed.close();
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a Simulation app rejects a declaration signed by the guessed namespace Home instead of the discovered Home', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-simulation-wrong-home-'));
  const homeOrigin = `http://127.0.0.1:${await freePort()}`;
  const playerOrigin = `http://127.0.0.1:${await freePort()}`;
  const origin = `http://127.0.0.1:${await freePort()}`;
  const authority = await startHome(homeOrigin, join(directory, 'authority.json'));
  const guessed = await startHome(playerOrigin, join(directory, 'guessed.json'));
  const app = await createSimulationApp({
    origin,
    storeFile: join(directory, 'simulation.json'),
    peerOrigin: 'https://peer.example',
    adminSecret: 'open-federation-simulation-wrong-home-secret',
    fetcher: playerDiscoveryFetcher(playerOrigin, authority.actor('home').id)
  });
  try {
    await app.host.listen(Number(new URL(origin).port));
    const player = `${playerOrigin}/actors/alice`;
    const token = await deriveDiplomaticToken(nativeToken(173), app.ids.actor);
    await queueTokenDigest(guessed, app, player, token, `${guessed.actor('home').id}/token-digest/guessed-player`);
    await assert.rejects(app.host.server.processInbox(), /Inbox processing failed/);
    assert.equal((await fetch(`${origin}/local/territory/state`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  } finally {
    await app.host.close();
    await guessed.close();
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Policy configures an administrator account without contacting its Home at startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-policy-admin-'));
  const administratorPort = await freePort();
  const origin = `http://127.0.0.1:${await freePort()}`;
  let app: Awaited<ReturnType<typeof createPolicyApp>> | undefined;
  try {
    app = await createPolicyApp({
      origin,
      storeFile: join(directory, 'policy.json'),
      administrator: `@admin@127.0.0.1:${administratorPort}`,

      adminSecret: 'open-federation-policy-admin-secret'
    });
    assert.ok(app);
  } finally {
    if (app) await app.host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Simulation configures an administrator account without contacting its Home at startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-simulation-admin-'));
  const administratorPort = await freePort();
  const origin = `http://127.0.0.1:${await freePort()}`;
  let app: Awaited<ReturnType<typeof createSimulationApp>> | undefined;
  try {
    app = await createSimulationApp({
      origin,
      storeFile: join(directory, 'simulation.json'),
      administrator: `@admin@127.0.0.1:${administratorPort}`,
      peerOrigin: 'https://peer.example',
      adminSecret: 'open-federation-simulation-admin-secret'
    });
    assert.ok(app);
  } finally {
    if (app) await app.host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
