import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createHost } from '@fctp/server-base';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
import { createAuthority } from '../apps/test-authority/src/bootstrap.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';
import { startClientServer } from '../apps/demo/src/client-server.js';

const NODEINFO_SCHEMA = 'http://nodeinfo.diaspora.software/ns/schema/2.1';
const BUILD_ENV = {
  FCTP_GIT_COMMIT: '0123456789abcdef0123456789abcdef01234567',
  FCTP_GIT_DESCRIBE: 'v3.2.1-5-g0123456',
  FCTP_GIT_DIRTY: 'true',
  FCTP_BUILD_TIME: '2026-10-31T12:34:56.000Z'
} as const;
const BUILD_ENV_KEYS = ['FCTP_GIT_COMMIT', 'FCTP_GIT_DESCRIBE', 'FCTP_GIT_DIRTY', 'FCTP_BUILD_TIME'] as const;
const EXPECTED_GIT = {
  commit: BUILD_ENV.FCTP_GIT_COMMIT,
  describe: BUILD_ENV.FCTP_GIT_DESCRIBE,
  dirty: true,
  builtAt: BUILD_ENV.FCTP_BUILD_TIME
};

const savedEnvironment = new Map<string, string | undefined>();
for (const key of BUILD_ENV_KEYS) {
  savedEnvironment.set(key, process.env[key]);
  process.env[key] = BUILD_ENV[key];
}
after(() => {
  for (const key of BUILD_ENV_KEYS) {
    const previous = savedEnvironment.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

interface NodeInfoDocument {
  version: string;
  software: { name: string; version: string };
  metadata?: { git?: Record<string, unknown>; homeAccountName?: string };
  protocols: unknown[];
  services: { inbound: unknown[]; outbound: unknown[] };
  openRegistrations: boolean;
  usage: { users: { total: number; activeHalfyear: number; activeMonth: number }; localPosts: number };
}

interface ExpectedNodeInfo {
  name: string;
  version: string;
  git: Record<string, unknown>;
  homeAccountName?: string;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    throw new Error('No TCP port allocated');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} responds with 200`);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i, `${url} responds with application/json`);
  return response.json();
}

async function assertNodeInfo(baseUrl: string, canonicalOrigin: string, expected: ExpectedNodeInfo): Promise<void> {
  const wellKnown = await getJson(`${baseUrl}/.well-known/nodeinfo`);
  assert.deepEqual(wellKnown, {
    links: [{ rel: NODEINFO_SCHEMA, href: `${canonicalOrigin}/nodeinfo/2.1` }]
  });

  const document = await getJson(`${baseUrl}/nodeinfo/2.1`) as NodeInfoDocument;
  assert.equal(document.version, '2.1');
  assert.equal(document.software.name, expected.name);
  assert.equal(document.software.version, expected.version);
  assert.ok(document.metadata?.git, 'NodeInfo includes metadata.git');
  assert.deepEqual(document.metadata.git, expected.git);
  if (expected.homeAccountName === undefined) {
    assert.equal(Object.hasOwn(document.metadata, 'homeAccountName'), false, 'NodeInfo omits metadata.homeAccountName without a hosted Home');
  } else {
    assert.equal(document.metadata?.homeAccountName, expected.homeAccountName);
  }
  assert.deepEqual(document.protocols, []);
  assert.deepEqual(document.services, { inbound: [], outbound: [] });
  assert.equal(document.openRegistrations, false);
  assert.deepEqual(document.usage, {
    users: { total: 0, activeHalfyear: 0, activeMonth: 0 },
    localPosts: 0
  });
}

interface HomeActorDocument {
  id: string;
  role: string;
  webfinger?: string;
  publicKeys?: string[];
}

async function assertHomeAdvertisement(baseUrl: string, canonicalOrigin: string, homeAccountName: string): Promise<HomeActorDocument> {
  const host = new URL(canonicalOrigin).host;
  const homeId = `${canonicalOrigin}/actors/home`;
  const actorResponse = await fetch(`${baseUrl}/actors/home`);
  assert.equal(actorResponse.status, 200, 'the Home Actor responds with 200');
  const actor = await actorResponse.json() as HomeActorDocument;
  assert.equal(actor.id, homeId, 'the Home Actor keeps the stable /actors/home identifier');
  assert.equal(actor.role, 'home');
  assert.equal(actor.webfinger, `${homeAccountName}@${host}`);
  assert.ok(Array.isArray(actor.publicKeys) && actor.publicKeys.length > 0, 'the Home Actor publishes its persisted key');

  const endpoint = new URL('/.well-known/webfinger', baseUrl);
  endpoint.searchParams.set('resource', `acct:${homeAccountName}@${host}`);
  const response = await fetch(endpoint);
  assert.equal(response.status, 200, 'the canonical Home WebFinger address resolves');
  const jrd = await response.json() as { subject?: string; links?: Array<{ rel?: string; href?: string }> };
  assert.equal(jrd.subject, `acct:${homeAccountName}@${host}`);
  const self = (jrd.links ?? []).filter((link) => link.rel === 'self');
  assert.equal(self.length, 1, 'the Home WebFinger document has exactly one self link');
  assert.equal(self[0]?.href, homeId);
  assert.equal(new URL(self[0]!.href!).protocol, 'https:', 'the self link is an absolute HTTPS URI');
  return actor;
}

function unsetBuildEnvironment(): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of BUILD_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  return () => {
    for (const key of BUILD_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('shared host publishes NodeInfo with configured canonical origin and build metadata', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-nodeinfo-host-'));
  let host: Awaited<ReturnType<typeof createHost>> | undefined;
  try {
    host = await createHost({
      origin: 'https://node.test',
      storeFile: join(directory, 'host.json'),
      actors: [{ name: 'node', role: 'node' }],
      nodeInfo: { name: 'fctp-test' }
    });
    const port = await freePort();
    await host.listen(port);
    await assertNodeInfo(`http://127.0.0.1:${port}`, 'https://node.test', {
      name: 'fctp-test',
      version: BUILD_ENV.FCTP_GIT_DESCRIBE,
      git: EXPECTED_GIT
    });
  } finally {
    await host?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority app publishes NodeInfo with its configured canonical origin', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-nodeinfo-authority-'));
  let app: Awaited<ReturnType<typeof createAuthorityApp>> | undefined;
  try {
    app = await createAuthorityApp({
      origin: 'https://authority.test',
      storeFile: join(directory, 'authority.json'),
      keyFile: join(directory, 'authority.keys.json'),
      adminSecret: 'authority-admin-secret',
      vesselNames: { player: 'demo' }
    });
    const port = await freePort();
    await app.authority.listen(port);
    await assertNodeInfo(`http://127.0.0.1:${port}`, 'https://authority.test', {
      name: 'fctp-authority',
      version: BUILD_ENV.FCTP_GIT_DESCRIBE,
      git: EXPECTED_GIT,
      homeAccountName: 'system.home'
    });
  } finally {
    await app?.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority advertises the default Home account name in NodeInfo and WebFinger', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-nodeinfo-home-default-'));
  let app: Awaited<ReturnType<typeof createAuthorityApp>> | undefined;
  try {
    app = await createAuthorityApp({
      origin: 'https://home-default.test',
      storeFile: join(directory, 'authority.json'),
      keyFile: join(directory, 'authority.keys.json'),
      adminSecret: 'home-default-admin-secret'
    });
    const port = await freePort();
    await app.authority.listen(port);
    await assertNodeInfo(`http://127.0.0.1:${port}`, 'https://home-default.test', {
      name: 'fctp-authority',
      version: BUILD_ENV.FCTP_GIT_DESCRIBE,
      git: EXPECTED_GIT,
      homeAccountName: 'system.home'
    });
    await assertHomeAdvertisement(`http://127.0.0.1:${port}`, 'https://home-default.test', 'system.home');
  } finally {
    await app?.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority publishes configured account handles and display names', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-identity-'));
  let app: Awaited<ReturnType<typeof createAuthorityApp>> | undefined;
  try {
    const origin = 'https://authority-identity.test';
    app = await createAuthorityApp({
      origin,
      storeFile: join(directory, 'authority.json'),
      keyFile: join(directory, 'authority.keys.json'),
      adminSecret: 'identity-admin-secret',
      registryAccountName: 'academy.registry',
      serverDisplayName: 'Academy',
      homeDisplayName: 'Academy Home',
      registryDisplayName: 'Academy Registry'
    });
    const port = await freePort();
    await app.authority.listen(port);
    const host = new URL(origin).host;
    const local = `http://127.0.0.1:${port}`;
    const home = await (await fetch(`${local}/actors/home`)).json() as Record<string, unknown>;
    const registry = await (await fetch(`${local}/actors/registry`)).json() as Record<string, unknown>;
    const info = await (await fetch(`${local}/local/info`)).json() as Record<string, unknown>;
    assert.equal(home.webfinger, `system.home@${host}`);
    assert.equal(home.name, 'Academy Home');
    assert.equal(registry.webfinger, `academy.registry@${host}`);
    assert.equal(registry.name, 'Academy Registry');
    assert.equal(info.name, 'Academy');
  } finally {
    await app?.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('territory apps publish configured account handles and display names', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-territory-identity-'));
  let policy: Awaited<ReturnType<typeof createPolicyApp>> | undefined;
  let simulation: Awaited<ReturnType<typeof createSimulationApp>> | undefined;
  try {
    const policyOrigin = 'https://policy-identity.test';
    policy = await createPolicyApp({
      origin: policyOrigin,
      storeFile: join(directory, 'policy.json'),
      keyFile: join(directory, 'policy.keys.json'),
      adminSecret: 'policy-identity-secret',
      serverDisplayName: 'Academy',
      territoryAccountName: 'academy.territory',
      territoryDisplayName: 'Academy Territory'
    });
    const policyPort = await freePort();
    await policy.host.listen(policyPort);
    const policyHost = new URL(policyOrigin).host;
    const policyLocal = `http://127.0.0.1:${policyPort}`;
    const policyInfo = await (await fetch(`${policyLocal}/local/territory/info`)).json() as Record<string, unknown>;
    const policyActor = await (await fetch(`${policyLocal}/actors/territory`)).json() as Record<string, unknown>;
    assert.equal(policyInfo.name, 'Academy');
    assert.equal(policyActor.webfinger, `academy.territory@${policyHost}`);
    assert.equal(policyActor.name, 'Academy Territory');

    const simulationOrigin = 'https://simulation-identity.test';
    simulation = await createSimulationApp({
      origin: simulationOrigin,
      storeFile: join(directory, 'simulation.json'),
      keyFile: join(directory, 'simulation.keys.json'),
      peerOrigin: policyOrigin,
      adminSecret: 'simulation-identity-secret'
    });
    const simulationPort = await freePort();
    await simulation.host.listen(simulationPort);
    const simulationHost = new URL(simulationOrigin).host;
    const simulationLocal = `http://127.0.0.1:${simulationPort}`;
    const simulationInfo = await (await fetch(`${simulationLocal}/local/territory/info`)).json() as Record<string, unknown>;
    const simulationActor = await (await fetch(`${simulationLocal}/actors/territory`)).json() as Record<string, unknown>;
    assert.equal(simulationInfo.name, simulationHost);
    assert.equal(simulationActor.webfinger, `system.territory@${simulationHost}`);
    assert.equal(simulationActor.name, `${simulationHost} Territory`);
  } finally {
    await policy?.host.close();
    await simulation?.host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority publishes and resolves a configured Home account name without changing other Actor handles', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-nodeinfo-home-custom-'));
  let authority: Awaited<ReturnType<typeof createAuthority>> | undefined;
  try {
    authority = await createAuthority({
      origin: 'https://home-custom.test',
      storeFile: join(directory, 'authority.json'),
      keyFile: join(directory, 'authority.keys.json'),
      adminSecret: 'home-custom-admin-secret',
      nodeInfo: { name: 'fctp-authority' },
      homeAccountName: 'academy.home'
    } as Parameters<typeof createAuthority>[0] & { homeAccountName: string });
    const port = await freePort();
    await authority.listen(port);
    const baseUrl = `http://127.0.0.1:${port}`;
    await assertNodeInfo(baseUrl, 'https://home-custom.test', {
      name: 'fctp-authority',
      version: BUILD_ENV.FCTP_GIT_DESCRIBE,
      git: EXPECTED_GIT,
      homeAccountName: 'academy.home'
    });
    await assertHomeAdvertisement(baseUrl, 'https://home-custom.test', 'academy.home');
    const host = new URL('https://home-custom.test').host;
    assert.equal(authority.actor('registry').webfinger, `system.registry@${host}`);
    assert.equal(authority.actor('player').webfinger, `player@${host}`);
  } finally {
    await authority?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

const invalidHomeAccountNames = ['', 'system', '@system.home', 'system.home@authority.test', 'system_home', 'system.home.extra'];

test('authority rejects invalid Home account names before writing startup files', { timeout: 30000 }, async () => {
  for (const homeAccountName of invalidHomeAccountNames) {
    const directory = await mkdtemp(join(tmpdir(), 'fctp-nodeinfo-home-invalid-'));
    const storeFile = join(directory, 'authority.json');
    const keyFile = join(directory, 'authority.keys.json');
    let app: Awaited<ReturnType<typeof createAuthorityApp>> | undefined;
    let caught: unknown;
    try {
      try {
        app = await createAuthorityApp({
          origin: 'https://home-invalid.test',
          storeFile,
          keyFile,
          adminSecret: 'home-invalid-admin-secret',
          homeAccountName
        } as Parameters<typeof createAuthorityApp>[0] & { homeAccountName: string });
      } catch (error) {
        caught = error;
      }
      assert.ok(caught instanceof TypeError, `${JSON.stringify(homeAccountName)} is rejected with TypeError`);
      await assert.rejects(stat(storeFile), { code: 'ENOENT' }, 'the store file is not written before validation');
      await assert.rejects(stat(keyFile), { code: 'ENOENT' }, 'the key file is not written before validation');
    } finally {
      await app?.authority.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('createAuthority rejects an invalid Home account name before writing startup files', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-nodeinfo-home-direct-invalid-'));
  const storeFile = join(directory, 'authority.json');
  const keyFile = join(directory, 'authority.keys.json');
  let authority: Awaited<ReturnType<typeof createAuthority>> | undefined;
  let caught: unknown;
  try {
    try {
      authority = await createAuthority({
        origin: 'https://home-direct-invalid.test',
        storeFile,
        keyFile,
        adminSecret: 'home-direct-invalid-admin-secret',
        nodeInfo: { name: 'fctp-authority' },
        homeAccountName: 'system'
      } as Parameters<typeof createAuthority>[0] & { homeAccountName: string });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof TypeError, 'an invalid Home account name is rejected with TypeError');
    await assert.rejects(stat(storeFile), { code: 'ENOENT' }, 'the store file is not written before validation');
    await assert.rejects(stat(keyFile), { code: 'ENOENT' }, 'the key file is not written before validation');
  } finally {
    await authority?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('policy app publishes NodeInfo with its configured canonical origin', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-nodeinfo-policy-'));
  let app: Awaited<ReturnType<typeof createPolicyApp>> | undefined;
  try {
    app = await createPolicyApp({
      origin: 'https://policy.test',
      storeFile: join(directory, 'policy.json'),
      keyFile: join(directory, 'policy.keys.json'),

      adminSecret: 'policy-admin-secret',
    });
    const port = await freePort();
    await app.host.listen(port);
    await assertNodeInfo(`http://127.0.0.1:${port}`, 'https://policy.test', {
      name: 'fctp-policy',
      version: BUILD_ENV.FCTP_GIT_DESCRIBE,
      git: EXPECTED_GIT
    });
  } finally {
    await app?.host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('simulation app publishes NodeInfo with its configured canonical origin', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-nodeinfo-simulation-'));
  let app: Awaited<ReturnType<typeof createSimulationApp>> | undefined;
  try {
    app = await createSimulationApp({
      origin: 'https://simulation.test',
      storeFile: join(directory, 'simulation.json'),
      keyFile: join(directory, 'simulation.keys.json'),
      peerOrigin: 'https://policy.test',
      adminSecret: 'simulation-admin-secret',
    });
    const port = await freePort();
    await app.host.listen(port);
    await assertNodeInfo(`http://127.0.0.1:${port}`, 'https://simulation.test', {
      name: 'fctp-simulation',
      version: BUILD_ENV.FCTP_GIT_DESCRIBE,
      git: EXPECTED_GIT
    });
  } finally {
    await app?.host.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('client server publishes NodeInfo for its configured canonical origin', { timeout: 30000 }, async () => {
  const client = await startClientServer({ port: 0, origin: 'https://client.test' });
  try {
    await assertNodeInfo(client.origin, 'https://client.test', {
      name: 'fctp-client',
      version: BUILD_ENV.FCTP_GIT_DESCRIBE,
      git: EXPECTED_GIT
    });
  } finally {
    await client.close();
  }
});

test('NodeInfo reports unknown build metadata when build environment is absent', { timeout: 30000 }, async () => {
  const restoreEnvironment = unsetBuildEnvironment();
  const directory = await mkdtemp(join(tmpdir(), 'fctp-nodeinfo-unknown-'));
  let host: Awaited<ReturnType<typeof createHost>> | undefined;
  try {
    host = await createHost({
      origin: 'https://unknown.test',
      storeFile: join(directory, 'host.json'),
      actors: [{ name: 'node', role: 'node' }],
      nodeInfo: { name: 'fctp-unknown' }
    });
    const port = await freePort();
    await host.listen(port);
    await assertNodeInfo(`http://127.0.0.1:${port}`, 'https://unknown.test', {
      name: 'fctp-unknown',
      version: 'unknown',
      git: { commit: 'unknown', dirty: false }
    });
  } finally {
    await host?.close();
    restoreEnvironment();
    await rm(directory, { recursive: true, force: true });
  }
});
