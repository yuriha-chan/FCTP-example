import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import test from 'node:test';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';

const playerNames = ['player', 'player-2', 'player-3', 'player-4', 'player-5'];
const adminSecret = 'browser-cli-isolated-admin-secret';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => server.listen(0, '127.0.0.1', resolveListen).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return address.port;
}

function refFor(markdown: string, label: string): string {
  const matches = [...markdown.matchAll(new RegExp(`^.*${escapeRegExp(label)}.*?\\[([\\da-f]{6}-[\\da-z]+-[\\da-z]+)\\](?: \\(disabled\\))?$`, 'gm'))];
  assert.equal(matches.length, 1, `Expected one control labelled ${label}, found ${matches.length}`);
  return matches[0]![1]!;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

test('CLI rejects malformed batches before connecting to a role daemon', async () => {
  for (const source of [
    '[]',
    '[{"command":"fill","ref":"abc-1-1"}]',
    '[{"command":"submit","ref":"abc-1-2","value":"extra"}]',
    '[{"command":"click","ref":"abc-1-1","unexpected":true}]',
    'not-json'
  ]) await assert.rejects(cli('/does-not-exist', ['player-1', 'batch', source]));
});

async function cli(configRoot: string, args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(process.execPath, [resolve('scripts/browser.mjs'), ...args], {
      cwd: process.cwd(),
      env: { ...process.env, FCTP_BROWSER_CONFIG_ROOT: configRoot },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`browser CLI exited ${code}: ${stderr.trim()}`));
      else resolveOutput(stdout);
    });
  });
}

