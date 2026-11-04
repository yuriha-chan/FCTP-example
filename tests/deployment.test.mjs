import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
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

const NODEINFO_SCHEMA = 'http://nodeinfo.diaspora.software/ns/schema/2.1';

async function readNodeInfo(origin) {
  const wellKnownResponse = await globalThis.fetch(`${origin}/.well-known/nodeinfo`);
  assert.equal(wellKnownResponse.status, 200);
  const wellKnown = await wellKnownResponse.json();
  const link = wellKnown.links.find((entry) => entry.rel === NODEINFO_SCHEMA);
  assert.ok(link, 'NodeInfo discovery advertises schema 2.1');
  const response = await globalThis.fetch(link.href);
  assert.equal(response.status, 200);
  return response.json();
}

async function readHomeIdentity(origin) {
  const response = await globalThis.fetch(`${origin}/actors/home`);
  assert.equal(response.status, 200);
  const actor = await response.json();
  assert.ok(Array.isArray(actor.publicKeys) && actor.publicKeys.length > 0, 'the Home Actor publishes its persisted key');
  const keyResponse = await globalThis.fetch(actor.publicKeys[0]);
  assert.equal(keyResponse.status, 200);
  const key = await keyResponse.json();
  return {
    id: actor.id,
    role: actor.role,
    webfinger: actor.webfinger,
    publicKeys: actor.publicKeys,
    keyId: key.id,
    keyValue: key.publicKeyMultibase
  };
}

