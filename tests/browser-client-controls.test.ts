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

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function refsFor(view: TextView, label: string | RegExp, within?: string): string[] {
  const markdown = within ? view.markdown.split(`## ${within}`)[1]?.split('\n## ')[0] ?? '' : view.markdown;
  return markdown.split('\n\n').flatMap((block) => {
    const matched = typeof label === 'string' ? block.includes(label) : label.test(block);
    if (!matched) return [];
    const refs = [...block.matchAll(/\[([A-Za-z0-9-]+)\](?: \(disabled\))?/g)];
    return refs.length ? [refs.at(-1)![1]!] : [];
  });
}

function refFor(view: TextView, label: string | RegExp, within?: string): string {
  const matches = refsFor(view, label, within);
  assert.equal(matches.length, 1, `Expected one control labelled ${String(label)}${within ? ` in ${within}` : ''}, found ${matches.length}`);
  return matches[0]!;
}

function firstRefFor(view: TextView, label: string | RegExp, within?: string): string {
  const matches = refsFor(view, label, within);
  assert.ok(matches.length > 0, `Expected at least one control labelled ${String(label)}${within ? ` in ${within}` : ''}`);
  return matches[0]!;
}

function control(session: BrowserSession, view: TextView, label: string | RegExp, operation: 'click' | 'submit' = 'click', within?: string): Promise<TextView> {
  return session[operation](refFor(view, label, within));
}

function fill(session: BrowserSession, view: TextView, label: string | RegExp, value: string, within?: string): Promise<TextView> {
  return session.fill(refFor(view, label, within), value);
}

function controlBlock(view: TextView, ref: string): string {
  return view.markdown.split('\n\n').find((block) => block.includes(`[${ref}]`)) ?? '';
}

async function selectReaderTarget(session: BrowserSession, view: TextView, target: string, within: string): Promise<TextView> {
  const refs = refsFor(view, /(?:reference|insertion|production)\s+target/i, within);
  if (refs.length !== 1) return view;
  const options = [...controlBlock(view, refs[0]!).matchAll(/([^,{}]+?)=([^\s,}]+)/g)];
  const option = options.find((candidate) => new RegExp(target, 'i').test(candidate[1]!));
  if (!option) return view;
  return session.select(refs[0]!, option[2]!);
}

async function useReaderReference(session: BrowserSession, view: TextView, name: string, target: 'tool' | 'ingredient', within: string): Promise<TextView> {
  const direct = new RegExp(`use\\s+${escapeRegExp(name)}\\s+as\\s+(?:an?\\s+)?(?:production\\s+)?${target}(?:\\s+(?:reference|uri))?`, 'i');
  const refs = refsFor(view, direct, 'Resource reader');
  if (refs.length === 1) return session.click(refs[0]!);
  view = await selectReaderTarget(session, view, target, within);
  return control(session, view, /use\s+.*\s+as\s+(?:an?\s+)?(?:reader\s+)?reference|insert\s+.*\s+reference/i, 'click', 'Resource reader');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function accountActionRef(view: TextView, handle: string, action: 'Select account' | 'Log out'): string {
  const start = view.markdown.indexOf(`${handle} ·`);
  assert.ok(start >= 0, `Expected the account list entry for ${handle}`);
  const match = new RegExp(`${action} \\[([A-Za-z0-9-]+)\\]`).exec(view.markdown.slice(start));
  assert.ok(match, `Expected a ${action} reference for ${handle}`);
  return match[1]!;
}


interface ClientSessionRecord {
  accountId: string;
  clientToken: string;
}

async function loginClientSession(origin: string, handle: string, password: string, homeOrigin?: string): Promise<ClientSessionRecord> {
  const response = await fetch(new URL('/api/accounts/login', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, password, ...(homeOrigin ? { homeOrigin } : {}) })
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { account?: { id?: string }; clientToken?: string };
  assert.ok(body.account?.id);
  assert.ok(body.clientToken);
  return { accountId: body.account.id, clientToken: body.clientToken };
}

function authorizedHeaders(session: ClientSessionRecord, content = false): Record<string, string> {
  return { Authorization: `Bearer ${session.clientToken}`, ...(content ? { 'Content-Type': 'application/json' } : {}) };
}



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

  view = await browser.reload();
  assert.match(view.markdown, new RegExp(escapeRegExp(handle)));
  assert.match(view.markdown, /signed[ -]?in/i, 'the saved client session survives a reload');
  view = await browser.click(accountActionRef(view, handle, 'Select account'));

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

  view = await browser.reload();
  assert.doesNotMatch(view.markdown.split('## Accounts')[1]?.split('\n## ')[0] ?? '', /signed[ -]?in/i, 'a logged-out client session is not retained');
  assert.match(view.markdown, /No known accounts/i);

  view = await fill(browser, view, /origin/i, origins.authority, 'Connections');
  view = await control(browser, view, /add server|discover server|connect server/i, 'submit', 'Connections');
  view = await control(browser, view, /registry authority details/i, 'click', 'Connections');
  assert.match(view.markdown, new RegExp(escapeRegExp(services.authority.ids.actor.registry)));
  assert.match(view.markdown, /registry/i);
  assert.match(view.markdown, /home/i);
});