test('spawned browser CLI keeps isolated Player and administrator daemon sessions', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-browser-cli-'));
  const configRoot = join(directory, 'config');
  const runtimeDirectory = join(configRoot, 'runtime');
  await mkdir(runtimeDirectory, { recursive: true });
  const ports = await Promise.all(Array.from({ length: 3 }, freePort));
  const origins = {
    authority: `http://127.0.0.1:${ports[0]}`,
    policy: `http://127.0.0.1:${ports[1]}`,
    simulation: `http://127.0.0.1:${ports[2]}`
  };
  const services: {
    authority?: Awaited<ReturnType<typeof createAuthorityApp>>;
    policy?: Awaited<ReturnType<typeof createPolicyApp>>;
    simulation?: Awaited<ReturnType<typeof createSimulationApp>>;
  } = {};
  const openedRoles = new Set<string>();
  t.after(async () => {
    const daemonClosures = await Promise.allSettled([...openedRoles].map((role) => cli(configRoot, [role, 'close'])));
    const shutdowns = [
      ...(services.simulation ? [services.simulation.host.close()] : []),
      ...(services.policy ? [services.policy.host.close()] : []),
      ...(services.authority ? [services.authority.authority.close()] : [])
    ];
    const results = await Promise.allSettled(shutdowns);
    await rm(directory, { recursive: true, force: true });
    const failures = [...daemonClosures, ...results].flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Browser CLI fixture cleanup failed');
  });

  services.authority = await createAuthorityApp({ origin: origins.authority, storeFile: join(directory, 'authority.json'), adminSecret, playerNames });
  services.policy = await createPolicyApp({ origin: origins.policy, storeFile: join(directory, 'policy.json'), authorityOrigin: origins.authority, playerNames, peerOrigin: origins.simulation, adminSecret });
  services.simulation = await createSimulationApp({ origin: origins.simulation, storeFile: join(directory, 'simulation.json'), authorityOrigin: origins.authority, playerNames, peerOrigin: origins.policy, adminSecret });
  await services.authority.authority.listen(ports[0]!, '127.0.0.1');
  await services.policy.host.listen(ports[1]!, '127.0.0.1');
  await services.simulation.host.listen(ports[2]!, '127.0.0.1');

  const authority = services.authority;
  const policy = services.policy;
  const simulation = services.simulation;
  const nativeTokens = new Map<string, string>();
  const adminHeaders = { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' };
  for (const name of ['player-2', 'player-3']) {
    const response = await fetch(`${origins.authority}/local/home/issue`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: authority.ids.players[name] }) });
    assert.equal(response.status, 200);
    nativeTokens.set(name, (await response.json() as { nativeToken: string }).nativeToken);
    for (const territory of [policy, simulation]) {
      await authority.home.requestDigest(authority.ids.players[name]!, { id: territory.ids.actor, inbox: territory.host.actor('territory').inbox });
      assert.equal(await authority.authority.server.processOutbox(), 1);
      assert.equal(await territory.host.server.processInbox(), 1);
    }
  }

  const config = {
    runId: 'browser-cli-isolated',
    origins: { authority: [origins.authority], territoryA: origins.policy, territoryB: origins.simulation },
    actors: {
      registry: authority.ids.actor.registry,
      home: authority.ids.actor.home,
      players: authority.ids.players,
      vessels: authority.ids.vessels,
      territoryA: policy.ids.actor,
      territoryB: simulation.ids.actor
    }
  };
  await writeFile(join(configRoot, 'runtime-config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const credentialFiles = [
    ['player-2', { role: 'player-2', player: authority.ids.players['player-2'], vessel: authority.ids.vessels['player-2'], nativeToken: nativeTokens.get('player-2') }],
    ['player-3', { role: 'player-3', player: authority.ids.players['player-3'], vessel: authority.ids.vessels['player-3'], nativeToken: nativeTokens.get('player-3') }],
    ['admin-1', { role: 'administrator-1', territoryAAdmin: adminSecret }]
  ] as const;
  for (const [role, credentials] of credentialFiles) {
    const roleDirectory = join(runtimeDirectory, config.runId, role);
    await mkdir(roleDirectory, { recursive: true, mode: 0o700 });
    const credentialPath = join(roleDirectory, 'credentials.json');
    await writeFile(credentialPath, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
    await chmod(credentialPath, 0o600);
  }

  openedRoles.add('player-2');
  let view = await cli(configRoot, ['player-2', 'open']);
  assert.match(view, /Player player-2.*vessel player-2/);
  assert.match(view, /Credential: \[REDACTED\]/);
  assert.doesNotMatch(view, new RegExp(escapeRegExp(nativeTokens.get('player-2')!)));
  view = await cli(configRoot, ['player-2', 'view']);
  assert.match(view, /Player player-2.*vessel player-2/);
  const refreshed = await cli(configRoot, ['player-2', 'batch', JSON.stringify([{ command: 'click', ref: refFor(view, 'Refresh A state and actions') }])]);
  assert.match(refreshed, /Mine one ore/);
  const mined = await cli(configRoot, ['player-2', 'batch', JSON.stringify([
    { command: 'click', ref: refFor(refreshed, 'Mine one ore') },
    { command: 'click', ref: refFor(refreshed, 'Mine one ore') }
  ])]);
  assert.match(mined, /Request accepted\./);
  const policyState = await policy.host.server.store.read((store) => structuredClone(store.domain.policyTerritory)) as { state?: { rawInventory?: Record<string, number> } };
  assert.equal(policyState.state?.rawInventory?.[policy.ids.varieties.ore], 2, 'the rendered Mine action changes actual Territory A state');

  view = await cli(configRoot, ['player-2', 'reload']);
  assert.match(view, /Player player-2.*vessel player-2/);
  assert.match(view, /Credential: \[REDACTED\]/);

  openedRoles.add('player-3');
  const player3 = await cli(configRoot, ['player-3', 'open']);
  assert.match(player3, /Player player-3.*vessel player-3/);
  assert.doesNotMatch(player3, new RegExp(escapeRegExp(authority.ids.players['player-2']!)));
  assert.doesNotMatch(player3, new RegExp(escapeRegExp(authority.ids.vessels['player-2']!)));

  openedRoles.add('administrator-1');
  const administrator = await cli(configRoot, ['administrator-1', 'open']);
  assert.match(administrator, /Role: policy-admin/);
  assert.match(administrator, /Update policy/);
  assert.match(administrator, /Update admission/);
  assert.doesNotMatch(administrator, /Configure facilities|Advance one tick|Send Registry entry request|Mine one ore/);
  assert.match(administrator, /Credential: \[REDACTED\]/);
  assert.doesNotMatch(administrator, new RegExp(escapeRegExp(adminSecret)));
});
