import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBrowserSession, type BrowserSession, type TextView } from '../dist/apps/browser-harness/index.js';
import { deriveDiplomaticToken } from '@fctp/auth';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';
import { startClientServer } from '../apps/demo/src/client-server.js';
import type { ActionHandler } from '../apps/client-server/src/actions.js';
import { createClientApplication } from '../apps/client-server/src/app.js';

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

function refFor(view: TextView, label: string | RegExp, within?: string): string {
  const markdown = within ? view.markdown.split(`## ${within}`)[1]?.split('\n## ')[0] ?? '' : view.markdown;
  const matches = markdown.split('\n\n').flatMap((block) => {
    const matched = typeof label === 'string' ? block.includes(label) : label.test(block);
    if (!matched) return [];
    const refs = [...block.matchAll(/\[([A-Za-z0-9-]+)\](?: \(disabled\))?/g)];
    return refs.length ? [refs.at(-1)![1]!] : [];
  });
  assert.equal(matches.length, 1, `Expected one control labelled ${String(label)}${within ? ` in ${within}` : ''}, found ${matches.length}`);
  return matches[0]!;
}

function control(session: BrowserSession, view: TextView, label: string | RegExp, operation: 'click' | 'submit' = 'click', within?: string): Promise<TextView> {
  return session[operation](refFor(view, label, within));
}

