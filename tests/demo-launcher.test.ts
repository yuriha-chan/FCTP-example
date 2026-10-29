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

test('serves authority and Territory resources plus a credential-free client config', async () => {
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

  const configResponse = await get(demo.origins.client, '/config.json');
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(config).sort(), ['actors', 'origins']);
  assert.equal(JSON.stringify(config).includes('demo-authority-admin'), false);
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
    return await response.json() as { account: { id: string; handle: string; login: { status: string } }; status: string };
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

  const configBody = await (await fetch(new URL('/config.json', demo.origins.client))).text();
  for (const secret of ['demo-player-password', 'demo-governor-password', 'demo-authority-admin', 'demo-policy-admin', 'demo-sim-admin', 'administratorBindings', 'administratorCredentials']) {
    assert.equal(configBody.includes(secret), false, secret);
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
  const configResponse = await fetch(new URL('/config.json', demo.origins.client));
  const configBody = await configResponse.text();
  for (const secret of ['demo-authority-admin', 'demo-policy-admin', 'demo-sim-admin']) {
    assert.equal(configBody.includes(secret), false);
  }
  await demo.close();
  await assert.rejects(fetch(new URL('/config.json', demo.origins.client)));
});

test('rejects nonpositive and duplicate ports', async () => {
  await assert.rejects(startDemo({ dataDir: join(dataDir, 'invalid'), ports: { authority: 0 } }), RangeError);
  await assert.rejects(startDemo({ dataDir: join(dataDir, 'duplicate'), ports: { authority: 4201, policy: 4201 } }), RangeError);
});
