import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveDiplomaticToken, encodeNativeToken } from '@fctp/auth';
import { generateActorKey, createLocalDocumentLoader, signJsonLd, webFingerSubject, withDocuments } from '@fctp/identity';
import type { URI } from '@fctp/protocol';
import { getAuthenticated, resourceAudience, verifyExit, type ClientConfig } from '../apps/client/src/client.js';
import { formatActor, formatAuthoringEntry, formatResource } from '../apps/client/src/presentation.js';
import { identityDisplay, technicalAddresses } from '../apps/client/src/identity-display.js';

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

test('public resources are read without credentials and text media follows Content-Type', async () => {
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(init ?? {});
    return requests.length === 1
      ? Response.json({ id: 'https://public.test/assets/public', name: 'Public asset' })
      : new Response('public text', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  };
  try {
    const config = { origins: { authority: 'https://auth.test', policy: 'https://policy.test', simulation: 'https://sim.test' } };
    const asset = await getAuthenticated<Record<string, unknown>>('https://public.test/assets/public', '', '', 'direct', config);
    const text = await getAuthenticated<string>('https://public.test/assets/readme', '', '', 'direct', config);
    assert.equal(asset.name, 'Public asset');
    assert.equal(text, 'public text');
    assert.equal(requests.length, 2);
    assert.equal(new Headers(requests[0]?.headers).has('Authorization'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('protected configured resources derive the configured Actor audience only after 403', async () => {
  const native = encodeNativeToken(new Uint8Array(32).fill(7));
  const actor = 'https://resources.test/actors/territory';
  const config: ClientConfig = { origins: { authority: 'https://auth.test', policy: 'https://policy.test', simulation: 'https://sim.test' }, actors: { territory: actor } };
  const expected = await deriveDiplomaticToken(native, actor as URI);
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let resolvedActor = '';
  globalThis.fetch = async (input, init) => {
    calls++;
    if (calls === 1) {
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      return new Response(null, { status: 403 });
    }
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${expected}`);
    return Response.json({ id: 'https://resources.test/objects/asset', name: 'Public identity' });
  };
  try {
    const result = await getAuthenticated<Record<string, unknown>>('https://resources.test/objects/asset', '', native, 'direct', config, new Map(), '', async (id) => { resolvedActor = id; });
    assert.equal(result.name, 'Public identity');
    assert.equal(calls, 2);
    assert.equal(resolvedActor, actor);
  } finally { globalThis.fetch = originalFetch; }
});

test('protected proxy retrieval retains its explicit resource Actor route', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return calls.length === 1 ? new Response(null, { status: 401 }) : Response.json({ value: 'proxied' });
  };
  try {
    const config: ClientConfig = { origins: { authority: 'https://auth.test', policy: 'https://policy.test', simulation: 'https://sim.test' } };
    const result = await getAuthenticated<{ value: string }>('https://resource.test/item', 'https://resource.test/actors/territory', 'native', 'proxy', config);
    assert.equal(result.value, 'proxied');
    assert.match(calls[1]!, /resourceActor=https%3A%2F%2Fresource\.test%2Factors%2Fterritory/);
  } finally { globalThis.fetch = originalFetch; }
});

test('resource audience resolution rejects unknown and ambiguous origins and presentation retains real identities and addresses', () => {
  const config: ClientConfig = { origins: { authority: 'https://auth.test', policy: 'https://policy.test', simulation: 'https://sim.test' }, actors: { one: 'https://remote.test/actors/one', two: 'https://remote.test/actors/two' } };
  assert.throws(() => resourceAudience('https://unlisted.test/resource', '', new Map(), config), /could not be identified/);
  assert.throws(() => resourceAudience('https://remote.test/resource', '', new Map(), config), /ambiguous/);
  assert.equal(resourceAudience('https://unlisted.test/resource', '', new Map([['https://unlisted.test/resource', new Set(['https://actors.test/a'])]]), config), 'https://actors.test/a');
  assert.throws(() => resourceAudience('https://unlisted.test/resource', '', new Map([['https://unlisted.test/resource', new Set(['https://actors.test/a', 'https://actors.test/b'])]]), config), /Multiple Actors link/);
  const actor = { id: 'https://actors.test/actors/blue', type: 'Actor', role: 'territory', name: 'Blue Coast' };
  identityDisplay.register(actor);
  identityDisplay.register({ id: 'https://actors.test/actors/registry', type: 'Actor', role: 'registry', name: 'Harbor Registry' });
  assert.match(formatActor(actor), /Actor: Blue Coast/);
  assert.equal(webFingerSubject(actor as never), '@blue.territory@actors.test');
  assert.match(formatActor(actor), /Handle: @blue\.territory@actors\.test/);
  const actorWithEndpoints = { ...actor, inbox: 'https://actors.test/inbox', outbox: 'https://actors.test/outbox' };
  assert.doesNotMatch(formatActor(actorWithEndpoints), /https:\/\//);
  assert.deepEqual(technicalAddresses(actorWithEndpoints).map((entry) => entry.address), [actor.id, actorWithEndpoints.inbox, actorWithEndpoints.outbox]);
  const unnamedActor = { id: 'https://actors.test/actors/player-1', role: 'player' };
  identityDisplay.register(unnamedActor);
  assert.equal(identityDisplay.label(unnamedActor.id), '@player-1@actors.test');
  const dottedActor = { id: 'https://actors.test/actors/blue.coast', role: 'territory', name: 'Blue Coast Archive' };
  identityDisplay.register(dottedActor);
  assert.equal(identityDisplay.label(dottedActor.id), 'Blue Coast Archive');
  assert.doesNotMatch(formatActor(dottedActor), /Handle:/);
  const rootActor = { id: 'https://actors.test/', role: 'territory', name: 'Root Actor' };
  identityDisplay.register(rootActor);
  assert.equal(identityDisplay.label(rootActor.id), 'Root Actor');
  const resource = { id: 'https://resources.test/assets/ore', name: 'Iron Ore', holder: 'https://actors.test/actors/registry', creator: ['https://actors.test/actors/blue'] };
  identityDisplay.register(resource);
  const ordinary = formatResource(resource);
  assert.match(ordinary, /Name: Iron Ore/);
  assert.match(ordinary, /Holder: Harbor Registry \(@registry.registry@actors.test\)/);
  assert.match(ordinary, /Creators: Blue Coast \(@blue.territory@actors.test\)/);
  assert.doesNotMatch(ordinary, /https:\/\//);
  assert.deepEqual(technicalAddresses(resource).map((entry) => entry.address), [resource.id, resource.holder, ...resource.creator]);
  assert.equal(identityDisplay.label(resource.id), 'Iron Ore');
  const authoring = formatAuthoringEntry('Asset', resource);
  assert.match(authoring, /Asset: “Iron Ore”/);
  assert.doesNotMatch(authoring, /https:\/\//);
  const collection = { orderedItems: [{ id: 'https://resources.test/objects/one', name: 'Named entry' }, 'https://resources.test/objects/two'] };
  assert.match(formatResource(collection), /Named entry[\s\S]*two/);
  assert.doesNotMatch(formatResource(collection), /https:\/\//);
  const collectionAddresses = technicalAddresses(collection).map((entry) => entry.address);
  assert.ok(collectionAddresses.includes((collection.orderedItems[0] as { id: string }).id));
  assert.ok(collectionAddresses.includes(collection.orderedItems[1] as string));
  const productionAddresses = technicalAddresses({ production: [{ ingredients: [{ variety: 'https://goods.test/ore', id: 'https://items.test/ore-1', data: { reference: 'https://private.test/data' } }], tool: 'https://tools.test/press', location: { id: 'https://areas.test/foundry', territory: 'https://actors.test/territory', name: 'Foundry' }, text: 'https://authored.test/text', proof: { id: 'https://proof.test/key' } }] }).map((entry) => entry.address);
  assert.deepEqual(productionAddresses, ['https://goods.test/ore', 'https://items.test/ore-1', 'https://tools.test/press', 'https://areas.test/foundry', 'https://actors.test/territory']);
});
