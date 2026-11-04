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
    assert.equal((await fetch(`${origin}/local/repository/authoring`)).status, 401);
    for (const credential of ['invalid-token', 'admin', 'diplomatic-credential']) {
      assert.equal((await fetch(`${origin}/local/repository/authoring`, { headers: { Authorization: `Bearer ${credential}` } })).status, 401);
    }
    for (const name of ['player', 'p3', 'p4', 'p5']) {
      const privateCatalog = await fetch(`${origin}/local/repository/authoring`, { headers: auth(name) }).then((response) => response.json()) as { assets: unknown[]; varieties: unknown[]; grants: unknown[] };
      assert.deepEqual([privateCatalog.assets, privateCatalog.varieties, privateCatalog.grants], [[], [], []]);
    }
    const foreignAttempt = await fetch(`${origin}/local/repository/authoring/assets`, { method: 'POST', headers: auth('p2'), body: JSON.stringify({ name: 'spoof', text: 'x', holder: app.ids.players.player }) });
    assert.equal(foreignAttempt.status, 400);
    const before = await app.authority.server.store.read((state) => state.domain.authoring);
    assert.equal(before, undefined);
    const unchanged = () => app.authority.server.store.read((state) => ({ authoring: state.domain.authoring, objects: state.objects, outboxArchive: state.outboxArchive }));
    const initialState = await unchanged();
    const malformed = await fetch(`${origin}/local/repository/authoring/assets`, { method: 'POST', headers: auth('p2'), body: '{' });
    assert.equal(malformed.status, 400);
    const invalidProduction = await fetch(`${origin}/local/repository/authoring/varieties`, { method: 'POST', headers: auth('p2'), body: JSON.stringify({ name: 'Invalid', mass: 1, version: '1', production: [{ type: 'manufacture', duration: 1, yield: [], location: [{ id: 'https://example.test/area' }] }] }) });
    assert.equal(invalidProduction.status, 400);
    const spoofVariety = await fetch(`${origin}/local/repository/authoring/varieties`, { method: 'POST', headers: auth('p2'), body: JSON.stringify({ name: 'Spoof', mass: 1, version: '1', holder: app.ids.players.player }) });
    assert.equal(spoofVariety.status, 400);
    assert.deepEqual(await unchanged(), initialState);
    const assetResponse = await fetch(`${origin}/local/repository/authoring/assets`, { method: 'POST', headers: auth('p2'), body: JSON.stringify({ name: 'Text', text: '<b>inert\ntext</b>' }) });
    assert.equal(assetResponse.status, 201);
    const { asset, activity } = await assetResponse.json() as { asset: Record<string, unknown>; activity: Record<string, unknown> };
    const media = (asset.media as Array<{ url: string }>)[0]!;
    const mediaResponse = await fetch(media.url);
    assert.equal(mediaResponse.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.equal(await mediaResponse.text(), '<b>inert\ntext</b>');
    assert.equal((await fetch(`${origin}/local/repository/authoring`, { headers: auth('player') })).status, 200);
    assert.equal(((await (await fetch(`${origin}/local/repository/authoring`, { headers: auth('p2') })).json()) as { assets: unknown[] }).assets.length, 1);
    const playerThreeBeforeForeignLink = await unchanged();
    const foreignLink = await fetch(`${origin}/local/repository/authoring/varieties`, { method: 'POST', headers: auth('p3'), body: JSON.stringify({ name: 'Foreign', mass: 1, version: '1', asset: asset.id }) });
    assert.equal(foreignLink.status, 403);
    assert.deepEqual(await unchanged(), playerThreeBeforeForeignLink);
    const varietyResponse = await fetch(`${origin}/local/repository/authoring/varieties`, { method: 'POST', headers: auth('p2'), body: JSON.stringify({ name: 'Ore', mass: 2.5, version: '1', asset: asset.id, production: [{ type: 'manufacture', duration: 2, ingredients: [{ variety: 'https://example.test/raw', count: 3, data: { grade: 'a' } }], location: [{ id: 'https://example.test/area', name: 'Area', territory: 'https://example.test/territory', extension: 'kept' }], yield: [{ probability: 0.75, count: 2, data: { nested: { tag: 'kept' } }, extra: true }], custom: { arbitrary: [1, 'x'] } }] }) });
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
    assert.equal(((await (await fetch(`${origin}/local/repository/authoring`, { headers: auth('p2') })).json()) as { varieties: unknown[] }).varieties.length, 1);
    const concurrent = await Promise.all(Array.from({ length: 5 }, (_, index) => fetch(`${origin}/local/repository/authoring/assets`, { method: 'POST', headers: auth('p3'), body: JSON.stringify({ name: `Asset ${index}`, text: `${index}` }) })));
    assert.ok(concurrent.every((response) => response.status === 201));
    const playerThree = await fetch(`${origin}/local/repository/authoring`, { headers: auth('p3') }).then((response) => response.json()) as { assets: Array<{ id: string }> };
    assert.equal(new Set(playerThree.assets.map((item) => item.id)).size, 5);
  } finally { await app.authority.close(); await rm(directory, { recursive: true, force: true }); }
});

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const TINY_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const TINY_WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0x00, 0x00, 0x00]), Buffer.from('WEBPVP8 '), Buffer.alloc(0x16)]);

