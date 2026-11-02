import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTokenDigest, deriveDiplomaticToken } from '@fctp/auth';
import type { Activity } from '@fctp/federation';
import { createHost, FctpServer } from '@fctp/server-base';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';

const context = ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'];

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

async function deliverTokenDigest(
  authority: Awaited<ReturnType<typeof createHost>>,
  territory: { host: { server: { receive(localActorId: string, activity: Activity): Promise<string>; processInbox(): Promise<number> } }; ids: { actor: string } },
  playerId: string,
  token: string,
  id: string
): Promise<void> {
  const homeId = authority.actor('home').id;
  const activity = await authority.sign('home', {
    '@context': context,
    id,
    type: 'Create',
    actor: homeId,
    object: await createTokenDigest(playerId, 1, token),
    to: [territory.ids.actor]
  } as never);
  await territory.host.server.receive(territory.ids.actor, activity);
  try {
    await territory.host.server.processInbox();
  } catch (error) {
    if (!(error instanceof AggregateError)) throw error;
  }
}

async function rejectedDeclaration(server: FctpServer, resource: string, sender: string, declaration: Awaited<ReturnType<typeof createTokenDigest>>): Promise<void> {
  try {
    await server.applyTokenDeclaration(resource, sender, declaration);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
}

test('a server without enrollment authenticates a declaration from the Player Home namespace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-server-'));
  try {
    const server = new FctpServer({ storeFile: join(directory, 'state.json') });
    const origin = `http://127.0.0.1:${await freePort()}`;
    const player = `${origin}/actors/alice`;
    const home = `${origin}/actors/home`;
    const resource = 'https://resource.example/actors/territory';
    const token = await deriveDiplomaticToken(nativeToken(1), resource);
    await server.open();
    await server.applyTokenDeclaration(resource, home, await createTokenDigest(player, 1, token));
    assert.equal(await server.authenticateDiplomaticToken(resource, token), player);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a declaration from another Home namespace does not authenticate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-foreign-home-'));
  try {
    const server = new FctpServer({ storeFile: join(directory, 'state.json') });
    const playerOrigin = `http://127.0.0.1:${await freePort()}`;
    const foreignOrigin = `http://127.0.0.1:${await freePort()}`;
    const player = `${playerOrigin}/actors/alice`;
    const foreignHome = `${foreignOrigin}/actors/home`;
    const resource = 'https://resource.example/actors/territory';
    const token = await deriveDiplomaticToken(nativeToken(33), resource);
    await server.open();
    await rejectedDeclaration(server, resource, foreignHome, await createTokenDigest(player, 1, token));
    assert.equal(await server.authenticateDiplomaticToken(resource, token), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('token declaration revisions are ordered independently of arrival order and equal revisions conflict', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-revisions-'));
  try {
    const server = new FctpServer({ storeFile: join(directory, 'state.json') });
    const origin = `http://127.0.0.1:${await freePort()}`;
    const player = `${origin}/actors/alice`;
    const home = `${origin}/actors/home`;
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

    assert.equal(await server.applyTokenDeclaration(resource, home, await createTokenDigest(player, 2, token3)), 'conflict');
    assert.equal(await server.authenticateDiplomaticToken(resource, token2), undefined);
    assert.equal(await server.authenticateDiplomaticToken(resource, token3), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a Policy app accepts a foreign Home Player declaration and authorizes player operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-policy-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const origin = `http://127.0.0.1:${await freePort()}`;
  const authority = await createHost({
    origin: authorityOrigin, storeFile: join(directory, 'authority.json'),
    actors: [{ name: 'home', role: 'home' }, { name: 'player', role: 'player' }, { name: 'registry', role: 'registry' }]
  });
  const app = await createPolicyApp({
    origin,
    storeFile: join(directory, 'policy.json'),
    adminSecret: 'open-federation-policy-secret'
  });
  try {
    await authority.listen(Number(new URL(authorityOrigin).port));
    await app.host.listen(Number(new URL(origin).port));
    const player = authority.actor('player').id;
    const token = await deriveDiplomaticToken(nativeToken(225), app.ids.actor);
    await deliverTokenDigest(authority, app, player, token, `${authority.actor('home').id}/token-digest/foreign-player`);

    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${origin}/local/state`, { headers })).status, 200);
    const mined = await fetch(`${origin}/local/mine`, {
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

test('a Simulation app accepts a foreign Home Player declaration and authorizes player operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-open-federation-simulation-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const origin = `http://127.0.0.1:${await freePort()}`;
  const authority = await createHost({
    origin: authorityOrigin, storeFile: join(directory, 'authority.json'),
    actors: [{ name: 'home', role: 'home' }, { name: 'player', role: 'player' }, { name: 'registry', role: 'registry' }]
  });
  const app = await createSimulationApp({
    origin,
    storeFile: join(directory, 'simulation.json'),
    peerOrigin: 'https://peer.example',
    adminSecret: 'open-federation-simulation-secret'
  });
  try {
    await authority.listen(Number(new URL(authorityOrigin).port));
    await app.host.listen(Number(new URL(origin).port));
    const player = authority.actor('player').id;
    const token = await deriveDiplomaticToken(nativeToken(250), app.ids.actor);
    await deliverTokenDigest(authority, app, player, token, `${authority.actor('home').id}/token-digest/foreign-player`);

    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${origin}/local/state`, { headers })).status, 200);
    const mined = await fetch(`${origin}/local/mine`, {
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

test('Policy derives the configured administrator Actor and Home from the loopback handle namespace', async () => {
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

test('Simulation derives the configured administrator Actor and Home from the loopback handle namespace', async () => {
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
