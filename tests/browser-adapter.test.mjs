import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { createApplicationTransport } from '../scripts/browser-api.mjs';
import { parseCommand, runtimeConfigRoot, socketPathFor, validateRuntimeConfig } from '../scripts/browser.mjs';
import { createJsonLineServer, createSerializedDispatcher } from '../scripts/browser-transport.mjs';

function config() {
  const homeOrigin = 'http://127.0.0.1:4100';
  return {
    runId: 'isolated-run',
    clientOrigin: 'http://127.0.0.1:4103',
    accounts: [
      { name: 'player', handle: '@player@127.0.0.1:4100', homeOrigin },
      { name: 'player-2', handle: '@player-2@127.0.0.1:4100', homeOrigin },
      { name: 'governor', handle: '@governor@127.0.0.1:4100', homeOrigin }
    ]
  };
}

test('command parser accepts application commands and exact DOM operation arity', () => {
  assert.deepEqual(parseCommand(['player', 'login']), { role: 'player', command: 'login' });
  assert.equal(parseCommand(['player-2', 'page', '/api/servers']).command, 'page');
  assert.equal(parseCommand(['governor', 'action', '{"id":"refresh","endpoint":"/api/explore/refresh","method":"POST"}', '{}']).command, 'action');
  assert.equal(parseCommand(['player', 'result', 'action:1']).command, 'result');
  assert.deepEqual(parseCommand(['tavi-lindgren', 'fill', 'ref-x', 'some value']), { role: 'tavi-lindgren', command: 'fill', ref: 'ref-x', value: 'some value' });
  assert.throws(() => parseCommand(['', 'page', '/api/servers']), /Unknown browser account/);
  assert.throws(() => parseCommand(['bad_account', 'view']), /Unknown browser account/);
  assert.throws(() => parseCommand(['sana-okonkwo', 'post']), /Unknown browser command/);
  assert.throws(() => parseCommand(['sana-okonkwo', 'click', 'ref', 'extra']), /Invalid operands/);
  assert.throws(() => parseCommand(['player', 'page']), /Invalid operands/);
  assert.throws(() => parseCommand(['player', 'page', 'https://foreign.test/api/servers']), /foreign|origin|path/i);
  assert.throws(() => parseCommand(['player', 'page', '/world/servers']), /world|path/i);
  assert.throws(() => parseCommand(['player', 'action', 'not-json', '{}']), /JSON|descriptor/i);
  assert.throws(() => parseCommand(['player', 'action', '{"id":"a","endpoint":"/api/servers","method":"POST"}', 'not-json']), /JSON|inputs/i);
  assert.throws(() => parseCommand(['player', 'result']), /Invalid operands/);
});

test('runtime config defaults to run and resolves relative overrides from the repository root', () => {
  assert.equal(runtimeConfigRoot({}), join(process.cwd(), 'run'));
  assert.equal(runtimeConfigRoot({ FCTP_BROWSER_CONFIG_ROOT: 'isolated/config' }), join(process.cwd(), 'isolated/config'));
});

test('runtime parsing accepts configured application accounts and rejects duplicate or incomplete accounts', () => {
  assert.doesNotThrow(() => validateRuntimeConfig(config()));
  assert.equal(socketPathFor(config(), 'player-2', '/tmp/root'), '/tmp/root/runtime/isolated-run/player-2/browser.sock');
  assert.throws(() => socketPathFor(config(), 'observer', '/tmp/root'), /Unknown browser account/);

  const duplicate = config();
  duplicate.accounts.push({ name: 'player', handle: '@other@127.0.0.1:4100', homeOrigin: duplicate.accounts[0].homeOrigin });
  assert.throws(() => validateRuntimeConfig(duplicate), /duplicate|unique/i);

  const empty = config();
  empty.accounts = [];
  assert.throws(() => validateRuntimeConfig(empty), /account/i);

  const missingHandle = config();
  missingHandle.accounts[0].handle = '';
  assert.throws(() => validateRuntimeConfig(missingHandle), /handle/i);

  const foreignHome = config();
  foreignHome.accounts[0].homeOrigin = 'ftp://127.0.0.1:4100';
  assert.throws(() => validateRuntimeConfig(foreignHome), /origin/i);

  const foreignClient = config();
  foreignClient.clientOrigin = 'ftp://127.0.0.1:4103';
  assert.throws(() => validateRuntimeConfig(foreignClient), /origin/i);

  const noRun = config();
  delete noRun.runId;
  assert.throws(() => validateRuntimeConfig(noRun), /run/i);
});

