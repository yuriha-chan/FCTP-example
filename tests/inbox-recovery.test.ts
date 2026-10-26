import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTokenDigest } from '@fctp/auth';
import { createActivity } from '@fctp/federation';
import { FctpServer } from '@fctp/server-base';

const local = 'https://local.example/actors/one';
const sender = 'https://remote.example/actors/one';

test('invalid token declaration is quarantined without blocking later work; handler failure retries after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-inbox-recovery-'));
  const storeFile = join(directory, 'state.json');
  const verifier = async () => ({ cryptographic: { verified: true }, attribution: { attributed: true }, expectedIssuer: { matches: true } });
  try {
    let server = new FctpServer({ storeFile, verifyInbound: verifier });
    await server.open();
    await server.registerActor({ actor: { id: local, type: 'Service', role: 'territory', inbox: `${local}/inbox`, outbox: `${local}/outbox`, publicKeys: [] } });
    await server.enrollPlayer('https://remote.example/players/alice', sender);
    const invalid = createActivity({ id: 'https://remote.example/activities/invalid', actor: sender, object: { type: 'TokenDigest', tokenDigest: 'bad' }, to: local });
    const declaration = await createTokenDigest('https://remote.example/players/alice', 1, 'dG9rZW4');
    const valid = createActivity({ id: 'https://remote.example/activities/valid', actor: sender, object: declaration, to: local });
    const failing = createActivity({ id: 'https://remote.example/activities/failing', actor: sender, object: { id: 'https://remote.example/objects/failing', type: 'Example' }, to: local });
    await server.receive(local, invalid);
    await server.receive(local, valid);
    await server.receive(local, failing);
    let firstFailure = true;
    server.on(local, 'Example', async (context) => {
      await context.store.transaction((state) => {
        if (state.domain.committed) return;
        state.domain.committed = true;
        state.outboxArchive.push({ actorId: local, activity: { id: 'https://local.example/activities/committed' } });
      });
      if (firstFailure) { firstFailure = false; throw new Error('handler interrupted'); }
    });
    await assert.rejects(server.processInbox(), /Inbox processing failed/);
    const queued = await server.store.read((state) => state.inboxQueue);
    const rejected = await server.store.read((state) => state.inboxRejected);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.activityId, failing.id);
    assert.equal(queued[0]?.attempts, 1);
    assert.match(queued[0]?.diagnostic ?? '', /handler interrupted/);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.activityId, invalid.id);
    assert.equal(rejected[0]?.objectId, undefined);
    assert.deepEqual(rejected[0]?.activity, structuredClone(invalid));
    assert.equal((await server.store.read((state) => state.credentials[`${local}\u0000https://remote.example/players/alice`])) !== undefined, true);
    await server.store.transaction((state) => { state.inboxQueue[0]!.nextAttemptAt = 0; });
    server = new FctpServer({ storeFile, verifyInbound: verifier });
    await server.open();
    let handled = 0;
    server.on(local, 'Example', async (context) => {
      handled++;
      assert.equal((await context.store.read((state) => state.domain.committed)), true);
    });
    assert.equal(await server.processInbox(), 1);
    assert.equal(handled, 1);
    assert.equal(await server.store.read((state) => state.outboxArchive.length), 1);
    const recoveredRejection = await server.store.read((state) => state.inboxRejected[0]);
    assert.deepEqual(recoveredRejection?.activity, structuredClone(invalid));
    await server.receive(local, invalid);
    assert.equal(await server.processInbox(), 0);
    assert.equal(await server.store.read((state) => state.inboxRejected.length), 1);
    assert.equal(await server.store.read((state) => state.inboxQueue.length), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('verification errors are observable and receive bounded delayed retry diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-inbox-retry-'));
  try {
    const server = new FctpServer({ storeFile: join(directory, 'state.json'), verifyInbound: async () => { throw new Error('key unavailable'); } });
    await server.open();
    await server.receive(local, createActivity({ id: 'https://remote.example/activities/retry', actor: sender, object: { type: 'Example' }, to: local }));
    await assert.rejects(server.processInbox(), (error: unknown) => error instanceof AggregateError && error.errors.some((failure) => failure instanceof Error && failure.message === 'key unavailable'));
    const item = await server.store.read((state) => state.inboxQueue[0]);
    assert.equal(item?.attempts, 1);
    assert.equal(item?.diagnostic, 'key unavailable');
    assert.ok((item?.nextAttemptAt ?? 0) > Date.now());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
