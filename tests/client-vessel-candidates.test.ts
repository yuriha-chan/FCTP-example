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

function homePublicationSource(account: AccountRecord): string {
  const base = account.homeAuthority ?? account.actorId;
  if (base === undefined) throw new Error('fixture account has no Home publication source');
  return new URL('/local/info', base).href;
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

test('explicit candidate refresh reads exact published string URI maps and validates vessel documents', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-candidate-maps-'));
  const storeFile = join(directory, 'client.store.json');
  const ownedId = 'https://vessels.test/alice';
  const otherId = 'https://vessels.test/bob';
  const mismatchedId = 'https://vessels.test/mismatched';
  const foreignId = 'https://vessels.test/foreign';
  const invalidId = 'not a vessel reference';
  const account = makeAccount({
    id: 'account:first',
    handle: `@sana@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    homeAuthority: FIRST_AUTHORITY,
    actorId: FIRST_ACTOR,
    nativeToken: 'first-native-token'
  });
  const source = homePublicationSource(account);
  const publication = {
    kind: 'authority',
    actor: FIRST_AUTHORITY,
    ids: {
      vessels: {
        'map-label-is-not-a-name': ownedId,
        duplicate: ownedId,
        bob: otherId,
        mismatched: mismatchedId,
        broken: invalidId
      }
    },
    vessels: { foreign: foreignId }
  };
  const documents = new Map<string, Record<string, unknown>>([
    [ownedId, vesselDocument(ownedId, FIRST_ACTOR, 'Alice Skiff')],
    [otherId, vesselDocument(otherId, OTHER_ACTOR, 'Bob Cutter')],
    [mismatchedId, vesselDocument(ownedId, FIRST_ACTOR, 'Mismatched identity')],
    [foreignId, vesselDocument(foreignId, FIRST_ACTOR, 'Foreign Registry', FOREIGN_REGISTRY)]
  ]);
  const harness = await openHarness(storeFile, (call) => {
    if (call.method === 'GET' && call.url === source) return json(publication);
    const document = documents.get(call.url);
    return document === undefined ? undefined : json(document);
  });
  try {
    const tokens = await installAccounts(harness.application, [account]);
    const response = await refreshCandidates(harness.client.origin, tokens.get(account.id)!, account.id);
    assert.equal(response.status, 200);
    const body = candidatePage(await response.json());

    assert.equal(body.data.accountId, account.id);
    assert.equal(body.data.candidates.length, 5, 'both supported string URI maps must publish candidates without map-key duplicates');
    assert.equal(new Set(body.data.candidates.map((candidate) => candidate.id)).size, 5);
    assert.equal(body.data.candidates.filter((candidate) => candidate.id === ownedId).length, 1);

    const owned = candidateById(body, ownedId);
    assert.equal(owned.source, ownedId);
    assert.equal(owned.name, 'Alice Skiff');
    assert.equal(owned.ownership, 'verified-owned');
    assert.equal(owned.possessor, FIRST_ACTOR);
    assert.equal(owned.registry, SAME_HOST_REGISTRY);
    assert.equal(owned.registrySupported, true);
    assert.equal(owned.state, 'available');
    assert.equal(typeof owned.observedAt, 'string');

    const other = candidateById(body, otherId);
    assert.equal(other.name, 'Bob Cutter');
    assert.equal(other.ownership, 'not-owned');
    assert.equal(other.possessor, OTHER_ACTOR);

    const mismatched = candidateById(body, mismatchedId);
    assert.equal(mismatched.name, undefined, 'a document whose id is not the candidate id cannot supply metadata');
    assert.equal(mismatched.ownership, 'unverified');
    assert.equal(mismatched.state, 'unavailable');
    assert.equal(typeof mismatched.error, 'string');
    assert.equal(mismatched.registrySupported, undefined);

    const invalid = candidateById(body, invalidId);
    assert.equal(invalid.source, invalidId);
    assert.equal(invalid.name, undefined);
    assert.equal(invalid.ownership, 'unverified');
    assert.equal(invalid.state, 'unavailable');
    assert.equal(typeof invalid.error, 'string');

    const foreign = candidateById(body, foreignId);
    assert.equal(foreign.name, 'Foreign Registry');
    assert.equal(foreign.ownership, 'verified-owned');
    assert.equal(foreign.registrySupported, false);

    const publicationCalls = harness.calls.filter((call) => call.url === source);
    assert.equal(publicationCalls.length, 1);
    assert.equal(publicationCalls[0]?.method, 'GET');
    assert.equal(publicationCalls[0]?.authorization, '');
    for (const id of [ownedId, otherId, mismatchedId, foreignId]) {
      const calls = harness.calls.filter((call) => call.url === id);
      assert.equal(calls.length, 1, `expected one public metadata read for ${id}`);
      assert.equal(calls[0]?.authorization, '', `candidate metadata read for ${id} must be public`);
    }
    assert.equal(harness.calls.some((call) => call.url === invalidId), false, 'an invalid candidate reference must not be fetched');
    assert.equal(harness.calls.some((call) => call.method !== 'GET'), false, 'candidate refresh must not submit an operation');
    assert.equal(JSON.stringify(harness.calls).includes('first-native-token'), false, 'candidate refresh must not use the native token');
    assert.equal(harness.calls.some((call) => {
      const pathname = new URL(call.url).pathname;
      return /\/local\/registry\/(?:state|actions)/.test(pathname) || /tick|reconcile/i.test(pathname);
    }), false, 'candidate refresh must not read Registry state, tick, or reconcile');
    assert.equal(harness.calls.some((call) => {
      if (!call.url.startsWith(FOREIGN_REGISTRY)) return false;
      if (call.authorization !== '') return true;
      return /\/local\/registry\/(?:state|actions)/.test(new URL(call.url).pathname);
    }), false, 'no foreign Registry credential request');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('candidate refresh refuses missing, invalid, or mismatched Home sources without world IO', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-candidate-source-'));
  const storeFile = join(directory, 'client.store.json');
  const accounts = [
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
      id: 'account:missing-source',
      handle: `@missing@${FIRST_SERVER}`,
      homeServer: FIRST_SERVER
    }),
    makeAccount({
      id: 'account:mismatched-login',
      handle: `@login@${FIRST_SERVER}`,
      homeServer: FIRST_SERVER,
      homeAuthority: FIRST_AUTHORITY,
      actorId: FIRST_ACTOR,
      loginHomeServer: 'other.test:4200'
    })
  ];
  const harness = await openHarness(storeFile, () => undefined);
  try {
    const tokens = await installAccounts(harness.application, accounts);
    for (const account of accounts) {
      const response = await refreshCandidates(harness.client.origin, tokens.get(account.id)!, account.id);
      assert.equal(response.status, 200, `${account.id} must return a retained candidate page with a blocker`);
      const body = candidatePage(await response.json());
      assert.deepEqual(body.data.candidates, []);
      assert.ok(body.data.blockers.length > 0, `${account.id} must report a Home source blocker`);
      assert.equal(harness.calls.length, 0, `${account.id} must not fetch an unverified Home source`);
    }
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('candidate publication uses the Actor origin only when HomeAuthority is absent', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-candidate-fallback-'));
  const storeFile = join(directory, 'client.store.json');
  const account = makeAccount({
    id: 'account:fallback',
    handle: `@fallback@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    actorId: FIRST_ACTOR
  });
  const source = homePublicationSource(account);
  const vesselId = 'https://vessels.test/fallback';
  const harness = await openHarness(storeFile, (call) => {
    if (call.method === 'GET' && call.url === source) return json({ kind: 'authority', ids: { vessels: { fallback: vesselId } } });
    if (call.method === 'GET' && call.url === vesselId) return json(vesselDocument(vesselId, FIRST_ACTOR, 'Fallback Skiff'));
    return undefined;
  });
  try {
    const tokens = await installAccounts(harness.application, [account]);
    const response = await refreshCandidates(harness.client.origin, tokens.get(account.id)!, account.id);
    assert.equal(response.status, 200);
    const body = candidatePage(await response.json());
    assert.equal(candidateById(body, vesselId).name, 'Fallback Skiff');
    assert.equal(harness.calls.filter((call) => call.url === source).length, 1);
    assert.equal(harness.calls.some((call) => new URL(call.url).pathname === '/local/info' && call.url !== source), false);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing Actor identity can show published candidates but cannot verify ownership', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-candidate-no-actor-'));
  const storeFile = join(directory, 'client.store.json');
  const account = makeAccount({
    id: 'account:no-actor',
    handle: `@noactor@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    homeAuthority: FIRST_AUTHORITY
  });
  const source = homePublicationSource(account);
  const vesselId = 'https://vessels.test/no-actor';
  const harness = await openHarness(storeFile, (call) => {
    if (call.method === 'GET' && call.url === source) return json({ kind: 'authority', ids: { vessels: { vessel: vesselId } } });
    if (call.method === 'GET' && call.url === vesselId) return json(vesselDocument(vesselId, FIRST_ACTOR, 'Unverifiable Skiff'));
    return undefined;
  });
  try {
    const tokens = await installAccounts(harness.application, [account]);
    const response = await refreshCandidates(harness.client.origin, tokens.get(account.id)!, account.id);
    assert.equal(response.status, 200);
    const candidate = candidateById(candidatePage(await response.json()), vesselId);
    assert.equal(candidate.name, 'Unverifiable Skiff');
    assert.equal(candidate.ownership, 'unverified');
    assert.equal(harness.calls.filter((call) => call.url === vesselId).length, 1, 'partial candidates still use public metadata reads');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing supported publication maps are not presented as an empty fleet', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-candidate-missing-publication-'));
  const storeFile = join(directory, 'client.store.json');
  const account = makeAccount({
    id: 'account:missing-maps',
    handle: `@maps@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    homeAuthority: FIRST_AUTHORITY,
    actorId: FIRST_ACTOR
  });
  const source = homePublicationSource(account);
  let publication: Record<string, unknown> = { kind: 'authority', ids: { ports: [] } };
  const harness = await openHarness(storeFile, (call) => {
    if (call.method === 'GET' && call.url === source) return json(publication);
    return undefined;
  });
  try {
    const tokens = await installAccounts(harness.application, [account]);
    const token = tokens.get(account.id)!;

    const missing = await refreshCandidates(harness.client.origin, token, account.id);
    assert.equal(missing.status, 200);
    const missingBody = candidatePage(await missing.json());
    assert.deepEqual(missingBody.data.candidates, []);
    assert.ok(missingBody.data.blockers.some((blocker) => /publication|missing|published/i.test(blocker)), 'missing supported maps need a publication blocker');

    publication = { kind: 'authority', ids: { vessels: {} }, vessels: {} };
    const empty = await refreshCandidates(harness.client.origin, token, account.id);
    assert.equal(empty.status, 200);
    const emptyBody = candidatePage(await empty.json());
    assert.deepEqual(emptyBody.data.candidates, []);
    assert.equal(emptyBody.data.blockers.some((blocker) => /missing|unavailable|absent/i.test(blocker)), false, 'empty supported maps are no published candidates, not a missing publication');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed publication retains prior published candidate IDs as stale evidence', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-candidate-publication-stale-'));
  const storeFile = join(directory, 'client.store.json');
  const account = makeAccount({
    id: 'account:publication-stale',
    handle: `@publication@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    homeAuthority: FIRST_AUTHORITY,
    actorId: FIRST_ACTOR
  });
  const source = homePublicationSource(account);
  const vesselId = 'https://vessels.test/stale-publication';
  let failPublication = false;
  const harness = await openHarness(storeFile, (call) => {
    if (call.method === 'GET' && call.url === source) {
      return failPublication ? json({ error: 'publication unavailable' }, 503) : json({ kind: 'authority', ids: { vessels: { vessel: vesselId } } });
    }
    if (call.method === 'GET' && call.url === vesselId) return json(vesselDocument(vesselId, FIRST_ACTOR, 'Retained Skiff'));
    return undefined;
  });
  try {
    const tokens = await installAccounts(harness.application, [account]);
    const token = tokens.get(account.id)!;
    assert.equal((await refreshCandidates(harness.client.origin, token, account.id)).status, 200);

    failPublication = true;
    const response = await refreshCandidates(harness.client.origin, token, account.id);
    assert.equal(response.status, 200);
    const body = candidatePage(await response.json());
    const candidate = candidateById(body, vesselId);
    assert.equal(candidate.name, 'Retained Skiff');
    assert.equal(candidate.ownership, 'verified-owned');
    const publicationObservation = observationFor(body, source);
    assert.equal(publicationObservation?.state, 'stale');
    assert.equal('error' in (publicationObservation ?? {}) ? typeof (publicationObservation as { error?: unknown }).error : undefined, 'string');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed metadata source retains prior verified candidate fields as stale evidence', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-candidate-metadata-stale-'));
  const storeFile = join(directory, 'client.store.json');
  const account = makeAccount({
    id: 'account:metadata-stale',
    handle: `@metadata@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    homeAuthority: FIRST_AUTHORITY,
    actorId: FIRST_ACTOR
  });
  const source = homePublicationSource(account);
  const vesselId = 'https://vessels.test/stale-metadata';
  let failMetadata = false;
  const harness = await openHarness(storeFile, (call) => {
    if (call.method === 'GET' && call.url === source) return json({ kind: 'authority', ids: { vessels: { vessel: vesselId } } });
    if (call.method === 'GET' && call.url === vesselId) {
      return failMetadata ? json({ error: 'metadata unavailable' }, 500) : json(vesselDocument(vesselId, FIRST_ACTOR, 'Verified Skiff'));
    }
    return undefined;
  });
  try {
    const tokens = await installAccounts(harness.application, [account]);
    const token = tokens.get(account.id)!;
    assert.equal((await refreshCandidates(harness.client.origin, token, account.id)).status, 200);

    failMetadata = true;
    const response = await refreshCandidates(harness.client.origin, token, account.id);
    assert.equal(response.status, 200);
    const body = candidatePage(await response.json());
    const candidate = candidateById(body, vesselId);
    assert.equal(candidate.name, 'Verified Skiff');
    assert.equal(candidate.ownership, 'verified-owned');
    assert.equal(candidate.state, 'stale');
    assert.equal(typeof candidate.error, 'string');
    assert.equal(observationFor(body, source)?.state, 'available', 'publication evidence remains independent of metadata failure');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('candidate publication and metadata stay isolated per account', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-candidate-isolation-'));
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
  const firstSource = homePublicationSource(first);
  const secondSource = homePublicationSource(second);
  const harness = await openHarness(storeFile, (call) => {
    if (call.method === 'GET' && call.url === firstSource) return json({ kind: 'authority', ids: { vessels: { first: firstVessel } } });
    if (call.method === 'GET' && call.url === secondSource) return json({ kind: 'authority', ids: { vessels: { second: secondVessel } } });
    if (call.method === 'GET' && call.url === firstVessel) return json(vesselDocument(firstVessel, FIRST_ACTOR, 'First Skiff'));
    if (call.method === 'GET' && call.url === secondVessel) return json(vesselDocument(secondVessel, secondActor, 'Second Skiff', `https://${secondServer}/actors/registry`));
    return undefined;
  });
  try {
    const tokens = await installAccounts(harness.application, [first, second]);
    assert.equal((await refreshCandidates(harness.client.origin, tokens.get(first.id)!, first.id)).status, 200);
    assert.equal((await refreshCandidates(harness.client.origin, tokens.get(second.id)!, second.id)).status, 200);

    const firstResponse = await readCandidates(harness.client.origin, tokens.get(first.id)!, first.id);
    assert.equal(firstResponse.status, 200);
    const firstText = await firstResponse.text();
    const firstBody = candidatePage(JSON.parse(firstText));
    assert.deepEqual(firstBody.data.candidates.map((candidate) => candidate.id), [firstVessel]);
    assert.equal(firstText.includes(secondVessel), false, 'another account publication must not leak');
    assert.equal(firstText.includes('Second Skiff'), false);
    assert.equal(firstText.includes(secondSource), false);

    const secondResponse = await readCandidates(harness.client.origin, tokens.get(second.id)!, second.id);
    assert.equal(secondResponse.status, 200);
    const secondBody = candidatePage(await secondResponse.json());
    assert.deepEqual(secondBody.data.candidates.map((candidate) => candidate.id), [secondVessel]);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('candidate routes require an exact client session and scope before world IO', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-candidate-auth-'));
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

test('retained candidate reads do not contact the world and survive restart', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-candidate-retained-'));
  const storeFile = join(directory, 'client.store.json');
  const account = makeAccount({
    id: 'account:retained',
    handle: `@retained@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    homeAuthority: FIRST_AUTHORITY,
    actorId: FIRST_ACTOR
  });
  const source = homePublicationSource(account);
  const vesselId = 'https://vessels.test/retained-candidate';
  const handler = (call: UpstreamCall): Response | undefined => {
    if (call.method === 'GET' && call.url === source) return json({ kind: 'authority', ids: { vessels: { vessel: vesselId } } });
    if (call.method === 'GET' && call.url === vesselId) return json(vesselDocument(vesselId, FIRST_ACTOR, 'Retained Candidate'));
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
    assert.equal(observationFor(beforeBody, source)?.state, 'not-retrieved', 'retained GET reports the publication source placeholder');
    assert.equal(harness.calls.length, 0, 'retained candidate read must not contact the world');

    const refreshed = await refreshCandidates(harness.client.origin, token, account.id);
    assert.equal(refreshed.status, 200);
    assert.equal(candidateById(candidatePage(await refreshed.json()), vesselId).name, 'Retained Candidate');
    const afterRefresh = harness.calls.length;
    assert.ok(afterRefresh > 0);

    const retained = await readCandidates(harness.client.origin, token, account.id);
    assert.equal(retained.status, 200);
    assert.equal(candidateById(candidatePage(await retained.json()), vesselId).name, 'Retained Candidate');
    assert.equal(harness.calls.length, afterRefresh, 'a retained candidate read performs no world IO');

    await harness.close();
    reopened = await openHarness(storeFile, () => undefined);
    const afterRestart = await readCandidates(reopened.client.origin, token, account.id);
    assert.equal(afterRestart.status, 200);
    assert.equal(candidateById(candidatePage(await afterRestart.json()), vesselId).name, 'Retained Candidate');
    assert.equal(reopened.calls.length, 0, 'restart retained candidate read performs no world IO');
  } finally {
    await reopened?.close();
    if (reopened === undefined) await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an unpublished known vessel reference still refreshes through the existing exact-reference path', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-candidate-known-vessel-'));
  const storeFile = join(directory, 'client.store.json');
  const account = makeAccount({
    id: 'account:known-vessel',
    handle: `@known@${FIRST_SERVER}`,
    homeServer: FIRST_SERVER,
    homeAuthority: FIRST_AUTHORITY,
    actorId: FIRST_ACTOR
  });
  const vesselId = 'https://vessels.test/known';
  const registryState = new URL('/local/registry/state', SAME_HOST_REGISTRY);
  registryState.searchParams.set('vessel', vesselId);
  const registryActions = new URL('/local/registry/actions', SAME_HOST_REGISTRY);
  registryActions.searchParams.set('vessel', vesselId);
  const harness = await openHarness(storeFile, (call) => {
    if (call.method === 'GET' && call.url === vesselId) return json(vesselDocument(vesselId, FIRST_ACTOR, 'Known Skiff'));
    if (call.method === 'GET' && call.url === registryState.href) return json({ cargo: { entries: [] }, requests: {}, events: [] });
    if (call.method === 'GET' && call.url === registryActions.href) return json({ state: { location: null, pendingRequests: [] } });
    return undefined;
  });
  try {
    const tokens = await installAccounts(harness.application, [account]);
    const response = await fetch(new URL(`/api/logistics/vessels/${encodeURIComponent(vesselId)}/refresh`, harness.client.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...bearer(tokens.get(account.id)!) },
      body: JSON.stringify({ accountId: account.id })
    });
    assert.equal(response.status, 200);
    const body = await response.json() as PageResponse<LogisticsVesselData>;
    assert.equal(body.data.vessel?.id, vesselId);
    assert.equal(body.data.vessel?.name, 'Known Skiff');
    assert.equal(harness.calls.some((call) => call.url === homePublicationSource(account)), false, 'known vessel refresh does not require candidate publication membership');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});
