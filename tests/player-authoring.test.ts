import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalDocumentLoader, verifyProofCryptography } from '@fctp/identity';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';

test('Player authoring publishes signed private catalogs and inert media with durable local outbox', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authoring-'));
  const port = await availablePort(); const origin = `http://127.0.0.1:${port}`; const storeFile = join(directory, 'authority.json');
  let app = await createAuthorityApp({ origin, storeFile, adminSecret: 'admin', playerNames: ['player', 'p2', 'p3', 'p4', 'p5'] });
  try {
    await app.authority.listen(port);
    const tokens = new Map<string, string>();
    for (const name of ['player', 'p2', 'p3', 'p4', 'p5']) tokens.set(name, await app.home.issueNativeToken(app.ids.players[name]!));
    const auth = (name: string) => ({ Authorization: `Bearer ${tokens.get(name)!}`, 'Content-Type': 'application/json' });
    assert.equal((await fetch(`${origin}/local/authoring`)).status, 401);
    for (const credential of ['invalid-token', 'admin', 'diplomatic-credential']) {
      assert.equal((await fetch(`${origin}/local/authoring`, { headers: { Authorization: `Bearer ${credential}` } })).status, 401);
    }
    for (const name of ['player', 'p3', 'p4', 'p5']) {
      const privateCatalog = await fetch(`${origin}/local/authoring`, { headers: auth(name) }).then((response) => response.json()) as { assets: unknown[]; varieties: unknown[]; grants: unknown[] };
      assert.deepEqual([privateCatalog.assets, privateCatalog.varieties, privateCatalog.grants], [[], [], []]);
    }
    const foreignAttempt = await fetch(`${origin}/local/authoring/assets`, { method: 'POST', headers: auth('p2'), body: JSON.stringify({ name: 'spoof', text: 'x', holder: app.ids.players.player }) });
    assert.equal(foreignAttempt.status, 400);
    const before = await app.authority.server.store.read((state) => state.domain.authoring);
    assert.equal(before, undefined);
    const unchanged = () => app.authority.server.store.read((state) => ({ authoring: state.domain.authoring, objects: state.objects, outboxArchive: state.outboxArchive }));
    const initialState = await unchanged();
    const malformed = await fetch(`${origin}/local/authoring/assets`, { method: 'POST', headers: auth('p2'), body: '{' });
    assert.equal(malformed.status, 400);
    const invalidProduction = await fetch(`${origin}/local/authoring/varieties`, { method: 'POST', headers: auth('p2'), body: JSON.stringify({ name: 'Invalid', mass: 1, version: '1', production: [{ type: 'manufacture', duration: 1, yield: [], location: [{ id: 'https://example.test/area' }] }] }) });
    assert.equal(invalidProduction.status, 400);
    const spoofVariety = await fetch(`${origin}/local/authoring/varieties`, { method: 'POST', headers: auth('p2'), body: JSON.stringify({ name: 'Spoof', mass: 1, version: '1', holder: app.ids.players.player }) });
    assert.equal(spoofVariety.status, 400);
    assert.deepEqual(await unchanged(), initialState);
    const assetResponse = await fetch(`${origin}/local/authoring/assets`, { method: 'POST', headers: auth('p2'), body: JSON.stringify({ name: 'Text', text: '<b>inert\ntext</b>' }) });
    assert.equal(assetResponse.status, 201);
    const { asset, activity } = await assetResponse.json() as { asset: Record<string, unknown>; activity: Record<string, unknown> };
    const media = (asset.media as Array<{ url: string }>)[0]!;
    const mediaResponse = await fetch(media.url);
    assert.equal(mediaResponse.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await mediaResponse.text(), '<b>inert\ntext</b>');
    assert.equal((await fetch(`${origin}/local/authoring`, { headers: auth('player') })).status, 200);
    assert.equal(((await (await fetch(`${origin}/local/authoring`, { headers: auth('p2') })).json()) as { assets: unknown[] }).assets.length, 1);
    const playerThreeBeforeForeignLink = await unchanged();
    const foreignLink = await fetch(`${origin}/local/authoring/varieties`, { method: 'POST', headers: auth('p3'), body: JSON.stringify({ name: 'Foreign', mass: 1, version: '1', asset: asset.id }) });
    assert.equal(foreignLink.status, 403);
    assert.deepEqual(await unchanged(), playerThreeBeforeForeignLink);
    const varietyResponse = await fetch(`${origin}/local/authoring/varieties`, { method: 'POST', headers: auth('p2'), body: JSON.stringify({ name: 'Ore', mass: 2.5, version: '1', asset: asset.id, production: [{ type: 'manufacture', duration: 2, ingredients: [{ variety: 'https://example.test/raw', count: 3, data: { grade: 'a' } }], location: [{ id: 'https://example.test/area', name: 'Area', territory: 'https://example.test/territory', extension: 'kept' }], yield: [{ probability: 0.75, count: 2, data: { nested: { tag: 'kept' } }, extra: true }], custom: { arbitrary: [1, 'x'] } }] }) });
    assert.equal(varietyResponse.status, 201);
    const result = await varietyResponse.json() as { variety: Record<string, unknown>; activity: Record<string, unknown>; grant: Record<string, unknown> };
    assert.equal((result.grant as { grantee: string }).grantee, app.ids.players.p2);
    const key = await fetch(`${origin}/keys/p2`).then((response) => response.json()) as Record<string, unknown>;
    const loader = createLocalDocumentLoader(new Map([[String(key.id), key]]));
    for (const uri of [String(asset.id), String(result.variety.id), String(result.grant.id)]) {
      const published = await fetch(uri).then((response) => response.json());
      assert.equal((await verifyProofCryptography(published, loader)).verified, true);
    }
    for (const value of [asset, result.variety, result.grant, activity]) assert.equal((await verifyProofCryptography(value, loader)).verified, true);
    const changedMedia = structuredClone(asset); ((changedMedia.media as Array<{ url: string }>)[0]!).url = 'https://example.test/forged-media';
    assert.equal((await verifyProofCryptography(changedMedia, loader)).verified, false);
    const tampered = structuredClone(result.variety); (tampered.production as Array<Record<string, unknown>>)[0]!.yield = [];
    assert.equal((await verifyProofCryptography(tampered, loader)).verified, false);
    for (const mutate of [
      (value: Record<string, unknown>) => { value.asset = 'https://example.test/other'; },
      (value: Record<string, unknown>) => { value.mass = 99; },
      (value: Record<string, unknown>) => { (value.production as Array<Record<string, unknown>>)[0]!.ingredients = []; },
      (value: Record<string, unknown>) => { (value.production as Array<Record<string, unknown>>)[0]!.location = []; },
      (value: Record<string, unknown>) => { (((value.production as Array<Record<string, unknown>>)[0]!.yield as Array<Record<string, unknown>>)[0]!).probability = 0.5; },
      (value: Record<string, unknown>) => { (((value.production as Array<Record<string, unknown>>)[0]!.yield as Array<Record<string, unknown>>)[0]!.data as Record<string, unknown>).nested = {}; }
    ]) { const changed = structuredClone(result.variety); mutate(changed); assert.equal((await verifyProofCryptography(changed, loader)).verified, false); }
    const changedGrant = structuredClone(result.grant); changedGrant.variety = 'https://example.test/other';
    assert.equal((await verifyProofCryptography(changedGrant, loader)).verified, false);
    const catalog = await fetch(`${origin}/objects/players/p2/creations`).then((response) => response.json()) as { orderedItems: unknown[] };
    assert.equal(catalog.orderedItems.length, 3);
    const archived = await fetch(`${origin}/actors/p2/outbox`).then((response) => response.json()) as { totalItems: number };
    assert.equal(archived.totalItems, 3);
    assert.equal(await app.authority.server.store.read((state) => state.outbox.length), 0);
    await app.authority.close();
    app = await createAuthorityApp({ origin, storeFile, adminSecret: 'admin', playerNames: ['player', 'p2', 'p3', 'p4', 'p5'] });
    await app.authority.listen(port);
    assert.equal((await fetch(media.url)).status, 200);
    assert.equal(((await (await fetch(`${origin}/local/authoring`, { headers: auth('p2') })).json()) as { varieties: unknown[] }).varieties.length, 1);
    const concurrent = await Promise.all(Array.from({ length: 5 }, (_, index) => fetch(`${origin}/local/authoring/assets`, { method: 'POST', headers: auth('p3'), body: JSON.stringify({ name: `Asset ${index}`, text: `${index}` }) })));
    assert.ok(concurrent.every((response) => response.status === 201));
    const playerThree = await fetch(`${origin}/local/authoring`, { headers: auth('p3') }).then((response) => response.json()) as { assets: Array<{ id: string }> };
    assert.equal(new Set(playerThree.assets.map((item) => item.id)).size, 5);
  } finally { await app.authority.close(); await rm(directory, { recursive: true, force: true }); }
});

async function availablePort(): Promise<number> { const server = createServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); const port = address.port; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); return port; }
