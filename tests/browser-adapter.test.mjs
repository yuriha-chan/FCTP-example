import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { credentialPathFor, extractRef, parseCommand, roleSession, runtimeConfigRoot, socketPathFor, validateRuntimeConfig } from '../scripts/browser.mjs';
import { createJsonLineServer, createSerializedDispatcher } from '../scripts/browser-transport.mjs';

function config() {
  const actor = (name) => `http://127.0.0.1:4200/actors/${name}`;
  const vessel = (name) => `http://127.0.0.1:4200/objects/vessels/${name}`;
  const players = { player: actor('player') };
  const vessels = { player: vessel('player') };
  for (let index = 2; index <= 5; index += 1) {
    players[`player-${index}`] = actor(`player-${index}`);
    vessels[`player-${index}`] = vessel(`player-${index}`);
  }
  return { runId: 'isolated-run', origins: { authority: ['http://127.0.0.1:4200'], territoryA: 'http://127.0.0.1:4210', territoryB: 'http://127.0.0.1:4211' }, actors: { registry: actor('registry'), home: actor('home'), players, vessels, territoryA: actor('territory-a'), territoryB: actor('territory-b') } };
}

test('command parser accepts only the assigned role and exact operation arity', () => {
  assert.deepEqual(parseCommand(['player-2', 'fill', 'ref-x', 'some value']), { role: 'player-2', command: 'fill', ref: 'ref-x', value: 'some value' });
  assert.throws(() => parseCommand(['observer', 'view']), /Unknown browser role/);
  assert.throws(() => parseCommand(['player-1', 'post']), /Unknown browser command/);
  assert.throws(() => parseCommand(['player-1', 'click', 'ref', 'extra']), /Invalid operands/);
});

test('runtime config defaults to run and resolves relative overrides from the repository root', () => {
  assert.equal(runtimeConfigRoot({}), join(process.cwd(), 'run'));
  assert.equal(runtimeConfigRoot({ FCTP_BROWSER_CONFIG_ROOT: 'isolated/config' }), join(process.cwd(), 'isolated/config'));
});

test('runtime parsing permits exactly configured five Players and maps only public origins', () => {
  const runtime = config();
  assert.deepEqual(validateRuntimeConfig(runtime), { authority: 'http://127.0.0.1:4200', policy: 'http://127.0.0.1:4210', simulation: 'http://127.0.0.1:4211' });
  delete runtime.actors.vessels['player-5'];
  assert.throws(() => validateRuntimeConfig(runtime), /exactly five/);
  assert.equal(socketPathFor(config(), 'administrator-2', '/tmp/root'), '/tmp/root/runtime/isolated-run/administrator-2/browser.sock');
  assert.throws(() => socketPathFor(config(), 'observer', '/tmp/root'), /Unknown browser role/);
});

test('credential paths map all eight daemon roles to their existing role directories', () => {
  const runtime = config();
  for (let index = 1; index <= 5; index += 1) {
    const role = `player-${index}`;
    assert.equal(credentialPathFor(runtime, role, '/tmp/root'), `/tmp/root/runtime/isolated-run/${role}/credentials.json`);
  }
  for (let index = 1; index <= 3; index += 1) {
    assert.equal(credentialPathFor(runtime, `administrator-${index}`, '/tmp/root'), `/tmp/root/runtime/isolated-run/admin-${index}/credentials.json`);
  }
});

test('each role resolves only its own credential field and Player identity', () => {
  const runtime = config();
  assert.deepEqual(roleSession('player-3', runtime, { role: 'player-3', player: runtime.actors.players['player-3'], vessel: runtime.actors.vessels['player-3'], nativeToken: 'secret-player', diplomaticTokens: { A: 'ignored', B: 'ignored' } }), {
    sessionRole: 'player', player: runtime.actors.players['player-3'], vessel: runtime.actors.vessels['player-3'], credential: 'secret-player'
  });
  assert.equal(roleSession('administrator-1', runtime, { role: 'administrator-1', territoryAAdmin: 'admin-a' }).credential, 'admin-a');
  assert.equal(roleSession('administrator-2', runtime, { role: 'administrator-2', territoryBAdmin: 'admin-b' }).sessionRole, 'simulation-admin');
  const admin3 = roleSession('administrator-3', runtime, { role: 'administrator-3', authorityAdmin: 'admin-c' });
  assert.equal(admin3.sessionRole, 'authority-admin');
  assert.equal(admin3.vessel, runtime.actors.vessels.player);
  assert.throws(() => roleSession('player-3', runtime, { role: 'player-3', player: runtime.actors.players.player, vessel: runtime.actors.vessels.player, nativeToken: 'wrong' }), /do not match/);
  assert.equal(roleSession('administrator-3', runtime, { role: 'administrator-3', authorityAdmin: 'secret', territoryAAdmin: 'must-not-use' }).credential, 'secret');
});

test('fresh visible refs are extracted by control label without accepting missing controls', () => {
  const markdown = 'Role: player {player=Player=player, policy-admin=Policy administrator=policy-admin} [opaque-1]\n\nPlayer URI: https://example.test/player [opaque-4]\n\nVessel URI: https://example.test/vessel [opaque-5]\n\nCredential: [REDACTED] [opaque-2]\n\nApply session [opaque-3]';
  assert.equal(extractRef(markdown, 'Role'), 'opaque-1');
  assert.equal(extractRef(markdown, 'Player URI'), 'opaque-4');
  assert.equal(extractRef(markdown, 'Vessel URI'), 'opaque-5');
  assert.equal(extractRef(markdown, 'Credential'), 'opaque-2');
  assert.equal(extractRef(markdown, 'Apply session'), 'opaque-3');
  assert.throws(() => extractRef(markdown, 'Missing field'), /unavailable/);
});

test('Unix socket transport returns an asynchronous response after the client ends its write side', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-transport-'));
  const socketPath = join(directory, 'browser.sock');
  const server = createJsonLineServer(async (request) => {
    await delay(40);
    return { markdown: request.value };
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const response = await new Promise((resolve, reject) => {
      const connection = net.createConnection(socketPath);
      let content = '';
      connection.setEncoding('utf8');
      connection.once('error', reject);
      connection.on('data', (chunk) => { content += chunk; });
      connection.once('end', () => resolve(JSON.parse(content)));
      connection.once('connect', () => connection.end(`${JSON.stringify({ command: 'view', value: 'async response' })}\n`));
    });
    assert.deepEqual(response, { ok: true, view: { markdown: 'async response' } });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('serialized dispatch preserves operation order and continues after a rejected operation', async () => {
  const operations = [];
  const dispatch = createSerializedDispatcher(async (value) => {
    operations.push(`start-${value}`);
    await delay(10);
    operations.push(`end-${value}`);
    if (value === 'reject') throw new Error('expected rejection');
    return value;
  });
  const results = await Promise.allSettled([dispatch('first'), dispatch('reject'), dispatch('last')]);
  assert.deepEqual(operations, ['start-first', 'end-first', 'start-reject', 'end-reject', 'start-last', 'end-last']);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected', 'fulfilled']);
});