test('rendered Accounts keeps per-account sessions, scopes activity by the selected session, and logs out one account', { timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-browser-sessions-'));
  const [authorityPort, clientPort] = await Promise.all([freePort(), freePort()]);
  const origins = { authority: `http://127.0.0.1:${authorityPort}` };
  const services: {
    authority?: Awaited<ReturnType<typeof createAuthorityApp>>;
    application?: Awaited<ReturnType<typeof createClientApplication>>;
    clientServer?: Awaited<ReturnType<typeof startClientServer>>;
  } = {};
  const browsers: BrowserSession[] = [];
  t.after(async () => {
    await Promise.allSettled([
      ...browsers.map((browser) => browser.close()),
      ...(services.clientServer ? [services.clientServer.close()] : []),
      ...(services.application ? [services.application.close()] : []),
      ...(services.authority ? [services.authority.authority.close()] : [])
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  const playerPassword = 'browser-sessions-player-password';
  const otherPassword = 'browser-sessions-other-password';
  services.authority = await createAuthorityApp({
    origin: origins.authority, storeFile: join(directory, 'authority.json'), adminSecret,
    playerNames: ['player', 'other'], accountPasswords: { player: playerPassword, other: otherPassword }
  });
  await services.authority.authority.listen(authorityPort!, '127.0.0.1');
  services.application = await createClientApplication({ storeFile: join(directory, 'client.store.json') });
  services.clientServer = await startClientServer({ port: clientPort!, application: services.application });
  const browser = await createBrowserSession({ url: services.clientServer.origin, allowedOrigins: [services.clientServer.origin, origins.authority] });
  browsers.push(browser);
  let view = await browser.view();

  const playerHandle = `@player@${new URL(origins.authority).host}`;
  const otherHandle = `@other@${new URL(origins.authority).host}`;
  view = await fill(browser, view, /handle/i, playerHandle, 'Accounts');
  view = await fill(browser, view, /password/i, playerPassword, 'Accounts');
  view = await fill(browser, view, /home origin/i, origins.authority, 'Accounts');
  view = await control(browser, view, /sign in|log in/i, 'submit', 'Accounts');

  view = await fill(browser, view, /handle/i, otherHandle, 'Accounts');
  view = await fill(browser, view, /password/i, otherPassword, 'Accounts');
  view = await fill(browser, view, /home origin/i, origins.authority, 'Accounts');
  view = await control(browser, view, /sign in|log in/i, 'submit', 'Accounts');
  assert.match(view.markdown, new RegExp(escapeRegExp(playerHandle)));
  assert.match(view.markdown, new RegExp(escapeRegExp(otherHandle)));

  const playerAccount = (await services.application.state.read((state) => Object.values(state.accounts))).find((candidate) => candidate.handle === playerHandle);
  const otherAccount = (await services.application.state.read((state) => Object.values(state.accounts))).find((candidate) => candidate.handle === otherHandle);
  assert.ok(playerAccount);
  assert.ok(otherAccount);
  const playerActionId = 'action:sessions:player';
  const otherActionId = 'action:sessions:other';
  await services.application.state.transaction((state) => {
    for (const [id, account] of [[playerActionId, playerAccount], [otherActionId, otherAccount]] as const) {
      state.actions[id] = {
        id,
        statusUrl: `/api/activity/${encodeURIComponent(id)}`,
        accountId: account.id,
        targetId: services.authority!.ids.actor.registry,
        resultReferences: [],
        intent: { kind: 'mine', inputs: { owner: account.handle } },
        submittedAt: '2026-10-29T12:00:00Z',
        submission: { status: 'accepted', result: id },
        outcome: { status: 'pending', evidence: [] }
      };
    }
  });

  view = await browser.click(accountActionRef(view, playerHandle, 'Select account'));
  view = await control(browser, view, /refresh activity/i, 'click', 'Activity');
  assert.match(view.markdown, new RegExp(escapeRegExp(playerActionId)));
  assert.equal(view.markdown.includes(otherActionId), false, 'the player session does not read the other account activity');

  view = await browser.click(accountActionRef(view, otherHandle, 'Select account'));
  view = await control(browser, view, /refresh activity/i, 'click', 'Activity');
  assert.match(view.markdown, new RegExp(escapeRegExp(otherActionId)));
  assert.equal(view.markdown.includes(playerActionId), false, 'the other session does not read the player activity');

  view = await browser.reload();
  assert.match(view.markdown, new RegExp(escapeRegExp(playerHandle)));
  assert.match(view.markdown, new RegExp(escapeRegExp(otherHandle)));

  view = await browser.click(accountActionRef(view, otherHandle, 'Log out'));
  assert.match(view.markdown, /Signed out/i);
  view = await browser.reload();
  assert.match(view.markdown, new RegExp(escapeRegExp(playerHandle)));
  assert.equal(view.markdown.includes(otherHandle), false, 'logging out one account leaves the other saved session');

  view = await browser.click(accountActionRef(view, playerHandle, 'Select account'));
  view = await control(browser, view, /refresh activity/i, 'click', 'Activity');
  assert.match(view.markdown, new RegExp(escapeRegExp(playerActionId)));
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
  services.policy = await createPolicyApp({
    origin: origins.policy, storeFile: join(directory, 'policy.json'), authorityOrigin: origins.authority,
    playerNames: ['player'], peerOrigin: origins.simulation, adminSecret,
    additionalRoutes: [{
      id: `${origins.policy}/objects/routes/outbound`, type: 'Route', name: 'Outbound Passage',
      from: `${origins.policy}/objects/ports/west`, to: `${origins.simulation}/objects/boundaries/east`
    }]
  });
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
  const account = (await services.application!.state.read((state) => Object.values(state.accounts))).find((candidate) => candidate.handle === handle);
  assert.ok(account, 'the Explore scenario keeps the signed-in account identity');
  const clientSession = await loginClientSession(services.clientServer.origin, handle, password, origins.authority);

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

  const entryResponse = await fetch(new URL(`/api/logistics/vessels/${encodeURIComponent(vessel)}/entry`, services.clientServer.origin), {
    method: 'POST', headers: authorizedHeaders(clientSession, true),
    body: JSON.stringify({ accountId: account.id, territoryId: services.policy.ids.actor, portId: services.policy.ids.ports[0], routeId: services.policy.ids.routes[0] })
  });
  assert.equal(entryResponse.status, 200);
  await services.authority.authority.server.processOutbox();
  assert.equal(await services.policy.host.server.processInbox(), 1);

  view = await fill(browser, view, /logistics vessel uri/i, vessel, 'Logistics & Production');
  assert.match(view.markdown, /traverse selected route/i);
  view = await control(browser, view, /traverse selected route/i, 'click', 'Logistics & Production');
  assert.match(view.markdown, /East Haven|West Haven|Coastal Passage|step|progress/i);
  assert.match(view.markdown, /(?:pending|progress|observ|completed|movement)/i);
  view = await control(browser, view, /refresh (?:journey|traverse|route|progress)|refresh selected (?:journey|route)/i, 'click', 'Logistics & Production');
  assert.match(view.markdown, /(?:completed|observed|local-movement|movement|West Haven)/i, 'the refreshed journey shows the observed local movement outcome');
  view = await control(browser, view, /(?:open|view|back to).*(?:selected )?route.*explore|explore.*(?:selected )?route/i, 'click', 'Logistics & Production');
  assert.match(view.markdown, /##\s+explore\b/i);
  assert.match(view.markdown, /Coastal Passage/i);
  const traversedRoute = services.policy.ids.routes[1]!;
  const plan = (await services.application!.state.read((state) => Object.values(state.routePlans))).find((candidate) => (candidate as Record<string, unknown>).accountId === account.id && JSON.stringify(candidate).includes(traversedRoute));
  assert.ok(plan, 'the rendered logistics selection is backed by a saved Explore plan');
  view = await control(browser, view, /traverse technical details|journey technical details/i, 'click', 'Logistics & Production');
  assert.match(view.markdown, new RegExp(escapeRegExp(String((plan as Record<string, unknown>).id))), 'exact plan identity is disclosed in technical details');
  assert.match(view.markdown, new RegExp(escapeRegExp(services.policy!.ids.routes[1]!)), 'exact traversed route identity is disclosed in technical details');
  assert.equal(view.markdown.includes(nativeToken), false);
  assert.equal(view.markdown.includes(password), false);
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
  const clientSession = await loginClientSession(services.clientServer.origin, handle, password, origins.authority);
  const entryResponse = await fetch(new URL(`/api/logistics/vessels/${encodeURIComponent(vessel)}/entry`, services.clientServer.origin), {
    method: 'POST', headers: authorizedHeaders(clientSession, true),
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
  const referenceControl = firstRefFor(view, /(?:read|open|inspect|view).*(?:resource|reference|variety|cargo|stock|recipe|asset|ore|metal)/i, 'Logistics & Production');
  assert.doesNotMatch(controlBlock(view, referenceControl), /https?:\/\//, 'logistics resource links use label text rather than raw URIs');
  view = await browser.click(referenceControl);
  assert.match(view.markdown, /##\s+resource reader/i);
  view = await control(browser, view, /resource technical details/i, 'click', 'Resource reader');
  assert.ok([services.policy.ids.varieties.ore, services.policy.ids.varieties.metal].some((id) => view.markdown.includes(id)), 'the shared reader discloses the exact referenced resource identity');
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
  const clientSession = await loginClientSession(services.clientServer.origin, handle, password, origins.authority);
  const entryResponse = await fetch(new URL(`/api/logistics/vessels/${encodeURIComponent(vessel)}/entry`, services.clientServer.origin), {
    method: 'POST', headers: authorizedHeaders(clientSession, true),
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

test('rendered Author & Publish creates, saves, reopens, publishes and reads an Asset, then builds a Variety with production references', { timeout: 240_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-browser-task09-authoring-'));
  const [authorityPort, clientPort] = await Promise.all([freePort(), freePort()]);
  const origins = { authority: `http://127.0.0.1:${authorityPort}` };
  const services: {
    authority?: Awaited<ReturnType<typeof createAuthorityApp>>;
    application?: Awaited<ReturnType<typeof createClientApplication>>;
    clientServer?: Awaited<ReturnType<typeof startClientServer>>;
  } = {};
  const browsers: BrowserSession[] = [];
  t.after(async () => {
    await Promise.allSettled([
      ...browsers.map((browser) => browser.close()),
      ...(services.clientServer ? [services.clientServer.close()] : []),
      ...(services.application ? [services.application.close()] : []),
      ...(services.authority ? [services.authority.authority.close()] : [])
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  const password = 'browser-task09-authoring-password';
  services.authority = await createAuthorityApp({ origin: origins.authority, storeFile: join(directory, 'authority.json'), adminSecret, playerNames: ['player'], accountPasswords: { player: password } });
  await services.authority.authority.listen(authorityPort!, '127.0.0.1');
  let failCatalog = false;
  let failMedia: string | undefined;
  const applicationFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const target = request ? request.url : String(input);
    const url = new URL(target);
    if (failCatalog && url.pathname === '/local/authoring') throw new TypeError('browser authoring catalog unavailable');
    if (failMedia !== undefined && target === failMedia) throw new TypeError('browser media source unavailable');
    return fetch(input, init);
  };
  services.application = await createClientApplication({ storeFile: join(directory, 'client.store.json'), fetch: applicationFetch });
  services.clientServer = await startClientServer({ port: clientPort!, application: services.application });
  const browser = await createBrowserSession({ url: services.clientServer.origin, allowedOrigins: [services.clientServer.origin, origins.authority] });
  browsers.push(browser);
  let view = await browser.view();
  const handle = `@player@${new URL(origins.authority).host}`;
  view = await fill(browser, view, /handle/i, handle, 'Accounts');
  view = await fill(browser, view, /password/i, password, 'Accounts');
  view = await fill(browser, view, /home origin/i, origins.authority, 'Accounts');
  view = await control(browser, view, /sign in|log in/i, 'submit', 'Accounts');
  assert.match(view.markdown, /signed[ -]?in/i);

  const authoring = 'Author & Publish';
  assert.match(view.markdown, /##\s+author\s*(?:&|and)\s*publish/i);
  assert.match(view.markdown, /library/i);

  view = await control(browser, view, /refresh library/i, 'click', authoring);
  view = await browser.select(refFor(view, /draft kind/i, authoring), 'asset');
  view = await fill(browser, view, /draft name/i, 'Harbor Signal', authoring);
  view = await fill(browser, view, /draft text/i, '<b>inert buoy notes</b>', authoring);
  view = await control(browser, view, /save draft|save asset/i, 'click', authoring);
  assert.match(view.markdown, /saved/i);

  view = await control(browser, view, /open (?:saved )?draft/i, 'click', authoring);
  assert.match(view.markdown, /Harbor Signal/);
  view = await fill(browser, view, /draft text/i, '<b>inert buoy notes revised</b>', authoring);
  view = await control(browser, view, /save draft|save asset/i, 'click', authoring);
  view = await control(browser, view, /publish/i, 'click', authoring);
  assert.match(view.markdown, /published|accepted/i);

  view = await control(browser, view, /refresh library/i, 'click', authoring);
  const account = (await services.application.state.read((state) => Object.values(state.accounts))).find((candidate) => candidate.handle === handle);
  assert.ok(account);
  const clientSession = await loginClientSession(services.clientServer.origin, handle, password, origins.authority);
  const libraryResponse = await fetch(new URL(`/api/library?accountId=${encodeURIComponent(account.id)}`, services.clientServer.origin), { headers: authorizedHeaders(clientSession) });
  assert.equal(libraryResponse.status, 200);
  const library = await libraryResponse.json() as { data?: { assets?: Array<{ id: string; name?: string }>; varieties?: Array<{ id: string; name?: string }>; grants?: Array<{ id: string; asset?: string; variety?: string; grantee?: string }> } };
  const asset = library.data?.assets?.find((candidate) => candidate.name === 'Harbor Signal');
  assert.ok(asset, `Expected the published Asset in the library: ${JSON.stringify(library)}`);
  const assetDocumentResponse = await fetch(asset.id);
  assert.equal(assetDocumentResponse.status, 200);
  const assetDocument = await assetDocumentResponse.json() as { media?: Array<{ url?: string }> };
  const mediaUrl = assetDocument.media?.find((candidate) => typeof candidate.url === 'string')?.url;
  assert.ok(mediaUrl, 'the published Asset advertises text media');

  failMedia = mediaUrl;
  view = await control(browser, view, /read .*harbor signal|open .*harbor signal/i, 'click', authoring);
  assert.match(view.markdown, /Harbor Signal/);
  assert.match(view.markdown, /unavailable/i, 'a failed media observation is visible');
  assert.match(view.markdown, /browser media source unavailable/, 'the failed media observation shows its error');

  failMedia = undefined;
  view = await control(browser, view, /read .*harbor signal|open .*harbor signal/i, 'click', authoring);
  assert.match(view.markdown, /inert buoy notes revised/i);
  assert.match(view.markdown, /<b>inert buoy notes revised<\/b>/, 'authored text is rendered inertly');

  view = await control(browser, view, /use .*asset|select .*asset reference|use as asset/i, 'click', 'Resource reader');
  assert.match(view.markdown, new RegExp(escapeRegExp(asset.id)), 'reference selection inserts the exact Asset identity');

  view = await browser.select(refFor(view, /draft kind/i, authoring), 'variety');
  view = await fill(browser, view, /draft name/i, 'Signal Alloy', authoring);
  view = await fill(browser, view, /mass/i, '2.5', authoring);
  view = await fill(browser, view, /version/i, '1', authoring);
  if (!view.markdown.includes(asset.id)) view = await fill(browser, view, /asset (?:reference|uri)/i, asset.id, authoring);
  assert.match(view.markdown, new RegExp(escapeRegExp(asset.id)));

  view = await control(browser, view, /add production entry/i, 'click', authoring);
  view = await browser.select(refFor(view, /production kind/i, authoring), 'manufacture');
  view = await fill(browser, view, /production time|duration/i, '2', authoring);
  view = await useReaderReference(browser, view, 'Harbor Signal', 'tool', authoring);
  assert.match(view.markdown, new RegExp(`tool uri:\\s*${escapeRegExp(asset.id)}`, 'i'), 'reader tool selection inserts the exact resource identity');
  view = await control(browser, view, /add ingredient/i, 'click', authoring);
  view = await useReaderReference(browser, view, 'Harbor Signal', 'ingredient', authoring);
  assert.match(view.markdown, new RegExp(`variety uri:\\s*${escapeRegExp(asset.id)}`, 'i'), 'reader ingredient selection inserts the exact resource identity');
  view = await fill(browser, view, /count \(stack\)/i, '2', authoring);
  view = await control(browser, view, /add location/i, 'click', authoring);
  view = await fill(browser, view, /area id uri|area id/i, 'https://places.test/workshop', authoring);
  view = await fill(browser, view, /area name/i, 'Workshop', authoring);
  view = await fill(browser, view, /territory uri/i, 'https://places.test/territory', authoring);
  view = await control(browser, view, /add yield/i, 'click', authoring);
  view = await fill(browser, view, /probability/i, '0.75', authoring);
  view = await fill(browser, view, /^count:/i, '2', authoring);

  view = await control(browser, view, /save draft|save variety/i, 'click', authoring);
  view = await control(browser, view, /publish/i, 'click', authoring);
  assert.match(view.markdown, /published|accepted/i);
  view = await control(browser, view, /refresh library/i, 'click', authoring);
  assert.match(view.markdown, /Signal Alloy/);
  assert.match(view.markdown, /grant/i);
  view = await control(browser, view, /read .*signal alloy|open .*signal alloy/i, 'click', authoring);
  assert.match(view.markdown, /ingredients?/i);
  assert.match(view.markdown, /workshop/i);
  assert.match(view.markdown, /0\.75/);
  view = await control(browser, view, /technical details/i, 'click', 'Resource reader');
  assert.match(view.markdown, new RegExp(escapeRegExp(asset.id)), 'the exact resource identity is disclosed');

  const refreshedResponse = await fetch(new URL(`/api/library?accountId=${encodeURIComponent(account.id)}`, services.clientServer.origin), { headers: authorizedHeaders(clientSession) });
  assert.equal(refreshedResponse.status, 200);
  const refreshed = await refreshedResponse.json() as { data?: { varieties?: Array<{ id: string; name?: string; asset?: string; production?: unknown[] }>; grants?: Array<{ asset?: string; variety?: string; grantee?: string }> } };
  const variety = refreshed.data?.varieties?.find((candidate) => candidate.name === 'Signal Alloy');
  assert.ok(variety);
  assert.equal(variety.asset, asset.id);
  assert.ok(Array.isArray(variety.production));
  const manufactured = (variety.production as Array<Record<string, unknown>>).find((entry) => entry.type === 'manufacture');
  assert.ok(manufactured);
  assert.equal(manufactured.tool, asset.id, 'the saved Production tool retains the selected resource identity');
  const ingredients = Array.isArray(manufactured.ingredients) ? manufactured.ingredients as Array<Record<string, unknown>> : [];
  assert.equal(ingredients[0]?.variety, asset.id, 'the saved Production ingredient retains the selected resource identity');
  const grant = refreshed.data?.grants?.find((candidate) => candidate.asset === asset.id && candidate.variety === variety.id);
  assert.ok(grant, 'the published Variety retains real AssetGrant evidence');
  assert.equal(grant.grantee, services.authority.ids.players['player']);

  failCatalog = true;
  view = await control(browser, view, /refresh library/i, 'click', authoring);
  const staleCatalog = await services.application.state.read((state) => Object.values(state.observations).find((observation) => observation.source === `${origins.authority}/local/authoring`));
  assert.ok(staleCatalog);
  assert.equal(staleCatalog.state, 'stale');
  const staleError = staleCatalog.error;
  const staleObservedAt = staleCatalog.observedAt;
  assert.ok(staleError);
  assert.ok(staleObservedAt);
  assert.match(view.markdown, /stale/i, 'a failed library refresh keeps a visible stale source state');
  assert.ok(view.markdown.includes(staleError), 'a failed library refresh shows the source error');
  assert.ok(view.markdown.includes(staleObservedAt), 'a failed library refresh shows the observation time');
  failCatalog = false;

  const nativeToken = account.login.status === 'signed-in' ? account.login.nativeToken : '';
  assert.equal(view.markdown.includes(nativeToken), false);
});

test('rendered Author & Publish preserves extension-bearing Production on a no-op reopen and save, then creates a separate draft explicitly', { timeout: 180_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-browser-task09-drafts-'));
  const [authorityPort, clientPort] = await Promise.all([freePort(), freePort()]);
  const origins = { authority: `http://127.0.0.1:${authorityPort}` };
  const services: {
    authority?: Awaited<ReturnType<typeof createAuthorityApp>>;
    application?: Awaited<ReturnType<typeof createClientApplication>>;
    clientServer?: Awaited<ReturnType<typeof startClientServer>>;
  } = {};
  const browsers: BrowserSession[] = [];
  t.after(async () => {
    await Promise.allSettled([
      ...browsers.map((browser) => browser.close()),
      ...(services.clientServer ? [services.clientServer.close()] : []),
      ...(services.application ? [services.application.close()] : []),
      ...(services.authority ? [services.authority.authority.close()] : [])
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  const password = 'browser-task09-drafts-password';
  services.authority = await createAuthorityApp({ origin: origins.authority, storeFile: join(directory, 'authority.json'), adminSecret, playerNames: ['player'], accountPasswords: { player: password } });
  await services.authority.authority.listen(authorityPort!, '127.0.0.1');
  services.application = await createClientApplication({ storeFile: join(directory, 'client.store.json') });
  services.clientServer = await startClientServer({ port: clientPort!, application: services.application });
  const browser = await createBrowserSession({ url: services.clientServer.origin, allowedOrigins: [services.clientServer.origin, origins.authority] });
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
  const clientSession = await loginClientSession(services.clientServer.origin, handle, password, origins.authority);
  const production = [
    {
      type: 'manufacture',
      duration: 2,
      tool: 'https://tools.test/hammer',
      ingredientNote: 'entry extension',
      ingredients: [
        { variety: 'https://resources.test/ore', count: 2, data: { grade: 'A' }, extension: { tag: 'stack' } },
        { id: 'https://items.test/catalyst', variety: 'https://resources.test/catalyst', data: { reusable: false }, extension: { tag: 'item' } }
      ],
      location: [{ id: 'https://places.test/workshop', name: 'Workshop', territory: 'https://places.test/territory', extension: { tag: 'area' } }],
      yield: [{ probability: 0.75, count: 2, data: { purity: 'high' }, extension: { tag: 'outcome' } }]
    },
    {
      type: 'mine',
      duration: 1,
      extension: { tag: 'second entry' },
      yield: [{ probability: 1, count: 1, data: {}, extension: { tag: 'second outcome' } }]
    }
  ];
  const createdResponse = await fetch(new URL('/api/drafts', services.clientServer.origin), {
    method: 'POST',
    headers: authorizedHeaders(clientSession, true),
    body: JSON.stringify({ accountId: account.id, kind: 'variety', fields: { name: 'Extension Alloy', mass: 2.5, version: '1', production } })
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as { draft: { id: string } };
  const draftId = created.draft.id;
  const authoring = 'Author & Publish';

  view = await control(browser, view, /refresh library/i, 'click', authoring);
  assert.match(view.markdown, /Extension Alloy/);
  view = await control(browser, view, /open (?:saved )?draft/i, 'click', authoring);
  view = await control(browser, view, /save draft|save variety/i, 'click', authoring);

  const savedResponse = await fetch(new URL(`/api/drafts/${encodeURIComponent(draftId)}?accountId=${encodeURIComponent(account.id)}`, services.clientServer.origin), { headers: authorizedHeaders(clientSession) });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json() as { draft: { fields: { production?: unknown[] } } };
  assert.deepEqual(saved.draft.fields.production, production, 'a no-op save preserves the complete Production entries, ingredients, areas, yields and extension fields');
  const stored = await services.application.state.read((state) => state.drafts[draftId] as { fields?: { production?: unknown[] } } | undefined);
  assert.deepEqual(stored?.fields?.production, production, 'the store retains the same extension-bearing Production after the no-op save');

  view = await control(browser, view, /new draft/i, 'click', authoring);
  view = await browser.select(refFor(view, /draft kind/i, authoring), 'variety');
  view = await fill(browser, view, /draft name/i, 'Second Extension Alloy', authoring);
  view = await fill(browser, view, /mass/i, '1', authoring);
  view = await fill(browser, view, /version/i, '2', authoring);
  view = await control(browser, view, /save draft|save variety/i, 'click', authoring);

  const libraryResponse = await fetch(new URL(`/api/library?accountId=${encodeURIComponent(account.id)}`, services.clientServer.origin), { headers: authorizedHeaders(clientSession) });
  assert.equal(libraryResponse.status, 200);
  const library = await libraryResponse.json() as { data?: { drafts?: Array<{ id: string; fields?: { name?: string; production?: unknown[] } }> } };
  const drafts = library.data?.drafts ?? [];
  const first = drafts.find((draft) => draft.id === draftId);
  assert.ok(first, 'the extension-bearing draft remains after creating another draft');
  assert.deepEqual(first.fields?.production, production, 'the prior draft is not overwritten by New draft');
  const second = drafts.find((draft) => draft.id !== draftId && draft.fields?.name === 'Second Extension Alloy');
  assert.ok(second, 'New draft created a separate same-kind draft');
});

test('rendered Administration applies structured admission, decides a manual entry request, and resets on account change', { timeout: 240_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-browser-task10-administration-'));
  const [authorityPort, policyPort, clientPort] = await Promise.all([freePort(), freePort(), freePort()]);
  const origins = { authority: `http://127.0.0.1:${authorityPort}`, policy: `http://127.0.0.1:${policyPort}` };
  const services: {
    authority?: Awaited<ReturnType<typeof createAuthorityApp>>;
    policy?: Awaited<ReturnType<typeof createPolicyApp>>;
    application?: Awaited<ReturnType<typeof createClientApplication>>;
    clientServer?: Awaited<ReturnType<typeof startClientServer>>;
  } = {};
  const browsers: BrowserSession[] = [];
  t.after(async () => {
    await Promise.allSettled([
      ...browsers.map((browser) => browser.close()),
      ...(services.clientServer ? [services.clientServer.close()] : []),
      ...(services.application ? [services.application.close()] : []),
      ...(services.policy ? [services.policy.host.close()] : []),
      ...(services.authority ? [services.authority.authority.close()] : [])
    ]);
    await rm(directory, { recursive: true, force: true });
  });

  const playerPassword = 'browser-task10-player-password';
  const otherPassword = 'browser-task10-other-password';
  services.authority = await createAuthorityApp({
    origin: origins.authority, storeFile: join(directory, 'authority.json'), adminSecret, playerNames: ['player', 'other'],
    accountPasswords: { player: playerPassword, other: otherPassword }
  });
  services.policy = await createPolicyApp({ origin: origins.policy, storeFile: join(directory, 'policy.json'), authorityOrigin: origins.authority, playerNames: ['player', 'other'], peerOrigin: origins.authority, adminSecret });
  await services.authority.authority.listen(authorityPort!, '127.0.0.1');
  await services.policy.host.listen(policyPort!, '127.0.0.1');

  const vessel = services.authority.ids.vessels['player']!;
  const playerHandle = `@player@${new URL(origins.authority).host}`;
  const otherHandle = `@other@${new URL(origins.authority).host}`;
  services.application = await createClientApplication({
    storeFile: join(directory, 'client.store.json'),
    administratorBindings: [{ accountId: playerHandle, authorityActorIds: [services.policy.ids.actor], credentialSource: 'territory-admin' }],
    administratorCredentials: { 'territory-admin': adminSecret }
  });
  services.clientServer = await startClientServer({ port: clientPort!, application: services.application });
  for (const origin of Object.values(origins)) await discoverClientOrigin(services.clientServer.origin, origin);
  const browser = await createBrowserSession({ url: services.clientServer.origin, allowedOrigins: [services.clientServer.origin, ...Object.values(origins)] });
  browsers.push(browser);
  let view = await browser.view();
  const administration = 'Administration';
  assert.match(view.markdown, /##\s+administration/i);

  view = await fill(browser, view, /handle/i, playerHandle, 'Accounts');
  view = await fill(browser, view, /password/i, playerPassword, 'Accounts');
  view = await fill(browser, view, /home origin/i, origins.authority, 'Accounts');
  view = await control(browser, view, /sign in|log in/i, 'submit', 'Accounts');
  assert.match(view.markdown, /signed[ -]?in/i);

  view = await browser.select(refFor(view, /administration (?:authority|target)/i, administration), services.policy.ids.actor);
  view = await control(browser, view, /refresh administration/i, 'click', administration);
  const targetControl = controlBlock(view, refsFor(view, /administration (?:authority|target)/i, administration)[0]!);
  assert.match(targetControl, /territory authority|home authority/i, 'unknown authority options have neutral role labels rather than fabricated names');
  const adminProse = (markdown: string): string => (markdown.split(`## ${administration}`)[1]?.split('\n## ')[0] ?? '').replace(/```[\s\S]*?```/g, '').split('\n').filter((line) => !line.includes('Administration target:') && !line.includes('Accepted Registries:') && !line.includes('Accepted Territories:') && !line.includes('Public ports:')).join('\n');
  assert.doesNotMatch(adminProse(view.markdown), new RegExp(escapeRegExp(services.policy.ids.actor)), 'authority identifiers stay out of Administration prose');
  assert.match(view.markdown, /review mode/i);
  assert.match(controlBlock(view, refFor(view, /mining quota/i, administration)), /20/, 'policy form starts with the observed current mining quota');
  view = await browser.select(refFor(view, /review mode/i, administration), 'manual');
  view = await control(browser, view, /apply admission|save admission|update admission/i, 'click', administration);
  assert.match(view.markdown, /manual/i);
  assert.match(view.markdown, /accepted|applied|completed/i);

  const account = (await services.application.state.read((state) => Object.values(state.accounts))).find((candidate) => candidate.handle === playerHandle);
  assert.ok(account);
  const clientSession = await loginClientSession(services.clientServer.origin, playerHandle, playerPassword, origins.authority);
  const entryResponse = await fetch(new URL(`/api/logistics/vessels/${encodeURIComponent(vessel)}/entry`, services.clientServer.origin), {
    method: 'POST', headers: authorizedHeaders(clientSession, true),
    body: JSON.stringify({ accountId: account.id, territoryId: services.policy.ids.actor, portId: services.policy.ids.ports[0], routeId: services.policy.ids.routes[0] })
  });
  assert.equal(entryResponse.status, 200);
  const entryBody = await entryResponse.json() as { action?: { resultReferences?: Array<{ kind: string; id: string }> } };
  const requestId = entryBody.action?.resultReferences?.find((reference) => reference.kind === 'request')?.id;
  assert.ok(requestId);
  await services.authority.authority.server.processOutbox();
  assert.equal(await services.policy.host.server.processInbox(), 1);

  view = await control(browser, view, /refresh administration/i, 'click', administration);
  const administrationProse = adminProse(view.markdown);
  assert.doesNotMatch(administrationProse, new RegExp(escapeRegExp(requestId)), 'request identifiers are disclosed only in technical details');
  assert.doesNotMatch(administrationProse, new RegExp(escapeRegExp(vessel)), 'vessel identifiers are disclosed only in technical details');
  assert.doesNotMatch(administrationProse, new RegExp(escapeRegExp(services.policy.ids.ports[0]!)), 'port identifiers are disclosed only in technical details');
  assert.match(view.markdown, /pending/i);

  view = await control(browser, view, /approve/i, 'click', administration);
  assert.match(view.markdown, /approved|accepted|decision/i);
  await services.policy.host.server.processOutbox();
  await services.authority.authority.server.processInbox();
  view = await control(browser, view, /refresh administration/i, 'click', administration);
   assert.match(view.markdown, /berth|event/i, 'the approval result distinguishes the decision from the resulting berth event');
   view = await control(browser, view, /entry request technical details/i, 'click', administration);
   assert.match(view.markdown, new RegExp(escapeRegExp(requestId)));
  assert.equal(view.markdown.includes(account.login.status === 'signed-in' ? account.login.nativeToken : ''), false);

  view = await control(browser, view, /log ?out/i, 'click', 'Accounts');
  view = await fill(browser, view, /handle/i, otherHandle, 'Accounts');
  view = await fill(browser, view, /password/i, otherPassword, 'Accounts');
  view = await fill(browser, view, /home origin/i, origins.authority, 'Accounts');
  view = await control(browser, view, /sign in|log in/i, 'submit', 'Accounts');
  assert.match(view.markdown, /signed[ -]?in/i);
  assert.equal(view.markdown.includes(requestId), false, 'changing the selected account resets administration data');
  view = await control(browser, view, /refresh administration/i, 'click', administration);
  assert.equal(view.markdown.includes(requestId), false, 'an unbound account cannot see another account administration data');
});