async function assertHomeAdvertisement(origin, homeAccountName) {
  const host = new globalThis.URL(origin).host;
  const identity = await readHomeIdentity(origin);
  assert.equal(identity.id, `${origin}/actors/home`);
  assert.equal(identity.role, 'home');
  assert.equal(identity.webfinger, `${homeAccountName}@${host}`);

  const endpoint = new globalThis.URL('/.well-known/webfinger', origin);
  endpoint.searchParams.set('resource', `acct:${homeAccountName}@${host}`);
  const response = await globalThis.fetch(endpoint);
  assert.equal(response.status, 200);
  const jrd = await response.json();
  assert.equal(jrd.subject, `acct:${homeAccountName}@${host}`);
  const self = jrd.links.filter((link) => link.rel === 'self');
  assert.equal(self.length, 1, 'the Home WebFinger document has exactly one self link');
  assert.equal(new globalThis.URL(self[0].href).href, `${origin}/actors/home`);
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

test('authority deployment defaults the Home account name in config, NodeInfo, and WebFinger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-home-default-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let deployment;
  try {
    await writeFile(join(directory, 'admin-secret'), 'home-default-admin-secret\n');
    await writeFile(join(directory, 'passwords.json'), JSON.stringify({ player: 'player-password' }));
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      origin, port, listenHost: '127.0.0.1', dataDir: './data',
      adminSecretFile: './admin-secret', playerNames: ['player'],
      vesselNames: { player: 'player-vessel' }, accountPasswordsFile: './passwords.json'
    }));
    const config = await readDeploymentConfig('authority', join(directory, 'config.json'));
    assert.equal(config.homeAccountName, 'system.home');
    assert.equal(config.registryAccountName, 'system.registry');
    assert.equal(config.serverDisplayName, new globalThis.URL(origin).host);
    assert.equal(config.homeDisplayName, `${new globalThis.URL(origin).host} Home`);
    assert.equal(config.registryDisplayName, `${new globalThis.URL(origin).host} Registry`);
    deployment = await startDeployment('authority', config);
    const nodeInfo = await readNodeInfo(origin);
    assert.equal(nodeInfo.metadata.homeAccountName, 'system.home');
    await assertHomeAdvertisement(origin, 'system.home');
  } finally {
    await deployment?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority deployment preserves a configured Home account name and Actor identity across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-home-restart-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let deployment;
  try {
    await writeFile(join(directory, 'admin-secret'), 'home-restart-admin-secret\n');
    await writeFile(join(directory, 'passwords.json'), JSON.stringify({ player: 'player-password' }));
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      origin, port, listenHost: '127.0.0.1', dataDir: './data',
      adminSecretFile: './admin-secret', playerNames: ['player'],
      vesselNames: { player: 'player-vessel' }, accountPasswordsFile: './passwords.json',
      homeAccountName: 'academy.home'
    }));
    const config = await readDeploymentConfig('authority', join(directory, 'config.json'));
    assert.equal(config.homeAccountName, 'academy.home');

    deployment = await startDeployment('authority', config);
    const before = await readHomeIdentity(origin);
    assert.equal((await readNodeInfo(origin)).metadata.homeAccountName, 'academy.home');
    await assertHomeAdvertisement(origin, 'academy.home');
    await deployment.close();
    deployment = undefined;

    deployment = await startDeployment('authority', config);
    assert.equal((await readNodeInfo(origin)).metadata.homeAccountName, 'academy.home');
    const after = await readHomeIdentity(origin);
    assert.equal(after.id, `${origin}/actors/home`);
    assert.deepEqual(after, before);
    await assertHomeAdvertisement(origin, 'academy.home');
  } finally {
    await deployment?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority deployment config rejects invalid registry account and display names before startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-identity-invalid-'));
  try {
    await writeFile(join(directory, 'admin-secret'), 'identity-invalid-admin-secret\n');
    await writeFile(join(directory, 'passwords.json'), JSON.stringify({ player: 'player-password' }));
    const base = {
      origin: 'https://authority.example.org', listenHost: '127.0.0.1', port: 8080, dataDir: './data',
      adminSecretFile: './admin-secret', playerNames: ['player'],
      vesselNames: { player: 'player-vessel' }, accountPasswordsFile: './passwords.json'
    };
    for (const override of [
      { registryAccountName: 'system' },
      { serverDisplayName: '   ' },
      { homeDisplayName: '' },
      { registryDisplayName: '  ' }
    ]) {
      await writeFile(join(directory, 'config.json'), JSON.stringify({ ...base, ...override }));
      await assert.rejects(readDeploymentConfig('authority', join(directory, 'config.json')), TypeError);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('territory deployment config rejects invalid territory account and display names before startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-territory-identity-invalid-'));
  try {
    await writeFile(join(directory, 'admin-secret'), 'territory-identity-invalid-admin-secret\n');
    const base = {
      origin: 'https://west.example.org', listenHost: '127.0.0.1', port: 8080, dataDir: './data',
      adminSecretFile: './admin-secret', peerOrigin: 'https://simulation.example.org'
    };
    for (const override of [
      { territoryAccountName: 'system' },
      { serverDisplayName: '   ' },
      { territoryDisplayName: '' }
    ]) {
      await writeFile(join(directory, 'config.json'), JSON.stringify({ ...base, ...override }));
      await assert.rejects(readDeploymentConfig('policy', join(directory, 'config.json')), TypeError);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority deployment config rejects invalid Home account names before startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-home-invalid-'));
  try {
    await writeFile(join(directory, 'admin-secret'), 'home-invalid-admin-secret\n');
    await writeFile(join(directory, 'passwords.json'), JSON.stringify({ player: 'player-password' }));
    const base = {
      origin: 'https://authority.example.org', listenHost: '127.0.0.1', port: 8080, dataDir: './data',
      adminSecretFile: './admin-secret', playerNames: ['player'],
      vesselNames: { player: 'player-vessel' }, accountPasswordsFile: './passwords.json'
    };
    for (const homeAccountName of ['system', '@system.home', 'system.home@authority.example.org', 'system_home']) {
      await writeFile(join(directory, 'config.json'), JSON.stringify({ ...base, homeAccountName }));
      await assert.rejects(readDeploymentConfig('authority', join(directory, 'config.json')), TypeError);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority deployment config reads object storage credentials from secret files before startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-object-storage-'));
  try {
    await mkdir(join(directory, 'secrets'));
    await writeFile(join(directory, 'admin-secret'), 'object-storage-admin-secret\n');
    await writeFile(join(directory, 'passwords.json'), JSON.stringify({ player: 'player-password' }));
    await writeFile(join(directory, 'secrets', 's3-access-key'), 'object-storage-access-key\n');
    await writeFile(join(directory, 'secrets', 's3-secret-key'), 'object-storage-secret-key\n');
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      origin: 'https://authority.example.org', listenHost: '127.0.0.1', port: 8080, dataDir: './data',
      adminSecretFile: './admin-secret', playerNames: ['player'],
      vesselNames: { player: 'player-vessel' }, accountPasswordsFile: './passwords.json',
      objectStorage: {
        endpoint: 'http://rustfs:9000', region: 'us-east-1', bucket: 'image-bucket',
        accessKeyIdFile: './secrets/s3-access-key', secretAccessKeyFile: './secrets/s3-secret-key',
        forcePathStyle: false
      }
    }));
    const config = await readDeploymentConfig('authority', join(directory, 'config.json'));
    assert.deepEqual(config.objectStorage, {
      endpoint: 'http://rustfs:9000', region: 'us-east-1', bucket: 'image-bucket',
      accessKeyId: 'object-storage-access-key', secretAccessKey: 'object-storage-secret-key',
      forcePathStyle: false
    });
    await assert.rejects(stat(join(directory, 'data')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority deployment config omits object storage for text-only authoring', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-object-storage-omitted-'));
  try {
    await writeFile(join(directory, 'admin-secret'), 'text-only-admin-secret\n');
    await writeFile(join(directory, 'passwords.json'), JSON.stringify({ player: 'player-password' }));
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      origin: 'https://authority.example.org', dataDir: './data',
      adminSecretFile: './admin-secret', playerNames: ['player'],
      vesselNames: { player: 'player-vessel' }, accountPasswordsFile: './passwords.json'
    }));
    const config = await readDeploymentConfig('authority', join(directory, 'config.json'));
    assert.equal(config.objectStorage, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority deployment config rejects malformed object storage before startup writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-object-storage-invalid-'));
  const marker = 'secret-marker-that-must-not-appear';
  try {
    await writeFile(join(directory, 'admin-secret'), 'invalid-object-storage-admin-secret\n');
    await writeFile(join(directory, 'passwords.json'), JSON.stringify({ player: 'player-password' }));
    await writeFile(join(directory, 's3-access-key'), 'object-storage-access-key\n');
    await writeFile(join(directory, 's3-secret-key'), 'object-storage-secret-key\n');
    await writeFile(join(directory, 'empty-secret'), '');
    const base = {
      origin: 'https://authority.example.org', dataDir: './data',
      adminSecretFile: './admin-secret', playerNames: ['player'],
      vesselNames: { player: 'player-vessel' }, accountPasswordsFile: './passwords.json'
    };
    const valid = {
      endpoint: 'https://objects.example.test', region: 'us-east-1', bucket: 'image-bucket',
      accessKeyIdFile: './s3-access-key', secretAccessKeyFile: './s3-secret-key'
    };
    for (const override of [
      { endpoint: 'objects.example.test' },
      { endpoint: '/objects' },
      { endpoint: 'ftp://objects.example.test' },
      { endpoint: `https://${marker}:${marker}@objects.example.test` },
      { endpoint: 'https://objects.example.test?policy=public' },
      { endpoint: 'https://objects.example.test#fragment' },
      { region: '' },
      { bucket: '' },
      { accessKeyIdFile: '' },
      { secretAccessKeyFile: '' },
      { accessKeyIdFile: './missing-access-key' },
      { secretAccessKeyFile: './empty-secret' },
      { forcePathStyle: 'yes' }
    ]) {
      await writeFile(join(directory, 'config.json'), JSON.stringify({ ...base, objectStorage: { ...valid, ...override } }));
      await assert.rejects(readDeploymentConfig('authority', join(directory, 'config.json')), (error) => {
        assert.equal(error instanceof TypeError, true);
        assert.equal(error.message.includes(marker), false);
        return true;
      });
      await assert.rejects(stat(join(directory, 'data')), { code: 'ENOENT' });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority deployment accepts partial vessel preallocation and retained starting ports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-initial-vessels-'));
  const startingPorts = ['https://west.example.org/objects/ports/east', 'https://west.example.org/objects/ports/west'];
  try {
    await writeFile(join(directory, 'admin-secret'), 'initial-admin-secret\n');
    await writeFile(join(directory, 'passwords.json'), JSON.stringify({ alice: 'alice-password', bob: 'bob-password' }));
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      origin: 'https://authority.example.org', dataDir: './data',
      adminSecretFile: './admin-secret', playerNames: ['alice', 'bob'],
      vesselNames: { alice: 'alice-vessel' }, startingPorts,
      accountPasswordsFile: './passwords.json'
    }));
    const config = await readDeploymentConfig('authority', join(directory, 'config.json'));
    assert.deepEqual(config.startingPorts, startingPorts);
    assert.deepEqual(config.vesselNames, { alice: 'alice-vessel' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority deployment accepts explicitly empty vessel preallocation and defaults starting ports to empty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-empty-vessels-'));
  try {
    await writeFile(join(directory, 'admin-secret'), 'empty-admin-secret\n');
    await writeFile(join(directory, 'passwords.json'), JSON.stringify({ alice: 'alice-password' }));
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      origin: 'https://authority.example.org', dataDir: './data',
      adminSecretFile: './admin-secret', playerNames: ['alice'],
      vesselNames: {}, accountPasswordsFile: './passwords.json'
    }));
    const config = await readDeploymentConfig('authority', join(directory, 'config.json'));
    assert.deepEqual(config.vesselNames, {});
    assert.deepEqual(config.startingPorts, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority deployment rejects invalid starting ports before startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-invalid-ports-'));
  try {
    await writeFile(join(directory, 'admin-secret'), 'ports-admin-secret\n');
    await writeFile(join(directory, 'passwords.json'), JSON.stringify({ alice: 'alice-password' }));
    const base = {
      origin: 'https://authority.example.org', dataDir: './data',
      adminSecretFile: './admin-secret', playerNames: ['alice'],
      vesselNames: { alice: 'alice-vessel' }, accountPasswordsFile: './passwords.json'
    };
    for (const startingPorts of ['https://west.example.org/objects/ports/east', [42], ['not a uri']]) {
      await writeFile(join(directory, 'config.json'), JSON.stringify({ ...base, startingPorts }));
      await assert.rejects(readDeploymentConfig('authority', join(directory, 'config.json')), TypeError);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('deployment config carries the configured administrator for Authority and Territories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-administrator-'));
  const handle = '@governor@authority.example.org';
  try {
    await writeFile(join(directory, 'admin-secret'), 'private-admin-secret\n');
    await writeFile(join(directory, 'passwords.json'), JSON.stringify({ player: 'player-password', governor: 'governor-password' }));
    await writeFile(join(directory, 'authority.json'), JSON.stringify({
      origin: 'https://authority.example.org', dataDir: './authority-data',
      adminSecretFile: './admin-secret', playerNames: ['player'], administratorNames: ['governor'], administrator: handle,
      vesselNames: { player: 'player-vessel' }, accountPasswordsFile: './passwords.json'
    }));
    await writeFile(join(directory, 'policy.json'), JSON.stringify({
      origin: 'https://west.example.org', dataDir: './policy-data', adminSecretFile: './admin-secret',
      peerOrigin: 'https://simulation.example.org',
      administrator: handle
    }));
    await writeFile(join(directory, 'simulation.json'), JSON.stringify({
      origin: 'https://simulation.example.org', dataDir: './simulation-data', adminSecretFile: './admin-secret',
      peerOrigin: 'https://west.example.org',
      administrator: handle
    }));

    assert.equal((await readDeploymentConfig('authority', join(directory, 'authority.json'))).administrator, handle);
    assert.equal((await readDeploymentConfig('policy', join(directory, 'policy.json'))).administrator, handle);
    assert.equal((await readDeploymentConfig('simulation', join(directory, 'simulation.json'))).administrator, handle);

    await writeFile(join(directory, 'invalid-policy.json'), JSON.stringify({
      origin: 'https://west.example.org', dataDir: './policy-data', adminSecretFile: './admin-secret',
      authorityOrigin: 'https://authority.example.org', peerOrigin: 'https://simulation.example.org',
      administrator: 'governor', playerNames: ['player']
    }));
    await assert.rejects(readDeploymentConfig('policy', join(directory, 'invalid-policy.json')), /Invalid administrator/);
  } finally {
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
    await writeFile(join(directory, 'config.json'), JSON.stringify({
      origin, port, listenHost: '127.0.0.1', dataDir: './client-data',
      seedServers: ['https://authority.example.org']
    }));
    const config = await readDeploymentConfig('client', join(directory, 'config.json'));
    assert.equal(Object.hasOwn(config, 'administratorBindings'), false);
    assert.equal(Object.hasOwn(config, 'administratorCredentials'), false);
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
  const policyOrigin = `http://127.0.0.1:${policyPort}`;
  const simulationOrigin = `http://127.0.0.1:${simulationPort}`;
  let policy;
  let simulation;
  try {
    await writeFile(join(directory, 'admin-secret'), 'territory-admin');
    const shared = { listenHost: '127.0.0.1', workerIntervalMs: 5, dataDir: './policy-data', adminSecretFile: './admin-secret' };
    await writeFile(join(directory, 'policy.json'), JSON.stringify({ ...shared, origin: policyOrigin, port: policyPort, peerOrigin: simulationOrigin }));
    await writeFile(join(directory, 'simulation.json'), JSON.stringify({ ...shared, dataDir: './simulation-data', origin: simulationOrigin, port: simulationPort, peerOrigin: policyOrigin }));
    const policyConfig = await readDeploymentConfig('policy', join(directory, 'policy.json'));
    const simulationConfig = await readDeploymentConfig('simulation', join(directory, 'simulation.json'));
    assert.equal(policyConfig.territoryAccountName, 'system.territory');
    assert.equal(policyConfig.serverDisplayName, new globalThis.URL(policyOrigin).host);
    assert.equal(policyConfig.territoryDisplayName, `${new globalThis.URL(policyOrigin).host} Territory`);
    assert.equal(simulationConfig.territoryAccountName, 'system.territory');
    assert.equal(simulationConfig.serverDisplayName, new globalThis.URL(simulationOrigin).host);
    assert.equal(simulationConfig.territoryDisplayName, `${new globalThis.URL(simulationOrigin).host} Territory`);
    policy = await startDeployment('policy', policyConfig);
    simulation = await startDeployment('simulation', simulationConfig);

    const policyInfoResponse = await globalThis.fetch(`${policyOrigin}/local/territory/info`);
    assert.equal(policyInfoResponse.status, 200);
    const policyInfo = await policyInfoResponse.json();
    assert.equal(policyInfo.name, new globalThis.URL(policyOrigin).host);
    assert.equal(policyInfo.actor, `${policyOrigin}/actors/territory`);
    const policyStateResponse = await globalThis.fetch(`${policyOrigin}/local/territory/state`, { headers: { authorization: 'Bearer territory-admin' } });
    const policyState = await policyStateResponse.json();
    assert.deepEqual(policyState.admission.trustedRegistry, { mode: 'allowlist', allowlist: [], denylist: [] });
    assert.deepEqual(policyState.admission.acceptedRegistry, { mode: 'denylist', allowlist: [], denylist: [] });
    assert.deepEqual(policyState.admission.acceptedTerritory, { mode: 'allowlist', allowlist: [], denylist: [] });
    assert.deepEqual(policyState.admission.vesselBuildingRegistry, { mode: 'allowlist', allowlist: [], denylist: [] });
    assert.equal('registryAcceptance' in policyState.admission, false);
    assert.equal('territoryAcceptance' in policyState.admission, false);

    const simulationStateUrl = `${simulationOrigin}/local/territory/state`;
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