let demo;
let configDirectory;
let transportOptions;

before(async () => {
  const ports = await Promise.all(Array.from({ length: 4 }, () => freePort()));
  configDirectory = await mkdtemp(join(tmpdir(), 'browser-adapter-demo-'));
  const { startDemo } = await import('../apps/demo/src/launcher.ts');
  demo = await startDemo({ dataDir: configDirectory, ports: { authority: ports[0], policy: ports[1], simulation: ports[2], client: ports[3] } });
  const host = new URL(demo.origins.authority).host;
  transportOptions = {
    origin: demo.origins.client,
    accounts: {
      player: { name: 'player', handle: `@player@${host}`, homeOrigin: demo.origins.authority },
      governor: { name: 'governor', handle: `@governor@${host}`, homeOrigin: demo.origins.authority }
    },
    passwords: { player: 'demo-player-password', governor: 'demo-governor-password' }
  };
});

after(async () => {
  await demo?.close();
  if (configDirectory) await rm(configDirectory, { recursive: true, force: true });
});

function transport(account) {
  return createApplicationTransport({ origin: transportOptions.origin, account: transportOptions.accounts[account] });
}

function descriptor(endpoint, inputs = []) {
  return { id: `test:${endpoint}`, label: 'Test action', endpoint, method: 'POST', inputs: inputs.map((name) => ({ name, required: true })), blockers: [] };
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

test('live application login, page, action, and result return the same application models', async () => {
  const player = transport('player');
  const login = await player.login(transportOptions.passwords.player);
  assert.equal(record(login).status, 'signed-in');
  assert.equal(record(record(login).account).handle, transportOptions.accounts.player.handle);

  const accounts = await player.page('/api/accounts');
  assert.equal(Array.isArray(record(accounts).accounts), true);
  assert.ok(record(accounts).accounts.some((account) => record(account).handle === transportOptions.accounts.player.handle));

  const publicServers = await player.page('/api/servers');
  assert.equal(typeof record(publicServers).servers, 'object');
  assert.equal(typeof record(publicServers).authorities, 'object');

  const discovered = await player.action(descriptor('/api/servers', ['origin']), { origin: demo.origins.authority });
  assert.ok(record(discovered).servers !== undefined || Array.isArray(record(discovered).servers));

  const entry = await player.action(descriptor(`/api/logistics/vessels/${encodeURIComponent(demo.authority.ids.vessels.player)}/entry`, ['territoryId', 'portId', 'routeId']), {
    territoryId: demo.policy.ids.actor,
    portId: demo.policy.ids.ports[0],
    routeId: demo.policy.ids.routes[0]
  });
  const action = record(entry).action;
  assert.equal(typeof record(action).id, 'string');
  const result = await player.result(record(action).id);
  assert.equal(record(record(result).data).action.id, record(action).id);
  assert.equal(record(record(record(result).data).action).accountId, record(record(login).account).id);

  for (const value of [login, accounts, publicServers, discovered, entry, result]) {
    const text = JSON.stringify(value);
    assert.equal(text.includes(transportOptions.passwords.player), false);
    assert.equal(text.includes('nativeToken'), false);
  }
});

test('wrong password, unavailable target, and upstream failures stay bounded without secrets', async () => {
  const player = transport('player');
  await assert.rejects(() => player.login('definitely-wrong-password'), (error) => {
    assert.ok(error.message.length <= 500);
    assert.equal(error.message.includes('definitely-wrong-password'), false);
    return true;
  });

  const unavailable = createApplicationTransport({ origin: 'http://127.0.0.1:1', account: transportOptions.accounts.player });
  await assert.rejects(() => unavailable.page('/api/servers'), (error) => {
    assert.ok(error.message.length <= 500);
    assert.equal(error.message.includes(transportOptions.passwords.player), false);
    return true;
  });
  await assert.rejects(() => unavailable.login(transportOptions.passwords.player), (error) => {
    assert.ok(error.message.length <= 500);
    assert.equal(error.message.includes(transportOptions.passwords.player), false);
    return true;
  });
});

test('two account contexts stay independent and caller account substitution is rejected', async () => {
  const player = transport('player');
  const governor = transport('governor');
  const playerLogin = await player.login(transportOptions.passwords.player);
  const governorLogin = await governor.login(transportOptions.passwords.governor);
  const playerId = record(record(playerLogin).account).id;
  const governorId = record(record(governorLogin).account).id;
  assert.notEqual(playerId, governorId);

  const playerActivity = await player.page('/api/activity');
  const governorActivity = await governor.page('/api/activity');
  assert.equal(record(playerActivity).context.accountId, playerId);
  assert.equal(record(governorActivity).context.accountId, governorId);

  const callerScoped = await player.page(`/api/activity?accountId=${encodeURIComponent(governorId)}`);
  assert.equal(record(callerScoped).context.accountId, playerId, 'caller accountId is never trusted for page reads');

  await assert.rejects(() => player.action(descriptor('/api/drafts', ['kind', 'fields']), {
    kind: 'asset',
    fields: { name: 'Substitution', text: 'not this account' },
    accountId: governorId
  }), /account|substitut|conflict/i);
  await assert.rejects(() => player.action(descriptor(`/api/accounts/${encodeURIComponent(governorId)}/logout`)), /account|substitut|conflict/i);
  await assert.rejects(() => player.action(descriptor('/api/accounts/login'), { handle: governorId, password: transportOptions.passwords.governor }), /login/i);
  const retained = await governor.page('/api/accounts');
  assert.equal(retained.accounts.find((entry) => entry.id === governorId).login.status, 'signed-in');
});

test('action rejects disabled descriptors, non-POST methods, foreign origins, queries, fragments, and world paths', async () => {
  const player = transport('player');
  await player.login(transportOptions.passwords.player);
  const disabled = { ...descriptor('/api/explore/refresh'), enabled: false };
  await assert.rejects(() => player.action(disabled), /disabled|enabled/i);
  await assert.rejects(() => player.action({ ...descriptor('/api/explore/refresh'), blockers: ['Required input unavailable'] }), /block|unavailable/i);
  await assert.rejects(() => player.action({ ...descriptor('/api/explore/refresh'), method: 'GET' }), /POST|method/i);
  for (const endpoint of [
    'https://foreign.test/api/explore/refresh',
    '//foreign.test/api/explore/refresh',
    'http://user:secret@127.0.0.1/api/explore/refresh',
    '/api/explore/refresh?accountId=other',
    '/api/explore/refresh#fragment',
    '/world/local/explore',
    '/local/explore',
    'api/explore/refresh'
  ]) {
    await assert.rejects(() => player.action(descriptor(endpoint)), /endpoint|origin|path|query|fragment|world/i, endpoint);
  }
});

test('public application reads work before login without account scope', async () => {
  const player = createApplicationTransport({ origin: transportOptions.origin, account: { name: 'newcomer', handle: `@newcomer@${new URL(demo.origins.authority).host}` } });
  const servers = await player.page('/api/servers');
  assert.equal(typeof record(servers).servers, 'object');
  const places = await player.page('/api/explore/places');
  assert.ok(record(places).data !== undefined);
});

test('application transport refuses redirects and suppresses echoed login passwords', async () => {
  const requests = [];
  const redirected = createApplicationTransport({
    origin: transportOptions.origin, account: transportOptions.accounts.player,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new globalThis.Response(null, { status: 307, headers: { Location: 'https://foreign.test/receive' } });
    }
  });
  await assert.rejects(() => redirected.login('fixture-redirect-password'));
  assert.equal(requests.length, 1);
  assert.ok(['error', 'manual'].includes(requests[0].init.redirect), 'fetch must not follow a redirect with login credentials');

  const echoed = createApplicationTransport({
    origin: transportOptions.origin, account: transportOptions.accounts.player,
    fetch: async () => globalThis.Response.json({ error: 'Rejected fixture-echo-password' }, { status: 401 })
  });
  await assert.rejects(() => echoed.login('fixture-echo-password'), (error) => {
    assert.equal(error.message.includes('fixture-echo-password'), false);
    return true;
  });
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

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
