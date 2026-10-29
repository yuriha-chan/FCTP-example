import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AccountRecord, ActionRecord, AuthorityRecord, ServerRecord, SourcedObservation } from '@fctp/client-sdk';
import { createClientApplication } from '../apps/client-server/src/app.js';
import { startClientServer } from '../apps/demo/src/client-server.js';

test('serves the existing browser client and public config on an isolated port', async () => {
  const config = {
    origins: { authority: 'http://authority.example', policy: 'http://policy.example', simulation: 'http://simulation.example' },
    actors: { registry: 'https://authority.example/registry', home: 'https://authority.example/home', player: 'https://authority.example/player', policy: 'https://policy.example/actor', simulation: 'https://simulation.example/actor' }
  };
  const client = await startClientServer({ port: 0, config });
  try {
    const html = await fetch(client.origin);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /href=["']\/styles\.css["']/);
    const stylesheet = await fetch(new URL('/styles.css', client.origin));
    assert.equal(stylesheet.status, 200);
    assert.ok((await stylesheet.text()).length > 0);
    const bundle = await fetch(new URL('/dist/client/main.js', client.origin));
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type') ?? '', /javascript/);
    assert.ok((await bundle.text()).length > 0);
    const configResponse = await fetch(new URL('/config.json', client.origin));
    assert.equal(configResponse.status, 200);
    assert.equal(configResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await configResponse.json(), config);
    assert.equal((await fetch(new URL('/package.json', client.origin))).status, 404);
    assert.equal((await fetch(new URL('/../../package.json', client.origin))).status, 404);
  } finally {
    await client.close();
  }
  await assert.rejects(fetch(new URL('/config.json', client.origin)));
});

const firstAccount: AccountRecord = {
  id: 'account:first',
  handle: '@sana@first.test:4200',
  homeServer: 'first.test:4200',
  actorId: 'https://first.test:4200/actors/sana',
  homeAuthority: 'https://first.test:4200/actors/home',
  login: { status: 'signed-in', homeServer: 'first.test:4200', nativeToken: 'first-native-token' }
};

const secondAccount: AccountRecord = {
  id: 'account:second',
  handle: '@orla@second.test:4200',
  homeServer: 'second.test:4200',
  actorId: 'https://second.test:4200/actors/orla',
  homeAuthority: 'https://second.test:4200/actors/home',
  login: { status: 'signed-in', homeServer: 'second.test:4200', nativeToken: 'second-native-token' }
};

const serverRecord: ServerRecord = {
  server: 'harbor.test:4200',
  origin: 'https://harbor.test:4200',
  authorities: ['https://harbor.test:4200/actors/registry']
};

const authorityRecord: AuthorityRecord = {
  handle: '@harbor.registry@harbor.test:4200',
  actorId: 'https://harbor.test:4200/actors/registry',
  server: 'harbor.test:4200',
  roles: ['registry']
};

const observationRecord: SourcedObservation<unknown> = {
  state: 'available',
  source: 'https://harbor.test:4200/local/registry/state',
  observedAt: '2026-10-29T12:00:00Z',
  value: { entries: [] }
};

const actionRecord: ActionRecord = {
  id: 'action:1',
  statusUrl: '/api/activity/action:1',
  accountId: firstAccount.id,
  targetId: authorityRecord.actorId,
  resultReferences: [{ kind: 'job', id: 'job:1' }],
  intent: { kind: 'mine', inputs: { count: 1 } },
  submittedAt: '2026-10-29T12:00:00Z',
  submission: { status: 'accepted', result: 'job:1' },
  outcome: { status: 'pending', evidence: [] }
};

test('client application retains concurrent account transactions and persists them after recreation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-application-'));
  const storeFile = join(directory, 'client.store.json');
  let application = await createClientApplication({ storeFile });
  try {
    await Promise.all([
      application.state.transaction(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        state.accounts[firstAccount.id] = firstAccount;
      }),
      application.state.transaction((state) => {
        state.accounts[secondAccount.id] = secondAccount;
      })
    ]);
    const concurrent = await application.state.read((state) => state.accounts);
    assert.deepEqual(Object.keys(concurrent).sort(), [firstAccount.id, secondAccount.id].sort());
    assert.equal(concurrent[firstAccount.id]?.login.status, 'signed-in');
    assert.equal(concurrent[secondAccount.id]?.login.status, 'signed-in');

    await application.close();
    application = await createClientApplication({ storeFile });
    const reopened = await application.state.read((state) => state.accounts);
    assert.deepEqual(Object.keys(reopened).sort(), [firstAccount.id, secondAccount.id].sort());
    assert.deepEqual(reopened[firstAccount.id], firstAccount);
    assert.deepEqual(reopened[secondAccount.id], secondAccount);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('client application persists every client collection after recreation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-collections-'));
  const storeFile = join(directory, 'client.store.json');
  let application = await createClientApplication({ storeFile });
  const draft = { id: 'draft:1', title: 'Harbor notes' };
  const routePlan = { id: 'route-plan:1', routeId: 'https://harbor.test:4200/routes/approach' };
  const followedRequest = { id: 'request:1', accountId: firstAccount.id };
  const followedJob = { id: 'job:1', accountId: secondAccount.id };
  try {
    await application.state.transaction((state) => {
      state.servers[serverRecord.server] = serverRecord;
      state.authorities[authorityRecord.actorId] = authorityRecord;
      state.accounts[firstAccount.id] = firstAccount;
      state.observations['observation:registry'] = observationRecord;
      state.drafts[draft.id] = draft;
      state.routePlans[routePlan.id] = routePlan;
      state.actions[actionRecord.id] = actionRecord;
      state.followedRequests[followedRequest.id] = followedRequest;
      state.followedJobs[followedJob.id] = followedJob;
    });
    await application.close();
    application = await createClientApplication({ storeFile });
    const clientState = await application.state.read((state) => state);
    assert.deepEqual(clientState.servers[serverRecord.server], serverRecord);
    assert.deepEqual(clientState.authorities[authorityRecord.actorId], authorityRecord);
    assert.deepEqual(clientState.accounts[firstAccount.id], firstAccount);
    assert.deepEqual(clientState.observations['observation:registry'], observationRecord);
    assert.deepEqual(clientState.drafts[draft.id], draft);
    assert.deepEqual(clientState.routePlans[routePlan.id], routePlan);
    assert.deepEqual(clientState.actions[actionRecord.id], actionRecord);
    assert.deepEqual(clientState.followedRequests[followedRequest.id], followedRequest);
    assert.deepEqual(clientState.followedJobs[followedJob.id], followedJob);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('supplied server seeds do not become discovered records and reopen preserves discovered servers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-seeds-'));
  const storeFile = join(directory, 'client.store.json');
  const seedServers = ['http://127.0.0.1:4100', 'https://world.example:4200'];
  let application = await createClientApplication({ storeFile, seedServers });
  try {
    const seeded = await application.state.read((state) => state.servers);
    assert.deepEqual(seeded, {});
    await application.state.transaction((state) => {
      state.servers[serverRecord.server] = serverRecord;
    });
    await application.close();
    application = await createClientApplication({ storeFile, seedServers });
    const reopened = await application.state.read((state) => state.servers);
    assert.deepEqual(Object.keys(reopened), [serverRecord.server]);
    assert.deepEqual(reopened[serverRecord.server], serverRecord);
    assert.equal(JSON.stringify(reopened).includes(seedServers[0]!), false);
    assert.equal(JSON.stringify(reopened).includes(seedServers[1]!), false);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('client server exposes a credential-free health API beside static assets on the same origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-health-'));
  const storeFile = join(directory, 'client.store.json');
  const seedOrigin = 'https://seeded-world.example:4300';
  const application = await createClientApplication({ storeFile, seedServers: [seedOrigin] });
  const config = {
    origins: { authority: 'http://authority.example', policy: 'http://policy.example', simulation: 'http://simulation.example' },
    actors: { registry: 'https://authority.example/registry', home: 'https://authority.example/home', player: 'https://authority.example/player', policy: 'https://policy.example/actor', simulation: 'https://simulation.example/actor' }
  };
  const client = await startClientServer({ port: 0, config, application });
  try {
    await application.state.transaction((state) => {
      state.accounts[firstAccount.id] = firstAccount;
    });
    const healthResponse = await fetch(new URL('/api/health', client.origin));
    assert.equal(healthResponse.status, 200);
    assert.match(healthResponse.headers.get('content-type') ?? '', /application\/json/);
    const healthBody = await healthResponse.text();
    const health = JSON.parse(healthBody) as Record<string, unknown>;
    assert.equal(typeof health, 'object');
    for (const secret of [seedOrigin, firstAccount.id, firstAccount.handle, 'first-native-token']) {
      assert.equal(healthBody.includes(secret), false, secret);
    }

    const html = await fetch(client.origin);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /href=["']\/styles\.css["']/);
    assert.equal((await fetch(new URL('/styles.css', client.origin))).status, 200);
    const configResponse = await fetch(new URL('/config.json', client.origin));
    assert.equal(configResponse.status, 200);
    assert.deepEqual(await configResponse.json(), config);

    assert.equal((await fetch(new URL('/api/unknown', client.origin))).status, 404);
    assert.equal((await fetch(new URL('/styles.css', client.origin), { method: 'POST' })).status, 405);
  } finally {
    await client.close();
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
