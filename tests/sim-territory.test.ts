import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHost, verifyPublishedDocument } from '@fctp/server-base';
import type { Activity } from '@fctp/federation';
import type { CargoManifest, EntryRequest, URI } from '@fctp/protocol';
import { installSimulationTerritory, simulationExpectedIssuer } from '../apps/territory-sim/src/territory.js';

const registry = 'https://sim.test/actors/registry' as URI;
const territory = 'https://sim.test/actors/territory' as URI;
const vesselId = 'https://registry.test/vessels/one' as URI;
const port = 'https://sim.test/ports/main' as URI;
const route = 'https://sim.test/routes/approach' as URI;
const commodity = {
  ore: 'https://sim.test/commodities/ore', nativeMetal: 'https://sim.test/commodities/metal',
  importedMetal: 'https://sim.test/commodities/imported', refinedProduct: 'https://sim.test/commodities/refined',
};
const config = () => ({
  commodities: commodity,
  commodityMasses: Object.fromEntries(Object.values(commodity).map((id) => [id, 1])),
  depositAmount: 10, miningCapacity: 4, miningEnabled: true, manufacturingSlots: 1,
  manufacturingTime: 2, portCapacity: 20, berthCapacity: 1,
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'sim-territory-'));
  const documents = new Map<string, unknown>();
  const fetcher: typeof fetch = async (input) => {
    const document = documents.get(String(input));
    return document === undefined ? new Response(null, { status: 404 }) : new Response(JSON.stringify(document), { status: 200, headers: { 'Content-Type': 'application/ld+json' } });
  };
  const host = await createHost({
    origin: 'https://sim.test', storeFile: join(directory, 'store.json'),
    actors: [{ name: 'registry', role: 'registry' }, { name: 'territory', role: 'territory' }],
    fetcher,
    resolveExpectedIssuer: async (_local, sender, activity) => simulationExpectedIssuer(sender, activity.object, registry),
  });
  for (const name of ['registry', 'territory']) {
    documents.set(host.actor(name).id, host.actor(name));
    documents.set(String(host.key(name).publicKey.id), host.key(name).publicKey);
  }
  const sim = installSimulationTerritory(host, {
    territoryActor: 'territory', port, route, config: config(), acceptedRegistries: [registry], acceptedTerritories: [],
    fetcher, registryInbox: async () => `${registry}/inbox` as URI, epoch: '2025-01-01T00:00:00.000Z', tickDurationMs: 1_000,
  });
  const send = async (object: Record<string, unknown>, corruptProof = false) => {
    const activity = await host.sign('registry', {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
      id: `${String(object.id)}/activity`, type: 'Create', actor: registry, to: [territory], object,
    } as Activity);
    if (corruptProof) (activity as unknown as Record<string, unknown>).proof = { type: 'invalid' };
    await host.server.receive(territory, activity);
    await host.server.processInbox();
  };
  return { host, sim, send, close: async () => { await host.close(); await rm(directory, { recursive: true, force: true }); } };
}

function entry(id: string, cargo: CargoManifest = { entries: [] }, idOfVessel: URI = vesselId): EntryRequest {
  return {
    id, type: 'EntryRequest', vessel: { id: idOfVessel, registry, possessor: 'https://registry.test/actors/player', capacity: 10 },
    cargo, journey: { events: [] }, destination: { territory, port, route },
  };
}

test('signed inbound entry waits for tick berthing; handling emits only completed cargo and exit is signed', async () => {
  const fixture = await setup();
  try {
    await fixture.send(entry('https://registry.test/requests/entry-1') as unknown as Record<string, unknown>);
    let state = await fixture.sim.state();
    assert.equal(state.simulation.vessels[0]?.status, 'pending', JSON.stringify(state.decisions));
    assert.equal(state.simulation.tick, 0);
    await fixture.sim.tick();
    state = await fixture.sim.state();
    assert.equal(state.simulation.vessels[0]?.status, 'berthed');
    const before = (await fixture.host.server.store.read((store) => store.outboxArchive.length));
    await fixture.sim.mine(2);
    await fixture.sim.tick();
    await fixture.sim.handle('https://registry.test/requests/entry-1', 'load', [{ commodity: commodity.ore, count: 2 }], 2);
    await fixture.sim.tick();
    assert.equal((await fixture.host.server.store.read((store) => store.outboxArchive.length)), before);
    await fixture.sim.tick();
    state = await fixture.sim.state();
    assert.deepEqual(state.simulation.vessels[0]?.cargo, [{ commodity: commodity.ore, count: 2, quantityKind: 'Stack', data: {} }]);
    const cargoEvents = await fixture.host.server.store.read((store) => store.outboxArchive.filter((item) => item.activity.object && (item.activity.object as Record<string, unknown>).type === 'CargoOperationEvent'));
    assert.equal(cargoEvents.length, 1);
    const departure = { id: 'https://registry.test/requests/departure-1', type: 'DepartureRequest', vessel: vesselId, territory, port, route };
    await fixture.send(departure);
    await fixture.sim.tick();
    state = await fixture.sim.state();
    assert.equal(state.visits['https://registry.test/requests/entry-1']?.exited, true);
    const exitEnvelope = await fixture.host.server.store.read((store) => store.outboxArchive.find((item) => (item.activity.object as Record<string, unknown>)?.type === 'ExitEvent')?.activity.object as Record<string, unknown>);
    assert.equal(exitEnvelope?.type, 'ExitEvent');
    assert.ok(exitEnvelope?.proof);
    assert.equal(exitEnvelope?.entryRequest, 'https://registry.test/requests/entry-1');
    const independentlyVerified = await verifyPublishedDocument(
      JSON.parse(JSON.stringify(exitEnvelope)) as Record<string, unknown>,
      territory,
      territory,
      async (input) => {
        const document = fixture.host.actor('territory').id === String(input)
          ? fixture.host.actor('territory')
          : fixture.host.key('territory').publicKey;
        return new Response(JSON.stringify(document), { status: 200, headers: { 'Content-Type': 'application/ld+json' } });
      },
      fixture.host.loader,
    );
    assert.equal(independentlyVerified.cryptographic.verified, true);
    assert.equal(independentlyVerified.attribution.attributed, true);
    assert.equal(independentlyVerified.expectedIssuer.matches, true);
    await fixture.send(entry('https://registry.test/requests/entry-return') as unknown as Record<string, unknown>);
    state = await fixture.sim.state();
    assert.equal(state.visits['https://registry.test/requests/entry-return']?.decision.accepted, true);
    assert.equal(state.simulation.vessels.length, 2);
  } finally {
    await fixture.close();
  }
});

