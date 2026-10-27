import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyKeyAttribution, verifyProofCryptography } from '@fctp/identity';
import { createHost, FctpServer } from '@fctp/server-base';

test('local publications are signed, archived, publicly fetchable and durable without delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-local-publication-'));
  const storeFile = join(directory, 'state.json');
  try {
    const probe = new FctpServer({ storeFile: join(directory, 'probe.json') });
    const probeListening = await probe.listen();
    const origin = `http://127.0.0.1:${probeListening.port}`;
    await probeListening.close();
    const options = { origin, storeFile, keyFile: join(directory, 'keys.json'), actors: [{ name: 'player', role: 'player' }] };
    const host = await createHost(options);
    await host.listen(probeListening.port);
    const actorId = host.actor('player').id;
    const object = { id: `${origin}/objects/creation-1`, type: 'Asset', name: 'local asset', holder: actorId };
    const activityId = `${origin}/activities/creation-1`;
    try {
      await host.server.commit((domain) => { domain.local = true; return 'committed'; }, [], [{ actorId, object, activityId }]);
      const outboxResponse = await fetch(`${actorId}/outbox`);
      assert.equal(outboxResponse.status, 200);
      const outbox = await outboxResponse.json() as { totalItems: number; orderedItems: Array<Record<string, unknown>> };
      assert.equal(outbox.totalItems, 1);
      const activity = outbox.orderedItems[0]!;
      assert.equal(activity.type, 'Create');
      assert.deepEqual(activity.to, []);
      assert.equal(activity.actor, actorId);
      assert.equal((activity.object as Record<string, unknown>).id, object.id);
      assert.equal((await verifyProofCryptography(activity, host.loader)).verified, true);
      assert.equal((await verifyKeyAttribution(activity, host.actor('player'), host.loader)).attributed, true);
      assert.deepEqual(await (await fetch(object.id)).json(), object);
      const state = await host.server.store.read((snapshot) => ({ queued: snapshot.outbox.length, archived: snapshot.outboxArchive.length }));
      assert.deepEqual(state, { queued: 0, archived: 1 });
    } finally {
      await host.close();
    }

    const restarted = await createHost(options);
    const restartedListening = await restarted.listen(probeListening.port);
    try {
      assert.deepEqual(await (await fetch(object.id)).json(), object);
      const outbox = await (await fetch(`${actorId}/outbox`)).json() as { totalItems: number };
      assert.equal(outbox.totalItems, 1);
      assert.equal((await restarted.server.store.read((snapshot) => snapshot.outbox.length)), 0);
    } finally {
      await restarted.close();
      await restartedListening.close().catch(() => undefined);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('publication conflicts roll back and concurrent local publications archive atomically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-local-publication-conflict-'));
  try {
    const probe = new FctpServer({ storeFile: join(directory, 'probe.json') });
    const initial = await probe.listen();
    const origin = `http://127.0.0.1:${initial.port}`;
    await initial.close();
    const host = await createHost({ origin, storeFile: join(directory, 'state.json'), keyFile: join(directory, 'keys.json'), actors: [{ name: 'player', role: 'player' }] });
    const actorId = host.actor('player').id;
    const listening = await host.listen(initial.port);
    try {
      const original = { id: `${origin}/objects/conflict`, type: 'Asset', name: 'first' };
      const activityId = `${origin}/activities/conflict`;
      await host.server.commit(() => undefined, [], [{ actorId, object: original, activityId }]);
      await assert.rejects(host.server.commit((domain) => { domain.rolledBack = true; }, [], [{
        actorId, object: { ...original, name: 'different' }, activityId: `${origin}/activities/conflict-2`
      }]), /Conflicting reuse of outgoing object ID/);
      assert.equal(await host.server.store.read((state) => state.domain.rolledBack), undefined);
      await assert.rejects(host.server.commit((domain) => { domain.activityRolledBack = true; }, [], [{
        actorId, object: { id: `${origin}/objects/activity-conflict`, type: 'Asset' }, activityId
      }]), /Conflicting reuse of outgoing Activity ID/);
      assert.equal(await host.server.store.read((state) => state.domain.activityRolledBack), undefined);

      await Promise.all(Array.from({ length: 4 }, (_, index) => host.server.commit(() => undefined, [], [{
        actorId,
        object: { id: `${origin}/objects/concurrent-${index}`, type: 'Asset', index },
        activityId: `${origin}/activities/concurrent-${index}`
      }])));
      const snapshot = await host.server.store.read((state) => ({ archive: state.outboxArchive.length, queue: state.outbox.length, objects: Object.keys(state.objects).length }));
      assert.deepEqual(snapshot, { archive: 5, queue: 0, objects: 5 });

      await host.server.commit(() => undefined, [{
        actorId, recipientActorId: 'https://remote.test/actors/recipient', inbox: 'https://remote.test/inbox',
        object: { id: `${origin}/objects/outgoing`, type: 'Asset' }, activityId: `${origin}/activities/outgoing`
      }]);
      assert.equal(await host.server.store.read((state) => state.outbox.length), 1);
    } finally {
      await host.close();
      await listening.close().catch(() => undefined);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
