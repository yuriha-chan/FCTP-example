import assert from 'node:assert/strict';
import test from 'node:test';
import { createActivity, type Activity } from '@fctp/federation';
import { createLocalDocumentLoader, generateActorKey, signJsonLd, withDocuments } from '@fctp/identity';
import type { FCTPActor } from '@fctp/protocol';
import { createInboundVerifier } from '@fctp/server-base';

const actor = (id: string, publicKeys: string[]): FCTPActor => ({
  id,
  inbox: `${id}/inbox`,
  outbox: `${id}/outbox`,
  role: 'registry',
  publicKeys
});

test('inbound verifier checks envelope proof, key attribution, and expected publisher independently', async () => {
  const publisherId = 'https://registry.test/actors/main';
  const publisherKey = await generateActorKey(publisherId);
  const publisher = actor(publisherId, [String(publisherKey.publicKey.id)]);
  const keys = new Map([[String(publisherKey.publicKey.id), publisherKey.publicKey]]);
  const loader = withDocuments(createLocalDocumentLoader(), keys);
  const envelope = createActivity({
    id: 'https://registry.test/activities/1',
    actor: publisherId,
    object: { id: 'https://registry.test/requests/1', type: 'EntryRequest' },
    to: 'https://territory.test/actors/blue'
  });
  const signed = await signJsonLd(envelope as unknown as Record<string, unknown>, publisherKey.keyPair, loader) as unknown as Activity;
  const fetcher: typeof fetch = async (input) => {
    const uri = String(input);
    if (uri === publisherId) return Response.json(publisher);
    if (keys.has(uri)) return Response.json(keys.get(uri));
    return new Response(null, { status: 404 });
  };
  const verifier = createInboundVerifier({
    fetcher,
    resolveExpectedIssuer: async () => publisherId
  });

  assert.deepEqual(await verifier('https://territory.test/actors/blue', publisherId, signed), {
    cryptographic: { verified: true },
    attribution: { attributed: true, publisher: publisherId, key: publisherKey.publicKey.id },
    expectedIssuer: { matches: true, expectedIssuer: publisherId, publisher: publisherId }
  });

  const tampered = structuredClone(signed);
  tampered.published = '2026-01-01T00:00:00Z';
  const tamperedReport = await verifier('https://territory.test/actors/blue', publisherId, tampered);
  assert.equal(tamperedReport.cryptographic.verified, false);
  assert.equal(tamperedReport.attribution.attributed, true);

  const unknownExpected = createInboundVerifier({ fetcher, resolveExpectedIssuer: async () => undefined });
  assert.equal((await unknownExpected('https://territory.test/actors/blue', publisherId, signed)).expectedIssuer.matches, false);
});

test('inbound verifier fails attribution for another Actor and mismatched key controller', async () => {
  const publisherId = 'https://registry.test/actors/main';
  const otherId = 'https://other.test/actors/main';
  const publisherKey = await generateActorKey(publisherId);
  const otherKey = await generateActorKey(otherId);
  const loader = withDocuments(createLocalDocumentLoader(), new Map([
    [String(publisherKey.publicKey.id), publisherKey.publicKey],
    [String(otherKey.publicKey.id), otherKey.publicKey]
  ]));
  const signed = await signJsonLd(createActivity({
    id: 'https://registry.test/activities/2',
    actor: publisherId,
    object: { id: 'https://registry.test/events/2', type: 'BerthingEvent' },
    to: 'https://territory.test/actors/blue'
  }) as unknown as Record<string, unknown>, publisherKey.keyPair, loader) as unknown as Activity;
  const foreignActor = actor(otherId, [String(otherKey.publicKey.id)]);
  const mismatchKeyDocument = { ...publisherKey.publicKey, controller: otherId };
  const actorWithMismatchedKey = actor(publisherId, [String(publisherKey.publicKey.id)]);
  const fetcher: typeof fetch = async (input) => {
    const uri = String(input);
    if (uri === otherId) return Response.json(foreignActor);
    if (uri === publisherId) return Response.json(actorWithMismatchedKey);
    if (uri === String(otherKey.publicKey.id)) return Response.json(otherKey.publicKey);
    if (uri === String(publisherKey.publicKey.id)) return Response.json(mismatchKeyDocument);
    return new Response(null, { status: 404 });
  };
  const verifier = createInboundVerifier({ fetcher, resolveExpectedIssuer: async () => publisherId });
  const wrongActor = await verifier('https://territory.test/actors/blue', otherId, signed);
  assert.equal(wrongActor.attribution.attributed, false);
  assert.equal(wrongActor.expectedIssuer.matches, false);
  const wrongController = await verifier('https://territory.test/actors/blue', publisherId, signed);
  assert.equal(wrongController.attribution.attributed, false);
  assert.equal(wrongController.attribution.error, 'controller-mismatch');
});

test('inbound verifier reports unavailable sender and key documents as failures', async () => {
  const publisherId = 'https://registry.test/actors/unavailable';
  const key = await generateActorKey(publisherId);
  const keyId = String(key.publicKey.id);
  const publisher = actor(publisherId, [keyId]);
  const signingLoader = withDocuments(createLocalDocumentLoader(), new Map([[keyId, key.publicKey]]));
  const signed = await signJsonLd(createActivity({
    id: 'https://registry.test/activities/3',
    actor: publisherId,
    object: { id: 'https://registry.test/objects/3', type: 'VoyageEvent' },
    to: 'https://territory.test/actors/blue'
  }) as unknown as Record<string, unknown>, key.keyPair, signingLoader) as unknown as Activity;
  const verifier = createInboundVerifier({
    fetcher: async (input) => String(input) === publisherId ? Response.json(publisher) : new Response(null, { status: 503 }),
    resolveExpectedIssuer: async () => publisherId
  });
  const report = await verifier('https://territory.test/actors/blue', publisherId, signed);
  assert.equal(report.cryptographic.verified, false);
  assert.equal(report.attribution.attributed, false);
  assert.equal(report.attribution.error, 'key-unavailable');

  const unresolved = await createInboundVerifier({
    fetcher: async () => new Response(null, { status: 503 }),
    resolveExpectedIssuer: async () => publisherId
  })('https://territory.test/actors/blue', publisherId, signed);
  assert.equal(unresolved.cryptographic.verified, false);
  assert.equal(unresolved.attribution.attributed, false);
  assert.equal(unresolved.expectedIssuer.matches, true);
});
