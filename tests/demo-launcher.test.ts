import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ClientApplication } from '../apps/client-server/src/app.js';
import { startDemo } from '../apps/demo/src/launcher.js';

let dataDir: string;
let demo: Awaited<ReturnType<typeof startDemo>>;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'fctp-demo-'));
  const ports = await Promise.all(Array.from({ length: 4 }, () => freePort()));
  demo = await startDemo({ dataDir, ports: { authority: ports[0]!, policy: ports[1]!, simulation: ports[2]!, client: ports[3]! } });
});

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

after(async () => {
  await demo.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('serves authority and Territory resources', async () => {
  const get = (base: string, path: string) => fetch(new URL(path, base));
  const authorityInfo = await get(demo.origins.authority, '/local/info');
  const policyInfo = await get(demo.origins.policy, '/local/info');
  const simulationInfo = await get(demo.origins.simulation, '/local/info');
  assert.equal(authorityInfo.status, 200);
  assert.equal(policyInfo.status, 200);
  assert.equal(simulationInfo.status, 200);
  const authorityData = await authorityInfo.json() as { ids: { actor: { registry: string } } };
  const policyData = await policyInfo.json() as { ids: { actor: string; map: string } };
  const simulationData = await simulationInfo.json() as { ids: { actor: string; map: string } };
  assert.equal((await get(demo.origins.authority, authorityData.ids.actor.registry)).status, 200);
  assert.equal((await get(demo.origins.policy, policyData.ids.actor)).status, 200);
  assert.equal((await get(demo.origins.policy, policyData.ids.map)).status, 200);
  assert.equal((await get(demo.origins.simulation, simulationData.ids.actor)).status, 200);
  assert.equal((await get(demo.origins.simulation, simulationData.ids.map)).status, 401);
  assert.equal((await get(demo.origins.client, '/../../package.json')).status, 404);
});

test('exposes the client API and persists client state under the demo data directory', async () => {
  const healthResponse = await fetch(new URL('/api/health', demo.origins.client));
  assert.equal(healthResponse.status, 200);
  assert.match(healthResponse.headers.get('content-type') ?? '', /application\/json/);
  const healthBody = await healthResponse.text();
  for (const secret of ['demo-authority-admin', 'demo-policy-admin', 'demo-sim-admin', demo.origins.authority, demo.origins.policy, demo.origins.simulation]) {
    assert.equal(healthBody.includes(secret), false, secret);
  }
  const storeBody = await readFile(join(dataDir, 'client.store.json'), 'utf8');
  assert.ok(storeBody.length > 0);
  const application = (demo as unknown as { application?: ClientApplication }).application;
  assert.ok(application);
  const servers = await application.state.read((state) => Object.keys(state.servers));
  assert.deepEqual(servers, []);
});

test('provides deterministic player and governor login without exposing bindings or credentials publicly', async () => {
  const host = new URL(demo.origins.authority).host;
  const login = async (handle: string, password: string) => {
    const response = await fetch(new URL('/api/accounts/login', demo.origins.client), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, password, homeOrigin: demo.origins.authority })
    });
    assert.equal(response.status, 200);
    return await response.json() as { account: { id: string; handle: string; login: { status: string } }; clientToken: string; status: string };
  };
  const readAccounts = async (clientToken: string) => {
    const response = await fetch(new URL('/api/accounts', demo.origins.client), { headers: { Authorization: `Bearer ${clientToken}` } });
    assert.equal(response.status, 200);
    return await response.json() as { accounts: Array<{ id: string; handle: string }> };
  };
  const player = await login(`@player@${host}`, 'demo-player-password');
  const governor = await login(`@governor@${host}`, 'demo-governor-password');
  assert.equal(player.status, 'signed-in');
  assert.equal(governor.status, 'signed-in');
  assert.equal(player.account.handle, `@player@${host}`);
  assert.equal(governor.account.handle, `@governor@${host}`);

  const application = demo.application;
  assert.ok(application);
  assert.equal(typeof application.resolveAdministratorCredential, 'function');
  assert.equal(await application.resolveAdministratorCredential(governor.account.id, demo.policy.ids.actor), 'demo-policy-admin');
  assert.equal(await application.resolveAdministratorCredential(governor.account.id, demo.simulation.ids.actor), 'demo-sim-admin');
  assert.equal(await application.resolveAdministratorCredential(governor.account.id, demo.authority.ids.actor.registry), 'demo-authority-admin');
  await assert.rejects(application.resolveAdministratorCredential(player.account.id, demo.policy.ids.actor));

  const playerAccounts = await readAccounts(player.clientToken);
  assert.deepEqual(playerAccounts.accounts.map((account) => ({ id: account.id, handle: account.handle })), [{ id: player.account.id, handle: `@player@${host}` }]);
  const governorAccounts = await readAccounts(governor.clientToken);
  assert.deepEqual(governorAccounts.accounts.map((account) => ({ id: account.id, handle: account.handle })), [{ id: governor.account.id, handle: `@governor@${host}` }]);

  const accountsBody = JSON.stringify(playerAccounts);
  for (const secret of ['demo-player-password', 'demo-governor-password', 'demo-authority-admin', 'demo-policy-admin', 'demo-sim-admin', 'administratorBindings', 'administratorCredentials', player.clientToken, governor.clientToken, `@governor@${host}`]) {
    assert.equal(accountsBody.includes(secret), false, secret);
  }
});

