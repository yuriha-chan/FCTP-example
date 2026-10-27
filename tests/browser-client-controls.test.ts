import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBrowserSession, type BrowserSession, type TextView } from '../dist/apps/browser-harness/index.js';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';
import { startClientServer } from '../apps/demo/src/client-server.js';

const adminSecret = 'browser-client-controls-admin';
const playerNames = ['player', 'player-2'];

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function refFor(view: TextView, label: string, within?: string): string {
  const markdown = within ? view.markdown.split(`## ${within}`)[1]?.split('\n## ')[0] ?? '' : view.markdown;
  const matches = markdown.split('\n\n').flatMap((block) => {
    if (!block.includes(label)) return [];
    const refs = [...block.matchAll(/\[([A-Za-z0-9-]+)\](?: \(disabled\))?/g)];
    return refs.length ? [refs.at(-1)![1]!] : [];
  });
  assert.equal(matches.length, 1, `Expected one control labelled ${label}${within ? ` in ${within}` : ''}, found ${matches.length}`);
  return matches[0]!;
}

function control(session: BrowserSession, view: TextView, label: string, operation: 'click' | 'submit' = 'click', within?: string): Promise<TextView> {
  return session[operation](refFor(view, label, within));
}

function fill(session: BrowserSession, view: TextView, label: string, value: string, within?: string): Promise<TextView> {
  return session.fill(refFor(view, label, within), value);
}

async function login(session: BrowserSession, view: TextView, role: string, credential: string, player = '', vessel = ''): Promise<TextView> {
  view = await session.select(refFor(view, 'Role'), role);
  view = await fill(session, view, 'Player URI', player);
  view = await fill(session, view, 'Vessel URI', vessel);
  view = await fill(session, view, 'Credential', credential);
  return control(session, view, 'Apply session', 'submit');
}

