import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { readDeploymentConfig, startDeployment } from '../scripts/deployment.mjs';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('authority deployment loads private config and serves persisted account credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-test-'));
  const dataDir = join(directory, 'data');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const secret = 'private-admin-secret';
  const password = 'private-player-password';
  await mkdir(dataDir);
  await writeFile(join(directory, 'admin-secret'), `${secret}\n`);
  await writeFile(join(directory, 'passwords.json'), JSON.stringify({ player: password }));
  await writeFile(join(directory, 'config.json'), JSON.stringify({
    origin, port, listenHost: '127.0.0.1', dataDir: './data',
    adminSecretFile: './admin-secret', playerNames: ['player'],
    vesselNames: { player: 'player-vessel' }, accountPasswordsFile: './passwords.json'
  }));

  let deployment;
  try {
    const config = await readDeploymentConfig('authority', join(directory, 'config.json'));
    assert.equal(config.adminSecret, secret);
    assert.equal(config.dataDir, dataDir);
    deployment = await startDeployment('authority', config);
    const login = await globalThis.fetch(`${origin}/local/home/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: `@player@127.0.0.1:${port}`, password })
    });
    assert.equal(login.status, 200);
    const result = await login.json();
    assert.equal(result.status, 'signed-in');
    assert.equal(result.actorId, `${origin}/actors/player`);
    const token = result.nativeToken;
    await deployment.close();
    deployment = await startDeployment('authority', config);
    const restartedLogin = await globalThis.fetch(`${origin}/local/home/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: `@player@127.0.0.1:${port}`, password })
    });
    assert.equal(restartedLogin.status, 200);
    assert.equal((await restartedLogin.json()).nativeToken, token);
  } finally {
    await deployment?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('deployment config rejects non-origin URLs without exposing config values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-invalid-'));
  const marker = 'secret-that-must-not-appear';
  try {
    await writeFile(join(directory, 'config.json'), JSON.stringify({ origin: 'https://example.test/path', adminSecretFile: marker }));
    await assert.rejects(readDeploymentConfig('authority', join(directory, 'config.json')), (error) => {
      assert.doesNotMatch(error.message, new RegExp(marker));
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('client deployment serves its API and static application from an isolated store', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-client-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  try {
    await writeFile(join(directory, 'client-secret'), 'client-admin-secret');
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      origin, port, listenHost: '127.0.0.1', dataDir: './client-data',
      seedServers: ['https://authority.example.org'],
      administratorBindings: [{ accountId: '@governor@authority.example.org', authorityActorIds: ['https://authority.example.org/actors/registry'], credentialSource: 'authority' }],
      administratorCredentialFiles: { authority: './client-secret' }
    }));
    const config = await readDeploymentConfig('client', join(directory, 'config.json'));
    assert.equal(config.administratorCredentials.authority, 'client-admin-secret');
    const deployment = await startDeployment('client', config);
    try {
      const health = await globalThis.fetch(`${origin}/api/health`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: 'ok' });
      const page = await globalThis.fetch(origin);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<html/i);
      assert.deepEqual(deployment.application.seedServers, ['https://authority.example.org']);
    } finally {
      await deployment.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('territory deployments preserve peer defaults and do not automatically tick simulation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-territories-'));
  const policyPort = await freePort();
  const simulationPort = await freePort();
  const authorityOrigin = 'https://authority.example.org';
  const policyOrigin = `http://127.0.0.1:${policyPort}`;
  const simulationOrigin = `http://127.0.0.1:${simulationPort}`;
  let policy;
  let simulation;
  try {
    await writeFile(join(directory, 'admin-secret'), 'territory-admin');
    const shared = { listenHost: '127.0.0.1', workerIntervalMs: 5, dataDir: './policy-data', adminSecretFile: './admin-secret', authorityOrigin, playerNames: ['player'] };
    await writeFile(join(directory, 'policy.json'), JSON.stringify({ ...shared, origin: policyOrigin, port: policyPort, peerOrigin: simulationOrigin }));
    await writeFile(join(directory, 'simulation.json'), JSON.stringify({ ...shared, dataDir: './simulation-data', origin: simulationOrigin, port: simulationPort, peerOrigin: policyOrigin }));
    const policyConfig = await readDeploymentConfig('policy', join(directory, 'policy.json'));
    const simulationConfig = await readDeploymentConfig('simulation', join(directory, 'simulation.json'));
    policy = await startDeployment('policy', policyConfig);
    simulation = await startDeployment('simulation', simulationConfig);

    const policyInfoResponse = await globalThis.fetch(`${policyOrigin}/local/info`);
    assert.equal(policyInfoResponse.status, 200);
    const policyInfo = await policyInfoResponse.json();
    assert.equal(policyInfo.actor, `${policyOrigin}/actors/territory`);
    const policyStateResponse = await globalThis.fetch(`${policyOrigin}/local/state`, { headers: { authorization: 'Bearer territory-admin' } });
    const policyState = await policyStateResponse.json();
    assert.deepEqual(policyState.admission.registryAcceptance, [`${authorityOrigin}/actors/registry`]);
    assert.deepEqual(policyState.admission.territoryAcceptance, [`${simulationOrigin}/actors/territory`]);

    const simulationStateUrl = `${simulationOrigin}/local/state`;
    const readSimulation = async () => (await globalThis.fetch(simulationStateUrl, { headers: { authorization: 'Bearer territory-admin' } })).json();
    assert.equal((await readSimulation()).simulation.tick, 0);
    await delay(30);
    assert.equal((await readSimulation()).simulation.tick, 0);
    assert.notEqual(policyConfig.dataDir, simulationConfig.dataDir);
  } finally {
    await simulation?.close();
    await policy?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
