import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createHost } from '@fctp/server-base';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
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
  metadata?: { git?: Record<string, unknown> };
  protocols: unknown[];
  services: { inbound: unknown[]; outbound: unknown[] };
  openRegistrations: boolean;
  usage: { users: { total: number; activeHalfyear: number; activeMonth: number }; localPosts: number };
}

interface ExpectedNodeInfo {
  name: string;
  version: string;
  git: Record<string, unknown>;
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
  assert.deepEqual(document.protocols, []);
  assert.deepEqual(document.services, { inbound: [], outbound: [] });
  assert.equal(document.openRegistrations, false);
  assert.deepEqual(document.usage, {
    users: { total: 0, activeHalfyear: 0, activeMonth: 0 },
    localPosts: 0
  });
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
      playerNames: ['player'],
      vesselNames: { player: 'demo' }
    });
    const port = await freePort();
    await app.authority.listen(port);
    await assertNodeInfo(`http://127.0.0.1:${port}`, 'https://authority.test', {
      name: 'fctp-authority',
      version: BUILD_ENV.FCTP_GIT_DESCRIBE,
      git: EXPECTED_GIT
    });
  } finally {
    await app?.authority.close();
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
      authorityOrigin: 'https://authority.test',
      peerOrigin: 'https://simulation.test',
      adminSecret: 'policy-admin-secret',
      playerNames: ['player']
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
      authorityOrigin: 'https://authority.test',
      peerOrigin: 'https://policy.test',
      adminSecret: 'simulation-admin-secret',
      playerNames: ['player']
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
