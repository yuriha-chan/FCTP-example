import assert from 'node:assert/strict';
import test from 'node:test';
import { generateActorKey, createLocalDocumentLoader, signJsonLd, withDocuments } from '@fctp/identity';
import { verifyExit } from '../apps/client/src/client.js';

const territoryId = 'https://territory.test/actors/blue';
const registryId = 'https://registry.test/actors/main';
const vesselId = 'https://registry.test/vessels/1';
const entryId = 'https://registry.test/requests/1';
const exitId = 'https://territory.test/events/exit/1';

async function fixture() {
  const key = await generateActorKey(territoryId);
  const keyId = String(key.publicKey.id);
  const loader = withDocuments(createLocalDocumentLoader(), new Map([[keyId, key.publicKey]]));
  const exit = await signJsonLd({
    '@context': 'https://www.w3.org/ns/activitystreams', id: exitId, type: 'ExitEvent',
    vessel: vesselId, territory: territoryId, route: 'https://territory.test/routes/1',
    entryRequest: entryId, cargo: { entries: [] }, effectiveAt: '2026-01-01T00:00:00Z'
  }, key.keyPair, loader);
  const actor = { id: territoryId, type: 'Actor', publicKeys: [keyId] };
  const entry = {
    id: entryId, type: 'EntryRequest',
    vessel: { id: vesselId, registry: registryId },
    destination: { territory: territoryId }
  };
  const documents = new Map<string, unknown>([[exitId, exit], [territoryId, actor], [keyId, key.publicKey]]);
  const fetcher: typeof fetch = async (input) => documents.has(String(input))
    ? Response.json(documents.get(String(input)))
    : new Response(null, { status: 404 });
  return { entry, documents, fetcher };
}

test('client ExitEvent helper verifies signed proof independently from exact Registry request binding', async () => {
  const current = await fixture();
  const good = await verifyExit(exitId, vesselId, registryId, { [entryId]: current.entry }, current.fetcher);
  assert.equal(good.proofCryptography, 'verified');
  assert.equal(good.keyAttribution, 'attributed');
  assert.equal(good.expectedIssuer, 'verified');
  assert.equal((good.binding as { bound: boolean }).bound, true);

  const wrongTerritory = structuredClone(current.entry) as typeof current.entry;
  wrongTerritory.destination.territory = 'https://territory.test/actors/other';
  const territoryResult = await verifyExit(exitId, vesselId, registryId, { [entryId]: wrongTerritory }, current.fetcher);
  assert.equal(territoryResult.proofCryptography, 'verified');
  assert.equal((territoryResult.binding as { bound: boolean }).bound, false);

  const wrongRequest = await verifyExit(exitId, vesselId, registryId, { [entryId]: { ...current.entry, id: 'https://registry.test/requests/other' } }, current.fetcher);
  assert.equal((wrongRequest.binding as { bound: boolean }).bound, false);

  const unknownRequest = await verifyExit(exitId, vesselId, registryId, {}, current.fetcher);
  assert.equal((unknownRequest.binding as { bound: boolean; requestExists: boolean }).bound, false);
  assert.equal((unknownRequest.binding as { requestExists: boolean }).requestExists, false);

  const wrongVessel = await verifyExit(exitId, 'https://registry.test/vessels/other', registryId, { [entryId]: current.entry }, current.fetcher);
  assert.equal((wrongVessel.binding as { bound: boolean }).bound, false);
});
