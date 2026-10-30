import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import { createTokenDigest, deriveDiplomaticToken } from '@fctp/auth';
import { createHost } from '@fctp/server-base';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port allocated');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('policy app serves linked resources and protects operations with enrolled Player tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-policy-app-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const origin = `http://127.0.0.1:${await freePort()}`;
  const authority = await createHost({
    origin: authorityOrigin, storeFile: join(directory, 'authority.json'),
    actors: [{ name: 'home', role: 'home' }, { name: 'player', role: 'player' }, { name: 'registry', role: 'registry' }]
  });
  const homeId = `${authorityOrigin}/actors/home`;
  const playerId = `${authorityOrigin}/actors/player`;
  const remoteFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    url.hash = '';
    for (const name of ['home', 'player', 'registry']) {
      if (url.href === `${authorityOrigin}/actors/${name}`) return Response.json(authority.actor(name));
      if (url.href === authority.key(name).keyPair.id.split('#')[0]) return Response.json(authority.key(name).publicKey);
    }
    return new Response('not found', { status: 404 });
  };
  const app = await createPolicyApp({ origin, storeFile: join(directory, 'policy.json'), authorityOrigin, peerOrigin: 'https://peer.example', adminSecret: 'policy-admin-secret', fetcher: remoteFetch });
  await app.host.listen(Number(new URL(origin).port));
  const nativeToken = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const diplomaticToken = await deriveDiplomaticToken(nativeToken, app.ids.actor);
  const digest = await createTokenDigest(playerId, 1, diplomaticToken);
  try {
    await app.host.server.receive(app.ids.actor, await authority.sign('home', {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
      id: `${homeId}/activities/token-digest/1`, type: 'Create', actor: homeId, object: digest, to: [app.ids.actor]
    } as never));
    await app.host.server.processInbox();
    const headers = { Authorization: `Bearer ${diplomaticToken}`, 'Content-Type': 'application/json' };
    const get = (uri: string, token?: string) => fetch(uri, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const unknownCommodity = await fetch(`${origin}/local/transfer`, { method: 'POST', headers, body: JSON.stringify({ direction: 'to-port', variety: `${origin}/objects/varieties/fake`, count: 1 }) });
    assert.equal(unknownCommodity.status, 400);
    const invalidPolicy = await fetch(`${origin}/local/admin/policy`, { method: 'POST', headers: { Authorization: 'Bearer policy-admin-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ miningPermitted: true, miningQuota: 2, oreReserve: 2, manufacturePermits: ['recipe'], recipes: [{ id: 'recipe', ingredients: { [app.ids.varieties.ore]: '2' }, output: app.ids.varieties.metal, outputCount: 1 }], warehouseLimits: {}, portLimits: {}, decisions: {} }) });
    assert.equal(invalidPolicy.status, 400);
    const basePolicy = { miningPermitted: true, miningQuota: 2, oreReserve: 2, manufacturePermits: [], recipes: [], warehouseLimits: {}, portLimits: {}, decisions: {} };
    const postPolicy = (varietyPortPolicy: unknown) => fetch(`${origin}/local/admin/policy`, { method: 'POST', headers: { Authorization: 'Bearer policy-admin-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...basePolicy, varietyPortPolicy }) });
    assert.equal((await postPolicy({ '/objects/varieties/metal': 'deny' })).status, 400);
    assert.equal((await postPolicy({ [app.ids.varieties.metal]: 'maybe' })).status, 400);
    assert.equal((await postPolicy([])).status, 400);
    const info = await (await fetch(`${origin}/local/info`)).json() as { ids: typeof app.ids };
    assert.deepEqual(info.ids, app.ids);
    assert.equal((await get(app.ids.ports[0]!)).status, 200);
    const publicPort = await (await get(app.ids.ports[0]!)).json() as { listings: string; resources?: unknown };
    assert.equal((await get(publicPort.listings)).status, 200);
    const listingCollection = await (await get(publicPort.listings)).json() as { items: Array<{ id: string }> };
    assert.equal((await get(listingCollection.items[0]!.id)).status, 200);
    assert.equal((await get(app.ids.ports[1]!)).status, 401);
    assert.equal((await get(app.ids.ports[1]!, diplomaticToken)).status, 403);
    assert.equal((await get(app.ids.ports[1]!, 'invalid')).status, 401);
    assert.equal((await fetch(`${origin}/local/mine`, { method: 'POST', headers: { Authorization: 'Bearer policy-admin-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 2 }) })).status, 401);
    const mined = await fetch(`${origin}/local/mine`, { method: 'POST', headers, body: JSON.stringify({ count: 2 }) });
    assert.equal(mined.status, 200);
    const manufactured = await fetch(`${origin}/local/manufacture`, { method: 'POST', headers, body: JSON.stringify({ count: 1, recipe: 'ore-to-metal' }) });
    assert.equal(manufactured.status, 200);
    const state = await (await fetch(`${origin}/local/state`, { headers: { Authorization: `Bearer ${diplomaticToken}` } })).json() as { state: { rawInventory: Record<string, number>; audit: Array<{ actor: string; action: string; outcome: string }> } };
    assert.equal(state.state.rawInventory[app.ids.varieties.metal], 1);
    assert.equal(state.state.rawInventory[app.ids.varieties.ore], 0);
    assert.deepEqual(state.state.audit.at(-1), { actor: playerId, action: 'manufacture', outcome: 'accepted', details: { recipeId: 'ore-to-metal', count: 1, outputCount: 1 } });
    const rejectedTransfer = await fetch(`${origin}/local/transfer`, { method: 'POST', headers, body: JSON.stringify({ direction: 'to-port', variety: app.ids.varieties.metal, count: 100 }) });
    assert.equal(rejectedTransfer.status, 409);
    const afterRejection = await (await fetch(`${origin}/local/state`, { headers: { Authorization: `Bearer ${diplomaticToken}` } })).json() as typeof state;
    assert.equal(afterRejection.state.audit.at(-1)?.actor, playerId);
    assert.equal(afterRejection.state.audit.at(-1)?.action, 'warehouse-to-port');
    assert.equal(afterRejection.state.audit.at(-1)?.outcome, 'rejected');
    const changed = await fetch(`${origin}/local/admin/admission`, { method: 'POST', headers: { Authorization: 'Bearer policy-admin-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ publicPorts: [app.ids.ports[1]] }) });
    assert.equal(changed.status, 200);
    assert.equal((await get(app.ids.ports[1]!)).status, 200);
    assert.equal((await get(`${app.ids.ports[1]}/listings`)).status, 200);
    assert.equal((await get(app.ids.ports[0]!)).status, 401);
    const actor = await (await fetch(app.ids.actor)).json() as { resources: { areas: Array<{ id: string; type: string }> } };
    assert.equal(actor.resources.areas[0]!.id, app.ids.areas[0]);
    assert.equal(actor.resources.areas[0]!.type, 'Area');
    const descriptor = await (await fetch(app.ids.map)).json() as { representations: Array<{ format: string }> };
    assert.equal(descriptor.representations[0]!.format, 'https://fctp.example/formats/ascii');
    const textMap = await fetch(`${origin}/objects/maps/territory/ascii`);
    assert.equal(textMap.headers.get('content-type'), 'text/plain; charset=utf-8');
    const asset = await (await fetch(app.ids.assets[0]!)).json() as { creator: string[]; media: Array<{ url: string }> };
    assert.deepEqual(asset.creator, [playerId]);
    const assetText = await fetch(asset.media[0]!.url);
    assert.equal(assetText.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(await assetText.text(), /^Ore: /);
    const variety = await fetch(app.ids.varieties.ore);
    assert.equal((await variety.json() as { id: string }).id, app.ids.varieties.ore);
  } finally {
    await app.host.close();
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('policy manual review persists verified entry requests across restart and applies one durable decision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-policy-manual-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const origin = `http://127.0.0.1:${await freePort()}`;
  const port = Number(new URL(origin).port);
  const adminSecret = 'policy-manual-admin-secret';
  const authority = await createHost({
    origin: authorityOrigin, storeFile: join(directory, 'authority.json'),
    actors: [{ name: 'home', role: 'home' }, { name: 'player', role: 'player' }, { name: 'registry', role: 'registry' }]
  });
  const registryId = `${authorityOrigin}/actors/registry`;
  const remoteFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    url.hash = '';
    for (const name of ['home', 'player', 'registry']) {
      if (url.href === `${authorityOrigin}/actors/${name}`) return Response.json(authority.actor(name));
      if (url.href === authority.key(name).keyPair.id.split('#')[0]) return Response.json(authority.key(name).publicKey);
    }
    return new Response('not found', { status: 404 });
  };
  let app = await createPolicyApp({ origin, storeFile: join(directory, 'policy.json'), authorityOrigin, peerOrigin: 'https://peer.example', adminSecret, fetcher: remoteFetch });
  await app.host.listen(port);
  const adminHeaders = { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' };
  const entry = (id: string, vessel: string) => ({
    id, type: 'EntryRequest',
    vessel: { id: vessel, registry: registryId, possessor: `${authorityOrigin}/actors/player`, capacity: 20 },
    cargo: { entries: [] }, journey: { events: [] },
    destination: { territory: app.ids.actor, port: app.ids.ports[0], route: app.ids.routes[0] }
  });
  const sendEntry = async (request: Record<string, unknown>): Promise<void> => {
    const activity = await authority.sign('registry', {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
      id: `${String(request.id)}/activity`, type: 'Create', actor: registryId, object: request, to: [app.ids.actor]
    } as never);
    await app.host.server.receive(app.ids.actor, activity);
    await app.host.server.processInbox();
  };
  const listRequests = async (): Promise<unknown[]> => {
    const response = await fetch(`${origin}/local/admin/entry-requests`, { headers: { Authorization: `Bearer ${adminSecret}` } });
    assert.equal(response.status, 200, 'entry request administration uses the existing administrator secret');
    const body = await response.json() as { requests?: unknown };
    assert.ok(Array.isArray(body.requests), 'entry request administration returns a requests collection');
    return body.requests;
  };
  const decide = (id: string, action: 'approve' | 'reject', body: Record<string, unknown> = {}): Promise<Response> =>
    fetch(`${origin}/local/admin/entry-requests/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: adminHeaders, body: JSON.stringify(body) });
  const events = (type: string): Promise<Array<Record<string, unknown>>> => app.host.server.store.read((store) =>
    store.outboxArchive.map((item) => item.activity.object as Record<string, unknown>).filter((object) => object.type === type));
  try {
    const admission = await fetch(`${origin}/local/admin/admission`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ reviewMode: 'manual' }) });
    assert.equal(admission.status, 200, 'manual review mode is a durable admission setting');

    const pendingRequest = entry('https://registry.test/entry/manual-pending', 'https://registry.test/vessels/manual-one');
    await sendEntry(pendingRequest);
    const pendingText = JSON.stringify(await listRequests());
    assert.match(pendingText, new RegExp(escapeRegExp(String(pendingRequest.id))));
    assert.match(pendingText, new RegExp(escapeRegExp(String(pendingRequest.vessel.id))));
    assert.match(pendingText, new RegExp(escapeRegExp(String(pendingRequest.destination.port))));
    assert.match(pendingText, /pending/i);
    assert.equal((await app.territory.ledger).visits[String(pendingRequest.vessel.id)], undefined, 'manual review does not berth a pending request');
    assert.equal((await events('BerthingEvent')).some((event) => event.request === pendingRequest.id), false, 'manual review does not emit a berthing event');

    await app.host.close();
    app = await createPolicyApp({ origin, storeFile: join(directory, 'policy.json'), authorityOrigin, peerOrigin: 'https://peer.example', adminSecret, fetcher: remoteFetch });
    await app.host.listen(port);
    assert.match(JSON.stringify(await listRequests()), new RegExp(escapeRegExp(String(pendingRequest.id))), 'pending records remain actionable after restart');

    const approved = await decide(String(pendingRequest.id), 'approve');
    assert.equal(approved.status, 200);
    const approvedText = JSON.stringify(await approved.json());
    assert.match(approvedText, new RegExp(escapeRegExp(String(pendingRequest.id))));
    assert.match(approvedText, /accept/i);
    assert.equal((await app.territory.ledger).decisions[String(pendingRequest.id)]?.accepted, true);
    assert.ok((await app.territory.ledger).visits[String(pendingRequest.vessel.id)], 'policy approval resumes the existing acceptance path');
    assert.equal((await events('BerthingEvent')).filter((event) => event.request === pendingRequest.id).length, 1, 'policy approval emits one BerthingEvent immediately');

    const repeated = await decide(String(pendingRequest.id), 'approve');
    assert.equal(repeated.status, 200);
    assert.match(JSON.stringify(await repeated.json()), /accept/i, 'repetition returns the saved result');
    assert.equal((await events('BerthingEvent')).filter((event) => event.request === pendingRequest.id).length, 1, 'repetition never creates another visit or event');
    const opposite = await decide(String(pendingRequest.id), 'reject', { reason: 'late-rejection' });
    assert.equal(opposite.status, 200);
    assert.match(JSON.stringify(await opposite.json()), /accept/i, 'a conflicting later decision returns the recorded outcome');
    assert.equal((await events('EntryRejected')).filter((event) => event.request === pendingRequest.id).length, 0, 'a conflicting decision never creates compensation or a forced exit');
    assert.equal((await app.territory.ledger).decisions[String(pendingRequest.id)]?.accepted, true);

    const rejectedRequest = entry('https://registry.test/entry/manual-rejected', 'https://registry.test/vessels/manual-two');
    await sendEntry(rejectedRequest);
    const rejected = await decide(String(rejectedRequest.id), 'reject', { reason: 'harbor-closed' });
    assert.equal(rejected.status, 200);
    assert.match(JSON.stringify(await rejected.json()), /harbor-closed/);
    assert.equal((await app.territory.ledger).decisions[String(rejectedRequest.id)]?.accepted, false);
    assert.equal((await app.territory.ledger).visits[String(rejectedRequest.vessel.id)], undefined, 'rejection does not berth');
    const rejectionEvents = await events('EntryRejected');
    assert.equal(rejectionEvents.filter((event) => event.request === rejectedRequest.id).length, 1);
    assert.match(JSON.stringify(rejectionEvents.find((event) => event.request === rejectedRequest.id)), /harbor-closed/);
    const repeatedReject = await decide(String(rejectedRequest.id), 'reject', { reason: 'different-reason' });
    assert.equal(repeatedReject.status, 200);
    assert.equal((await events('EntryRejected')).filter((event) => event.request === rejectedRequest.id).length, 1, 'repeated rejection returns the saved result');
    const ignoredApprove = await decide(String(rejectedRequest.id), 'approve');
    assert.equal(ignoredApprove.status, 200);
    assert.equal((await events('BerthingEvent')).filter((event) => event.request === rejectedRequest.id).length, 0);
    assert.equal((await app.territory.ledger).visits[String(rejectedRequest.vessel.id)], undefined);

    const changedRequest = entry('https://registry.test/entry/manual-current-rule', 'https://registry.test/vessels/manual-three');
    await sendEntry(changedRequest);
    const changedAdmission = await fetch(`${origin}/local/admin/admission`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ registryAcceptance: [] }) });
    assert.equal(changedAdmission.status, 200);
    const currentRule = await decide(String(changedRequest.id), 'approve');
    assert.equal(currentRule.status, 200);
    assert.match(JSON.stringify(await currentRule.json()), /reject|deny|not-accepted|policy/i, 'approval applies current admission rules rather than the receipt snapshot');
    assert.equal((await app.territory.ledger).decisions[String(changedRequest.id)]?.accepted, false);
    assert.equal((await app.territory.ledger).visits[String(changedRequest.vessel.id)], undefined);
    assert.equal((await events('EntryRejected')).filter((event) => event.request === changedRequest.id).length, 1);

    const unauthorizedList = await fetch(`${origin}/local/admin/entry-requests`);
    assert.equal(unauthorizedList.status, 401);
    const unauthorizedDecision = await fetch(`${origin}/local/admin/entry-requests/${encodeURIComponent(String(pendingRequest.id))}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(unauthorizedDecision.status, 401, 'entry request decisions require the existing administrator secret');
  } finally {
    await app.host.close();
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function findObject(value: unknown, predicate: (record: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObject(item, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (predicate(record)) return record;
  for (const item of Object.values(record)) {
    const found = findObject(item, predicate);
    if (found) return found;
  }
  return undefined;
}

test('policy local traverse moves an active visit between owned ports with an observable VoyageEvent and permits departure from the new port', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-policy-traverse-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const origin = `http://127.0.0.1:${await freePort()}`;
  const peerOrigin = 'https://simulation.test';
  const authority = await createHost({
    origin: authorityOrigin, storeFile: join(directory, 'authority.json'),
    actors: [{ name: 'home', role: 'home' }, { name: 'player', role: 'player' }, { name: 'other', role: 'player' }, { name: 'registry', role: 'registry' }]
  });
  const registryId = `${authorityOrigin}/actors/registry`;
  const playerId = `${authorityOrigin}/actors/player`;
  const outboundRouteId = `${origin}/objects/routes/outbound`;
  const outboundRoute = {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
    id: outboundRouteId, type: 'Route', name: 'Outbound Passage',
    from: `${origin}/objects/ports/west`, to: `${peerOrigin}/objects/boundaries/east`, distance: 4
  };
  const remoteFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    url.hash = '';
    for (const name of ['home', 'player', 'other', 'registry']) {
      if (url.href === `${authorityOrigin}/actors/${name}`) return Response.json(authority.actor(name));
      if (url.href === authority.key(name).keyPair.id.split('#')[0]) return Response.json(authority.key(name).publicKey);
    }
    return new Response('not found', { status: 404 });
  };
  const app = await createPolicyApp({
    origin, storeFile: join(directory, 'policy.json'), authorityOrigin, peerOrigin, adminSecret: 'policy-traverse-secret',
    playerNames: ['player', 'other'], additionalRoutes: [outboundRoute], fetcher: remoteFetch
  });
  await app.host.listen(Number(new URL(origin).port));
  const tokens = {} as Record<'player' | 'other', { native: Uint8Array; diplomatic: string }>;
  try {
    for (const name of ['player', 'other'] as const) {
      const native = Uint8Array.from({ length: 32 }, (_, index) => index + (name === 'player' ? 1 : 33));
      const diplomatic = await deriveDiplomaticToken(native, app.ids.actor);
      const digest = await createTokenDigest(`${authorityOrigin}/actors/${name}`, 1, diplomatic);
      await app.host.server.receive(app.ids.actor, await authority.sign('home', {
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
        id: `${authorityOrigin}/actors/home/token-digest/${name}`, type: 'Create', actor: `${authorityOrigin}/actors/home`, object: digest, to: [app.ids.actor]
      } as never));
      tokens[name] = { native, diplomatic };
    }
    await app.host.server.processInbox();

    const info = await (await fetch(`${origin}/local/info`)).json() as { ids: typeof app.ids; endpoints?: string[] };
    assert.ok(info.ids.routes.includes(outboundRouteId), 'explicit additional routes are advertised with owned route identities');
    assert.ok((info.endpoints ?? []).includes('/local/traverse'), 'local traverse is advertised through territory info');
    assert.equal(JSON.stringify(info.ids).includes(`${origin}/objects/routes/coastal`), true, 'the default topology remains advertised');
    const publishedRoute = await fetch(outboundRouteId);
    assert.equal(publishedRoute.status, 200);
    const routeDocument = await publishedRoute.json() as Record<string, unknown>;
    assert.equal(routeDocument.from, app.ids.ports[1]);
    assert.equal(routeDocument.to, `${peerOrigin}/objects/boundaries/east`);

    const vessel = `${authorityOrigin}/objects/vessels/traverse-one`;
    const cargo = { entries: [{ variety: app.ids.varieties.ore, count: 2, data: {} }] };
    const entryId = `${authorityOrigin}/objects/entry-requests/traverse-one`;
    const entryRequest = {
      id: entryId, type: 'EntryRequest',
      vessel: { id: vessel, registry: registryId, possessor: playerId, capacity: 20 },
      cargo, journey: { events: [] },
      destination: { territory: app.ids.actor, port: app.ids.ports[0], route: app.ids.routes[0] }
    };
    await app.host.server.receive(app.ids.actor, await authority.sign('registry', {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
      id: `${entryId}/activity`, type: 'Create', actor: registryId, object: entryRequest, to: [app.ids.actor]
    } as never));
    await app.host.server.processInbox();
    const active = (await app.territory.ledger).visits[vessel];
    assert.equal(active?.port, app.ids.ports[0]);
    assert.equal(active?.route, app.ids.routes[0]);
    assert.deepEqual(active?.cargo, cargo, 'local movement starts from the admitted cargo identity');

    const playerHeaders = { Authorization: `Bearer ${tokens.player.diplomatic}`, 'Content-Type': 'application/json' };
    const otherHeaders = { Authorization: `Bearer ${tokens.other.diplomatic}`, 'Content-Type': 'application/json' };
    const discovery = await (await fetch(`${origin}/local/actions?vessel=${encodeURIComponent(vessel)}`, { headers: playerHeaders })).json() as { actions: Array<Record<string, unknown>>; state?: { visits?: Array<Record<string, unknown>> } };
    const traverse = discovery.actions.find((action) => typeof action.request === 'object' && action.request !== null && String((action.request as Record<string, unknown>).href).endsWith('/local/traverse') && JSON.stringify((action.request as Record<string, unknown>).body).includes(app.ids.routes[1]!));
    assert.ok(traverse, 'an available traverse action names the Coastal Passage route for the active visit');
    assert.equal(traverse.available, true);

    const wrongPossessor = await fetch(`${origin}/local/traverse`, { method: 'POST', headers: otherHeaders, body: JSON.stringify({ vessel, route: app.ids.routes[1] }) });
    assert.equal(wrongPossessor.status, 403, 'only the active visit possessor can move the vessel');
    assert.equal((await app.territory.ledger).visits[vessel]?.port, app.ids.ports[0], 'a wrong possessor never moves the visit');

    const wrongStart = await fetch(`${origin}/local/traverse`, { method: 'POST', headers: playerHeaders, body: JSON.stringify({ vessel, route: app.ids.routes[0] }) });
    assert.ok([400, 409].includes(wrongStart.status), 'a route that does not start at the current port is refused');
    const unknownRoute = await fetch(`${origin}/local/traverse`, { method: 'POST', headers: playerHeaders, body: JSON.stringify({ vessel, route: `${origin}/objects/routes/unowned` }) });
    assert.ok([400, 403, 404, 409].includes(unknownRoute.status), 'unowned routes are refused');
    assert.equal((await app.territory.ledger).visits[vessel]?.port, app.ids.ports[0], 'invalid routes never move the visit');

    const moved = await fetch(`${origin}/local/traverse`, { method: 'POST', headers: playerHeaders, body: JSON.stringify({ vessel, route: app.ids.routes[1] }) });
    assert.equal(moved.status, 200);
    const movedBody = await moved.json();
    const voyage = findObject(movedBody, (record) => record.type === 'VoyageEvent' && record.kind === 'local-movement');
    assert.ok(voyage, 'local movement returns its authoritative VoyageEvent');
    assert.equal(voyage.vessel, vessel);
    assert.equal(voyage.territory, app.ids.actor);
    assert.deepEqual(voyage.details, { from: app.ids.ports[0], to: app.ids.ports[1], route: app.ids.routes[1], entryRequest: entryId });
    assert.equal(typeof voyage.id, 'string');
    const eventResponse = await fetch(String(voyage.id));
    assert.equal(eventResponse.status, 200, 'the movement event remains observable through its authoritative identity');
    assert.equal((await eventResponse.json() as Record<string, unknown>).kind, 'local-movement');
    const ledgerAfterMove = await app.territory.ledger;
    assert.equal(ledgerAfterMove.visits[vessel]?.port, app.ids.ports[1], 'the persisted visit now records the destination port');
    assert.equal(ledgerAfterMove.visits[vessel]?.route, app.ids.routes[1], 'the persisted visit records the traversed route');
    assert.equal(ledgerAfterMove.visits[vessel]?.entryRequest, entryId, 'local movement keeps the original entry identity');
    assert.deepEqual(ledgerAfterMove.visits[vessel]?.cargo, cargo, 'local movement keeps the cargo identity');
    assert.match(JSON.stringify(ledgerAfterMove), new RegExp(escapeRegExp(String(voyage.id))), 'the territory ledger retains the observable movement event');

    const afterMoveDiscovery = await (await fetch(`${origin}/local/actions?vessel=${encodeURIComponent(vessel)}`, { headers: playerHeaders })).json() as { state?: { visits?: Array<Record<string, unknown>>; cargo?: unknown } };
    assert.equal(afterMoveDiscovery.state?.visits?.[0]?.port, app.ids.ports[1]);
    assert.deepEqual(afterMoveDiscovery.state?.cargo, cargo);

    const reverse = await fetch(`${origin}/local/traverse`, { method: 'POST', headers: playerHeaders, body: JSON.stringify({ vessel, route: app.ids.routes[1] }) });
    assert.ok([400, 403, 404, 409].includes(reverse.status), 'the Coastal Passage is not traversable in reverse without an explicit route');
    assert.equal((await app.territory.ledger).visits[vessel]?.port, app.ids.ports[1], 'a reverse attempt never moves the vessel');

    const departureId = `${authorityOrigin}/objects/departure-requests/traverse-one`;
    const departure = {
      id: departureId, type: 'DepartureRequest', vessel, territory: app.ids.actor, port: app.ids.ports[1], route: app.ids.routes[1]
    };
    await app.host.server.receive(app.ids.actor, await authority.sign('registry', {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
      id: `${departureId}/activity`, type: 'Create', actor: registryId, object: departure, to: [app.ids.actor]
    } as never));
    await app.host.server.processInbox();
    const events = await app.host.server.store.read((store) => store.outboxArchive.map((item) => item.activity.object as Record<string, unknown>));
    const departureEvent = events.find((event) => event.type === 'DepartureEvent' && event.request === departureId);
    const exitEvent = events.find((event) => event.type === 'ExitEvent' && event.entryRequest === entryId);
    assert.equal(departureEvent?.port, app.ids.ports[1], 'departure uses the port reached by actual local movement');
    assert.equal(exitEvent?.route, app.ids.routes[1], 'the signed ExitEvent identifies the actual departure route');
    assert.equal((await app.territory.ledger).visits[vessel]?.departed, true);
  } finally {
    await app.host.close();
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});
