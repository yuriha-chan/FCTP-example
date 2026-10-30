import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveDiplomaticToken, createTokenDigest } from '@fctp/auth';
import type { URI } from '@fctp/protocol';
import { createHost } from '@fctp/server-base';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No allocated port');
  const value = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('simulation app serves resources and enforces enrolled Player and administrator permissions over HTTP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sim-app-'));
  const authorityPort = await port();
  const appPort = await port();
  const authorityOrigin = `http://127.0.0.1:${authorityPort}`;
  const origin = `http://127.0.0.1:${appPort}`;
  const authority = await createHost({ origin: authorityOrigin, storeFile: join(directory, 'authority.json'), actors: [{ name: 'registry', role: 'registry' }, { name: 'home', role: 'home' }, { name: 'player', role: 'player' }] });
  const app = await createSimulationApp({ origin, storeFile: join(directory, 'simulation.json'), authorityOrigin, peerOrigin: 'https://policy.example', adminSecret: 'local-admin-secret' });
  try {
    await authority.listen(authorityPort);
    await app.host.listen(appPort);
    const infoResponse = await fetch(`${origin}/local/info`);
    assert.equal(infoResponse.status, 200);
    const info = await infoResponse.json() as { ids: typeof app.ids };
    assert.equal(info.ids.varieties.importedMetal, 'https://policy.example/objects/varieties/metal');
    assert.equal((await fetch(info.ids.varieties.metal)).status, 200);
    assert.equal((await fetch(info.ids.assets[1]!)).status, 200);
    const asset = await (await fetch(info.ids.assets[1]!)).json() as { media: Array<{ url: string; mediaType: string }> };
    assert.equal(asset.media[0]!.mediaType, 'text/plain');
    assert.equal((await fetch(asset.media[0]!.url)).status, 401);
    assert.equal((await fetch(asset.media[0]!.url, { headers: { Authorization: 'Bearer invalid' } })).status, 401);
    assert.equal((await fetch(info.ids.map)).status, 401);
    assert.equal((await fetch(`${origin}/objects/maps/territory/ascii`)).status, 401);

    const player = authority.actor('player').id as URI;
    const token = await deriveDiplomaticToken(new Uint8Array(32).fill(7), app.ids.actor);
    const digest = await createTokenDigest(player, 1, token);
    const declaration = await authority.sign('home', {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
      id: `${authority.actor('home').id}/token-digest/1`, type: 'Create', actor: authority.actor('home').id,
      to: [app.ids.actor], object: digest,
    } as never);
    await app.host.server.receive(app.ids.actor, declaration);
    await app.host.server.processInbox();
    const playerAuth = { Authorization: `Bearer ${token}` };
    const assetResponse = await fetch(asset.media[0]!.url, { headers: playerAuth });
    assert.equal(assetResponse.status, 200);
    assert.match(assetResponse.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(await assetResponse.text(), 'metal production asset');
    assert.equal((await fetch(info.ids.map, { headers: playerAuth })).status, 200);
    assert.equal((await fetch(`${origin}/local/state`)).status, 401);
    assert.equal((await fetch(`${origin}/local/mine`, { method: 'POST', headers: { ...playerAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 2 }) })).status, 200);
    assert.equal((await fetch(`${origin}/local/mine`, { method: 'POST', headers: { Authorization: 'Bearer local-admin-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1 }) })).status, 403);
    assert.equal((await fetch(`${origin}/local/mine`, { method: 'POST', headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 1 }) })).status, 401);
    assert.equal((await fetch(`${origin}/local/admin/tick`, { method: 'POST', headers: playerAuth })).status, 403);
    const stateResponse = await fetch(`${origin}/local/state`, { headers: playerAuth });
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json() as { simulation: { productionJobs: Array<{ count: number }> } };
    assert.equal(state.simulation.productionJobs[0]?.count, 2);
    assert.equal((await fetch(`${origin}/local/unload`, { method: 'POST', headers: { Authorization: 'Bearer local-admin-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ entryRequest: `${authorityOrigin}/requests/missing`, cargo: { entries: [] }, duration: 1 }) })).status, 403);
    assert.equal((await fetch(`${origin}/local/unload`, { method: 'POST', headers: { ...playerAuth, 'Content-Type': 'application/json' }, body: JSON.stringify({ entryRequest: `${authorityOrigin}/requests/missing`, cargo: { entries: [{ variety: app.ids.varieties.ore, count: 2 }] }, duration: 1 }) })).status, 400);
  } finally {
    await app.host.close();
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('simulation manual review persists pending entry requests and waits for tick berthing after approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sim-manual-'));
  const authorityPort = await port();
  const appPort = await port();
  const authorityOrigin = `http://127.0.0.1:${authorityPort}`;
  const origin = `http://127.0.0.1:${appPort}`;
  const adminSecret = 'sim-manual-admin-secret';
  const authority = await createHost({
    origin: authorityOrigin, storeFile: join(directory, 'authority.json'),
    actors: [{ name: 'registry', role: 'registry' }, { name: 'home', role: 'home' }, { name: 'player', role: 'player' }]
  });
  const registryId = `${authorityOrigin}/actors/registry`;
  let app = await createSimulationApp({ origin, storeFile: join(directory, 'simulation.json'), authorityOrigin, peerOrigin: 'https://policy.example', adminSecret });
  await authority.listen(authorityPort);
  await app.host.listen(appPort);
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
    const admission = await fetch(`${origin}/local/admin/admission`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ reviewMode: 'manual', acceptedRegistries: [registryId] }) });
    assert.equal(admission.status, 200, 'simulation accepts durable admission settings over its administration endpoint');

    const pendingRequest = entry('https://registry.test/entry/sim-manual-pending', 'https://registry.test/vessels/sim-manual-one');
    await sendEntry(pendingRequest);
    const pendingText = JSON.stringify(await listRequests());
    assert.match(pendingText, new RegExp(escapeRegExp(String(pendingRequest.id))));
    assert.match(pendingText, new RegExp(escapeRegExp(String(pendingRequest.vessel.id))));
    assert.match(pendingText, new RegExp(escapeRegExp(String(pendingRequest.destination.port))));
    assert.match(pendingText, /pending/i);
    assert.equal((await app.territory.state()).visits[String(pendingRequest.id)], undefined, 'manual review does not admit a pending request');
    assert.equal((await events('BerthingEvent')).some((event) => event.request === pendingRequest.id), false);

    await app.host.close();
    app = await createSimulationApp({ origin, storeFile: join(directory, 'simulation.json'), authorityOrigin, peerOrigin: 'https://policy.example', adminSecret });
    await app.host.listen(appPort);
    assert.match(JSON.stringify(await listRequests()), new RegExp(escapeRegExp(String(pendingRequest.id))), 'pending simulation records remain actionable after restart');

    const approved = await decide(String(pendingRequest.id), 'approve');
    assert.equal(approved.status, 200);
    const approvedText = JSON.stringify(await approved.json());
    assert.match(approvedText, new RegExp(escapeRegExp(String(pendingRequest.id))));
    assert.match(approvedText, /accept/i);
    let state = await app.territory.state();
    assert.equal(state.visits[String(pendingRequest.id)]?.decision.accepted, true);
    assert.equal(state.simulation.vessels[0]?.status, 'pending', 'simulation approval resumes admission but waits for a tick to berth');
    assert.equal((await events('BerthingEvent')).some((event) => event.request === pendingRequest.id), false, 'simulation approval does not emit BerthingEvent before the tick');

    const tick = await fetch(`${origin}/local/admin/tick`, { method: 'POST', headers: adminHeaders, body: '{}' });
    assert.equal(tick.status, 200);
    state = await app.territory.state();
    assert.equal(state.simulation.vessels[0]?.status, 'berthed');
    assert.equal((await events('BerthingEvent')).filter((event) => event.request === pendingRequest.id).length, 1, 'the delayed simulation BerthingEvent is discoverable after the tick');
    assert.match(JSON.stringify(await listRequests()), /berth|event/i, 'the delayed berthing event is retained in subsequent request data');

    const repeated = await decide(String(pendingRequest.id), 'approve');
    assert.equal(repeated.status, 200);
    assert.match(JSON.stringify(await repeated.json()), /accept/i, 'repetition returns the saved result');
    assert.equal((await events('BerthingEvent')).filter((event) => event.request === pendingRequest.id).length, 1, 'repetition never creates another visit or event');
    const opposite = await decide(String(pendingRequest.id), 'reject', { reason: 'late-rejection' });
    assert.equal(opposite.status, 200);
    assert.match(JSON.stringify(await opposite.json()), /accept/i, 'a conflicting later decision returns the recorded outcome');
    assert.equal((await events('EntryRejected')).filter((event) => event.request === pendingRequest.id).length, 0);

    const rejectedRequest = entry('https://registry.test/entry/sim-manual-rejected', 'https://registry.test/vessels/sim-manual-two');
    await sendEntry(rejectedRequest);
    const rejected = await decide(String(rejectedRequest.id), 'reject', { reason: 'harbor-closed' });
    assert.equal(rejected.status, 200);
    assert.match(JSON.stringify(await rejected.json()), /harbor-closed/);
    assert.equal((await app.territory.state()).visits[String(rejectedRequest.id)], undefined);
    const rejectionEvents = await events('EntryRejected');
    assert.equal(rejectionEvents.filter((event) => event.request === rejectedRequest.id).length, 1);
    assert.match(JSON.stringify(rejectionEvents.find((event) => event.request === rejectedRequest.id)), /harbor-closed/);

    const invalidEvidenceRequest = {
      ...entry('https://registry.test/entry/sim-invalid-evidence', 'https://registry.test/vessels/invalid-evidence'),
      journey: { events: [], exitEvidence: `${authorityOrigin}/objects/nonexistent-exit` }
    };
    await sendEntry(invalidEvidenceRequest);
    const invalidEvidenceApproval = await decide(invalidEvidenceRequest.id, 'approve');
    assert.equal(invalidEvidenceApproval.status, 200);
    assert.equal((await app.territory.state()).visits[invalidEvidenceRequest.id], undefined, 'supplied invalid exit evidence cannot become evidence-free admission during manual approval');
    assert.equal((await events('EntryRejected')).filter((event) => event.request === invalidEvidenceRequest.id).length, 1);

    const changedRequest = entry('https://registry.test/entry/sim-manual-current-rule', 'https://registry.test/vessels/sim-manual-three');
    await sendEntry(changedRequest);
    const changedAdmission = await fetch(`${origin}/local/admin/admission`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ acceptedRegistries: [] }) });
    assert.equal(changedAdmission.status, 200);
    const currentRule = await decide(String(changedRequest.id), 'approve');
    assert.equal(currentRule.status, 200);
    assert.match(JSON.stringify(await currentRule.json()), /reject|deny|not-accepted|policy/i, 'approval applies current admission rules rather than the receipt snapshot');
    assert.equal((await app.territory.state()).visits[String(changedRequest.id)], undefined);
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
