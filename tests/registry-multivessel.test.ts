import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createActivity } from '@fctp/federation';
import { createLocalDocumentLoader, generateActorKey, signJsonLd, withDocuments } from '@fctp/identity';
import { createInboundVerifier } from '@fctp/server-base';
import type { Vessel } from '@fctp/protocol';
import { createAuthority } from '../apps/test-authority/src/bootstrap.js';
import { installRegistry } from '../apps/test-authority/src/registry.js';

test('one signed Registry isolates vessel requests, cargo, adoption, Player API access and restart state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-registry-fleet-'));
  const origin = `http://127.0.0.1:${await availablePort()}`;
  const territory = 'https://territory.test/actors/blue';
  const key = await generateActorKey(territory);
  const resources = new Map<string, unknown>([[territory, { id: territory, role: 'territory', inbox: `${territory}/inbox`, publicKeys: [String(key.publicKey.id)] }], [String(key.publicKey.id), key.publicKey]]);
  const fetcher: typeof fetch = async (input) => resources.has(String(input)) ? Response.json(resources.get(String(input))) : new Response(null, { status: 404 });
  const vessels: Vessel[] = [
    { id: `${origin}/objects/vessels/one`, registry: `${origin}/actors/registry`, possessor: `${origin}/actors/player`, capacity: 100 },
    { id: `${origin}/objects/vessels/two`, registry: `${origin}/actors/registry`, possessor: `${origin}/actors/player-2`, capacity: 100 }
  ];
  const owners = new Map([['native-one', vessels[0]!.possessor], ['native-two', vessels[1]!.possessor]]);
  let registry: ReturnType<typeof installRegistry> | undefined;
  const verifier = createInboundVerifier({ fetcher, resolveExpectedIssuer: async (_local, sender, activity) => registry?.resolveExpectedIssuer(sender, activity.object) });
  let authority: Awaited<ReturnType<typeof createAuthority>> | undefined;
  const create = async () => {
    authority = await createAuthority({ origin, storeFile: join(directory, 'authority.json'), adminSecret: 'registry-admin', fetcher, verifyInbound: verifier });
    registry = installRegistry(authority, { fetcher, initialVessels: vessels, initialCargo: { entries: [{ variety: 'https://goods.test/ore', count: 10, data: {} }] }, route: async () => ({ actor: territory, inbox: `${territory}/inbox` }), authenticatePlayer: async (request) => owners.get((request.headers.authorization ?? '').replace(/^Bearer /, '')) });
    return authority;
  };
  try {
    await create();
    await authority!.listen(Number(new URL(origin).port));
    await registry!.switchAdoption(true, vessels[0]!.id);
    const first = await registry!.sendEntry({ territory, port: 'https://territory.test/ports/1', route: 'https://territory.test/routes/1', vessel: vessels[0]!.id });
    const second = await registry!.sendEntry({ territory, port: 'https://territory.test/ports/2', route: 'https://territory.test/routes/2', vessel: vessels[1]!.id });
    const loader = withDocuments(createLocalDocumentLoader(), new Map([[String(key.publicKey.id), key.publicKey]]));
    let eventIndex = 0;
    const deliver = async (object: Record<string, unknown>) => {
      const activity = await signJsonLd(createActivity({ id: `${territory}/activities/${++eventIndex}`, actor: territory, object, to: authority!.actor('registry').id }) as unknown as Record<string, unknown>, key.keyPair, loader);
      await authority!.server.receive(authority!.actor('registry').id, activity as never);
      await authority!.server.processInbox();
    };
    const cargo = (id: string, vessel: Vessel, operation: 'load' | 'unload', count: number) => ({ id, type: 'CargoOperationEvent', vessel: vessel.id, territory, port: 'https://territory.test/ports/1', operation, cargo: { entries: [{ variety: 'https://goods.test/ore', count, data: {} }] }, effectiveAt: '2026-01-01T00:00:00Z' });
    await deliver(cargo(`${territory}/events/one`, vessels[0]!, 'load', 2));
    await deliver(cargo(`${territory}/events/two`, vessels[1]!, 'load', 3));
    await deliver({ id: `${territory}/events/rejected`, type: 'EntryRejected', request: second.id, territory });
    const nextFirst = await registry!.sendEntry({ territory, port: 'https://territory.test/ports/1', route: 'https://territory.test/routes/1', vessel: vessels[0]!.id });
    const nextSecond = await registry!.sendEntry({ territory, port: 'https://territory.test/ports/2', route: 'https://territory.test/routes/2', vessel: vessels[1]!.id });
    assert.deepEqual(nextFirst.journey.events, [`${territory}/events/one`]);
    assert.deepEqual(nextSecond.journey.events, [`${territory}/events/two`, `${territory}/events/rejected`]);
    let fleet = await registry!.fleet();
    assert.equal((fleet[vessels[0]!.id]!.cargo!.entries[0] as { count: number }).count, 12);
    assert.equal((fleet[vessels[1]!.id]!.cargo!.entries[0] as { count: number }).count, 10);
    assert.equal(fleet[vessels[1]!.id]!.events.length, 2);
    assert.equal(fleet[vessels[1]!.id]!.events[1]!.type, 'EntryRejected');
    assert.equal(fleet[vessels[0]!.id]!.requests[first.id]!.type, 'EntryRequest');
    assert.equal(await registry!.state('https://registry.test/unknown').then(() => false, () => true), true);

    const playerOneHeaders = { Authorization: 'Bearer native-one', 'Content-Type': 'application/json' };
    const playerTwoHeaders = { Authorization: 'Bearer native-two', 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${origin}/local/registry/state?vessel=${encodeURIComponent(vessels[0]!.id)}`, { headers: playerOneHeaders })).status, 200);
    assert.equal((await fetch(`${origin}/local/registry/state?vessel=${encodeURIComponent(vessels[1]!.id)}`, { headers: playerOneHeaders })).status, 403);
    assert.equal((await fetch(`${origin}/local/registry/state?vessel=${encodeURIComponent(origin + '/unknown')}`, { headers: playerOneHeaders })).status, 404);
    assert.equal((await fetch(`${origin}/local/registry/fleet`, { headers: playerOneHeaders })).status, 403);
    const adminFleet = await fetch(`${origin}/local/registry/fleet`, { headers: { Authorization: 'Bearer registry-admin' } });
    assert.equal(adminFleet.status, 200);
    assert.equal(Object.keys(await adminFleet.json() as Record<string, unknown>).length, 2);
    assert.equal((await fetch(`${origin}/local/registry/state`, { headers: playerTwoHeaders })).status, 404);
    assert.equal((await fetch(`${origin}/local/registry/state?vessel=${encodeURIComponent(vessels[1]!.id)}`, { headers: playerTwoHeaders })).status, 200);
    assert.equal((await fetch(`${origin}/local/registry/entry`, { method: 'POST', headers: playerOneHeaders, body: JSON.stringify({ territory, port: 'https://territory.test/ports/2', route: 'https://territory.test/routes/2', vessel: vessels[1]!.id }) })).status, 403);

    await authority!.close();
    authority = undefined;
    await create();
    fleet = await registry!.fleet();
    assert.equal(fleet[vessels[0]!.id]!.events.length, 1);
    assert.equal(fleet[vessels[1]!.id]!.events.length, 2);
    assert.equal((fleet[vessels[0]!.id]!.cargo!.entries[0] as { count: number }).count, 12);
  } finally {
    if (authority) await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Registry migrates legacy single-vessel state without dropping requests or evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-registry-migration-'));
  let authority: Awaited<ReturnType<typeof createAuthority>> | undefined;
  try {
    authority = await createAuthority({ origin: 'http://registry.test', storeFile: join(directory, 'authority.json') });
    const vessel: Vessel = { id: 'https://registry.test/objects/vessels/legacy', registry: authority.actor('registry').id, possessor: authority.actor('player').id, capacity: 4 };
    const old = { vessel, cargo: { entries: [] }, adoption: true, requests: { 'https://registry.test/requests/1': { id: 'https://registry.test/requests/1', type: 'DepartureRequest' } }, events: [{ id: 'https://territory.test/events/1', type: 'VoyageEvent', vessel: vessel.id, territory: 'https://territory.test/actors/blue' }], eventIds: { 'https://territory.test/events/1': true }, exitEvidence: ['https://territory.test/events/exit'] };
    await authority.server.store.transaction((store) => { store.domain.registry = old; });
    const registry = installRegistry(authority);
    const state = await registry.state();
    assert.deepEqual(state.requests, old.requests);
    assert.deepEqual(state.events, old.events);
    assert.deepEqual(state.exitEvidence, old.exitEvidence);
    assert.equal((await registry.fleet())[vessel.id]!.adoption, true);
  } finally {
    if (authority) await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
