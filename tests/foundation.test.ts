import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  assertModel, compareCargo, validateModel, type CargoManifest, type FCTPActor, type ExitEvent
} from '@fctp/protocol';
import {
  createTokenDigest, createTokenRevoke, deriveDiplomaticToken, encodeNativeToken, TokenCredentialStore
} from '@fctp/auth';
import {
  checkExpectedIssuer, createLocalDocumentLoader, generateActorKey, signJsonLd, verifyKeyAttribution,
  resolveWebFinger, verifyProofCryptography, withDocuments, webFingerSubject
} from '@fctp/identity';
import { ResourceClient, ResourceError, selectMapRepresentation } from '@fctp/resources';
import { createActivity, parseActivity } from '@fctp/federation';
import { FctpServer } from '@fctp/server-base';

const actor = (id: string, role: FCTPActor['role'] = 'territory'): FCTPActor => ({
  id, inbox: `${id}/inbox`, outbox: `${id}/outbox`, role, publicKeys: [`${id}#key-1`]
});

test('protocol validation preserves extensions and cargo comparison remains descriptive', () => {
  const manifest: CargoManifest = { entries: [{ variety: 'https://example.test/ore', count: 5, data: { grade: 'A' } }], x_game: { untouched: true } };
  const valid = validateModel<CargoManifest>(manifest, 'CargoManifest');
  assert.equal(valid.success, true);
  if (valid.success) assert.deepEqual(valid.data, manifest);
  assert.equal(validateModel({ entries: [{ variety: 'https://example.test/ore', count: -1, data: {} }] }, 'CargoManifest').success, false);
  assertModel({ id: 'https://example.test/item/1', variety: 'https://example.test/ore', data: { extension: 1 }, x_extra: true }, 'Item');
  const left = { entries: [
    { variety: 'https://example.test/ore', count: 5, data: { grade: 'A' } },
    { id: 'https://example.test/item/1', variety: 'https://example.test/ore', data: {} }
  ] };
  const right = { entries: [{ variety: 'https://example.test/ore', count: 2, data: { grade: 'A' } }] };
  assert.deepEqual(compareCargo(left, right), {
    leftOnly: [
      { variety: 'https://example.test/ore', count: 3, data: { grade: 'A' } },
      { id: 'https://example.test/item/1', variety: 'https://example.test/ore', data: {} }
    ], rightOnly: []
  });
});

test('diplomatic token follows exact HMAC bytes and revision conflict fails closed', async () => {
  const native = new Uint8Array([0, 1, 2, 127, 128, 255]);
  const resourceServer = 'https://resource.test/actors/one';
  const expected = createHmac('sha256', native).update(Buffer.from(resourceServer, 'utf8')).digest('base64').replace(/=+$/, '');
  const token = await deriveDiplomaticToken(native, resourceServer);
  assert.equal(token, expected);
  assert.equal(encodeNativeToken(native), Buffer.from(native).toString('base64').replace(/=+$/, ''));
  const declaration = await createTokenDigest('https://home.test/players/alice', 3, token);
  assert.equal(declaration.tokenDigest, createHash('sha256').update(Buffer.from(token, 'base64')).digest('base64'));
  const credentials = new TokenCredentialStore();
  assert.equal(credentials.apply(declaration), 'applied');
  assert.equal(await credentials.authenticate(declaration.actor, token), true);
  assert.equal(credentials.apply({ ...declaration, tokenDigest: 'different' }), 'conflict');
  assert.equal(await credentials.authenticate(declaration.actor, token), false);
  assert.equal(credentials.apply(await createTokenRevoke(declaration.actor, 4)), 'applied');
  assert.equal(credentials.get(declaration.actor)?.status, 'revoked');
  assert.equal(credentials.apply(declaration), 'stale');
});

