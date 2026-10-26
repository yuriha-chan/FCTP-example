import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalDocumentLoader, generateActorKey, signJsonLd, verifyProofCryptography, withDocuments } from '@fctp/identity';

test('signed nested ExitEvent remains independently verifiable inside a signed Create', async () => {
  const territory = 'https://territory.test/actors/blue';
  const registry = 'https://registry.test/actors/main';
  const exitKey = await generateActorKey(territory);
  const registryKey = await generateActorKey(registry);
  const loader = withDocuments(createLocalDocumentLoader(), new Map([
    [String(exitKey.publicKey.id), exitKey.publicKey],
    [String(registryKey.publicKey.id), registryKey.publicKey]
  ]));
  const exit = await signJsonLd({
    id: 'https://territory.test/events/exit/1', type: 'ExitEvent', vessel: 'https://registry.test/vessels/1',
    territory, route: 'https://territory.test/routes/1', entryRequest: 'https://registry.test/requests/entry/1',
    cargo: { entries: [{ variety: 'https://territory.test/commodities/ore', count: 4, data: { assay: { purity: 0.97, tags: ['blue', 'dense'] } } }] },
    effectiveAt: '2026-10-26T10:00:00Z'
  }, exitKey.keyPair, loader);
  const create = await signJsonLd({
    id: 'https://territory.test/activities/exit/1', type: 'Create', actor: territory,
    to: [registry], object: exit
  }, registryKey.keyPair, loader);

  assert.deepEqual(await verifyProofCryptography(create, loader), { verified: true });
  const roundTripped = JSON.parse(JSON.stringify(create)) as typeof create;
  assert.deepEqual(roundTripped.object, exit);
  assert.deepEqual(await verifyProofCryptography(roundTripped, loader), { verified: true });
  assert.deepEqual(await verifyProofCryptography(roundTripped.object as Record<string, unknown>, loader), { verified: true });

  const tampered = structuredClone(roundTripped);
  const nestedCargo = (tampered.object as Record<string, unknown>).cargo as { entries: Array<{ data: Record<string, unknown> }> };
  (nestedCargo.entries[0]!.data.assay as { purity: number }).purity = 0.98;
  assert.equal((await verifyProofCryptography(tampered, loader)).verified, false);
  assert.equal((await verifyProofCryptography(tampered.object as Record<string, unknown>, loader)).verified, false);
});

test('EntryRequest signature binds embedded vessel fields and opaque Quantity.data JSON', async () => {
  const registry = 'https://registry.test/actors/main';
  const key = await generateActorKey(registry);
  const loader = withDocuments(createLocalDocumentLoader(), new Map([[String(key.publicKey.id), key.publicKey]]));
  const request = {
    id: 'https://registry.test/requests/entry/2', type: 'EntryRequest',
    vessel: {
      id: 'https://registry.test/vessels/2', registry, possessor: 'https://registry.test/actors/player', capacity: 100,
      data: { hull: { alloy: 'titanium', serial: 17 } }
    },
    cargo: { entries: [{ id: 'https://registry.test/items/ore/1', variety: 'https://registry.test/commodities/ore', data: { assay: { purity: 0.91, elements: ['Fe', 'Ni'] } } }] },
    journey: { events: [] }, destination: {
      territory: 'https://territory.test/actors/blue', port: 'https://territory.test/ports/main', route: 'https://territory.test/routes/1'
    }
  };
  const signed = await signJsonLd(request, key.keyPair, loader);
  assert.deepEqual(await verifyProofCryptography(signed, loader), { verified: true });
  const tampered = structuredClone(signed);
  const cargo = tampered.cargo as { entries: Array<{ data: Record<string, unknown> }> };
  (cargo.entries[0]!.data.assay as { purity: number }).purity = 0.92;
  assert.equal((await verifyProofCryptography(tampered, loader)).verified, false);
  const vesselTampered = structuredClone(signed);
  (vesselTampered.vessel as { capacity: number }).capacity = 101;
  assert.equal((await verifyProofCryptography(vesselTampered, loader)).verified, false);
});
