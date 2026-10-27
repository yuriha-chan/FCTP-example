import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Vessel } from '@fctp/protocol';
import type { LocalActionDiscovery } from '@fctp/server-base';
import { createAuthority } from '../apps/test-authority/src/bootstrap.js';
import { installRegistry } from '../apps/test-authority/src/registry.js';

test('Registry action discovery is owned-player-only, visit-bound, lifecycle-aware, and read-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-registry-actions-'));
  const origin = `http://127.0.0.1:${await availablePort()}`;
  const territoryA = 'https://territory.test/actors/a';
  const territoryB = 'https://territory.test/actors/b';
  const vessels: Vessel[] = Array.from({ length: 5 }, (_, index) => ({ id: `${origin}/objects/vessels/${index}`, registry: `${origin}/actors/registry`, possessor: `${origin}/actors/player-${index}`, capacity: 5 }));
  const credentials = new Map(vessels.map((vessel, index) => [`native-${index}`, vessel.possessor]));
  let authority: Awaited<ReturnType<typeof createAuthority>> | undefined;
  try {
    authority = await createAuthority({ origin, storeFile: join(directory, 'registry.json'), adminSecret: 'admin' });
    const registry = installRegistry(authority, { initialVessels: vessels, route: async (territory) => ({ actor: territory, inbox: `${territory}/inbox` }), authenticatePlayer: async (request) => credentials.get((request.headers.authorization ?? '').replace(/^Bearer /, '')) });
    await authority.listen(Number(new URL(origin).port));
    const vessel = vessels[0]!;
    const entry = await registry.sendEntry({ vessel: vessel.id, territory: territoryA, port: `${territoryA}/ports/1`, route: `${territoryA}/routes/1` });
    const wrongDestination = await registry.sendDeparture({ vessel: vessel.id, territory: territoryB, port: `${territoryB}/ports/1`, route: `${territoryB}/routes/1` });
    await authority.server.store.transaction((store) => {
      const data = store.domain.registry as { vessels: Record<string, { events: Array<Record<string, unknown>> }> };
      data.vessels[vessel.id]!.events.push({ id: `${territoryA}/events/berth`, type: 'BerthingEvent', vessel: vessel.id, territory: territoryA, port: entry.destination.port, request: entry.id, effectiveAt: '2026-01-01T00:00:00Z' });
    });
    const url = `${origin}/local/registry/actions?vessel=${encodeURIComponent(vessel.id)}`;
    const request = (auth?: string, target = url) => fetch(target, { headers: auth ? { Authorization: `Bearer ${auth}` } : {} });
    const before = await authority.server.store.read((store) => structuredClone({ domain: store.domain, outbox: store.outbox, outboxArchive: store.outboxArchive }));
    assert.equal((await request()).status, 401);
    assert.equal((await request('admin')).status, 401);
    assert.equal((await request('native-1')).status, 403);
    assert.equal((await request('native-0', `${origin}/local/registry/actions`)).status, 400);
    const response = await request('native-0');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    let discovery = await response.json() as LocalActionDiscovery;
    const departure = discovery.actions.find((action) => action.id === 'departure')!;
    assert.equal(departure.available, true);
    assert.equal((departure.request!.body as Record<string, string>).territory, territoryA);
    assert.equal((discovery.state.pendingRequests as Array<{ id: string }>).some((item) => item.id === wrongDestination.id), true);
    const after = await authority.server.store.read((store) => ({ domain: store.domain, outbox: store.outbox, outboxArchive: store.outboxArchive }));
    assert.deepEqual(after, before);
    const realDeparture = await registry.sendDeparture({ vessel: vessel.id, territory: territoryA, port: entry.destination.port, route: entry.destination.route });
    discovery = await (await request('native-0')).json() as typeof discovery;
    assert.equal(discovery.actions.find((action) => action.id === 'departure')!.available, false);
    assert.equal((discovery.state.location as { status: string }).status, 'berthed');
    await authority.server.store.transaction((store) => {
      const data = store.domain.registry as { vessels: Record<string, { events: Array<Record<string, unknown>> }> };
      data.vessels[vessel.id]!.events.push({ id: `${territoryA}/events/departure`, type: 'DepartureEvent', vessel: vessel.id, territory: territoryA, port: entry.destination.port, request: realDeparture.id, effectiveAt: '2026-01-01T00:01:00Z' });
    });
    discovery = await (await request('native-0')).json() as typeof discovery;
    assert.equal((discovery.state.location as { status: string }).status, 'departed-awaiting-exit');
    await authority.server.store.transaction((store) => {
      const data = store.domain.registry as { vessels: Record<string, { events: Array<Record<string, unknown>>; exitEvidence: string[] }> };
      data.vessels[vessel.id]!.events.push({ id: `${territoryA}/events/exit`, type: 'ExitEvent', vessel: vessel.id, territory: territoryA, entryRequest: entry.id });
      data.vessels[vessel.id]!.exitEvidence.push(`${territoryA}/events/exit`);
    });
    discovery = await (await request('native-0')).json() as typeof discovery;
    assert.equal((discovery.state.location as { status: string }).status, 'exited');
    assert.equal(discovery.actions.find((action) => action.id === 'departure')!.available, false);
    const reentry = await registry.sendEntry({ vessel: vessel.id, territory: territoryA, port: `${territoryA}/ports/1`, route: `${territoryA}/routes/1` });
    await authority.server.store.transaction((store) => {
      const data = store.domain.registry as { vessels: Record<string, { events: Array<Record<string, unknown>> }> };
      data.vessels[vessel.id]!.events.push({ id: `${territoryA}/events/reentry-berth`, type: 'BerthingEvent', vessel: vessel.id, territory: territoryA, port: reentry.destination.port, request: reentry.id, effectiveAt: '2026-01-01T00:02:00Z' });
    });
    discovery = await (await request('native-0')).json() as typeof discovery;
    assert.equal(discovery.actions.find((action) => action.id === 'departure')!.available, true);
    const optionalRouteDeparture = await registry.sendDeparture({ vessel: vessel.id, territory: territoryA, port: reentry.destination.port });
    assert.equal(optionalRouteDeparture.route, undefined);
    discovery = await (await request('native-0')).json() as typeof discovery;
    assert.equal(discovery.actions.find((action) => action.id === 'departure')!.available, false);
    assert.match(discovery.actions.find((action) => action.id === 'departure')!.reason!, /pending/);
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