interface ImageObjectStorage {
  put(key: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

interface ImageStorageDouble extends ImageObjectStorage {
  readonly objects: Map<string, { bytes: Uint8Array; mediaType: string }>;
  readonly puts: Array<{ key: string; bytes: Uint8Array; mediaType: string }>;
  readonly gets: string[];
  failNextPut?: string | undefined;
}

function imageStorageDouble(): ImageStorageDouble {
  const objects = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  const puts: Array<{ key: string; bytes: Uint8Array; mediaType: string }> = [];
  const gets: string[] = [];
  return {
    objects, puts, gets,
    async put(key, bytes, mediaType) {
      puts.push({ key, bytes: Uint8Array.from(bytes), mediaType });
      if (this.failNextPut !== undefined) { const message = this.failNextPut; this.failNextPut = undefined; throw new Error(message); }
      objects.set(key, { bytes: Uint8Array.from(bytes), mediaType });
    },
    async get(key) {
      gets.push(key);
      const stored = objects.get(key);
      if (!stored) throw new Error('image-not-found');
      return Uint8Array.from(stored.bytes);
    }
  };
}

type ImageAuthorityOptions = Parameters<typeof createAuthorityApp>[0] & { imageStorage?: ImageObjectStorage };
const createImageAuthorityApp = createAuthorityApp as unknown as (options: ImageAuthorityOptions) => ReturnType<typeof createAuthorityApp>;

async function startAuthoring(directory: string, port: number, storage?: ImageStorageDouble, retainedTokens?: Map<string, string>) {
  const origin = `http://127.0.0.1:${port}`;
  const app = await createImageAuthorityApp({
    origin,
    storeFile: join(directory, 'authority.json'),
    adminSecret: 'admin',
    playerNames: ['player', 'p2', 'p3'],
    ...(storage ? { imageStorage: storage } : {})
  });
  await app.authority.listen(port);
  const tokens = retainedTokens ?? new Map<string, string>();
  if (!retainedTokens) for (const name of ['player', 'p2', 'p3']) tokens.set(name, await app.home.issueNativeToken(app.ids.players[name]!));
  return { app, origin, tokens, auth: (name: string) => ({ Authorization: `Bearer ${tokens.get(name)!}`, 'Content-Type': 'application/json' }) };
}

function uploadImage(origin: string, token: string, mediaType: string, bytes: Uint8Array): Promise<Response> {
  return fetch(`${origin}/local/repository/authoring/images`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType, data: Buffer.from(bytes).toString('base64') }) });
}