test('rejected admission can be retried; configured route ownership and envelope verification are enforced', async () => {
  const fixture = await setup();
  try {
    const vessel = 'https://registry.test/vessels/retry' as URI;
    await fixture.send({ ...entry('https://registry.test/requests/wrong-port', { entries: [] }, vessel), destination: { territory, port: 'https://sim.test/ports/other', route } });
    await fixture.send({ ...entry('https://registry.test/requests/wrong-route', { entries: [] }, vessel), destination: { territory, port, route: 'https://sim.test/routes/other' } });
    await fixture.send(entry('https://registry.test/requests/invalid-proof', { entries: [] }, vessel) as unknown as Record<string, unknown>, true);
    let state = await fixture.sim.state();
    assert.equal(state.visits['https://registry.test/requests/invalid-proof'], undefined);
    assert.equal(state.decisions.some((decision) => decision.request === 'https://registry.test/requests/invalid-proof'), false);
    assert.equal(state.decisions.filter((decision) => !decision.accepted).length, 2);

    await fixture.send(entry('https://registry.test/requests/rejected-capacity', { entries: [{ variety: commodity.ore, count: 11, data: {} }] }, vessel) as unknown as Record<string, unknown>);
    await fixture.send(entry('https://registry.test/requests/retry-valid', { entries: [] }, vessel) as unknown as Record<string, unknown>);
    state = await fixture.sim.state();
    assert.equal(state.visits['https://registry.test/requests/retry-valid']?.decision.accepted, true);
    assert.equal(state.simulation.vessels.length, 1);
  } finally {
    await fixture.close();
  }
});

test('pending handling blocks departure until its internal simulation vessel work completes', async () => {
  const fixture = await setup();
  try {
    await fixture.send(entry('https://registry.test/requests/handling-departure') as unknown as Record<string, unknown>);
    await fixture.sim.tick();
    await fixture.sim.mine(2);
    await fixture.sim.tick();
    await fixture.sim.handle('https://registry.test/requests/handling-departure', 'load', [{ commodity: commodity.ore, count: 1 }], 2);
    await fixture.send({ id: 'https://registry.test/requests/departure-pending', type: 'DepartureRequest', vessel: vesselId, territory, port, route });
    await fixture.sim.tick();
    let state = await fixture.sim.state();
    assert.equal(state.visits['https://registry.test/requests/handling-departure']?.exited, false);
    assert.equal(state.simulation.vessels[0]?.status, 'berthed');
    await fixture.sim.tick();
    state = await fixture.sim.state();
    assert.equal(state.visits['https://registry.test/requests/handling-departure']?.exited, true);
    assert.equal(state.simulation.vessels[0]?.status, 'departed');
  } finally {
    await fixture.close();
  }
});

test('native production, imported reprocessing and capacity constraints are exposed through the adapter', async () => {
  const fixture = await setup();
  try {
    await assert.rejects(fixture.sim.mine(11), /capacity|deposit/);
    await fixture.sim.mine(2);
    await fixture.sim.tick();
    await fixture.sim.manufacture('native', 2);
    await fixture.sim.tick();
    await fixture.sim.tick();
    assert.equal((await fixture.sim.state()).simulation.productStock[0]?.commodity, commodity.nativeMetal);
    const importedRequest = 'https://registry.test/requests/import';
    await fixture.send(entry(importedRequest, { entries: [{ variety: commodity.importedMetal, count: 2, data: {} }] }, 'https://registry.test/vessels/importer') as unknown as Record<string, unknown>);
    await fixture.sim.tick();
    await fixture.sim.handle(importedRequest, 'unload', [{ commodity: commodity.importedMetal, count: 2 }], 1);
    await fixture.sim.tick();
    await fixture.sim.manufacture('imported', 2);
    await fixture.sim.tick();
    await fixture.sim.tick();
    assert.ok((await fixture.sim.state()).simulation.productStock.some((item) => item.commodity === commodity.refinedProduct && item.count === 2));
    await assert.rejects(fixture.sim.configureFacilities({ port: { capacity: 1, berths: 1 } }), /occupied and reserved/);
  } finally {
    await fixture.close();
  }
});