test('provisions a second Player account and vessel that both Territories enroll', async () => {
  const host = new URL(demo.origins.authority).host;
  const login = async (handle: string, password: string) => {
    const response = await fetch(new URL('/api/accounts/login', demo.origins.client), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, password, homeOrigin: demo.origins.authority })
    });
    assert.equal(response.status, 200);
    return await response.json() as { account: { id: string; handle: string; login: { status: string } }; clientToken: string; status: string };
  };
  const player = await login(`@player@${host}`, 'demo-player-password');
  const player2 = await login(`@player-2@${host}`, 'demo-player-2-password');
  assert.equal(player2.status, 'signed-in');
  assert.equal(player2.account.handle, `@player-2@${host}`);
  assert.notEqual(player2.account.id, player.account.id);
  assert.deepEqual(Object.keys(demo.authority.ids.vessels).sort(), ['player', 'player-2']);
  assert.notEqual(demo.authority.ids.vessels.player, demo.authority.ids.vessels['player-2']);

  const vessel2 = demo.authority.ids.vessels['player-2']!;
  for (const origin of [demo.origins.policy, demo.origins.simulation]) {
    const discovery = await fetch(new URL('/api/servers', demo.origins.client), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin })
    });
    assert.equal(discovery.status, 200);
  }
  const refresh = await fetch(new URL('/api/production/refresh', demo.origins.client), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${player2.clientToken}` },
    body: JSON.stringify({ accountId: player2.account.id, vesselId: vessel2 })
  });
  assert.equal(refresh.status, 200);
  const productionResponse = await fetch(new URL(`/api/production?accountId=${encodeURIComponent(player2.account.id)}&vesselId=${encodeURIComponent(vessel2)}`, demo.origins.client), {
    headers: { Authorization: `Bearer ${player2.clientToken}` }
  });
  assert.equal(productionResponse.status, 200);
  const production = await productionResponse.json() as { data?: { operations?: Array<{ authorityId?: string }> } };
  const authorities = new Set((production.data?.operations ?? []).map((operation) => operation.authorityId));
  assert.ok(authorities.has(demo.policy.ids.actor));
  assert.ok(authorities.has(demo.simulation.ids.actor));
});

test('publishes the outbound fixture route and both public Policy ports', async () => {
  const outbound = `${demo.origins.policy}/objects/routes/outbound`;
  assert.ok(demo.policy.ids.routes.map(String).includes(outbound));
  const routeResponse = await fetch(outbound);
  assert.equal(routeResponse.status, 200);
  const route = await routeResponse.json() as { from: string; to: string };
  assert.equal(route.from, `${demo.origins.policy}/objects/ports/west`);
  assert.equal(route.to, `${demo.origins.simulation}/objects/boundaries/east`);

  const ledger = await demo.policy.territory.ledger;
  assert.deepEqual([...ledger.admission.publicPorts].sort(), [...demo.policy.ids.ports].sort());
});

test('demo restart preserves admission changes and disabled accounts without reprovisioning credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-demo-restart-'));
  const ports = await Promise.all(Array.from({ length: 4 }, () => freePort()));
  const options = { dataDir: directory, ports: { authority: ports[0]!, policy: ports[1]!, simulation: ports[2]!, client: ports[3]! } };
  let fixture = await startDemo(options);
  const post = async (path: string, body: unknown, clientToken?: string) => fetch(new URL(path, fixture.origins.client), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(clientToken === undefined ? {} : { Authorization: `Bearer ${clientToken}` }) }, body: JSON.stringify(body)
  });
  const get = async (path: string, clientToken: string) => fetch(new URL(path, fixture.origins.client), {
    headers: { Authorization: `Bearer ${clientToken}` }
  });
  try {
    const host = new URL(fixture.origins.authority).host;
    const login = await post('/api/accounts/login', { handle: `@governor@${host}`, password: 'demo-governor-password', homeOrigin: fixture.origins.authority });
    assert.equal(login.status, 200);
    const { account, clientToken } = await login.json() as { account: { id: string }; clientToken: string };
    assert.equal((await post('/api/servers', { origin: fixture.origins.authority }, clientToken)).status, 200);
    const admission = await post('/api/administration/controls', {
      accountId: account.id, authorityId: fixture.policy.ids.actor, control: 'admission', inputs: { publicPorts: [fixture.policy.ids.ports[0]] }
    }, clientToken);
    assert.equal(admission.status, 200);
    const availability = await post('/api/administration/controls', {
      accountId: account.id, authorityId: fixture.authority.ids.actor.home, control: 'availability', inputs: { handle: `@player@${host}`, available: false }
    }, clientToken);
    assert.equal(availability.status, 200);
    const disabledBefore = await post('/api/accounts/login', { handle: `@player@${host}`, password: 'demo-player-password', homeOrigin: fixture.origins.authority });
    assert.equal((await disabledBefore.json() as { status: string }).status, 'unavailable');
    await fixture.close();
    fixture = await startDemo(options);
    assert.deepEqual((await fixture.policy.territory.ledger).admission.publicPorts, [fixture.policy.ids.ports[0]]);
    const persistedAccounts = await get('/api/accounts', clientToken);
    assert.equal(persistedAccounts.status, 200, 'the persisted client session survives restart');
    assert.deepEqual((await persistedAccounts.json() as { accounts: Array<{ id: string }> }).accounts.map((entry) => entry.id), [account.id]);
    const disabledAfter = await post('/api/accounts/login', { handle: `@player@${host}`, password: 'demo-player-password', homeOrigin: fixture.origins.authority });
    assert.equal(disabledAfter.status, 401);
    assert.equal((await disabledAfter.json() as { status: string }).status, 'unavailable');
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('closes all listeners cleanly', async () => {
  const clientResponse = await fetch(new URL('/', demo.origins.client));
  assert.equal(clientResponse.status, 200);
  const html = await clientResponse.text();
  assert.match(html, /href=["']\/styles\.css["']/);
  assert.match(html, /src=["']\/dist\/client\/main\.js["']/);
  const stylesheet = await fetch(new URL('/styles.css', demo.origins.client));
  assert.equal(stylesheet.status, 200);
  assert.ok((await stylesheet.text()).length > 0);
  const bundle = await fetch(new URL('/dist/client/main.js', demo.origins.client));
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get('content-type') ?? '', /javascript/);
  assert.ok((await bundle.text()).length > 0);
  await demo.close();
  await assert.rejects(fetch(new URL('/', demo.origins.client)));
});

test('rejects nonpositive and duplicate ports', async () => {
  await assert.rejects(startDemo({ dataDir: join(dataDir, 'invalid'), ports: { authority: 0 } }), RangeError);
  await assert.rejects(startDemo({ dataDir: join(dataDir, 'duplicate'), ports: { authority: 4201, policy: 4201 } }), RangeError);
});