test('real eddsa-rdfc-2022 signs and verifies through fixed local contexts', async () => {
  const publisher = actor('https://territory.test/actors/blue');
  const key = await generateActorKey(publisher.id);
  publisher.publicKeys = [key.publicKey.id as string];
  const documents = new Map([[String(key.publicKey.id), key.publicKey]]);
  const loader = withDocuments(createLocalDocumentLoader(), documents);
  const payload: Omit<ExitEvent, 'proof'> = {
    id: 'https://territory.test/events/exit/1', type: 'ExitEvent', vessel: 'https://registry.test/vessels/1',
    territory: publisher.id, route: 'https://territory.test/routes/1', entryRequest: 'https://registry.test/requests/1',
    cargo: { entries: [] }, effectiveAt: '2026-10-26T10:00:00Z'
  };
  const signed = await signJsonLd(payload, key.keyPair, loader);
  assert.equal((signed.proof as Record<string, unknown>).cryptosuite, 'eddsa-rdfc-2022');
  assert.deepEqual(await verifyProofCryptography(signed, loader), { verified: true });
  assert.equal((await verifyKeyAttribution(signed, publisher, loader)).attributed, true);
  assert.deepEqual(checkExpectedIssuer(publisher.id, publisher.id).matches, true);
  const tampered = structuredClone(signed);
  (tampered.cargo as CargoManifest).entries.push({ variety: 'https://example.test/ore', count: 1, data: {} });
  assert.equal((await verifyProofCryptography(tampered, loader)).verified, false);
  assert.equal((await verifyKeyAttribution(signed, { ...publisher, publicKeys: [] }, loader)).attributed, false);
  assert.equal(webFingerSubject(publisher), '@blue.territory@territory.test');
  const resolved = await resolveWebFinger('@blue.territory@territory.test', async (input) => {
    const url = String(input);
    if (url.includes('.well-known/webfinger')) {
      assert.equal(new URL(url).searchParams.get('resource'), 'acct:@blue.territory@territory.test');
      return Response.json({ subject: 'acct:@blue.territory@territory.test', links: [{ rel: 'self', href: publisher.id }] });
    }
    return Response.json(publisher);
  });
  assert.equal(resolved.actor.id, publisher.id);
});

test('Fetch resources isolate bearer caches, handle errors and select map formats', async () => {
  const calls: Array<{ token: string; etag: string }> = [];
  const client = new ResourceClient(async (_input, init) => {
    const headers = new Headers(init?.headers);
    const token = headers.get('Authorization') ?? '';
    calls.push({ token, etag: headers.get('If-None-Match') ?? '' });
    return Response.json({ token }, { headers: { ETag: `"${token || 'public'}"` } });
  });
  assert.deepEqual((await client.get<{ token: string }>('https://resource.test/item', { token: 'one' })).value, { token: 'Bearer one' });
  assert.deepEqual((await client.get<{ token: string }>('https://resource.test/item', { token: 'two' })).value, { token: 'Bearer two' });
  assert.equal(calls.length, 2);
  const errorClient = new ResourceClient(async () => new Response(null, { status: 403 }));
  await assert.rejects(errorClient.get('https://resource.test/private'), (error: unknown) => error instanceof ResourceError && error.code === 'forbidden');
  const descriptor = { id: 'https://resource.test/map', representations: [{ format: 'https://fctp.example/map/ascii', resources: [] }] };
  assert.equal(selectMapRepresentation(descriptor, new Set(['https://fctp.example/map/ascii'])).format, 'https://fctp.example/map/ascii');
  assert.throws(() => selectMapRepresentation(descriptor, new Set()), (error: unknown) => error instanceof ResourceError && error.status === 406);
});

test('Activity wrapping and parser preserve object declarations', () => {
  const object = { id: 'https://territory.test/events/1', type: 'CargoOperationEvent', extension: 'kept' };
  const activity = createActivity({ id: 'https://territory.test/activities/1', actor: 'https://territory.test/actors/blue', object, to: 'https://registry.test/actors/main' });
  const parsed = parseActivity(activity);
  assert.equal(parsed.objectId, object.id);
  assert.deepEqual(parsed.object, object);
  assert.throws(() => parseActivity({ ...activity, to: undefined }));
});

