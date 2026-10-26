import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createActivity } from '@fctp/federation';
import { createTokenDigest, deriveDiplomaticToken } from '@fctp/auth';
import { createHost, FctpServer } from '@fctp/server-base';

test('committed request and signed event references are retrieved by absolute URI after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-server-wire-'));
  const storeFile = join(directory, 'state.json');
  try {
    const probe = new FctpServer({ storeFile });
    await probe.open();
    const initialListening = await probe.listen();
    await initialListening.close();
    const origin = `http://127.0.0.1:${initialListening.port}`;
    const actorId = `${origin}/actors/territory`;
    const requestId = `${origin}/objects/request-1`;
    const eventId = `${origin}/objects/event-1`;
    const options = { origin, storeFile, keyFile: join(directory, 'keys.json'), actors: [{ name: 'territory', role: 'territory' }] };
    const host = await createHost(options);
    const signedEvent = await host.signObject('territory', {
      id: eventId, type: 'ExitEvent', vessel: 'https://registry.test/vessels/1', territory: actorId,
      route: 'https://territory.test/routes/1', entryRequest: 'https://territory.test/requests/1',
      cargo: { entries: [] }, effectiveAt: '2026-01-01T00:00:00Z',
    });
    await host.server.store.transaction((state) => { state.objects['request-1'] = { id: 'https://decoy.test/objects/request-1', type: 'Decoy' }; });
    await host.server.commit(() => undefined, [
      { actorId, recipientActorId: 'https://registry.test/actors/registry', inbox: 'https://registry.test/inbox', object: { id: requestId, type: 'EntryRequest', extension: 'preserved' }, activityId: `${origin}/activities/request-1` },
      { actorId, recipientActorId: 'https://registry.test/actors/registry', inbox: 'https://registry.test/inbox', object: signedEvent, activityId: `${origin}/activities/event-1` },
    ]);
    await host.close();
    const restarted = await createHost(options);
    const listening = await restarted.listen(initialListening.port);
    try {
      for (const [id, expectedType] of [[requestId, 'EntryRequest'], [eventId, 'ExitEvent']] as const) {
        const uri = `http://127.0.0.1:${listening.port}/objects/${id.split('/').at(-1)}`;
        const response = await fetch(uri);
        assert.equal(response.status, 200);
        assert.equal((await response.json() as { id: string; type: string }).id, id);
        assert.equal((await (await fetch(uri)).json() as { type: string }).type, expectedType);
      }
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('inbox recognizes structural token declarations without a type field', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-server-token-wire-'));
  const playerId = 'https://home.test/players/alice';
  const homeId = 'https://home.test/actors/home';
  const resourceId = 'https://resource.test/actors/territory';
  const token = await deriveDiplomaticToken(new Uint8Array([1, 2, 3]), resourceId);
  const server = new FctpServer({ storeFile: join(directory, 'state.json'), verifyInbound: async () => ({
    cryptographic: { verified: true }, attribution: { attributed: true, publisher: homeId }, expectedIssuer: { matches: true, expected: homeId, actual: homeId },
  }) });
  try {
    await server.open();
    await server.enrollPlayer(playerId, homeId);
    const declaration = { ...await createTokenDigest(playerId, 1, token), extensionField: 'preserved' };
    const activity = createActivity({ id: 'https://home.test/activities/token', actor: homeId, object: declaration, to: resourceId });
    await server.receive(resourceId, activity);
    assert.equal(await server.processInbox(), 1);
    assert.equal(await server.authenticateDiplomaticToken(resourceId, token), playerId);
    const revoke = createActivity({
      id: 'https://home.test/activities/revoke', actor: homeId,
      object: { actor: playerId, revision: 2, tokenRevoke: 'revoke', extensionField: 'preserved' }, to: resourceId,
    });
    await server.receive(resourceId, revoke);
    assert.equal(await server.processInbox(), 1);
    assert.equal(await server.authenticateDiplomaticToken(resourceId, token), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('protected GET distinguishes invalid credentials from denied resource policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-server-get-wire-'));
  const resourceId = 'https://resource.test/actors/territory';
  const homeId = 'https://home.test/actors/home';
  const playerId = 'https://home.test/players/alice';
  const deniedPlayerId = 'https://home.test/players/bob';
  const server = new FctpServer({ storeFile: join(directory, 'state.json'), authorizeResource: async () => ({ allowed: false }) });
  try {
    await server.open();
    await server.registerActor({ actor: { id: resourceId, role: 'territory', inbox: `${resourceId}/inbox`, outbox: `${resourceId}/outbox`, publicKeys: [] } });
    await server.enrollPlayer(playerId, homeId);
    await server.enrollPlayer(deniedPlayerId, homeId);
    const allowedPolicyToken = await deriveDiplomaticToken(new Uint8Array([4, 5]), resourceId);
    const deniedPolicyToken = await deriveDiplomaticToken(new Uint8Array([6, 7]), resourceId);
    await server.applyTokenDeclaration(resourceId, homeId, await createTokenDigest(playerId, 1, allowedPolicyToken));
    await server.applyTokenDeclaration(resourceId, homeId, await createTokenDigest(deniedPlayerId, 1, deniedPolicyToken));
    const listening = await server.listen();
    try {
      const uri = `http://127.0.0.1:${listening.port}/objects/private`;
      server.registerResource(uri, { value: 'secret' }, { public: false, actorId: resourceId });
      assert.equal((await fetch(uri)).status, 401);
      assert.equal((await fetch(uri, { headers: { Authorization: 'Bearer %%%' } })).status, 401);
      assert.equal((await fetch(uri, { headers: { Authorization: `Bearer ${deniedPolicyToken}` } })).status, 403);
    } finally {
      await listening.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