test('rendered client restores bounded operations and administrator controls without stale authority', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-browser-client-controls-'));
  const [authorityPort, policyPort, simulationPort, clientPort] = await Promise.all(Array.from({ length: 4 }, freePort));
  const origins = { authority: `http://127.0.0.1:${authorityPort}`, policy: `http://127.0.0.1:${policyPort}`, simulation: `http://127.0.0.1:${simulationPort}` };
  const services: {
    authority?: Awaited<ReturnType<typeof createAuthorityApp>>;
    policy?: Awaited<ReturnType<typeof createPolicyApp>>;
    simulation?: Awaited<ReturnType<typeof createSimulationApp>>;
    clientServer?: Awaited<ReturnType<typeof startClientServer>>;
  } = {};
  const browsers: BrowserSession[] = [];
  t.after(async () => {
    const results = await Promise.allSettled([
      ...browsers.map((browser) => browser.close()),
      ...(services.clientServer ? [services.clientServer.close()] : []),
      ...(services.simulation ? [services.simulation.host.close()] : []),
      ...(services.policy ? [services.policy.host.close()] : []),
      ...(services.authority ? [services.authority.authority.close()] : [])
    ]);
    await rm(directory, { recursive: true, force: true });
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Browser client-controls fixture cleanup failed');
  });

  services.authority = await createAuthorityApp({ origin: origins.authority, storeFile: join(directory, 'authority.json'), adminSecret, playerNames });
  services.policy = await createPolicyApp({ origin: origins.policy, storeFile: join(directory, 'policy.json'), authorityOrigin: origins.authority, playerNames, peerOrigin: origins.simulation, adminSecret });
  services.simulation = await createSimulationApp({ origin: origins.simulation, storeFile: join(directory, 'simulation.json'), authorityOrigin: origins.authority, playerNames, peerOrigin: origins.policy, adminSecret });
  await services.authority.authority.listen(authorityPort, '127.0.0.1');
  await services.policy.host.listen(policyPort, '127.0.0.1');
  await services.simulation.host.listen(simulationPort, '127.0.0.1');
  services.clientServer = await startClientServer({ port: clientPort!, config: { origins, actors: { registry: services.authority.ids.actor.registry, home: services.authority.ids.actor.home, player: services.authority.ids.actor.player, policy: services.policy.ids.actor, simulation: services.simulation.ids.actor } } });

  const authority = services.authority;
  const policy = services.policy;
  const simulation = services.simulation;
  const adminHeaders = { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' };
  const nativeResponse = await fetch(`${origins.authority}/local/home/issue`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: authority.ids.players['player-2'] }) });
  assert.equal(nativeResponse.status, 200);
  const nativeToken = (await nativeResponse.json() as { nativeToken: string }).nativeToken;
  for (const territory of [policy, simulation]) {
    await authority.home.requestDigest(authority.ids.players['player-2']!, { id: territory.ids.actor, inbox: territory.host.actor('territory').inbox });
    assert.equal(await authority.authority.server.processOutbox(), 1);
    assert.equal(await territory.host.server.processInbox(), 1);
  }

  const browser = await createBrowserSession({ url: services.clientServer.origin, allowedOrigins: [services.clientServer.origin, ...Object.values(origins)] });
  browsers.push(browser);
  let view = await browser.view();
  view = await login(browser, view, 'policy-admin', adminSecret);
  assert.match(view.markdown, /Update policy \[[A-Za-z0-9-]+\] \(disabled\)/);
  assert.match(view.markdown, /Update admission \[[A-Za-z0-9-]+\] \(disabled\)/);
  const initialPolicy = await policy.territory.ledger;
  const policyUpdate = await fetch(`${origins.policy}/local/admin/policy`, { method: 'POST', headers: { Authorization: 'Bearer invalid-admin', 'Content-Type': 'application/json' }, body: JSON.stringify({ ...initialPolicy.state.policy, miningQuota: 9 }) });
  assert.equal(policyUpdate.status, 401, 'a rejected administrator mutation leaves policy unchanged');
  assert.equal((await policy.territory.ledger).state.policy.miningQuota, initialPolicy.state.policy.miningQuota);

  view = await control(browser, view, 'Refresh policy and inventory view');
  view = await browser.select(refFor(view, 'Policy editing mode'), 'advanced');
  const fullPolicy = {
    ...initialPolicy.state.policy,
    miningQuota: 9,
    recipes: [...initialPolicy.state.policy.recipes],
    manufacturePermits: [...initialPolicy.state.policy.manufacturePermits],
    varietyPortPolicy: { 'https://example.test/varieties/custom': 'deny' }
  };
  view = await fill(browser, view, 'Complete policy JSON', JSON.stringify(fullPolicy));
  view = await control(browser, view, 'Update policy');
  assert.equal((await policy.territory.ledger).state.policy.varietyPortPolicy?.['https://example.test/varieties/custom'], 'deny');
  view = await browser.select(refFor(view, 'Admission editing mode'), 'advanced');
  const fullAdmission = {
    registryAcceptance: [authority.ids.actor.registry], territoryAcceptance: [simulation.ids.actor],
    mismatchPolicy: 'declared', publicPorts: [policy.ids.ports[1]]
  };
  view = await fill(browser, view, 'Complete admission JSON', JSON.stringify(fullAdmission));
  view = await control(browser, view, 'Update admission');
  assert.deepEqual((await policy.territory.ledger).admission.registryAcceptance, fullAdmission.registryAcceptance);
  assert.deepEqual((await policy.territory.ledger).admission.territoryAcceptance, fullAdmission.territoryAcceptance);

  view = await browser.select(refFor(view, 'Policy editing mode'), 'common');
  view = await fill(browser, view, 'Mining quota', '11');
  view = await control(browser, view, 'Update policy');
  const commonPolicy = (await policy.territory.ledger).state.policy;
  assert.equal(commonPolicy.miningQuota, 11);
  assert.deepEqual(commonPolicy.recipes, fullPolicy.recipes);
  assert.deepEqual(commonPolicy.manufacturePermits, fullPolicy.manufacturePermits);
  assert.equal(commonPolicy.varietyPortPolicy?.['https://example.test/varieties/custom'], 'deny');

  view = await login(browser, view, 'simulation-admin', adminSecret);
  assert.match(view.markdown, /Configure facilities \[[A-Za-z0-9-]+\] \(disabled\)/);
  view = await control(browser, view, 'Refresh facilities and inventory view');
  view = await fill(browser, view, 'Mining capacity', '12');
  view = await control(browser, view, 'Configure facilities');
  assert.equal((await simulation.territory.state()).simulation.config.miningCapacity, 12);

  view = await login(browser, view, 'policy-admin', adminSecret);
  assert.match(view.markdown, /Update policy \[[A-Za-z0-9-]+\] \(disabled\)/, 'switching sessions invalidates policy readiness');

  view = await login(browser, view, 'player', nativeToken, authority.ids.players['player-2']!, authority.ids.vessels['player-2']!);
  assert.match(view.markdown, /Load vessel cargo \[[A-Za-z0-9-]+\] \(disabled\)/);
  assert.match(view.markdown, /Schedule load \[[A-Za-z0-9-]+\] \(disabled\)/);
  view = await control(browser, view, 'Refresh inventory and completion view', 'click', 'Territory A · Policy rules');
  view = await fill(browser, view, 'Mine ore quantity', '3', 'Territory A · Policy rules');
  view = await control(browser, view, 'Mine selected quantity', 'click', 'Territory A · Policy rules');
  assert.equal((await policy.territory.state).rawInventory[policy.ids.varieties.ore], 3);
  view = await control(browser, view, 'Refresh inventory and completion view', 'click', 'Territory B · Facilities and discrete ticks');
  assert.match(view.markdown, /Schedule load \[[A-Za-z0-9-]+\] \(disabled\)/, 'cargo stays unavailable without a persisted accepted local berth');
});
