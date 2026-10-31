import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, stat, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import processModule from 'node:process';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const root = new globalThis.URL('../', import.meta.url);
const serveScript = new globalThis.URL('../scripts/serve.mjs', import.meta.url);
const timeoutMs = 10_000;

async function createConfig(directory, value) {
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(value));
  return configPath;
}

function launch(service, configPath) {
  const child = spawn(processModule.execPath, [serveScript.pathname, service, configPath], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  return { child, get stdout() { return stdout; }, get stderr() { return stderr; } };
}

async function waitFor(predicate, message) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = predicate();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function waitForExit(child) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => reject(new Error('Timed out waiting for process exit')), timeoutMs);
    child.once('error', (error) => { globalThis.clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { globalThis.clearTimeout(timer); resolve(code); });
  });
}

async function stop(child) {
  if (!child) return;
  if (child.exitCode !== null) return;
  child.kill('SIGKILL');
  await waitForExit(child);
}

async function clientConfig(directory, extras = {}) {
  return createConfig(directory, {
    origin: 'https://client.example.test', listenHost: '127.0.0.1', port: 0,
    dataDir: './data', ...extras
  });
}

test('standalone client advertises its canonical origin, serves health and JavaScript, and shuts down on SIGTERM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-runtime-'));
  let process;
  try {
    const secret = 'runtime-client-admin-secret-93a0';
    await writeFile(join(directory, 'client-secret'), secret);
    const configPath = await clientConfig(directory, {
      administratorBindings: [{ accountId: 'governor', authorityActorIds: ['https://authority.example.test/actors/registry'], credentialSource: 'authority' }],
      administratorCredentialFiles: { authority: './client-secret' }
    });
    process = launch('client', configPath);
    const line = await waitFor(() => process.stdout.split(/\r?\n/).find((entry) => entry.startsWith('client ')), 'startup log');
    assert.match(line, /^client https:\/\/client\.example\.test 127\.0\.0\.1:\d+$/);
    assert.doesNotMatch(`${process.stdout}${process.stderr}`, new RegExp(secret));
    assert.doesNotMatch(`${process.stdout}${process.stderr}`, /secret|password/i);

    const address = line.split(' ').at(-1);
    const base = `http://${address}`;
    const health = await globalThis.fetch(`${base}/api/health`, { signal: globalThis.AbortSignal.timeout(timeoutMs) });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const script = await globalThis.fetch(`${base}/dist/client/main.js`, { signal: globalThis.AbortSignal.timeout(timeoutMs) });
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.ok((await script.text()).length > 0);

    process.child.kill('SIGTERM');
    assert.equal(await waitForExit(process.child), 0);
    assert.doesNotMatch(`${process.stdout}${process.stderr}`, new RegExp(secret));
    assert.doesNotMatch(`${process.stdout}${process.stderr}`, /secret|password/i);
  } finally {
    if (process) await stop(process.child);
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid deployment configurations exit before creating their data directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-invalid-runtime-'));
  const cases = [
    {
      service: 'authority', name: 'missing secret', secretPath: './missing-secret', passwordFile: { player: 'player-password' }
    },
    {
      service: 'authority', name: 'empty secret', secretValue: '', passwordFile: { player: 'player-password' }
    },
    {
      service: 'authority', name: 'password mismatch', secretValue: 'authority-secret', passwordFile: { other: 'password' }
    },
    { service: 'unknown-service', name: 'unknown service' },
    { service: 'client', name: 'missing administrator binding secret', binding: true }
  ];
  try {
    for (const [index, invalid] of cases.entries()) {
      const itemDirectory = join(directory, String(index));
      await mkdir(itemDirectory);
      const dataDir = join(itemDirectory, 'data');
      let serviceConfig;
      if (invalid.service === 'authority') {
        const secretPath = invalid.secretPath ?? './admin-secret';
        if (invalid.secretValue !== undefined) await writeFile(join(itemDirectory, 'admin-secret'), invalid.secretValue);
        await writeFile(join(itemDirectory, 'passwords.json'), JSON.stringify(invalid.passwordFile));
        serviceConfig = {
          origin: 'https://authority.example.test', listenHost: '127.0.0.1', port: 0,
          dataDir: './data', adminSecretFile: secretPath, accountPasswordsFile: './passwords.json',
          playerNames: ['player'], vesselNames: { player: 'vessel' }
        };
      } else if (invalid.binding) {
        serviceConfig = {
          origin: 'https://client.example.test', listenHost: '127.0.0.1', port: 0, dataDir: './data',
          administratorBindings: [{ accountId: 'governor', authorityActorIds: ['https://authority.example.test/actors/registry'], credentialSource: 'authority' }],
          administratorCredentialFiles: { authority: './missing-secret' }
        };
      } else {
        serviceConfig = { origin: 'https://unknown.example.test', dataDir: './data' };
      }
      const configPath = await createConfig(itemDirectory, serviceConfig);
      const process = launch(invalid.service, configPath);
      try {
        assert.equal(await waitForExit(process.child), 1, invalid.name);
        assert.match(process.stderr, /secret|password|service/i, invalid.name);
        assert.doesNotMatch(`${process.stdout}${process.stderr}`, /player-password|authority-secret/i);
        await assert.rejects(stat(dataDir), { code: 'ENOENT' });
      } finally {
        await stop(process.child);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed client listener startup releases application resources and exits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deployment-listener-failure-'));
  const blocker = createServer();
  let process;
  try {
    await new Promise((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const address = blocker.address();
    const configPath = await clientConfig(directory, { port: address.port });
    process = launch('client', configPath);
    assert.equal(await waitForExit(process.child), 1);
    assert.match(process.stderr, /address already in use/i);
  } finally {
    await stop(process?.child);
    await new Promise((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
