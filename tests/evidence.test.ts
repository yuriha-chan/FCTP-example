import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalDocumentLoader, generateActorKey, signJsonLd, withDocuments } from '@fctp/identity';
import { resolveExitEvidence } from '@fctp/server-base';

const territoryId = 'https://territory.test/actors/blue';
const registryId = 'https://registry.test/actors/main';
const vesselId = 'https://registry.test/vessels/1';
const entryId = 'https://registry.test/requests/1';
const exitId = 'https://territory.test/events/exit/1';

async function scenario() {
  const key = await generateActorKey(territoryId);
  const loader = withDocuments(createLocalDocumentLoader(), new Map([[String(key.publicKey.id), key.publicKey]]));
  const exit = await signJsonLd({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: exitId,
    type: 'ExitEvent',
    vessel: vesselId,
    territory: territoryId,
    route: 'https://territory.test/routes/1',
    entryRequest: entryId,
    cargo: { entries: [] },
    effectiveAt: '2026-01-01T00:00:00Z'
  }, key.keyPair, loader);
  const actor = { id: territoryId, role: 'territory', inbox: `${territoryId}/inbox`, outbox: `${territoryId}/outbox`, publicKeys: [String(key.publicKey.id)] };
  const entry = {
    id: entryId,
    type: 'EntryRequest',
    vessel: { id: vesselId, registry: registryId, possessor: 'https://player.test/actors/p', capacity: 10 },
    cargo: { entries: [] },
    journey: { events: [] },
    destination: { territory: territoryId, port: 'https://territory.test/ports/1', route: 'https://territory.test/routes/1' }
  };
  const resources = new Map<string, unknown>([
    [territoryId, actor], [String(key.publicKey.id), key.publicKey], [exitId, exit], [entryId, entry]
  ]);
  const fetcher: typeof fetch = async (input) => resources.has(String(input))
    ? Response.json(resources.get(String(input)))
    : new Response(null, { status: 404 });
  return { exit, entry, resources, fetcher };
}

test('exit evidence verifies a signed ExitEvent and factual EntryRequest binding', async () => {
  const { fetcher } = await scenario();
  const result = await resolveExitEvidence(exitId, { vessel: vesselId, registry: registryId }, { fetcher });
  assert.equal(result.verification.cryptographic.verified, true);
  assert.equal(result.verification.attribution.attributed, true);
  assert.equal(result.verification.expectedIssuer.matches, true);
  assert.equal(result.binding.bound, true);
  assert.equal(result.binding.reason, 'entry-request-publisher-unproven');
  assert.equal(result.entry?.id, entryId);
});

test('exit evidence reports tampering and wrong key controller without verifying the evidence', async () => {
  const tampered = await scenario();
  tampered.resources.set(exitId, { ...(tampered.exit as Record<string, unknown>), route: 'https://territory.test/routes/tampered' });
  const tamperedResult = await resolveExitEvidence(exitId, { vessel: vesselId, registry: registryId }, { fetcher: tampered.fetcher });
  assert.equal(tamperedResult.verification.cryptographic.verified, false);

  const wrongController = await scenario();
  const keyId = String((wrongController.exit as Record<string, unknown>).proof && ((wrongController.exit as Record<string, unknown>).proof as Record<string, unknown>).verificationMethod);
  wrongController.resources.set(keyId, { ...(wrongController.resources.get(keyId) as Record<string, unknown>), controller: 'https://other.test/actors/x' });
  const wrongControllerResult = await resolveExitEvidence(exitId, { vessel: vesselId, registry: registryId }, { fetcher: wrongController.fetcher });
  assert.equal(wrongControllerResult.verification.attribution.attributed, false);
});

test('exit evidence returns unavailable references and unissued foreign-destination entry as binding failures', async () => {
  const missing = await scenario();
  missing.resources.delete(entryId);
  const missingResult = await resolveExitEvidence(exitId, { vessel: vesselId, registry: registryId }, { fetcher: missing.fetcher });
  assert.equal(missingResult.binding.bound, false);
  assert.match(missingResult.error ?? '', /HTTP 404/);

  const foreign = await scenario();
  foreign.resources.set(entryId, { ...(foreign.entry as Record<string, unknown>), destination: { ...((foreign.entry as Record<string, unknown>).destination as object), territory: 'https://other.test/actors/red' } });
  const foreignResult = await resolveExitEvidence(exitId, { vessel: vesselId, registry: registryId }, { fetcher: foreign.fetcher });
  assert.equal(foreignResult.binding.bound, false);
  assert.match(foreignResult.binding.reason ?? '', /destination-does-not-match/);
});
