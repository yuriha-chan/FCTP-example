import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHost } from '@fctp/server-base';
import { installPolicyTerritory } from '../apps/territory-policy/src/territory.js';
import { territoryAProduction } from '../apps/territory-policy/src/domain.js';

test('policy Territory accepts a signed Registry entry, produces and loads cargo, and publishes a signed exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-policy-territory-'));
  const registry = 'http://policy.test/actors/registry';
  const territoryId = 'http://policy.test/actors/territory';
  let exitEvidence: Record<string, unknown> | undefined;
  let entryRequestEvidence: Record<string, unknown> | undefined;
  let departureEvidence: Record<string, unknown> | undefined;
  let departureRequestEvidence: Record<string, unknown> | undefined;
  const fetchUri = (input: string | URL | Request) => {
    const uri = new URL(input instanceof Request ? input.url : String(input));
    uri.hash = '';
    return uri.toString();
  };
  const options = {
    origin: 'http://policy.test', storeFile: join(directory, 'store.json'),
    actors: [{ name: 'registry', role: 'registry' }, { name: 'territory', role: 'territory' }],
    resolveExpectedIssuer: async (_local: string, _sender: string, activity: { object: unknown }) => {
      const object = activity.object as Record<string, unknown>;
      if (object.type === 'ExitEvent') return territoryId;
      return object.type === 'EntryRequest' || object.type === 'DepartureRequest' ? registry : undefined;
    },
    fetcher: async (input: string | URL | Request) => {
      const uri = fetchUri(input);
      if (uri === registry) return Response.json({ ...host.actor('registry'), inbox: 'http://registry.test/inbox' });
      if (uri === territoryId) return Response.json(host.actor('territory'));
      if (uri === 'http://policy.test/keys/registry') return Response.json(host.key('registry').publicKey);
      if (uri === 'http://policy.test/keys/territory') return Response.json(host.key('territory').publicKey);
      if (exitEvidence && uri === exitEvidence.id) return Response.json(exitEvidence);
      if (entryRequestEvidence && uri === entryRequestEvidence.id) return Response.json(entryRequestEvidence);
      if (departureEvidence && uri === departureEvidence.id) return Response.json(departureEvidence);
      if (departureRequestEvidence && uri === departureRequestEvidence.id) return Response.json(departureRequestEvidence);
      return new Response('not found', { status: 404 });
    }
  };
  let host!: Awaited<ReturnType<typeof createHost>>;
  try {
    host = await createHost(options);
    const policy = installPolicyTerritory(host, {
      name: 'territory', portIds: ['https://example.test/port/1'], routeIds: ['https://example.test/route/1'],
      commodities: [{ variety: territoryAProduction.ore, mass: 2 }, { variety: territoryAProduction.metal, mass: 1 }],
      initialPolicy: { miningPermitted: true, miningQuota: 10, oreReserve: 10, manufacturePermits: ['ore-to-metal'], recipes: territoryAProduction.recipes, warehouseLimits: {}, portLimits: {}, decisions: {} },
      registryAcceptance: [registry], fetcher: options.fetcher
    });
    const request = {
      id: 'https://registry.test/entry/1', type: 'EntryRequest',
      vessel: { id: 'https://registry.test/vessels/1', registry, possessor: 'https://registry.test/players/1', capacity: 20 },
      cargo: { entries: [] }, journey: { events: [] },
      destination: { territory: territoryId, port: 'https://example.test/port/1', route: 'https://example.test/route/1' }
    };
    entryRequestEvidence = request;
    const entryActivity = await host.sign('registry', { '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'], id: 'https://registry.test/activities/entry/1', type: 'Create', actor: registry, object: request, to: [territoryId] } as never);
    await host.server.receive(territoryId, entryActivity);
    await host.server.processInbox();
    const player = 'https://registry.test/players/1';
    assert.equal((await policy.ledger).visits[request.vessel.id]?.departed, false);
    assert.equal((await policy.ledger).state.audit.find((entry) => entry.action === 'prepare-vessel')?.actor, registry);
    assert.equal((await policy.mine(territoryAProduction.ore.id, 2, player)).success, true);
    assert.equal((await policy.manufacture('ore-to-metal', 1, player)).success, true);
    assert.equal((await policy.transferWarehouseToPort(territoryAProduction.metal.id, 1, player)).success, true);
    assert.equal((await policy.load(request.vessel.id, territoryAProduction.metal.id, 1, player)).success, true);
    assert.equal((await policy.ledger).state.audit.find((entry) => entry.action === 'load')?.actor, player);
    const departureRequest = { id: 'https://registry.test/departure/1', type: 'DepartureRequest', vessel: request.vessel.id, territory: territoryId, port: 'https://example.test/port/1' };
    departureRequestEvidence = departureRequest;
    const departureActivity = await host.sign('registry', { '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'], id: 'https://registry.test/activities/departure/1', type: 'Create', actor: registry, object: departureRequest, to: [territoryId] } as never);
    await host.server.receive(territoryId, departureActivity);
    await host.server.processInbox();
    const archive = await host.server.store.read((state) => state.outboxArchive.filter((item) => item.actorId === territoryId).map((item) => item.activity.object as Record<string, unknown>));
    const exit = archive.find((object) => object.type === 'ExitEvent');
    departureEvidence = archive.find((object) => object.type === 'DepartureEvent');
    assert.ok(exit?.proof);
    exitEvidence = exit;
    assert.match(String(exit?.id), /\/objects\/policy\/exit\//);
    assert.deepEqual(exit?.cargo, { entries: [{ variety: territoryAProduction.metal.id, count: 1, data: {} }] });
    assert.equal((await policy.ledger).visits[request.vessel.id]?.departed, true);
    assert.equal((await policy.ledger).state.audit.find((entry) => entry.action === 'exit-vessel')?.actor, registry);
    assert.equal((await policy.state).vessels[request.vessel.id], undefined);
    assert.deepEqual((await policy.ledger).visits[request.vessel.id]?.cargo, exit?.cargo);

    await policy.updateAdmissionPolicy({ mismatchPolicy: 'evidence', territoryAcceptance: ['http://policy.test/actors/territory'] });
    assert.equal((await policy.ledger).admission.mismatchPolicy, 'evidence');
    const returning = { ...request, id: 'https://registry.test/entry/return', cargo: exit?.cargo as { entries: [] }, journey: { events: [], exitEvidence: String(exit?.id) } };
    const returnActivity = await host.sign('registry', { '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'], id: 'https://registry.test/activities/entry/return', type: 'Create', actor: registry, object: returning, to: [territoryId] } as never);
    await host.server.receive(territoryId, returnActivity);
    await host.server.processInbox();
    const returnDecision = (await policy.ledger).decisions[returning.id];
    assert.equal(returnDecision?.accepted, true, JSON.stringify(returnDecision, null, 2));
    assert.deepEqual((await policy.state).vessels[request.vessel.id]?.manifest, exit?.cargo);
  } finally {
    if (host) await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('verified business rejection is delivered and admission policy changes affect later decisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-policy-rejection-'));
  const registry = 'http://policy.test/actors/registry';
  const territoryId = 'http://policy.test/actors/territory';
  let host!: Awaited<ReturnType<typeof createHost>>;
  const fetcher = async (input: string | URL | Request) => String(input) === registry
    ? Response.json({ ...host.actor('registry'), inbox: 'http://registry.test/inbox' })
    : String(input) === territoryId
      ? Response.json(host.actor('territory'))
    : String(input) === 'http://policy.test/keys/registry'
      ? Response.json(host.key('registry').publicKey)
      : new Response('not found', { status: 404 });
  try {
    host = await createHost({
      origin: 'http://policy.test', storeFile: join(directory, 'store.json'),
      actors: [{ name: 'registry', role: 'registry' }, { name: 'territory', role: 'territory' }],
      resolveExpectedIssuer: async () => registry, fetcher
    });
    const policy = installPolicyTerritory(host, {
      name: 'territory', portIds: ['https://example.test/port/1'], routeIds: ['https://example.test/route/1'],
      commodities: [{ variety: territoryAProduction.ore, mass: 2 }],
      initialPolicy: { miningPermitted: true, miningQuota: 10, oreReserve: 10, manufacturePermits: [], recipes: [], warehouseLimits: {}, portLimits: {}, decisions: {} },
      registryAcceptance: [], fetcher
    });
    const request = { id: 'https://registry.test/entry/rejected', type: 'EntryRequest', vessel: { id: 'https://registry.test/vessels/returning', registry, possessor: 'https://registry.test/players/1', capacity: 20 }, cargo: { entries: [] }, journey: { events: [] }, destination: { territory: territoryId, port: 'https://example.test/port/1', route: 'https://example.test/route/1' } };
    const activity = await host.sign('registry', { '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'], id: 'https://registry.test/activities/entry/rejected', type: 'Create', actor: registry, object: request, to: [territoryId] } as never);
    await host.server.receive(territoryId, activity);
    await host.server.processInbox();
    assert.equal((await policy.ledger).decisions[request.id]?.accepted, false);
    const rejected = await host.server.store.read((state) => state.outboxArchive.find((item) => item.actorId === territoryId)?.activity.object as Record<string, unknown>);
    assert.equal(rejected.type, 'EntryRejected');
    assert.equal(rejected.request, request.id);

    await policy.updateAdmissionPolicy({ registryAcceptance: [registry] });
    const allowed = { ...request, id: 'https://registry.test/entry/allowed' };
    const allowedActivity = await host.sign('registry', { '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'], id: 'https://registry.test/activities/entry/allowed', type: 'Create', actor: registry, object: allowed, to: [territoryId] } as never);
    await host.server.receive(territoryId, allowedActivity);
    await host.server.processInbox();
    assert.equal((await policy.ledger).decisions[allowed.id]?.accepted, true);
  } finally {
    if (host) await host.close();
    await rm(directory, { recursive: true, force: true });
  }
});
