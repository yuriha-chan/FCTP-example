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
  const names = ['sana-okonkwo', 'tavi-lindgren', 'priya-nandakumar', 'halvar-ostergaard', 'leon-castellan'];
  const players = Object.fromEntries(names.map((name) => [name, actor(name)]));
  const vessels = Object.fromEntries(names.map((name) => [name, vessel(name)]));
  const administrators = ['orla-fitzgerald', 'dmitri-sato', 'mirela-vukovic'];
  return { runId: 'isolated-run', origins: { authority: ['http://127.0.0.1:4200'], territoryA: 'http://127.0.0.1:4210', territoryB: 'http://127.0.0.1:4211' }, players: names.map((name) => ({ name, role: name, player: players[name], vessel: vessels[name] })), administrators: administrators.map((name, index) => ({ name, sessionRole: ['policy-admin', 'simulation-admin', 'authority-admin'][index] })), actors: { registry: actor('registry'), home: actor('home'), players, vessels, territoryA: actor('territory-a'), territoryB: actor('territory-b') } };
}

test('command parser accepts only the assigned role and exact operation arity', () => {
  assert.deepEqual(parseCommand(['tavi-lindgren', 'fill', 'ref-x', 'some value']), { role: 'tavi-lindgren', command: 'fill', ref: 'ref-x', value: 'some value' });
  assert.throws(() => parseCommand(['bad_account', 'view']), /Unknown browser account/);
  assert.throws(() => parseCommand(['sana-okonkwo', 'post']), /Unknown browser command/);
  assert.throws(() => parseCommand(['sana-okonkwo', 'click', 'ref', 'extra']), /Invalid operands/);
});

test('runtime config defaults to run and resolves relative overrides from the repository root', () => {
  assert.equal(runtimeConfigRoot({}), join(process.cwd(), 'run'));
  assert.equal(runtimeConfigRoot({ FCTP_BROWSER_CONFIG_ROOT: 'isolated/config' }), join(process.cwd(), 'isolated/config'));
});

test('runtime parsing permits exactly configured five Players and maps only public origins', () => {
  const runtime = config();
  assert.deepEqual(validateRuntimeConfig(runtime), { authority: 'http://127.0.0.1:4200', policy: 'http://127.0.0.1:4210', simulation: 'http://127.0.0.1:4211' });
  delete runtime.actors.vessels['leon-castellan'];
  assert.throws(() => validateRuntimeConfig(runtime), /exactly five/);
  assert.equal(socketPathFor(config(), 'dmitri-sato', '/tmp/root'), '/tmp/root/runtime/isolated-run/dmitri-sato/browser.sock');
  assert.throws(() => socketPathFor(config(), 'observer', '/tmp/root'), /Unknown browser account/);
});

test('credential and socket paths use configured public accounts directly', () => {
  const runtime = config();
  assert.equal(credentialPathFor(runtime, 'sana-okonkwo', '/tmp/root'), '/tmp/root/runtime/isolated-run/sana-okonkwo/credentials.json');
  assert.equal(credentialPathFor(runtime, 'orla-fitzgerald', '/tmp/root'), '/tmp/root/runtime/isolated-run/orla-fitzgerald/credentials.json');
});

test('each role resolves only its own credential field and Player identity', () => {
  const runtime = config();
  assert.deepEqual(roleSession('priya-nandakumar', runtime, { role: 'priya-nandakumar', player: runtime.actors.players['priya-nandakumar'], vessel: runtime.actors.vessels['priya-nandakumar'], nativeToken: 'secret-player', diplomaticTokens: { A: 'ignored', B: 'ignored' } }), {
    sessionRole: 'player', player: runtime.actors.players['priya-nandakumar'], vessel: runtime.actors.vessels['priya-nandakumar'], credential: 'secret-player'
  });
  assert.equal(roleSession('orla-fitzgerald', runtime, { role: 'orla-fitzgerald', territoryAAdmin: 'admin-a' }).credential, 'admin-a');
  assert.equal(roleSession('dmitri-sato', runtime, { role: 'dmitri-sato', territoryBAdmin: 'admin-b' }).sessionRole, 'simulation-admin');
  const admin3 = roleSession('mirela-vukovic', runtime, { role: 'mirela-vukovic', authorityAdmin: 'admin-c' });
  assert.equal(admin3.sessionRole, 'authority-admin');
  assert.equal(admin3.vessel, runtime.actors.vessels['sana-okonkwo']);
  assert.throws(() => roleSession('priya-nandakumar', runtime, { role: 'priya-nandakumar', player: runtime.actors.players['sana-okonkwo'], vessel: runtime.actors.vessels['sana-okonkwo'], nativeToken: 'wrong' }), /do not match/);
  assert.equal(roleSession('mirela-vukovic', runtime, { role: 'mirela-vukovic', authorityAdmin: 'secret', territoryAAdmin: 'must-not-use' }).credential, 'secret');
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
