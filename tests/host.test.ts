import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHost } from '@fctp/server-base';

test('generic host persists named Actor keys and reports inbox worker failures without stopping cycles', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-host-'));
  let failures = 0;
  const workerErrorWaiters = new Map<number, (error: unknown) => void>();
  const workerErrors: unknown[] = [];
  const options = {
    origin: 'http://127.0.0.1:38765',
    storeFile: join(directory, 'host.json'),
    actors: [{ name: 'alpha', role: 'service' }],
    onWorkerError: (failure: unknown) => {
      failures++;
      workerErrors.push(failure);
      const waiter = workerErrorWaiters.get(failures);
      workerErrorWaiters.delete(failures);
      waiter?.(failure);
    }
  };
  const waitForWorkerError = (count: number): Promise<unknown> => {
    if (workerErrors.length >= count) return Promise.resolve(workerErrors[count - 1]);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        workerErrorWaiters.delete(count);
        reject(new Error(`Timed out waiting for worker error ${count}`));
      }, 5000);
      workerErrorWaiters.set(count, (failure) => {
        clearTimeout(timeout);
        resolve(failure);
      });
    });
  };
  let keyId: string;
  try {
    const host = await createHost(options);
    try {
      assert.equal(host.actor('alpha').id, 'http://127.0.0.1:38765/actors/alpha');
      keyId = host.key('alpha').keyPair.id;
      const signedObject = await host.signObject('alpha', { id: 'https://example.test/events/1', type: 'ExitEvent' });
      assert.equal((signedObject.proof as Record<string, unknown>).verificationMethod, keyId);
      const listening = await host.listen();
      const keyResponse = await fetch(`http://127.0.0.1:${listening.port}/keys/alpha`);
      assert.equal(keyResponse.status, 200);
      assert.deepEqual(await keyResponse.json(), host.key('alpha').publicKey);
      assert.equal((await fetch(`http://127.0.0.1:${listening.port}/keys/missing`)).status, 404);
      await host.server.store.transaction((state) => { state.inboxQueue.push({ localActorId: host.actor('alpha').id, activityId: 'bad-1', activity: {}, sender: 'https://remote.example/actor', receivedAt: new Date().toISOString() }); });
      host.startWorkers(5);
      await waitForWorkerError(1);
      const firstItem = await host.server.store.read((state) => state.inboxQueue.find(({ activityId }) => activityId === 'bad-1'));
      assert.ok(firstItem);
      assert.ok(firstItem.nextAttemptAt && firstItem.nextAttemptAt > Date.now());
      await host.server.store.transaction((state) => { state.inboxQueue.push({ localActorId: host.actor('alpha').id, activityId: 'bad-2', activity: {}, sender: 'https://remote.example/actor', receivedAt: new Date().toISOString() }); });
      await waitForWorkerError(2);
      await host.stopWorkers();
      assert.ok(failures >= 2);
      assert.equal(host.workerErrors.at(-1)?.phase, 'inbox');
      const queue = await host.server.store.read((state) => state.inboxQueue);
      const delayedFirstItem = queue.find(({ activityId }) => activityId === 'bad-1');
      assert.ok(delayedFirstItem);
      assert.ok(delayedFirstItem.nextAttemptAt && delayedFirstItem.nextAttemptAt > Date.now());
      assert.ok(queue.some(({ activityId }) => activityId === 'bad-2'));
    } finally {
      await host.close();
    }
    const restarted = await createHost(options);
    try {
      assert.equal(restarted.key('alpha').keyPair.id, keyId);
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
