import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import test from 'node:test';
import { startDemo } from '../apps/demo/src/launcher.js';

test('CLI rejects malformed batches before connecting to a role daemon', async () => {
  for (const source of [
    '[]',
    '[{"command":"fill","ref":"abc-1-1"}]',
    '[{"command":"submit","ref":"abc-1-2","value":"extra"}]',
    '[{"command":"click","ref":"abc-1-1","unexpected":true}]',
    'not-json'
  ]) await assert.rejects(cli('/does-not-exist', ['player-1', 'batch', source]));
});

test('spawned API commands use the live application without a browser while DOM rendering uses the same origin', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-cli-live-'));
  const ports = await Promise.all(Array.from({ length: 4 }, () => freePort()));
  const demo = await startDemo({ dataDir: directory, ports: { authority: ports[0]!, policy: ports[1]!, simulation: ports[2]!, client: ports[3]! } });
  const configRoot = join(directory, 'config');
  await mkdir(configRoot, { recursive: true });
  const host = new URL(demo.origins.authority).host;
  const config = {
    runId: 'cli-live',
    clientOrigin: demo.origins.client,
    accounts: [
      { name: 'player', handle: `@player@${host}`, homeOrigin: demo.origins.authority },
      { name: 'governor', handle: `@governor@${host}`, homeOrigin: demo.origins.authority }
    ]
  };
  await writeFile(join(configRoot, 'runtime-config.json'), JSON.stringify(config));
  try {
    await assert.rejects(cli(configRoot, ['player', 'login', 'demo-player-password']), /operand|login|command/i);

    const login = JSON.parse(await cliWithInput(configRoot, ['player', 'login'], 'demo-player-password\n')) as { status?: string; account?: { handle?: string } };
    assert.equal(login.status, 'signed-in');
    assert.equal(login.account?.handle, `@player@${host}`);
    assert.equal(JSON.stringify(login).includes('demo-player-password'), false);
    assert.equal((await readFile(join(configRoot, 'runtime-config.json'), 'utf8')).includes('demo-player-password'), false);

    const publicPage = JSON.parse(await cli(configRoot, ['player', 'page', '/api/servers'])) as { servers?: unknown; authorities?: unknown };
    assert.equal(typeof publicPage.servers, 'object');
    assert.equal(typeof publicPage.authorities, 'object');

    const accounts = JSON.parse(await cli(configRoot, ['player', 'page', '/api/accounts'])) as { accounts?: Array<{ handle?: string }> };
    assert.ok(accounts.accounts?.some((account) => account.handle === `@player@${host}`));

    const actionDescriptor = { id: 'refresh-explore', label: 'Refresh explore', endpoint: '/api/explore/refresh', method: 'POST', inputs: [], blockers: [] };
    const actionPage = JSON.parse(await cli(configRoot, ['player', 'action', JSON.stringify(actionDescriptor), '{}'])) as { data?: unknown };
    assert.ok(actionPage.data !== undefined);

    const activity = JSON.parse(await cli(configRoot, ['player', 'page', '/api/activity'])) as { data?: { actions?: unknown[] } };
    assert.ok(Array.isArray(activity.data?.actions));

    const rendered = await cli(configRoot, ['player', 'open']);
    assert.match(rendered, /FCTP Browser Client/);
    assert.match(rendered, new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const health = JSON.parse(await cli(configRoot, ['player', 'page', '/api/health'])) as { status?: string };
    assert.equal(health.status, 'ok', 'API stays available while the DOM worker uses the shared application origin');
    await cli(configRoot, ['player', 'close']);
  } finally {
    await demo.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function cli(configRoot: string, args: string[]): Promise<string> {
  return cliWithInput(configRoot, args);
}

async function cliWithInput(configRoot: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/browser.mjs'), ...args], {
      cwd: process.cwd(),
      env: { ...process.env, FCTP_BROWSER_CONFIG_ROOT: configRoot },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    if (input !== undefined) child.stdin!.end(input);
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`browser CLI exited ${code}: ${stderr.trim()}`));
      else resolveOutput(stdout);
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a TCP port');
  const { port } = address;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}