function fill(session: BrowserSession, view: TextView, label: string | RegExp, value: string, within?: string): Promise<TextView> {
  return session.fill(refFor(view, label, within), value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

test('rendered accounts and connections controls log in, log out, and discover a public server', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-browser-accounts-'));
  const [authorityPort, policyPort, simulationPort, clientPort] = await Promise.all(Array.from({ length: 4 }, freePort));
  const origins = { authority: `http://127.0.0.1:${authorityPort}`, policy: `http://127.0.0.1:${policyPort}`, simulation: `http://127.0.0.1:${simulationPort}` };
  const services: {
    authority?: Awaited<ReturnType<typeof createAuthorityApp>>;
    policy?: Awaited<ReturnType<typeof createPolicyApp>>;
    simulation?: Awaited<ReturnType<typeof createSimulationApp>>;
    application?: Awaited<ReturnType<typeof createClientApplication>>;
    clientServer?: Awaited<ReturnType<typeof startClientServer>>;
  } = {};
  const browsers: BrowserSession[] = [];
  t.after(async () => {
    await Promise.allSettled([
      ...browsers.map((browser) => browser.close()),
      ...(services.clientServer ? [services.clientServer.close()] : []),
      ...(services.application ? [services.application.close()] : []),
      ...(services.simulation ? [services.simulation.host.close()] : []),
      ...(services.policy ? [services.policy.host.close()] : []),
      ...(services.authority ? [services.authority.authority.close()] : [])
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  const playerPassword = 'browser-player-login-password';
  services.authority = await createAuthorityApp({
    origin: origins.authority,
    storeFile: join(directory, 'authority.json'),
    adminSecret,
    playerNames: ['player'],
    accountPasswords: { player: playerPassword }
  });
  services.policy = await createPolicyApp({ origin: origins.policy, storeFile: join(directory, 'policy.json'), authorityOrigin: origins.authority, playerNames: ['player'], peerOrigin: origins.simulation, adminSecret });
  services.simulation = await createSimulationApp({ origin: origins.simulation, storeFile: join(directory, 'simulation.json'), authorityOrigin: origins.authority, playerNames: ['player'], peerOrigin: origins.policy, adminSecret });
  await services.authority.authority.listen(authorityPort!, '127.0.0.1');
  await services.policy.host.listen(policyPort!, '127.0.0.1');
  await services.simulation.host.listen(simulationPort!, '127.0.0.1');
  const activityActionId = 'action:browser:1';
  const activityTargetId = services.authority.ids.actor.registry;
  const activityEvidenceSource = 'https://registry.test:4200/local/registry/state';
  const activityReconciliations: string[] = [];
  const activityHandler: ActionHandler = {
    async submit() { throw new Error('Activity refresh must not submit'); },
    async reconcile(input) {
      activityReconciliations.push(`${input.accountId}|${input.targetId}|${input.intent.kind}`);
      return { status: 'completed', evidence: [{ source: activityEvidenceSource, observedAt: '2026-10-29T12:05:00Z', changes: { job: 'job:browser' } }] };
    }
  };
  services.application = await createClientApplication({
    storeFile: join(directory, 'client.store.json'),
    actionHandlers: { mine: activityHandler }
  });
  services.clientServer = await startClientServer({
    port: clientPort!,
    config: {
      origins,
      actors: {
        registry: services.authority.ids.actor.registry,
        home: services.authority.ids.actor.home,
        player: services.authority.ids.actor.player,
        policy: services.policy.ids.actor,
        simulation: services.simulation.ids.actor
      }
    },
    application: services.application
  });
  const browser = await createBrowserSession({ url: services.clientServer.origin, allowedOrigins: [services.clientServer.origin, ...Object.values(origins)] });
  browsers.push(browser);
  let view = await browser.view();
  assert.match(view.markdown, /##\s+accounts\b/i);
  assert.match(view.markdown, /##\s+connections\b/i);

  const handle = `@player@${new URL(origins.authority).host}`;
  view = await fill(browser, view, /handle/i, handle, 'Accounts');
  view = await fill(browser, view, /password/i, playerPassword, 'Accounts');
  view = await fill(browser, view, /home origin/i, origins.authority, 'Accounts');
  view = await control(browser, view, /sign in|log in/i, 'submit', 'Accounts');
  assert.match(view.markdown, new RegExp(escapeRegExp(handle)));
  assert.match(view.markdown, /signed[ -]?in/i);
  assert.equal(view.markdown.includes(playerPassword), false);

  const signedInAccounts = await services.application!.state.read((state) => Object.values(state.accounts));
  const activityAccount = signedInAccounts.find((account) => account.handle === handle);
  assert.ok(activityAccount);
  await services.application!.state.transaction((state) => {
    state.actions[activityActionId] = {
      id: activityActionId,
      statusUrl: `/api/activity/${encodeURIComponent(activityActionId)}`,
      accountId: activityAccount.id,
      targetId: activityTargetId,
      resultReferences: [{ kind: 'request', id: 'request:browser' }],
      intent: { kind: 'mine', inputs: { count: 2, note: 'gameplay value' } },
      submittedAt: '2026-10-29T12:00:00Z',
      submission: { status: 'accepted', result: 'request:browser' },
      outcome: { status: 'pending', evidence: [] }
    };
    state.observations['activity:evidence'] = {
      state: 'stale',
      source: activityEvidenceSource,
      observedAt: '2026-10-29T12:00:00Z',
      value: { job: 'job:browser' },
      error: 'peer server unavailable'
    };
  });

  assert.match(view.markdown, /##\s+activity\b/i);
  view = await control(browser, view, 'Refresh Activity', 'click', 'Activity');
  assert.match(view.markdown, new RegExp(escapeRegExp(activityActionId)));
  assert.match(view.markdown, /mine/i);
  assert.match(view.markdown, /pending/i);
  assert.match(view.markdown, /accepted/i);
  assert.match(view.markdown, new RegExp(escapeRegExp('request:browser')));
  const activityNativeToken = activityAccount.login.status === 'signed-in' ? activityAccount.login.nativeToken : '';
  assert.equal(view.markdown.includes(activityNativeToken), false);

  view = await control(browser, view, new RegExp(`Open action ${escapeRegExp(activityActionId)}`));
  assert.match(view.markdown, new RegExp(escapeRegExp(activityActionId)));
  assert.match(view.markdown, /pending/i);
  assert.match(view.markdown, /2/);
  view = await control(browser, view, new RegExp(`Action ${escapeRegExp(activityActionId)} details`));
  assert.match(view.markdown, new RegExp(escapeRegExp(activityAccount.id)));
  assert.match(view.markdown, new RegExp(escapeRegExp(activityTargetId)));

  view = await control(browser, view, 'Refresh selected action');
  assert.deepEqual(activityReconciliations, [`${activityAccount.id}|${activityTargetId}|mine`]);
  assert.match(view.markdown, /completed/i);
  view = await control(browser, view, 'Observation details');
  assert.match(view.markdown, new RegExp(escapeRegExp(activityEvidenceSource)));
  assert.match(view.markdown, /stale/i);
  assert.match(view.markdown, /peer server unavailable/i);
  assert.equal(view.markdown.includes(activityNativeToken), false);

  view = await control(browser, view, /log ?out/i, 'click', 'Accounts');
  assert.match(view.markdown, /signed[ -]?out/i);
  assert.match(view.markdown, new RegExp(escapeRegExp(handle)));

  view = await fill(browser, view, /origin/i, origins.authority, 'Connections');
  view = await control(browser, view, /add server|discover server|connect server/i, 'submit', 'Connections');
  view = await control(browser, view, /registry authority details/i, 'click', 'Connections');
  assert.match(view.markdown, new RegExp(escapeRegExp(services.authority.ids.actor.registry)));
  assert.match(view.markdown, /registry/i);
  assert.match(view.markdown, /home/i);
});

test('rendered Explore discovers places, capabilities and blockers, saves a route, and carries it to Logistics & Production', { timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-browser-explore-'));
  const [authorityPort, policyPort, simulationPort, clientPort] = await Promise.all(Array.from({ length: 4 }, freePort));
  const origins = { authority: `http://127.0.0.1:${authorityPort}`, policy: `http://127.0.0.1:${policyPort}`, simulation: `http://127.0.0.1:${simulationPort}` };
  const services: {
    authority?: Awaited<ReturnType<typeof createAuthorityApp>>;
    policy?: Awaited<ReturnType<typeof createPolicyApp>>;
    simulation?: Awaited<ReturnType<typeof createSimulationApp>>;
    application?: Awaited<ReturnType<typeof createClientApplication>>;
    clientServer?: Awaited<ReturnType<typeof startClientServer>>;
  } = {};
  const browsers: BrowserSession[] = [];
  t.after(async () => {
    await Promise.allSettled([
      ...browsers.map((browser) => browser.close()),
      ...(services.clientServer ? [services.clientServer.close()] : []),
      ...(services.application ? [services.application.close()] : []),
      ...(services.simulation ? [services.simulation.host.close()] : []),
      ...(services.policy ? [services.policy.host.close()] : []),
      ...(services.authority ? [services.authority.authority.close()] : [])
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  const password = 'browser-explore-password';
  services.authority = await createAuthorityApp({ origin: origins.authority, storeFile: join(directory, 'authority.json'), adminSecret, playerNames: ['player'], accountPasswords: { player: password } });
  services.policy = await createPolicyApp({ origin: origins.policy, storeFile: join(directory, 'policy.json'), authorityOrigin: origins.authority, playerNames: ['player'], peerOrigin: origins.simulation, adminSecret });
  services.simulation = await createSimulationApp({ origin: origins.simulation, storeFile: join(directory, 'simulation.json'), authorityOrigin: origins.authority, playerNames: ['player'], peerOrigin: origins.policy, adminSecret });
  await services.authority.authority.listen(authorityPort!, '127.0.0.1');
  await services.policy.host.listen(policyPort!, '127.0.0.1');
  await services.simulation.host.listen(simulationPort!, '127.0.0.1');

  const player = services.authority.ids.players['player']!;
  const vessel = services.authority.ids.vessels['player']!;
  const admission = await fetch(`${origins.policy}/local/admin/admission`, {
    method: 'POST', headers: { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicPorts: services.policy.ids.ports })
  });
  assert.equal(admission.status, 200);
  const nativeResponse = await fetch(`${origins.authority}/local/home/issue`, { method: 'POST', headers: { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ actor: player }) });
  assert.equal(nativeResponse.status, 200);
  const nativeToken = (await nativeResponse.json() as { nativeToken: string }).nativeToken;
  await services.authority.home.requestDigest(player, { id: services.policy.ids.actor, inbox: services.policy.host.actor('territory').inbox });
  await services.authority.home.requestDigest(player, { id: services.simulation.ids.actor, inbox: services.simulation.host.actor('territory').inbox });
  assert.equal(await services.authority.authority.server.processOutbox(), 2);
  assert.equal(await services.policy.host.server.processInbox(), 1);
  assert.equal(await services.simulation.host.server.processInbox(), 1);

  services.application = await createClientApplication({ storeFile: join(directory, 'client.store.json') });
  services.clientServer = await startClientServer({
    port: clientPort!,
    config: {
      origins,
      actors: { registry: services.authority.ids.actor.registry, home: services.authority.ids.actor.home, player: services.authority.ids.actor.player, policy: services.policy.ids.actor, simulation: services.simulation.ids.actor }
    },
    application: services.application
  });
  const browser = await createBrowserSession({ url: services.clientServer.origin, allowedOrigins: [services.clientServer.origin, ...Object.values(origins)] });
  browsers.push(browser);
  let view = await browser.view();
  assert.match(view.markdown, /##\s+explore\b/i);
  assert.match(view.markdown, /##\s+logistics\s*&\s*production\b/i);

  const handle = `@player@${new URL(origins.authority).host}`;
  view = await fill(browser, view, /handle/i, handle, 'Accounts');
  view = await fill(browser, view, /password/i, password, 'Accounts');
  view = await fill(browser, view, /home origin/i, origins.authority, 'Accounts');
  view = await control(browser, view, /sign in|log in/i, 'submit', 'Accounts');
  assert.match(view.markdown, /signed[ -]?in/i);
  assert.equal(view.markdown.includes(password), false);
  assert.equal(view.markdown.includes(nativeToken), false);

  view = await fill(browser, view, /server origin/i, origins.policy, 'Connections');
  view = await control(browser, view, /add server|discover server|connect server/i, 'submit', 'Connections');
  view = await fill(browser, view, /server origin/i, origins.simulation, 'Connections');
  view = await control(browser, view, /add server|discover server|connect server/i, 'submit', 'Connections');

  view = await fill(browser, view, /vessel uri/i, vessel, 'Explore');
  view = await control(browser, view, /refresh places/i, 'click', 'Explore');
  assert.match(view.markdown, /East Haven/);
  assert.match(view.markdown, /West Haven/);
  assert.match(view.markdown, /Simulation Harbor/);
  assert.match(view.markdown, /Haven Island/);
  assert.match(view.markdown, /Harbor District/);

  view = await control(browser, view, /open East Haven/i, 'click', 'Explore');
  assert.match(view.markdown, /East Haven/);
  assert.match(view.markdown, /capabilit/i);
  assert.match(view.markdown, /Mine one ore/i);
  assert.match(view.markdown, /Consumes one (?:unit of )?shared reserve/i);
  assert.match(view.markdown, /Load one ore/i);
  assert.match(view.markdown, /no-persisted-local-visit|no persisted local visit/i);
  assert.match(view.markdown, /West Haven/);

  view = await control(browser, view, /open authority for East Haven/i, 'click', 'Explore');
  assert.match(view.markdown, /resource reader/i);
  view = await control(browser, view, /resource technical details/i, 'click', 'Resource reader');
  assert.match(view.markdown, new RegExp(escapeRegExp(services.policy.ids.actor)));
  assert.match(view.markdown, /https?:\/\//);

  view = await control(browser, view, /open onward West Haven/i, 'click', 'Explore');
  assert.match(view.markdown, /West Haven/);
  assert.match(view.markdown, /Simulation Harbor|Coastal Passage/i);

  view = await control(browser, view, /select East Haven as route origin/i, 'click', 'Explore');
  view = await control(browser, view, /select West Haven as route destination/i, 'click', 'Explore');
  view = await control(browser, view, /save route plan/i, 'click', 'Explore');
  assert.match(view.markdown, /Coastal Passage/i);
  view = await control(browser, view, /route technical details/i, 'click', 'Explore');
  assert.match(view.markdown, new RegExp(escapeRegExp(services.policy.ids.ports[0]!)));
  assert.match(view.markdown, new RegExp(escapeRegExp(services.policy.ids.ports[1]!)));

  view = await control(browser, view, /continue to logistics\s*&\s*production/i, 'click', 'Explore');
  assert.match(view.markdown, /##\s+logistics\s*&\s*production\b/i);
  view = await control(browser, view, /selection technical details/i, 'click', 'Logistics & Production');
  assert.match(view.markdown, new RegExp(escapeRegExp(services.policy.ids.ports[0]!)));
  assert.match(view.markdown, new RegExp(escapeRegExp(services.policy.ids.ports[1]!)));
  assert.match(view.markdown, /Coastal Passage/i);
  assert.equal(view.markdown.includes(nativeToken), false);
});

async function discoverClientOrigin(clientOrigin: string, server: string): Promise<void> {
  const response = await fetch(new URL('/api/servers', clientOrigin), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: server })
  });
  assert.equal(response.status, 200);
}

test('rendered Logistics & Production refreshes scoped cargo and executes typed Policy production with blockers, results, and separated stock', { timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-browser-task08-policy-'));
  const [authorityPort, policyPort, simulationPort, clientPort] = await Promise.all(Array.from({ length: 4 }, freePort));
  const origins = { authority: `http://127.0.0.1:${authorityPort}`, policy: `http://127.0.0.1:${policyPort}`, simulation: `http://127.0.0.1:${simulationPort}` };
  const services: {
    authority?: Awaited<ReturnType<typeof createAuthorityApp>>;
    policy?: Awaited<ReturnType<typeof createPolicyApp>>;
    simulation?: Awaited<ReturnType<typeof createSimulationApp>>;
    application?: Awaited<ReturnType<typeof createClientApplication>>;
    clientServer?: Awaited<ReturnType<typeof startClientServer>>;
  } = {};
  const browsers: BrowserSession[] = [];
  t.after(async () => {
    await Promise.allSettled([
      ...browsers.map((browser) => browser.close()),
      ...(services.clientServer ? [services.clientServer.close()] : []),
      ...(services.application ? [services.application.close()] : []),
      ...(services.simulation ? [services.simulation.host.close()] : []),
      ...(services.policy ? [services.policy.host.close()] : []),
      ...(services.authority ? [services.authority.authority.close()] : [])
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  const password = 'browser-task08-policy-password';
  services.authority = await createAuthorityApp({ origin: origins.authority, storeFile: join(directory, 'authority.json'), adminSecret, playerNames: ['player'], accountPasswords: { player: password } });
  services.policy = await createPolicyApp({ origin: origins.policy, storeFile: join(directory, 'policy.json'), authorityOrigin: origins.authority, playerNames: ['player'], peerOrigin: origins.simulation, adminSecret });
  services.simulation = await createSimulationApp({ origin: origins.simulation, storeFile: join(directory, 'simulation.json'), authorityOrigin: origins.authority, playerNames: ['player'], peerOrigin: origins.policy, adminSecret });
  await services.authority.authority.listen(authorityPort!, '127.0.0.1');
  await services.policy.host.listen(policyPort!, '127.0.0.1');
  await services.simulation.host.listen(simulationPort!, '127.0.0.1');

  const player = services.authority.ids.players['player']!;
  const vessel = services.authority.ids.vessels['player']!;
  const adminHeaders = { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' };
  const issued = await fetch(`${origins.authority}/local/home/issue`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: player }) });
  assert.equal(issued.status, 200);
  for (const territory of [services.policy, services.simulation]) {
    await services.authority.home.requestDigest(player, { id: territory.ids.actor, inbox: territory.host.actor('territory').inbox });
    assert.equal(await services.authority.authority.server.processOutbox(), 1);
    assert.equal(await territory.host.server.processInbox(), 1);
  }

  services.application = await createClientApplication({ storeFile: join(directory, 'client.store.json') });
  services.clientServer = await startClientServer({
    port: clientPort!,
    config: { origins, actors: { registry: services.authority.ids.actor.registry, home: services.authority.ids.actor.home, player: services.authority.ids.actor.player, policy: services.policy.ids.actor, simulation: services.simulation.ids.actor } },
    application: services.application
  });
  for (const origin of Object.values(origins)) await discoverClientOrigin(services.clientServer.origin, origin);
  const browser = await createBrowserSession({ url: services.clientServer.origin, allowedOrigins: [services.clientServer.origin, ...Object.values(origins)] });
  browsers.push(browser);
  let view = await browser.view();
  const handle = `@player@${new URL(origins.authority).host}`;
  view = await fill(browser, view, /handle/i, handle, 'Accounts');
  view = await fill(browser, view, /password/i, password, 'Accounts');
  view = await fill(browser, view, /home origin/i, origins.authority, 'Accounts');
  view = await control(browser, view, /sign in|log in/i, 'submit', 'Accounts');
  assert.match(view.markdown, /signed[ -]?in/i);

  const account = (await services.application.state.read((state) => Object.values(state.accounts))).find((candidate) => candidate.handle === handle);
  assert.ok(account);
  const entryResponse = await fetch(new URL(`/api/logistics/vessels/${encodeURIComponent(vessel)}/entry`, services.clientServer.origin), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: account.id, territoryId: services.policy.ids.actor, portId: services.policy.ids.ports[0], routeId: services.policy.ids.routes[0] })
  });
  assert.equal(entryResponse.status, 200);
  await services.authority.authority.server.processOutbox();
  assert.equal(await services.policy.host.server.processInbox(), 1);
  await services.policy.host.server.processOutbox();
  await services.authority.authority.server.processInbox();

  view = await fill(browser, view, /logistics vessel uri/i, vessel, 'Logistics & Production');
  view = await control(browser, view, /refresh vessel/i, 'click', 'Logistics & Production');
  assert.match(view.markdown, /registry/i);
  assert.match(view.markdown, /territory/i);
  assert.match(view.markdown, /cargo|stock/i);
  assert.match(view.markdown, /adoption/i);

  view = await control(browser, view, /refresh production/i, 'click', 'Logistics & Production');
  view = await browser.select(refFor(view, /production authority/i, 'Logistics & Production'), services.policy.ids.actor);
   assert.match(view.markdown, /Mine one ore/i);
  assert.match(view.markdown, /Manufacture one metal/i);
  assert.match(view.markdown, /Load one/i);
  assert.match(view.markdown, /Unload one/i);
  assert.match(view.markdown, /insufficient|blocked|requires|no .*ore/i);

  view = await fill(browser, view, /Mine one ore quantity/i, '2', 'Logistics & Production');
  view = await control(browser, view, /Execute Mine one ore/i, 'click', 'Logistics & Production');
  assert.equal((await services.policy.territory.state).rawInventory[services.policy.ids.varieties.ore], 2);
  assert.match(view.markdown, /completed|evidence|accepted/i);
  view = await control(browser, view, /refresh vessel/i, 'click', 'Logistics & Production');
  assert.match(view.markdown, /Shared stock:.*Warehouse:.*2/i, 'warehouse quantities remain readable without technical JSON');

  view = await control(browser, view, /refresh production/i, 'click', 'Logistics & Production');
  view = await fill(browser, view, /Manufacture one metal quantity/i, '1', 'Logistics & Production');
  view = await control(browser, view, /Execute Manufacture one metal/i, 'click', 'Logistics & Production');
  assert.equal((await services.policy.territory.state).rawInventory[services.policy.ids.varieties.metal], 1);
  assert.match(view.markdown, /completed|evidence|accepted/i);

  const nativeToken = account.login.status === 'signed-in' ? account.login.nativeToken : '';
  const diplomaticToken = await deriveDiplomaticToken(nativeToken, services.policy.ids.actor as never);
  const policyHeaders = { Authorization: `Bearer ${diplomaticToken}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${origins.policy}/local/transfer`, { method: 'POST', headers: policyHeaders, body: JSON.stringify({ direction: 'to-port', variety: services.policy.ids.varieties.metal, count: 1 }) })).status, 200);
  assert.equal((await fetch(`${origins.policy}/local/load`, { method: 'POST', headers: policyHeaders, body: JSON.stringify({ vessel, variety: services.policy.ids.varieties.metal, count: 1 }) })).status, 200);
  await services.policy.host.server.processOutbox();
  await services.authority.authority.server.processInbox();

  view = await control(browser, view, /refresh vessel/i, 'click', 'Logistics & Production');
  assert.match(view.markdown, /Registry cargo/i);
  assert.match(view.markdown, /Territory cargo|Shared stock/i);
  assert.doesNotMatch(view.markdown, /Registry cargo:\s*\{/);
  assert.doesNotMatch(view.markdown, /Shared stock:\s*\{/);
  assert.match(view.markdown, /available|stale|not-retrieved/i);
  view = await control(browser, view, /Logistics technical details/i, 'click', 'Logistics & Production');
  assert.match(view.markdown, new RegExp(escapeRegExp(services.authority.ids.actor.registry)));
  assert.match(view.markdown, new RegExp(escapeRegExp(services.policy.ids.actor)));
  assert.equal(view.markdown.includes(nativeToken), false);
});

test('rendered Simulation production shows pending job progress and completes only after an explicit administrator tick and job refresh', { timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-browser-task08-simulation-'));
  const [authorityPort, policyPort, simulationPort, clientPort] = await Promise.all(Array.from({ length: 4 }, freePort));
  const origins = { authority: `http://127.0.0.1:${authorityPort}`, policy: `http://127.0.0.1:${policyPort}`, simulation: `http://127.0.0.1:${simulationPort}` };
  const services: {
    authority?: Awaited<ReturnType<typeof createAuthorityApp>>;
    policy?: Awaited<ReturnType<typeof createPolicyApp>>;
    simulation?: Awaited<ReturnType<typeof createSimulationApp>>;
    application?: Awaited<ReturnType<typeof createClientApplication>>;
    clientServer?: Awaited<ReturnType<typeof startClientServer>>;
  } = {};
  const browsers: BrowserSession[] = [];
  t.after(async () => {
    await Promise.allSettled([
      ...browsers.map((browser) => browser.close()),
      ...(services.clientServer ? [services.clientServer.close()] : []),
      ...(services.application ? [services.application.close()] : []),
      ...(services.simulation ? [services.simulation.host.close()] : []),
      ...(services.policy ? [services.policy.host.close()] : []),
      ...(services.authority ? [services.authority.authority.close()] : [])
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  const password = 'browser-task08-simulation-password';
  services.authority = await createAuthorityApp({ origin: origins.authority, storeFile: join(directory, 'authority.json'), adminSecret, playerNames: ['player'], accountPasswords: { player: password } });
  services.policy = await createPolicyApp({ origin: origins.policy, storeFile: join(directory, 'policy.json'), authorityOrigin: origins.authority, playerNames: ['player'], peerOrigin: origins.simulation, adminSecret });
  services.simulation = await createSimulationApp({ origin: origins.simulation, storeFile: join(directory, 'simulation.json'), authorityOrigin: origins.authority, playerNames: ['player'], peerOrigin: origins.policy, adminSecret });
  await services.authority.authority.listen(authorityPort!, '127.0.0.1');
  await services.policy.host.listen(policyPort!, '127.0.0.1');
  await services.simulation.host.listen(simulationPort!, '127.0.0.1');

  const player = services.authority.ids.players['player']!;
  const vessel = services.authority.ids.vessels['player']!;
  const adminHeaders = { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' };
  const issued = await fetch(`${origins.authority}/local/home/issue`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: player }) });
  assert.equal(issued.status, 200);
  await services.authority.home.requestDigest(player, { id: services.simulation.ids.actor, inbox: services.simulation.host.actor('territory').inbox });
  assert.equal(await services.authority.authority.server.processOutbox(), 1);
  assert.equal(await services.simulation.host.server.processInbox(), 1);

  services.application = await createClientApplication({ storeFile: join(directory, 'client.store.json') });
  services.clientServer = await startClientServer({
    port: clientPort!,
    config: { origins, actors: { registry: services.authority.ids.actor.registry, home: services.authority.ids.actor.home, player: services.authority.ids.actor.player, policy: services.policy.ids.actor, simulation: services.simulation.ids.actor } },
    application: services.application
  });
  for (const origin of Object.values(origins)) await discoverClientOrigin(services.clientServer.origin, origin);
  const browser = await createBrowserSession({ url: services.clientServer.origin, allowedOrigins: [services.clientServer.origin, ...Object.values(origins)] });
  browsers.push(browser);
  let view = await browser.view();
  const handle = `@player@${new URL(origins.authority).host}`;
  view = await fill(browser, view, /handle/i, handle, 'Accounts');
  view = await fill(browser, view, /password/i, password, 'Accounts');
  view = await fill(browser, view, /home origin/i, origins.authority, 'Accounts');
  view = await control(browser, view, /sign in|log in/i, 'submit', 'Accounts');
  assert.match(view.markdown, /signed[ -]?in/i);

  const account = (await services.application.state.read((state) => Object.values(state.accounts))).find((candidate) => candidate.handle === handle);
  assert.ok(account);
  const entryResponse = await fetch(new URL(`/api/logistics/vessels/${encodeURIComponent(vessel)}/entry`, services.clientServer.origin), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: account.id, territoryId: services.simulation.ids.actor, portId: services.simulation.ids.ports[0], routeId: services.simulation.ids.routes[0] })
  });
  assert.equal(entryResponse.status, 200);
  await services.authority.authority.server.processOutbox();
  assert.equal(await services.simulation.host.server.processInbox(), 1);
  assert.equal((await fetch(`${origins.simulation}/local/admin/tick`, { method: 'POST', headers: adminHeaders, body: '{}' })).status, 200);
  await services.simulation.host.server.processOutbox();
  await services.authority.authority.server.processInbox();

  view = await fill(browser, view, /logistics vessel uri/i, vessel, 'Logistics & Production');
  view = await control(browser, view, /refresh vessel/i, 'click', 'Logistics & Production');
  view = await control(browser, view, /refresh production/i, 'click', 'Logistics & Production');
  view = await browser.select(refFor(view, /production authority/i, 'Logistics & Production'), services.simulation.ids.actor);
  assert.match(view.markdown, /Mine one ore/i);
  view = await fill(browser, view, /Mine one ore quantity/i, '1', 'Logistics & Production');
  view = await control(browser, view, /Execute Mine one ore/i, 'click', 'Logistics & Production');
  assert.match(view.markdown, /pending|progress|queued|remaining/i);

  const actions = await services.application.state.read((state) => Object.values(state.actions).filter((action) => action.accountId === account.id));
  const miningAction = actions.find((action) => action.intent.kind === 'mine' && action.resultReferences.some((reference) => reference.kind === 'job'));
  assert.ok(miningAction);
  const jobReference = miningAction.resultReferences.find((reference) => reference.kind === 'job')!;
  const tickBefore = (await services.simulation.territory.state()).simulation.tick;
  view = await control(browser, view, /production technical details/i, 'click', 'Logistics & Production');
  assert.match(view.markdown, new RegExp(escapeRegExp(jobReference.id)));

  view = await control(browser, view, /refresh selected job/i, 'click', 'Logistics & Production');
  assert.match(view.markdown, /pending|progress|queued|remaining/i);
  assert.equal((await services.simulation.territory.state()).simulation.tick, tickBefore);

  assert.equal((await fetch(`${origins.simulation}/local/admin/tick`, { method: 'POST', headers: adminHeaders, body: '{}' })).status, 200);
  await services.simulation.host.server.processOutbox();
  await services.authority.authority.server.processInbox();
  view = await control(browser, view, /refresh selected job/i, 'click', 'Logistics & Production');
  assert.match(view.markdown, /completed|evidence/i);
  assert.equal((await services.simulation!.territory.state()).simulation.rawStock.find((item) => item.commodity === services.simulation!.ids.varieties.ore)?.count, 1);
  assert.equal(view.markdown.includes(account.login.status === 'signed-in' ? account.login.nativeToken : ''), false);
});
