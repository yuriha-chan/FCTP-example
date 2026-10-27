import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { createTokenDigest, deriveDiplomaticToken } from '@fctp/auth';
import { createHost } from '@fctp/server-base';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port allocated');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('policy app serves linked resources and protects operations with enrolled Player tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-policy-app-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const origin = `http://127.0.0.1:${await freePort()}`;
  const authority = await createHost({
    origin: authorityOrigin, storeFile: join(directory, 'authority.json'),
    actors: [{ name: 'home', role: 'home' }, { name: 'player', role: 'player' }, { name: 'registry', role: 'registry' }]
  });
  const homeId = `${authorityOrigin}/actors/home`;
  const playerId = `${authorityOrigin}/actors/player`;
  const remoteFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    url.hash = '';
    for (const name of ['home', 'player', 'registry']) {
      if (url.href === `${authorityOrigin}/actors/${name}`) return Response.json(authority.actor(name));
      if (url.href === authority.key(name).keyPair.id.split('#')[0]) return Response.json(authority.key(name).publicKey);
    }
    return new Response('not found', { status: 404 });
  };
  const app = await createPolicyApp({ origin, storeFile: join(directory, 'policy.json'), authorityOrigin, peerOrigin: 'https://peer.example', adminSecret: 'policy-admin-secret', fetcher: remoteFetch });
  await app.host.listen(Number(new URL(origin).port));
  const nativeToken = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const diplomaticToken = await deriveDiplomaticToken(nativeToken, app.ids.actor);
  const digest = await createTokenDigest(playerId, 1, diplomaticToken);
  try {
    await app.host.server.receive(app.ids.actor, await authority.sign('home', {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
      id: `${homeId}/activities/token-digest/1`, type: 'Create', actor: homeId, object: digest, to: [app.ids.actor]
    } as never));
    await app.host.server.processInbox();
    const headers = { Authorization: `Bearer ${diplomaticToken}`, 'Content-Type': 'application/json' };
    const get = (uri: string, token?: string) => fetch(uri, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const unknownCommodity = await fetch(`${origin}/local/transfer`, { method: 'POST', headers, body: JSON.stringify({ direction: 'to-port', variety: `${origin}/objects/varieties/fake`, count: 1 }) });
    assert.equal(unknownCommodity.status, 400);
    const invalidPolicy = await fetch(`${origin}/local/admin/policy`, { method: 'POST', headers: { Authorization: 'Bearer policy-admin-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ miningPermitted: true, miningQuota: 2, oreReserve: 2, manufacturePermits: ['recipe'], recipes: [{ id: 'recipe', ingredients: { [app.ids.varieties.ore]: '2' }, output: app.ids.varieties.metal, outputCount: 1 }], warehouseLimits: {}, portLimits: {}, decisions: {} }) });
    assert.equal(invalidPolicy.status, 400);
    const basePolicy = { miningPermitted: true, miningQuota: 2, oreReserve: 2, manufacturePermits: [], recipes: [], warehouseLimits: {}, portLimits: {}, decisions: {} };
    const postPolicy = (varietyPortPolicy: unknown) => fetch(`${origin}/local/admin/policy`, { method: 'POST', headers: { Authorization: 'Bearer policy-admin-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...basePolicy, varietyPortPolicy }) });
    assert.equal((await postPolicy({ '/objects/varieties/metal': 'deny' })).status, 400);
    assert.equal((await postPolicy({ [app.ids.varieties.metal]: 'maybe' })).status, 400);
    assert.equal((await postPolicy([])).status, 400);
    const info = await (await fetch(`${origin}/local/info`)).json() as { ids: typeof app.ids };
    assert.deepEqual(info.ids, app.ids);
    assert.equal((await get(app.ids.ports[0]!)).status, 200);
    const publicPort = await (await get(app.ids.ports[0]!)).json() as { listings: string; resources?: unknown };
    assert.equal((await get(publicPort.listings)).status, 200);
    const listingCollection = await (await get(publicPort.listings)).json() as { items: Array<{ id: string }> };
    assert.equal((await get(listingCollection.items[0]!.id)).status, 200);
    assert.equal((await get(app.ids.ports[1]!)).status, 401);
    assert.equal((await get(app.ids.ports[1]!, diplomaticToken)).status, 403);
    assert.equal((await get(app.ids.ports[1]!, 'invalid')).status, 401);
    assert.equal((await fetch(`${origin}/local/mine`, { method: 'POST', headers: { Authorization: 'Bearer policy-admin-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 2 }) })).status, 401);
    const mined = await fetch(`${origin}/local/mine`, { method: 'POST', headers, body: JSON.stringify({ count: 2 }) });
    assert.equal(mined.status, 200);
    const manufactured = await fetch(`${origin}/local/manufacture`, { method: 'POST', headers, body: JSON.stringify({ count: 1, recipe: 'ore-to-metal' }) });
    assert.equal(manufactured.status, 200);
    const state = await (await fetch(`${origin}/local/state`, { headers: { Authorization: `Bearer ${diplomaticToken}` } })).json() as { state: { rawInventory: Record<string, number>; audit: Array<{ actor: string; action: string; outcome: string }> } };
    assert.equal(state.state.rawInventory[app.ids.varieties.metal], 1);
    assert.equal(state.state.rawInventory[app.ids.varieties.ore], 0);
    assert.deepEqual(state.state.audit.at(-1), { actor: playerId, action: 'manufacture', outcome: 'accepted', details: { recipeId: 'ore-to-metal', count: 1, outputCount: 1 } });
    const rejectedTransfer = await fetch(`${origin}/local/transfer`, { method: 'POST', headers, body: JSON.stringify({ direction: 'to-port', variety: app.ids.varieties.metal, count: 100 }) });
    assert.equal(rejectedTransfer.status, 409);
    const afterRejection = await (await fetch(`${origin}/local/state`, { headers: { Authorization: `Bearer ${diplomaticToken}` } })).json() as typeof state;
    assert.equal(afterRejection.state.audit.at(-1)?.actor, playerId);
    assert.equal(afterRejection.state.audit.at(-1)?.action, 'warehouse-to-port');
    assert.equal(afterRejection.state.audit.at(-1)?.outcome, 'rejected');
    const changed = await fetch(`${origin}/local/admin/admission`, { method: 'POST', headers: { Authorization: 'Bearer policy-admin-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ publicPorts: [app.ids.ports[1]] }) });
    assert.equal(changed.status, 200);
    assert.equal((await get(app.ids.ports[1]!)).status, 200);
    assert.equal((await get(`${app.ids.ports[1]}/listings`)).status, 200);
    assert.equal((await get(app.ids.ports[0]!)).status, 401);
    const actor = await (await fetch(app.ids.actor)).json() as { resources: { areas: Array<{ id: string; type: string }> } };
    assert.equal(actor.resources.areas[0]!.id, app.ids.areas[0]);
    assert.equal(actor.resources.areas[0]!.type, 'Area');
    const descriptor = await (await fetch(app.ids.map)).json() as { representations: Array<{ format: string }> };
    assert.equal(descriptor.representations[0]!.format, 'https://fctp.example/formats/ascii');
    const textMap = await fetch(`${origin}/objects/maps/territory/ascii`);
    assert.equal(textMap.headers.get('content-type'), 'text/plain; charset=utf-8');
    const asset = await (await fetch(app.ids.assets[0]!)).json() as { creator: string[]; media: Array<{ url: string }> };
    assert.deepEqual(asset.creator, [playerId]);
    const assetText = await fetch(asset.media[0]!.url);
    assert.equal(assetText.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(await assetText.text(), /^Ore: /);
    const variety = await fetch(app.ids.varieties.ore);
    assert.equal((await variety.json() as { id: string }).id, app.ids.varieties.ore);
  } finally {
    await app.host.close();
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});
