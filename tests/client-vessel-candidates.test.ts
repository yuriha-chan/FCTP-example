import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  AccountRecord,
  LogisticsVesselCandidate,
  LogisticsVesselCandidatesData,
  LogisticsVesselData,
  PageResponse,
  SourcedObservation
} from '@fctp/client-sdk';
import { createClientApplication, type ClientApplication } from '../apps/client-server/src/app.js';
import { createClientToken, digestClientToken } from '../apps/client-server/src/sessions.js';
import { startClientServer } from '../apps/demo/src/client-server.js';

const FIRST_SERVER = 'first.test:4200';
const FIRST_AUTHORITY = `https://${FIRST_SERVER}/actors/home`;
const FIRST_ACTOR = `https://${FIRST_SERVER}/actors/sana`;
const OTHER_ACTOR = 'https://other.test:4200/actors/orla';
const SAME_HOST_REGISTRY = `https://${FIRST_SERVER}/actors/registry`;
const FOREIGN_REGISTRY = 'https://foreign.test:4200/actors/registry';

interface UpstreamCall {
  url: string;
  method: string;
  authorization: string;
  body?: string;
}

interface Harness {
  application: ClientApplication;
  client: Awaited<ReturnType<typeof startClientServer>>;
  calls: UpstreamCall[];
  close(): Promise<void>;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function openHarness(
  storeFile: string,
  handler: (call: UpstreamCall) => Response | undefined | Promise<Response | undefined>
): Promise<Harness> {
  const calls: UpstreamCall[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : String(input);
    const method = init?.method ?? request?.method ?? 'GET';
    const headers = new Headers(init?.headers ?? request?.headers);
    const call: UpstreamCall = {
      url,
      method,
      authorization: headers.get('authorization') ?? '',
      ...(typeof init?.body === 'string' ? { body: init.body } : {})
    };
    calls.push(call);
    return await handler(call) ?? json({ error: 'not-found' }, 404);
  };
  const application = await createClientApplication({ storeFile, fetch: fetcher, observationTimeoutMs: 2_000 });
  const client = await startClientServer({ port: 0, application });
  return {
    application,
    client,
    calls,
    close: async () => {
      await client.close();
      await application.close();
    }
  };
}

function makeAccount(input: {
  id: string;
  handle: string;
  homeServer: string;
  homeAuthority?: string;
  actorId?: string;
  loginHomeServer?: string;
  nativeToken?: string;
}): AccountRecord {
  return {
    id: input.id,
    handle: input.handle,
    homeServer: input.homeServer,
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    ...(input.homeAuthority === undefined ? {} : { homeAuthority: input.homeAuthority }),
    login: {
      status: 'signed-in',
      homeServer: input.loginHomeServer ?? input.homeServer,
      nativeToken: input.nativeToken ?? `${input.id}:native-token`
    }
  };
}

async function installAccounts(application: ClientApplication, accounts: readonly AccountRecord[]): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  await application.state.transaction((state) => {
    for (const account of accounts) {
      state.accounts[account.id] = account;
      const token = createClientToken();
      state.clientSessions[digestClientToken(token)] = { accountId: account.id, issuedAt: '2026-10-31T00:00:00Z' };
      tokens.set(account.id, token);
    }
  });
  return tokens;
}

function vesselDocument(
  id: string,
  possessor: string,
  name: string,
  registry = SAME_HOST_REGISTRY
): Record<string, unknown> {
  return { id, type: 'Vessel', registry, possessor, capacity: 2, name };
}

function homeVesselsSource(account: AccountRecord): string {
  const base = account.homeAuthority ?? account.actorId;
  if (base === undefined) throw new Error('fixture account has no Home source');
  return new URL('/local/home/vessels', base).href;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function readCandidates(origin: string, token: string, accountId: string): Promise<Response> {
  return fetch(new URL(`/api/logistics/vessels?accountId=${encodeURIComponent(accountId)}`, origin), {
    headers: bearer(token)
  });
}

async function refreshCandidates(origin: string, token: string, accountId: string): Promise<Response> {
  return fetch(new URL('/api/logistics/vessels/refresh', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(token) },
    body: JSON.stringify({ accountId })
  });
}