function publishAsset(origin: string, token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${origin}/local/repository/authoring/assets`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function bytesOf(response: Response): Promise<Buffer> { return Buffer.from(await response.arrayBuffer()); }
function mediaTypeOf(response: Response): string | null { return response.headers.get('content-type')?.split(';')[0]?.trim() ?? null; }

test('Player uploads an image to private object storage and publishes it as a signed public Asset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authoring-images-'));
  const port = await availablePort();
  const storage = imageStorageDouble();
  const { app, origin, tokens, auth } = await startAuthoring(directory, port, storage);
  try {
    const unauthenticated = await fetch(`${origin}/local/repository/authoring/images`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType: 'image/png', data: TINY_PNG.toString('base64') }) });
    assert.equal(unauthenticated.status, 401);
    assert.equal(storage.puts.length, 0);

    const upload = await uploadImage(origin, tokens.get('p2')!, 'image/png', TINY_PNG);
    assert.equal(upload.status, 201);
    const descriptor = await upload.json() as { url: string; mediaType: string };
    assert.equal(descriptor.mediaType, 'image/png');
    assert.ok(descriptor.url.startsWith(`${origin}/objects/players/p2/images/`));
    assert.equal(storage.puts.length, 1);
    assert.equal(storage.puts[0]!.mediaType, 'image/png');
    assert.deepEqual(Buffer.from(storage.puts[0]!.bytes), TINY_PNG);
    assert.ok(storage.puts[0]!.key.length > 0);

    const anonymous = await fetch(descriptor.url);
    assert.notEqual(anonymous.status, 200);
    assert.notDeepEqual(await bytesOf(anonymous), TINY_PNG);
    const foreign = await fetch(descriptor.url, { headers: auth('p3') });
    assert.notEqual(foreign.status, 200);
    assert.notDeepEqual(await bytesOf(foreign), TINY_PNG);
    const preview = await fetch(descriptor.url, { headers: auth('p2') });
    assert.equal(preview.status, 200);
    assert.equal(mediaTypeOf(preview), 'image/png');
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await bytesOf(preview), TINY_PNG);
    assert.ok(storage.gets.length > 0);

    const publication = await publishAsset(origin, tokens.get('p2')!, { name: 'Picture', text: '', media: [descriptor] });
    assert.equal(publication.status, 201);
    const { asset } = await publication.json() as { asset: { id: string; media: Array<{ url: string; mediaType: string }> } };
    assert.equal(asset.media.length, 1);
    assert.equal(asset.media[0]!.url, descriptor.url);
    assert.equal(asset.media[0]!.mediaType, 'image/png');
    assert.equal(asset.media.some((item) => item.mediaType === 'text/plain'), false);

    const key = await fetch(`${origin}/keys/p2`).then((response) => response.json()) as Record<string, unknown>;
    const loader = createLocalDocumentLoader(new Map([[String(key.id), key]]));
    assert.equal((await verifyProofCryptography(asset as unknown as Record<string, unknown>, loader)).verified, true);

    const publicRead = await fetch(descriptor.url);
    assert.equal(publicRead.status, 200);
    assert.equal(mediaTypeOf(publicRead), 'image/png');
    assert.equal(publicRead.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await bytesOf(publicRead), TINY_PNG);
    const catalog = await fetch(`${origin}/local/repository/authoring`, { headers: auth('p2') }).then((response) => response.json()) as { assets: unknown[] };
    assert.equal(catalog.assets.length, 1);
  } finally { await app.authority.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Repository accepts supported image types with matching signatures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authoring-formats-'));
  const port = await availablePort();
  const storage = imageStorageDouble();
  const { app, origin, tokens, auth } = await startAuthoring(directory, port, storage);
  try {
    const formats: Array<[string, Buffer]> = [['image/png', TINY_PNG], ['image/gif', TINY_GIF], ['image/jpeg', TINY_JPEG], ['image/webp', TINY_WEBP]];
    for (const [mediaType, bytes] of formats) {
      const upload = await uploadImage(origin, tokens.get('p2')!, mediaType, bytes);
      assert.equal(upload.status, 201, mediaType);
      const descriptor = await upload.json() as { url: string; mediaType: string };
      assert.equal(descriptor.mediaType, mediaType);
      const preview = await fetch(descriptor.url, { headers: auth('p2') });
      assert.equal(preview.status, 200);
      assert.equal(mediaTypeOf(preview), mediaType);
      assert.deepEqual(await bytesOf(preview), bytes);
    }
  } finally { await app.authority.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Repository rejects malformed, signature-mismatched, and oversized image uploads before storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authoring-invalid-images-'));
  const port = await availablePort();
  const storage = imageStorageDouble();
  const { app, origin, tokens } = await startAuthoring(directory, port, storage);
  try {
    const rejected: Array<[string, string]> = [
      ['image/svg+xml', TINY_PNG.toString('base64')],
      ['text/plain', TINY_PNG.toString('base64')],
      ['image/png', TINY_GIF.toString('base64')],
      ['image/png', '<svg>not an image</svg>'],
      ['image/png', 'not base64!!!'],
      ['image/png', '']
    ];
    for (const [mediaType, data] of rejected) {
      const response = await fetch(`${origin}/local/repository/authoring/images`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.get('p2')!}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType, data }) });
      assert.equal(response.status, 400, `${mediaType} ${data.slice(0, 16)}`);
    }
    assert.equal(storage.puts.length, 0);
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1); TINY_PNG.copy(oversized);
    assert.equal((await uploadImage(origin, tokens.get('p2')!, 'image/png', oversized)).status, 400);
    assert.equal(storage.puts.length, 0);
    const atLimit = Buffer.alloc(10 * 1024 * 1024); TINY_PNG.copy(atLimit);
    const acceptedAtLimit = await uploadImage(origin, tokens.get('p2')!, 'image/png', atLimit);
    assert.equal(acceptedAtLimit.status, 201);
    assert.equal(storage.puts.length, 1);
    assert.deepEqual(Buffer.from(storage.puts[0]!.bytes), atLimit);
  } finally { await app.authority.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Repository refuses foreign, arbitrary, and type-substituted image references without publishing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authoring-references-'));
  const port = await availablePort();
  const storage = imageStorageDouble();
  const { app, origin, tokens, auth } = await startAuthoring(directory, port, storage);
  try {
    const upload = await uploadImage(origin, tokens.get('p2')!, 'image/png', TINY_PNG);
    assert.equal(upload.status, 201);
    const descriptor = await upload.json() as { url: string; mediaType: string };

    const foreign = await publishAsset(origin, tokens.get('p3')!, { name: 'Foreign', text: '', media: [descriptor] });
    assert.ok([400, 403].includes(foreign.status));
    const arbitrary = await publishAsset(origin, tokens.get('p2')!, { name: 'Arbitrary', text: '', media: [{ url: `${origin}/objects/players/p2/images/${'0'.repeat(32)}`, mediaType: 'image/png' }] });
    assert.ok([400, 403].includes(arbitrary.status));
    const substituted = await publishAsset(origin, tokens.get('p2')!, { name: 'Substituted', text: '', media: [{ url: descriptor.url, mediaType: 'image/gif' }] });
    assert.ok([400, 403].includes(substituted.status));

    const catalog = await fetch(`${origin}/local/repository/authoring`, { headers: auth('p2') }).then((response) => response.json()) as { assets: unknown[] };
    assert.equal(catalog.assets.length, 0);
    assert.notEqual((await fetch(descriptor.url)).status, 200);
  } finally { await app.authority.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Repository reports bounded storage failures without publishing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authoring-storage-failure-'));
  const port = await availablePort();
  const storage = imageStorageDouble();
  const { app, origin, tokens, auth } = await startAuthoring(directory, port, storage);
  try {
    storage.failNextPut = 'secret-bucket-detail';
    const upload = await uploadImage(origin, tokens.get('p2')!, 'image/png', TINY_PNG);
    assert.ok(upload.status >= 500);
    assert.equal((await upload.text()).includes('secret-bucket-detail'), false);
    assert.equal(storage.puts.length, 1);
    assert.equal(storage.objects.size, 0);
    const catalog = await fetch(`${origin}/local/repository/authoring`, { headers: auth('p2') }).then((response) => response.json()) as { assets: unknown[] };
    assert.equal(catalog.assets.length, 0);
  } finally { await app.authority.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Uploaded image metadata and bytes survive restart and can be published afterwards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authoring-image-restart-'));
  const port = await availablePort();
  const storage = imageStorageDouble();
  let session = await startAuthoring(directory, port, storage);
  try {
    const upload = await uploadImage(session.origin, session.tokens.get('p2')!, 'image/png', TINY_PNG);
    assert.equal(upload.status, 201);
    const descriptor = await upload.json() as { url: string; mediaType: string };
    assert.equal((await fetch(descriptor.url, { headers: session.auth('p2') })).headers.get('content-type'), 'image/png');
    await session.app.authority.close();
    session = await startAuthoring(directory, port, storage, session.tokens);
    const preview = await fetch(descriptor.url, { headers: session.auth('p2') });
    assert.equal(preview.status, 200);
    assert.deepEqual(await bytesOf(preview), TINY_PNG);
    const publication = await publishAsset(session.origin, session.tokens.get('p2')!, { name: 'Restarted', text: '', media: [descriptor] });
    assert.equal(publication.status, 201);
    const publicRead = await fetch(descriptor.url);
    assert.equal(publicRead.status, 200);
    assert.deepEqual(await bytesOf(publicRead), TINY_PNG);
  } finally { await session.app.authority.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Text authoring remains available and image upload is explicitly unavailable without object storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authoring-no-images-'));
  const port = await availablePort();
  const { app, origin, tokens, auth } = await startAuthoring(directory, port);
  try {
    const text = await fetch(`${origin}/local/repository/authoring/assets`, { method: 'POST', headers: auth('p2'), body: JSON.stringify({ name: 'Text', text: 'kept' }) });
    assert.equal(text.status, 201);
    const { asset } = await text.json() as { asset: { media: Array<{ url: string }> } };
    const media = await fetch(asset.media[0]!.url);
    assert.equal(media.status, 200);
    assert.equal(mediaTypeOf(media), 'text/plain');
    assert.equal(await media.text(), 'kept');
    const upload = await uploadImage(origin, tokens.get('p2')!, 'image/png', TINY_PNG);
    assert.ok(upload.status >= 400);
    assert.notEqual(upload.status, 404);
  } finally { await app.authority.close(); await rm(directory, { recursive: true, force: true }); }
});

async function availablePort(): Promise<number> { const server = createServer(); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); const port = address.port; await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); return port; }
