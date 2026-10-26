import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createActivity } from '@fctp/federation';
import { createLocalDocumentLoader, generateActorKey, signJsonLd, withDocuments } from '@fctp/identity';
import { createInboundVerifier } from '@fctp/server-base';
import { createAuthority } from '../apps/test-authority/src/bootstrap.js';
import { installRegistry } from '../apps/test-authority/src/registry.js';

test('Registry persists exact issued request handling, adoption deltas, and rejects forged or impossible events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-registry-'));
  const authorityOrigin = `http://127.0.0.1:${await availablePort()}`;
  const territory = 'https://territory.test/actors/blue';
  const territoryKey = await generateActorKey(territory);
  const resources = new Map<string, unknown>([[territory, { id: territory, role: 'territory', inbox: `${territory}/inbox`, outbox: `${territory}/outbox`, publicKeys: [String(territoryKey.publicKey.id)] }], [String(territoryKey.publicKey.id), territoryKey.publicKey]]);
  const fetcher: typeof fetch = async (input) => resources.has(String(input)) ? Response.json(resources.get(String(input))) : new Response(null, { status: 404 });
  let registry: ReturnType<typeof installRegistry> | undefined;
  const verifier = createInboundVerifier({ fetcher, resolveExpectedIssuer: async (_localActorId, senderActorId, activity) => registry?.resolveExpectedIssuer(senderActorId, activity.object as Record<string, unknown>) });
  let authority: Awaited<ReturnType<typeof createAuthority>> | undefined;
  try {
  authority = await createAuthority({ origin: authorityOrigin, storeFile: join(directory, 'registry.json'), fetcher, verifyInbound: verifier });
  registry = installRegistry(authority, { fetcher, route: async () => ({ actor: territory, inbox: `${territory}/inbox` }), initialCargo: { entries: [{ variety: 'https://goods.test/ore', count: 5, data: { grade: 'A' } }] } });
  const entry = await registry.sendEntry({ territory, port: 'https://territory.test/ports/1', route: 'https://territory.test/routes/1' });
  const loader = withDocuments(createLocalDocumentLoader(), new Map([[String(territoryKey.publicKey.id), territoryKey.publicKey]]));
  const deliver = async (id: string, object: Record<string, unknown>) => {
    const activity = await signJsonLd(createActivity({ id: `${id}/activity`, actor: territory, object, to: authority!.actor('registry').id }) as unknown as Record<string, unknown>, territoryKey.keyPair, loader);
    await authority!.server.receive(authority!.actor('registry').id, activity as never);
    await authority!.server.processInbox();
  };
  const cargoEvent = (id: string, operation: 'load' | 'unload', count: number, variety = 'https://goods.test/ore') => ({ id, type: 'CargoOperationEvent', vessel: entry.vessel.id, territory, port: 'https://territory.test/ports/1', operation, cargo: { entries: [{ variety, count, data: { grade: 'A' } }] }, effectiveAt: '2026-01-01T00:00:00Z' });
  await deliver('https://territory.test/events/nonadopted', cargoEvent('https://territory.test/events/nonadopted', 'unload', 2));
  assert.equal(((await registry.state()).cargo!.entries[0] as { count: number }).count, 5);
  await registry.switchAdoption(true);
  await deliver('https://territory.test/events/load', cargoEvent('https://territory.test/events/load', 'load', 3));
  await deliver('https://territory.test/events/impossible', cargoEvent('https://territory.test/events/impossible', 'unload', 99));
  let state = await registry.state();
  assert.equal((state.cargo!.entries[0] as { count: number }).count, 8);
  assert.equal(state.events.some((event) => event.id.endsWith('/impossible')), false);
  await deliver('https://territory.test/events/forged', { ...cargoEvent('https://territory.test/events/forged', 'load', 1), vessel: 'https://registry.test/vessels/forged' });
  assert.equal((await registry.state()).events.some((event) => event.id.endsWith('/forged')), false);
  await authority.close();
  authority = undefined;
  authority = await createAuthority({ origin: authorityOrigin, storeFile: join(directory, 'registry.json'), fetcher, verifyInbound: verifier });
  registry = installRegistry(authority, { fetcher });
  state = await registry.state();
  assert.equal(state.events.length, 2);
  assert.equal((state.cargo!.entries[0] as { count: number }).count, 8);
  } finally {
    if (authority) await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('EntryRejected issuer is the exact issued destination and does not require a vessel field', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-registry-rejection-'));
  let authority: Awaited<ReturnType<typeof createAuthority>> | undefined;
  try {
    authority = await createAuthority({ origin: 'http://registry.test', storeFile: join(directory, 'registry.json') });
    const registry = installRegistry(authority, { route: async () => ({ actor: 'https://territory.test/actors/blue', inbox: 'https://territory.test/inbox' }) });
    const request = await registry.sendEntry({ territory: 'https://territory.test/actors/blue', port: 'https://territory.test/ports/1', route: 'https://territory.test/routes/1' });
    assert.equal(await registry.resolveExpectedIssuer('https://territory.test/actors/blue', { type: 'EntryRejected', territory: 'https://territory.test/actors/blue', request: request.id }), 'https://territory.test/actors/blue');
    assert.equal(await registry.resolveExpectedIssuer('https://registry.test/actors/registry', { type: 'EntryRejected', territory: 'https://territory.test/actors/blue', request: request.id }), undefined);
  } finally {
    if (authority) await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