function candidatePage(body: unknown): PageResponse<LogisticsVesselCandidatesData> {
  return body as PageResponse<LogisticsVesselCandidatesData>;
}

function candidateById(
  body: PageResponse<LogisticsVesselCandidatesData>,
  id: string
): LogisticsVesselCandidate {
  const candidate = body.data.candidates.find((entry) => entry.id === id);
  assert.ok(candidate, `expected candidate ${id}`);
  return candidate;
}

function observationFor(
  body: PageResponse<LogisticsVesselCandidatesData>,
  source: string
): SourcedObservation<unknown> | undefined {
  return Object.values(body.observations).find((observation) => observation.source === source);
}

test('explicit owned-vessel refresh reads the Home API with the account native token and retains only owned vessels', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-owned-vessels-'));
  const storeFile = join(directory, 'client.store.json');
  const ownedId = 'https://vessels.test/alice';
  const otherId = 'https://vessels.test/bob';
  const foreignId = 'https://vessels.test/foreign';
  const account = makeAccount({
    id: 'account:first',
    handle: `@sana@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    homeAuthority: FIRST_AUTHORITY,
    actorId: FIRST_ACTOR,
    nativeToken: 'first-native-token'
  });
  const source = homeVesselsSource(account);
  const harness = await openHarness(storeFile, (call) => {
    if (call.method === 'GET' && call.url === source) {
      return json({
        actor: FIRST_ACTOR,
        vessels: [
          vesselDocument(ownedId, FIRST_ACTOR, 'Alice Skiff'),
          vesselDocument(otherId, OTHER_ACTOR, 'Bob Cutter'),
          vesselDocument(foreignId, FIRST_ACTOR, 'Foreign Registry', FOREIGN_REGISTRY)
        ]
      });
    }
    return undefined;
  });
  try {
    const tokens = await installAccounts(harness.application, [account]);
    const token = tokens.get(account.id)!;
    const response = await refreshCandidates(harness.client.origin, token, account.id);
    assert.equal(response.status, 200);
    const body = candidatePage(await response.json());

    assert.equal(body.data.accountId, account.id);
    assert.deepEqual(body.data.candidates.map((candidate) => candidate.id), [ownedId, foreignId], 'only vessels owned by the authenticated account are listed');
    assert.ok(body.data.blockers.some((blocker) => /another account|omitted/i.test(blocker)), 'a foreign vessel in the Home response is omitted with an explanation');

    const owned = candidateById(body, ownedId);
    assert.equal(owned.source, source);
    assert.equal(owned.name, 'Alice Skiff');
    assert.equal(owned.ownership, 'verified-owned');
    assert.equal(owned.possessor, FIRST_ACTOR);
    assert.equal(owned.registry, SAME_HOST_REGISTRY);
    assert.equal(owned.registrySupported, true);
    assert.equal(owned.state, 'available');
    assert.equal(typeof owned.observedAt, 'string');

    const foreign = candidateById(body, foreignId);
    assert.equal(foreign.name, 'Foreign Registry');
    assert.equal(foreign.ownership, 'verified-owned');
    assert.equal(foreign.registrySupported, false);
    assert.equal(body.data.candidates.some((candidate) => candidate.id === otherId), false);

    const sourceCalls = harness.calls.filter((call) => call.url === source);
    assert.equal(sourceCalls.length, 1, 'refresh reads the Home listing once');
    assert.equal(sourceCalls[0]?.method, 'GET');
    assert.equal(sourceCalls[0]?.authorization, 'Bearer first-native-token');
    assert.equal(harness.calls.some((call) => call.url !== source && call.authorization === 'Bearer first-native-token'), false, 'the native token is sent only to the exact Home listing');
    assert.equal(harness.calls.some((call) => new URL(call.url).pathname === '/local/info'), false, 'owned vessels do not use the FCTP publication');
    assert.equal(harness.calls.some((call) => call.url === ownedId || call.url === otherId), false, 'the Home listing already carries vessel documents');
    assert.equal(harness.calls.some((call) => {
      const pathname = new URL(call.url).pathname;
      return /\/local\/registry\/(?:state|actions)/.test(pathname) || /tick|reconcile/i.test(pathname);
    }), false, 'refresh must not read Registry state, tick, or reconcile');

    const retainedRead = await fetch(new URL(`/api/logistics/vessels/${encodeURIComponent(ownedId)}?accountId=${encodeURIComponent(account.id)}`, harness.client.origin), {
      headers: bearer(token)
    });
    assert.equal(retainedRead.status, 200);
    const vesselPage = await retainedRead.json() as PageResponse<LogisticsVesselData>;
    assert.equal(vesselPage.data.vessel?.id, ownedId);
    assert.equal(vesselPage.data.vessel?.name, 'Alice Skiff');
    assert.equal(harness.calls.filter((call) => call.url === source).length, 1, 'selecting a listed vessel uses retained metadata');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('retained owned-vessel reads do not contact the Home server and survive restart', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-owned-vessels-retained-'));
  const storeFile = join(directory, 'client.store.json');
  const account = makeAccount({
    id: 'account:retained',
    handle: `@retained@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    homeAuthority: FIRST_AUTHORITY,
    actorId: FIRST_ACTOR
  });
  const source = homeVesselsSource(account);
  const vesselId = 'https://vessels.test/retained';
  const handler = (call: UpstreamCall): Response | undefined => {
    if (call.method === 'GET' && call.url === source) {
      return json({ actor: FIRST_ACTOR, vessels: [vesselDocument(vesselId, FIRST_ACTOR, 'Retained Skiff')] });
    }
    return undefined;
  };
  const harness = await openHarness(storeFile, handler);
  let reopened: Harness | undefined;
  try {
    const tokens = await installAccounts(harness.application, [account]);
    const token = tokens.get(account.id)!;

    const before = await readCandidates(harness.client.origin, token, account.id);
    assert.equal(before.status, 200);
    const beforeBody = candidatePage(await before.json());
    assert.deepEqual(beforeBody.data.candidates, []);
    assert.equal(observationFor(beforeBody, source)?.state, 'not-retrieved');
    assert.equal(harness.calls.length, 0, 'a retained read must not contact the Home server');

    const refreshed = await refreshCandidates(harness.client.origin, token, account.id);
    assert.equal(refreshed.status, 200);
    assert.equal(candidateById(candidatePage(await refreshed.json()), vesselId).name, 'Retained Skiff');
    const afterRefresh = harness.calls.filter((call) => call.url === source).length;
    assert.equal(afterRefresh, 1, 'explicit refresh reads the Home listing once');

    const retained = await readCandidates(harness.client.origin, token, account.id);
    assert.equal(retained.status, 200);
    assert.equal(candidateById(candidatePage(await retained.json()), vesselId).name, 'Retained Skiff');
    assert.equal(harness.calls.filter((call) => call.url === source).length, afterRefresh, 'a retained read performs no Home IO');

    await harness.close();
    reopened = await openHarness(storeFile, () => undefined);
    const afterRestart = await readCandidates(reopened.client.origin, token, account.id);
    assert.equal(afterRestart.status, 200);
    assert.equal(candidateById(candidatePage(await afterRestart.json()), vesselId).name, 'Retained Skiff');
    assert.equal(reopened.calls.length, 0, 'restart retained read performs no Home IO');
  } finally {
    await reopened?.close();
    if (reopened === undefined) await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('owned-vessel source requires the exact signed-in Home origin', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-owned-vessels-source-'));
  const storeFile = join(directory, 'client.store.json');
  const fallback = makeAccount({
    id: 'account:fallback',
    handle: `@fallback@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    actorId: FIRST_ACTOR
  });
  const accounts = [
    fallback,
    makeAccount({
      id: 'account:mismatch-host',
      handle: `@mismatch@${FIRST_SERVER}`,
      homeServer: FIRST_SERVER,
      homeAuthority: 'https://other.test:4200/actors/home',
      actorId: FIRST_ACTOR
    }),
    makeAccount({
      id: 'account:invalid-source',
      handle: `@invalid@${FIRST_SERVER}`,
      homeServer: FIRST_SERVER,
      homeAuthority: 'not a valid URI',
      actorId: FIRST_ACTOR
    }),
    makeAccount({
      id: 'account:mismatched-login',
      handle: `@login@${FIRST_SERVER}`,
      homeServer: FIRST_SERVER,
      homeAuthority: FIRST_AUTHORITY,
      actorId: FIRST_ACTOR,
      loginHomeServer: 'other.test:4200'
    }),
    makeAccount({
      id: 'account:no-actor',
      handle: `@noactor@${FIRST_SERVER}`,
      homeServer: FIRST_SERVER,
      homeAuthority: FIRST_AUTHORITY
    })
  ];
  const fallbackSource = homeVesselsSource(fallback);
  const fallbackVessel = 'https://vessels.test/fallback';
  const harness = await openHarness(storeFile, (call) => {
    if (call.method === 'GET' && call.url === fallbackSource) {
      return json({ actor: FIRST_ACTOR, vessels: [vesselDocument(fallbackVessel, FIRST_ACTOR, 'Fallback Skiff')] });
    }
    return undefined;
  });
  try {
    const tokens = await installAccounts(harness.application, accounts);
    const response = await refreshCandidates(harness.client.origin, tokens.get(fallback.id)!, fallback.id);
    assert.equal(response.status, 200);
    assert.equal(candidateById(candidatePage(await response.json()), fallbackVessel).name, 'Fallback Skiff');
    assert.equal(harness.calls.filter((call) => call.url === fallbackSource).length, 1);
    assert.equal(new URL(fallbackSource).pathname, '/local/home/vessels');

    for (const account of accounts.slice(1)) {
      const failure = await refreshCandidates(harness.client.origin, tokens.get(account.id)!, account.id);
      assert.equal(failure.status, 200, `${account.id} returns a retained page with a blocker`);
      const body = candidatePage(await failure.json());
      assert.deepEqual(body.data.candidates, []);
      assert.ok(body.data.blockers.length > 0, `${account.id} must explain the missing exact Home source`);
    }
    assert.equal(harness.calls.filter((call) => call.url === fallbackSource).length, 1, 'unverified Home sources are not fetched');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed Home refresh retains prior owned vessels as stale evidence', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-owned-vessels-stale-'));
  const storeFile = join(directory, 'client.store.json');
  const account = makeAccount({
    id: 'account:stale',
    handle: `@stale@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    homeAuthority: FIRST_AUTHORITY,
    actorId: FIRST_ACTOR
  });
  const source = homeVesselsSource(account);
  const vesselId = 'https://vessels.test/stale';
  let fail = false;
  const harness = await openHarness(storeFile, (call) => {
    if (call.method === 'GET' && call.url === source) {
      return fail
        ? json({ error: 'listing unavailable' }, 503)
        : json({ actor: FIRST_ACTOR, vessels: [vesselDocument(vesselId, FIRST_ACTOR, 'Stale Skiff')] });
    }
    return undefined;
  });
  try {
    const tokens = await installAccounts(harness.application, [account]);
    const token = tokens.get(account.id)!;
    assert.equal((await refreshCandidates(harness.client.origin, token, account.id)).status, 200);

    fail = true;
    const response = await refreshCandidates(harness.client.origin, token, account.id);
    assert.equal(response.status, 200);
    const body = candidatePage(await response.json());
    const candidate = candidateById(body, vesselId);
    assert.equal(candidate.name, 'Stale Skiff');
    assert.equal(candidate.ownership, 'verified-owned');
    assert.equal(candidate.state, 'stale');
    assert.equal(typeof candidate.error, 'string');
    assert.equal(typeof candidate.observedAt, 'string');
    const observation = observationFor(body, source);
    assert.equal(observation?.state, 'stale');
    assert.equal('error' in (observation ?? {}) ? typeof (observation as { error?: unknown }).error : undefined, 'string');
    assert.equal(harness.calls.filter((call) => call.url === source).length, 2);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a mismatched or malformed Home listing never becomes owned vessels', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-owned-vessels-malformed-'));
  const storeFile = join(directory, 'client.store.json');
  const account = makeAccount({
    id: 'account:malformed',
    handle: `@malformed@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    homeAuthority: FIRST_AUTHORITY,
    actorId: FIRST_ACTOR
  });
  const invalidAccount = makeAccount({
    id: 'account:malformed-fresh',
    handle: `@malformedfresh@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    homeAuthority: FIRST_AUTHORITY,
    actorId: FIRST_ACTOR
  });
  const source = homeVesselsSource(account);
  let mode: 'mismatch' | 'invalid' = 'mismatch';
  const harness = await openHarness(storeFile, (call) => {
    if (call.method === 'GET' && call.url === source) {
      return mode === 'mismatch'
        ? json({ actor: OTHER_ACTOR, vessels: [vesselDocument('https://vessels.test/other', OTHER_ACTOR, 'Other Skiff')] })
        : json({ actor: FIRST_ACTOR, vessels: [{ id: 'https://vessels.test/invalid', registry: SAME_HOST_REGISTRY }] });
    }
    return undefined;
  });
  try {
    const tokens = await installAccounts(harness.application, [account, invalidAccount]);

    const mismatched = await refreshCandidates(harness.client.origin, tokens.get(account.id)!, account.id);
    assert.equal(mismatched.status, 200);
    const mismatchedBody = candidatePage(await mismatched.json());
    assert.deepEqual(mismatchedBody.data.candidates, []);
    assert.ok(mismatchedBody.data.blockers.some((blocker) => /another account/i.test(blocker)));

    mode = 'invalid';
    const invalid = await refreshCandidates(harness.client.origin, tokens.get(invalidAccount.id)!, invalidAccount.id);
    assert.equal(invalid.status, 200);
    const invalidBody = candidatePage(await invalid.json());
    assert.deepEqual(invalidBody.data.candidates, []);
    assert.ok(invalidBody.data.blockers.some((blocker) => /unavailable|invalid/i.test(blocker)));
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('owned-vessel listings stay isolated per account', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-owned-vessels-isolation-'));
  const storeFile = join(directory, 'client.store.json');
  const first = makeAccount({
    id: 'account:first-isolation',
    handle: `@first@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    homeAuthority: FIRST_AUTHORITY,
    actorId: FIRST_ACTOR
  });
  const secondServer = 'second.test:4200';
  const secondAuthority = `https://${secondServer}/actors/home`;
  const secondActor = `https://${secondServer}/actors/orla`;
  const second = makeAccount({
    id: 'account:second-isolation',
    handle: `@second@${secondServer}`,
    homeServer: secondServer,
    homeAuthority: secondAuthority,
    actorId: secondActor
  });
  const firstVessel = 'https://vessels.test/first-only';
  const secondVessel = 'https://vessels.test/second-only';
  const firstSource = homeVesselsSource(first);
  const secondSource = homeVesselsSource(second);
  const harness = await openHarness(storeFile, (call) => {
    if (call.method === 'GET' && call.url === firstSource) {
      return json({ actor: FIRST_ACTOR, vessels: [vesselDocument(firstVessel, FIRST_ACTOR, 'First Skiff')] });
    }
    if (call.method === 'GET' && call.url === secondSource) {
      return json({ actor: secondActor, vessels: [vesselDocument(secondVessel, secondActor, 'Second Skiff', `https://${secondServer}/actors/registry`)] });
    }
    return undefined;
  });
  try {
    const tokens = await installAccounts(harness.application, [first, second]);
    assert.equal((await refreshCandidates(harness.client.origin, tokens.get(first.id)!, first.id)).status, 200);
    assert.equal((await refreshCandidates(harness.client.origin, tokens.get(second.id)!, second.id)).status, 200);

    const firstResponse = await readCandidates(harness.client.origin, tokens.get(first.id)!, first.id);
    const firstText = await firstResponse.text();
    const firstBody = candidatePage(JSON.parse(firstText));
    assert.deepEqual(firstBody.data.candidates.map((candidate) => candidate.id), [firstVessel]);
    assert.equal(firstText.includes(secondVessel), false);
    assert.equal(firstText.includes('Second Skiff'), false);
    assert.equal(firstText.includes(secondSource), false);

    const secondResponse = await readCandidates(harness.client.origin, tokens.get(second.id)!, second.id);
    const secondBody = candidatePage(await secondResponse.json());
    assert.deepEqual(secondBody.data.candidates.map((candidate) => candidate.id), [secondVessel]);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('owned-vessel routes require an exact client session and scope before Home IO', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-owned-vessels-auth-'));
  const storeFile = join(directory, 'client.store.json');
  const first = makeAccount({
    id: 'account:auth-first',
    handle: `@authfirst@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    homeAuthority: FIRST_AUTHORITY,
    actorId: FIRST_ACTOR,
    nativeToken: 'first-auth-native'
  });
  const second = makeAccount({
    id: 'account:auth-second',
    handle: '@authsecond@second.test:4200',
    homeServer: 'second.test:4200',
    homeAuthority: 'https://second.test:4200/actors/home',
    actorId: 'https://second.test:4200/actors/orla'
  });
  const harness = await openHarness(storeFile, () => undefined);
  try {
    const tokens = await installAccounts(harness.application, [first, second]);
    const firstToken = tokens.get(first.id)!;
    const secondToken = tokens.get(second.id)!;
    const firstPath = `/api/logistics/vessels?accountId=${encodeURIComponent(first.id)}`;

    const unauthenticated = await fetch(new URL(firstPath, harness.client.origin));
    assert.equal(unauthenticated.status, 401);
    assert.equal(harness.calls.length, 0);

    const nativeAsClient = await fetch(new URL(firstPath, harness.client.origin), {
      headers: bearer(first.login.status === 'signed-in' ? first.login.nativeToken : '')
    });
    assert.equal(nativeAsClient.status, 401);
    assert.equal(harness.calls.length, 0);

    const crossAccount = await fetch(new URL(firstPath, harness.client.origin), { headers: bearer(secondToken) });
    assert.equal(crossAccount.status, 403);
    assert.equal(harness.calls.length, 0);

    const duplicate = await fetch(new URL(
      `/api/logistics/vessels?accountId=${encodeURIComponent(first.id)}&accountId=${encodeURIComponent(first.id)}`,
      harness.client.origin
    ), { headers: bearer(firstToken) });
    assert.equal(duplicate.status, 400);
    assert.equal(harness.calls.length, 0);

    const missing = await fetch(new URL('/api/logistics/vessels', harness.client.origin), { headers: bearer(firstToken) });
    assert.equal(missing.status, 400);
    assert.equal(harness.calls.length, 0);

    const conflicting = await fetch(new URL(
      `/api/logistics/vessels/refresh?accountId=${encodeURIComponent(first.id)}`,
      harness.client.origin
    ), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(firstToken) },
      body: JSON.stringify({ accountId: second.id })
    });
    assert.equal(conflicting.status, 400);
    assert.equal(harness.calls.length, 0);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});