test('server persists inbox deduplication and atomically delivers outbox work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-foundation-'));
  const stateFile = join(directory, 'state.json');
  const localActor = actor('https://local.test/actors/blue');
  const senderActor = 'https://remote.test/actors/registry';
    const delivered: string[] = [];
  try {
    const signingKey = await generateActorKey(localActor.id);
    const signingLoader = withDocuments(createLocalDocumentLoader(), new Map([[String(signingKey.publicKey.id), signingKey.publicKey]]));
    const server = new FctpServer({
      storeFile: stateFile,
      fetcher: async (_input, init) => { delivered.push(String(init?.body)); return new Response(null, { status: delivered.length === 1 ? 503 : 202 }); },
      signActivity: async (_actorId, activity) => await signJsonLd(activity as unknown as Record<string, unknown>, signingKey.keyPair, signingLoader) as unknown as typeof activity
    });
    await server.open();
    await server.registerActor({ actor: localActor });
    let handled = 0;
    server.on(localActor.id, 'EntryRequest', async (context, request) => {
      assert.equal(context.recipientActor, localActor.id);
      assert.equal(context.senderActor, senderActor);
      assert.equal((request as { type: string }).type, 'EntryRequest');
      handled++;
    });
    const entry = { id: 'https://remote.test/requests/1', type: 'EntryRequest', vessel: {}, cargo: { entries: [] }, journey: { events: [] }, destination: {} };
    const activity = createActivity({ id: 'https://remote.test/activities/1', actor: senderActor, object: entry, to: localActor.id });
    assert.equal(await server.receive(localActor.id, activity), 'queued');
    assert.equal(await server.receive(localActor.id, activity), 'duplicate');
    assert.equal(await server.processInbox(), 1);
    assert.equal(handled, 1);
    await server.commit((domain) => { domain.applied = true; }, [{
      actorId: localActor.id, recipientActorId: senderActor, inbox: `${senderActor}/inbox`,
      object: { id: 'https://local.test/events/exit/1', type: 'ExitEvent' }, activityId: 'https://local.test/activities/exit/1'
    }]);
    assert.equal(await server.processOutbox(), 0);
    await server.store.transaction((state) => { state.outbox[0]!.nextAttemptAt = 0; });
    assert.equal(await server.processOutbox(), 1);
    assert.equal(delivered.length, 2);
    assert.equal(delivered[0], delivered[1]);
    const signedActivity = JSON.parse(delivered[0]!) as Record<string, unknown>;
    assert.equal(signedActivity.id, 'https://local.test/activities/exit/1');
    assert.equal((signedActivity.proof as Record<string, unknown>).cryptosuite, 'eddsa-rdfc-2022');
    const persisted = JSON.parse(await readFile(stateFile, 'utf8')) as { domain: { applied: boolean }; outboxArchive: unknown[] };
    assert.equal(persisted.domain.applied, true);
    assert.equal(persisted.outboxArchive.length, 1);
    const restarted = new FctpServer({ storeFile: stateFile });
    await restarted.open();
    assert.equal(await restarted.receive(localActor.id, activity), 'duplicate');
    const conflicting = { ...activity, object: { ...entry, content: 'mutated' } };
    await assert.rejects(restarted.receive(localActor.id, conflicting), /Conflicting reuse/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('resource-server tokens are Home-enrolled, persistent and required for protected GET', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-auth-server-'));
  const nativeToken = new Uint8Array([9, 8, 7]);
  const playerId = 'https://home.test/players/alice';
  const homeId = 'https://home.test/actors/home';
  const resourceActor = actor('https://resource.test/actors/territory');
  try {
    const server = new FctpServer({
      storeFile: join(directory, 'state.json'),
      authorizeResource: async (_request, _actor, _resource, player) => ({ allowed: player === playerId })
    });
    await server.open();
    await server.registerActor({ actor: resourceActor });
    await server.enrollPlayer(playerId, homeId);
    const token = await deriveDiplomaticTokenForTest(nativeToken, resourceActor.id);
    const declaration = await createTokenDigest(playerId, 1, token);
    await assert.rejects(server.applyTokenDeclaration(resourceActor.id, 'https://other.test/actors/home', declaration), /not the enrolled Home/);
    await server.applyTokenDeclaration(resourceActor.id, homeId, declaration);
    server.registerResource('http://127.0.0.1/objects/listing', { id: 'http://127.0.0.1/objects/listing', type: 'Listing' }, { public: false, actorId: resourceActor.id });
    const listening = await server.listen();
    try {
      const uri = `http://127.0.0.1:${listening.port}/objects/listing`;
      server.registerResource(uri, { id: uri, type: 'Listing' }, { public: false, actorId: resourceActor.id });
      assert.equal((await fetch(uri)).status, 401);
      assert.equal((await fetch(uri, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
      assert.equal(await server.authenticateDiplomaticToken(resourceActor.id, token), playerId);
    } finally {
      await listening.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function deriveDiplomaticTokenForTest(native: Uint8Array, actorId: string): Promise<string> {
  return (await import('@fctp/auth')).deriveDiplomaticToken(native, actorId);
}
