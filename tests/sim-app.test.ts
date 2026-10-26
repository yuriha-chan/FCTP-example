import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveDiplomaticToken, createTokenDigest } from '@fctp/auth';
import type { URI } from '@fctp/protocol';
import { createHost } from '@fctp/server-base';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No allocated port');
  const value = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return value;
}

test('simulation app serves resources and enforces enrolled Player and administrator permissions over HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sim-app-'));
  const authorityPort = await port();
  const appPort = await port();
  const authorityOrigin = `http://127.0.0.1:${authorityPort}`;
  const origin = `http://127.0.0.1:${appPort}`;
  const authority = await createHost({ origin: authorityOrigin, storeFile: join(directory, 'authority.json'), actors: [{ name: 'registry', role: 'registry' }, { name: 'home', role: 'home' }, { name: 'player', role: 'player' }] });
  const app = await createSimulationApp({ origin, storeFile: join(directory, 'simulation.json'), authorityOrigin, peerOrigin: 'https://policy.example', adminSecret: 'local-admin-secret' });
  try {
    await authority.listen(authorityPort);
    await app.host.listen(appPort);
    const infoResponse = await fetch(`${origin}/local/info`);
    assert.equal(infoResponse.status, 200);
    const info = await infoResponse.json() as { ids: typeof app.ids };
    assert.equal(info.ids.varieties.importedMetal, 'https://policy.example/objects/varieties/metal');
    assert.equal((await fetch(info.ids.varieties.metal)).status, 200);
    assert.equal((await fetch(info.ids.assets[1]!)).status, 200);
    const asset = await (await fetch(info.ids.assets[1]!)).json() as { media: Array<{ url: string; mediaType: string }> };
    assert.equal(asset.media[0]!.mediaType, 'text/plain');
    assert.equal((await fetch(asset.media[0]!.url)).status, 401);
    assert.equal((await fetch(asset.media[0]!.url, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
    assert.equal((await fetch(info.ids.map)).status, 401);
    assert.equal((await fetch(`${origin}/objects/maps/territory/ascii`)).status, 401);

    const player = authority.actor('player').id as URI;
    const token = await deriveDiplomaticToken(new Uint8Array(32).fill(7), app.ids.actor);
    const digest = await createTokenDigest(player, 1, token);
    const declaration = await authority.sign('home', {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
      id: `${authority.actor('home').id}/token-digest/1`, type: 'Create', actor: authority.actor('home').id,
      to: [app.ids.actor], object: digest,
    } as never);
    await app.host.server.receive(app.ids.actor, declaration);
    await app.host.server.processInbox();
    const playerAuth = { Authorization: `Bearer ${token}` };
    const assetResponse = await fetch(asset.media[0]!.url, { headers: playerAuth });
    assert.equal(assetResponse.status, 200);
    assert.match(assetResponse.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(await assetResponse.text(), 'metal production asset');
    assert.equal((await fetch(info.ids.map, { headers: playerAuth })).status, 200);
    assert.equal((await fetch(`${origin}/local/state`)).status, 401);
    assert.equal((await fetch(`${origin}/local/mine`, { method: 'POST', headers: { ...playerAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 2 }) })).status, 200);
    assert.equal((await fetch(`${origin}/local/mine`, { method: 'POST', headers: { Authorization: 'Bearer local-admin-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1 }) })).status, 403);
    assert.equal((await fetch(`${origin}/local/mine`, { method: 'POST', headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1 }) })).status, 401);
    assert.equal((await fetch(`${origin}/local/admin/tick`, { method: 'POST', headers: playerAuth })).status, 403);
    const stateResponse = await fetch(`${origin}/local/state`, { headers: playerAuth });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json() as { simulation: { productionJobs: Array<{ count: number }> } };
    assert.equal(state.simulation.productionJobs[0]?.count, 2);
    assert.equal((await fetch(`${origin}/local/unload`, { method: 'POST', headers: { Authorization: 'Bearer local-admin-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ entryRequest: `${authorityOrigin}/requests/missing`, cargo: { entries: [] }, duration: 1 }) })).status, 403);
    assert.equal((await fetch(`${origin}/local/unload`, { method: 'POST', headers: { ...playerAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ entryRequest: `${authorityOrigin}/requests/missing`, cargo: { entries: [{ variety: app.ids.varieties.ore, count: 2 }] }, duration: 1 }) })).status, 400);
  } finally {
    await app.host.close();
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});
