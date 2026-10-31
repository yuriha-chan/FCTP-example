import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
      { name: 'player', handle: `@player@${host}` },
      { name: 'player-2', handle: `@player-2@${host}` },
      { name: 'governor', handle: `@governor@${host}` }
    ]
  };
  await writeFile(join(configRoot, 'runtime-config.json'), JSON.stringify(config));
  const clientSessionPathFor = (role: string): string => join(configRoot, 'runtime', 'cli-live', role, 'client-session.json');
  try {
    await assert.rejects(cli(configRoot, ['player', 'login', 'demo-player-password']), /operand|login|command/i);
    await assert.rejects(cli(configRoot, ['player', 'page', '/api/accounts']), /session|sign|credential|401|account/i);

    const login = JSON.parse(await cliWithInput(configRoot, ['player', 'login'], 'demo-player-password\n')) as { status?: string; account?: { handle?: string }; clientToken?: string };
    assert.equal(login.status, 'signed-in');
    assert.equal(login.account?.handle, `@player@${host}`);
    assert.equal(Object.hasOwn(login, 'clientToken'), false, 'login stdout never includes the raw client token');
    assert.equal(JSON.stringify(login).includes('demo-player-password'), false);
    assert.equal((await readFile(join(configRoot, 'runtime-config.json'), 'utf8')).includes('demo-player-password'), false);

    const playerSessionPath = clientSessionPathFor('player');
    const storedSession = JSON.parse(await readFile(playerSessionPath, 'utf8')) as { origin?: string; handle?: string; accountId?: string; clientToken?: string };
    assert.equal(storedSession.origin, demo.origins.client);
    assert.equal(storedSession.handle, `@player@${host}`);
    assert.equal(typeof storedSession.accountId, 'string');
    assert.equal(typeof storedSession.clientToken, 'string');
    assert.equal(JSON.stringify(login).includes(String(storedSession.clientToken)), false, 'login stdout omits the stored client token');
    assert.equal((await stat(playerSessionPath)).mode & 0o777, 0o600, 'the client session file is private');
    assert.equal((await stat(join(configRoot, 'runtime', 'cli-live', 'player'))).mode & 0o777, 0o700, 'the account runtime directory is private');

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
    assert.match(rendered, /^# Client/m);
    assert.match(rendered, /## Sign in/, 'the DOM browser does not share the API harness client session');
    assert.equal(rendered.includes(`@player@${host}`), false, 'the browser has no account before its own login');
    const health = JSON.parse(await cli(configRoot, ['player', 'page', '/api/health'])) as { status?: string };
    assert.equal(health.status, 'ok', 'API stays available while the DOM worker uses the shared application origin');
    await cli(configRoot, ['player', 'close']);

    const governorSessionPath = clientSessionPathFor('governor');
    await mkdir(dirname(governorSessionPath), { recursive: true, mode: 0o700 });
    await writeFile(governorSessionPath, await readFile(playerSessionPath, 'utf8'), { mode: 0o600 });
    await assert.rejects(cli(configRoot, ['governor', 'page', '/api/accounts']), /session|sign|credential|401|account/i, 'a session bound to another handle is not used');
    await rm(governorSessionPath, { force: true });

    const secondSessionPath = clientSessionPathFor('player-2');
    await mkdir(dirname(secondSessionPath), { recursive: true, mode: 0o700 });
    const otherOrigin = { ...storedSession, origin: 'http://127.0.0.1:1' };
    await writeFile(secondSessionPath, JSON.stringify(otherOrigin), { mode: 0o600 });
    await assert.rejects(cli(configRoot, ['player-2', 'page', '/api/accounts']), /session|sign|credential|401|account/i, 'a session bound to another origin is not used');
    await rm(secondSessionPath, { force: true });

    await symlink(playerSessionPath, governorSessionPath);
    await assert.rejects(cli(configRoot, ['governor', 'page', '/api/accounts']), /regular file|session/i, 'a symlinked session file is rejected rather than followed');
    await rm(governorSessionPath, { force: true });

    const logout = JSON.parse(await cli(configRoot, ['player', 'logout'])) as { account?: { login?: { status?: string } } };
    assert.equal(logout.account?.login?.status, 'signed-out');
    await assert.rejects(lstat(playerSessionPath), /ENOENT|no such file/i, 'a successful logout removes the saved client session');
    await assert.rejects(cli(configRoot, ['player', 'page', '/api/accounts']), /session|sign|credential|401|account/i, 'a removed session cannot be reused');
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
