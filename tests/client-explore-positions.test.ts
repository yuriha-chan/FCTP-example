import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AccountRecord } from '@fctp/client-sdk';
import { createClientApplication, type ClientApplication } from '../apps/client-server/src/app.js';
import { createClientToken, digestClientToken } from '../apps/client-server/src/sessions.js';
import { startClientServer } from '../apps/demo/src/client-server.js';

const ACCOUNT_SERVER = 'explore.test:4200';
const POLICY_AUTHORITY = 'https://policy.test:4200/actors/policy';
const SIMULATION_AUTHORITY = 'https://simulation.test:4200/actors/simulation';
const OTHER_AUTHORITY = 'https://other-policy.test:4200/actors/policy';

interface UpstreamCall {
  url: string;
  method: string;
  authorization: string;
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

async function openHarness(storeFile: string): Promise<Harness> {
  const calls: UpstreamCall[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const headers = new Headers(init?.headers ?? request?.headers);
    calls.push({
      url: request ? request.url : String(input),
      method: init?.method ?? request?.method ?? 'GET',
      authorization: headers.get('authorization') ?? ''
    });
    return json({ error: 'unexpected world IO' }, 500);
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

function makeAccount(id: string, actorId?: string): AccountRecord {
  return {
    id,
    handle: `@${id.replace(/[^a-z0-9]+/gi, '')}@${ACCOUNT_SERVER}`,
    homeServer: ACCOUNT_SERVER,
    ...(actorId === undefined ? {} : { actorId }),
    homeAuthority: `https://${ACCOUNT_SERVER}/actors/home`,
    login: { status: 'signed-in', homeServer: ACCOUNT_SERVER, nativeToken: `${id}:native-token` }
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

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function capabilityKey(accountId: string, vesselId: string, authorityId: string): string {
  return `explore-account:${accountId}\0capabilities\0${accountId}\0${vesselId}\0${authorityId}`;
}

function capabilitySource(authorityId: string): string {
  return new URL('/local/actions', authorityId).href;
}

interface CapabilitySeed {
  accountId: string;
  vesselId: string;
  authorityId: string;
  state: Record<string, unknown>;
  snapshotAccountId?: string;
  snapshotVesselId?: string;
  observedAt?: string;
  actions?: Array<Record<string, unknown>>;
}

async function seedCapability(application: ClientApplication, seed: CapabilitySeed): Promise<void> {
  const key = capabilityKey(seed.accountId, seed.vesselId, seed.authorityId);
  const source = capabilitySource(seed.authorityId);
  await application.observations.refresh({
    key,
    source,
    load: async () => ({
      territoryId: seed.authorityId,
      authorityId: seed.authorityId,
      accountId: seed.snapshotAccountId ?? seed.accountId,
      vesselId: seed.snapshotVesselId ?? seed.vesselId,
      observedAt: seed.observedAt ?? '2026-10-31T00:00:00Z',
      state: seed.state,
      actions: seed.actions ?? []
    })
  });
}

async function seedPlace(
  application: ClientApplication,
  input: { placeId: string; authorityId: string; accountId?: string }
): Promise<void> {
  const key = input.accountId === undefined
    ? `explore\0place\0${input.placeId}`
    : `explore-account:${input.accountId}\0place\0${input.placeId}`;
  await application.observations.refresh({
    key,
    source: input.authorityId,
    load: async () => ({ id: input.placeId, type: 'Port', authorityId: input.authorityId, name: 'Test Port' })
  });
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) as unknown : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positionArray(body: unknown): Array<Record<string, unknown>> {
  assert.ok(isRecord(body) && isRecord(body.data), 'expected Explore page data');
  const data = body.data;
  assert.ok(Array.isArray(data.positions), 'Explore page data must contain typed positions');
  return data.positions.filter(isRecord);
}

function observationsOf(body: unknown): Record<string, unknown> {
  assert.ok(isRecord(body) && isRecord(body.observations), 'expected page observations');
  return body.observations;
}

async function listPositions(
  origin: string,
  token: string,
  accountId: string,
  vesselId: string
): Promise<unknown> {
  const response = await fetch(new URL(
    `/api/explore/places?accountId=${encodeURIComponent(accountId)}&vesselId=${encodeURIComponent(vesselId)}`,
    origin
  ), { headers: bearer(token) });
  assert.equal(response.status, 200);
  return readJson(response);
}

async function detailPositions(
  origin: string,
  token: string | undefined,
  placeId: string,
  accountId: string | undefined,
  vesselId: string | undefined
): Promise<unknown> {
  const parameters = new URLSearchParams();
  if (accountId !== undefined) parameters.set('accountId', accountId);
  if (vesselId !== undefined) parameters.set('vesselId', vesselId);
  const query = parameters.toString();
  const response = await fetch(new URL(
    `/api/explore/places/${encodeURIComponent(placeId)}${query ? `?${query}` : ''}`,
    origin
  ), token === undefined ? undefined : { headers: bearer(token) });
  assert.equal(response.status, 200);
  return readJson(response);
}

test('Policy positions are derived only from matching persisted visit records', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-position-policy-'));
  const storeFile = join(directory, 'client.store.json');
  const harness = await openHarness(storeFile);
  try {
    const account = makeAccount('account:policy', `https://${ACCOUNT_SERVER}/actors/sana`);
    const tokens = await installAccounts(harness.application, [account]);
    const token = tokens.get(account.id)!;
    const portEast = 'https://policy.test:4200/objects/ports/east';
    const portWest = 'https://policy.test:4200/objects/ports/west';
    const route = 'https://policy.test:4200/objects/routes/coast';
    const activeVessel = 'https://vessels.test/policy-active';
    const departedVessel = 'https://vessels.test/policy-departed';
    const absentVessel = 'https://vessels.test/policy-absent';
    const contradictoryVessel = 'https://vessels.test/policy-contradictory';
    const malformedVessel = 'https://vessels.test/policy-malformed';
    const otherOnlyVessel = 'https://vessels.test/policy-other-only';
    const mixedVessel = 'https://vessels.test/policy-mixed';
    const otherVessel = 'https://vessels.test/policy-other';

    await seedCapability(harness.application, {
      accountId: account.id, vesselId: activeVessel, authorityId: POLICY_AUTHORITY,
      state: { visits: [{ vessel: activeVessel, port: portEast, route, departed: false }] }
    });
    await seedCapability(harness.application, {
      accountId: account.id, vesselId: departedVessel, authorityId: POLICY_AUTHORITY,
      state: { visits: [{ vessel: departedVessel, port: portEast, route, departed: true }] }
    });
    await seedCapability(harness.application, {
      accountId: account.id, vesselId: absentVessel, authorityId: POLICY_AUTHORITY,
      state: { visits: [] }
    });
    await seedCapability(harness.application, {
      accountId: account.id, vesselId: contradictoryVessel, authorityId: POLICY_AUTHORITY,
      state: { visits: [
        { vessel: contradictoryVessel, port: portEast, route, departed: false },
        { vessel: contradictoryVessel, port: portWest, route, departed: false }
      ] }
    });
    await seedCapability(harness.application, {
      accountId: account.id, vesselId: malformedVessel, authorityId: POLICY_AUTHORITY,
      state: { visits: [{ vessel: malformedVessel, port: 42, route, departed: false }] }
    });
    await seedCapability(harness.application, {
      accountId: account.id, vesselId: otherOnlyVessel, authorityId: POLICY_AUTHORITY,
      state: { visits: [{ vessel: otherVessel, port: portEast, route, departed: false }] }
    });
    await seedCapability(harness.application, {
      accountId: account.id, vesselId: mixedVessel, authorityId: POLICY_AUTHORITY,
      state: { visits: [
        { vessel: otherVessel, port: portWest, route, departed: false },
        { vessel: mixedVessel, port: portEast, route, departed: false }
      ] }
    });

    const active = positionArray(await listPositions(harness.client.origin, token, account.id, activeVessel));
    assert.equal(active.length, 1);
    assert.equal(active[0]?.accountId, account.id);
    assert.equal(active[0]?.vesselId, activeVessel);
    assert.equal(active[0]?.authorityId, POLICY_AUTHORITY);
    assert.equal(active[0]?.source, capabilitySource(POLICY_AUTHORITY));
    assert.equal(active[0]?.state, 'available');
    assert.equal(active[0]?.status, 'active');
    assert.equal(active[0]?.portId, portEast);
    assert.equal(typeof active[0]?.observedAt, 'string');

    const departed = positionArray(await listPositions(harness.client.origin, token, account.id, departedVessel));
    assert.equal(departed.length, 1);
    assert.equal(departed[0]?.status, 'departed');
    assert.notEqual(departed[0]?.status, 'active');

    const absent = positionArray(await listPositions(harness.client.origin, token, account.id, absentVessel));
    assert.equal(absent.length, 1);
    assert.equal(absent[0]?.status, 'absent');
    assert.equal(absent[0]?.portId, undefined);

    const contradictory = positionArray(await listPositions(harness.client.origin, token, account.id, contradictoryVessel));
    assert.equal(contradictory.length, 1);
    assert.equal(contradictory[0]?.status, 'unknown', 'conflicting matching visits must not use the first record');
    assert.equal(contradictory[0]?.portId, undefined);

    const malformed = positionArray(await listPositions(harness.client.origin, token, account.id, malformedVessel));
    assert.equal(malformed.length, 1);
    assert.equal(malformed[0]?.status, 'unknown');
    assert.equal(malformed[0]?.portId, undefined);

    const otherOnly = positionArray(await listPositions(harness.client.origin, token, account.id, otherOnlyVessel));
    assert.equal(otherOnly.length, 1);
    assert.equal(otherOnly[0]?.status, 'unknown', 'a non-empty visit list without this vessel is unknown, not another vessel position');
    assert.equal(otherOnly[0]?.portId, undefined);

    const mixed = positionArray(await listPositions(harness.client.origin, token, account.id, mixedVessel));
    assert.equal(mixed.length, 1);
    assert.equal(mixed[0]?.status, 'active');
    assert.equal(mixed[0]?.portId, portEast);
    assert.notEqual(mixed[0]?.portId, portWest);

    assert.equal(harness.calls.length, 0, 'retained Explore pages must not fetch');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Simulation visit presence is an unknown location and never uses action request ports', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-position-simulation-'));
  const storeFile = join(directory, 'client.store.json');
  const harness = await openHarness(storeFile);
  try {
    const account = makeAccount('account:simulation', `https://${ACCOUNT_SERVER}/actors/sana`);
    const tokens = await installAccounts(harness.application, [account]);
    const token = tokens.get(account.id)!;
    const berthedVessel = 'https://vessels.test/simulation-berthed';
    const absentVessel = 'https://vessels.test/simulation-absent';
    const defaultPort = 'https://simulation.test:4200/objects/ports/default';
    const defaultRoute = 'https://simulation.test:4200/objects/routes/default';

    await seedCapability(harness.application, {
      accountId: account.id, vesselId: berthedVessel, authorityId: SIMULATION_AUTHORITY,
      state: {
        tick: 9,
        visit: { entryRequest: 'https://simulation.test:4200/objects/requests/one', status: 'berthed', cargo: { entries: [] }, handling: [] }
      },
      actions: [{
        id: 'departure',
        label: 'Request Registry departure',
        available: true,
        request: {
          method: 'POST',
          href: 'https://simulation.test:4200/local/registry/departure',
          body: { vessel: berthedVessel, territory: SIMULATION_AUTHORITY, port: defaultPort, route: defaultRoute }
        },
        effect: 'Requests departure from the current local berth.'
      }]
    });
    await seedCapability(harness.application, {
      accountId: account.id, vesselId: absentVessel, authorityId: SIMULATION_AUTHORITY,
      state: { tick: 9, visit: null }
    });

    const berthed = positionArray(await listPositions(harness.client.origin, token, account.id, berthedVessel));
    assert.equal(berthed.length, 1);
    assert.equal(berthed[0]?.authorityId, SIMULATION_AUTHORITY);
    assert.equal(berthed[0]?.status, 'unknown', 'a non-null Simulation visit has no published port');
    assert.equal(berthed[0]?.portId, undefined);
    assert.notEqual(berthed[0]?.portId, defaultPort);

    const absent = positionArray(await listPositions(harness.client.origin, token, account.id, absentVessel));
    assert.equal(absent.length, 1);
    assert.equal(absent[0]?.status, 'absent');
    assert.equal(absent[0]?.portId, undefined);
    assert.equal(harness.calls.length, 0);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('conflicting authority positions remain independent records', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-position-conflict-'));
  const storeFile = join(directory, 'client.store.json');
  const harness = await openHarness(storeFile);
  try {
    const account = makeAccount('account:conflict', `https://${ACCOUNT_SERVER}/actors/sana`);
    const tokens = await installAccounts(harness.application, [account]);
    const token = tokens.get(account.id)!;
    const vessel = 'https://vessels.test/conflicting';
    const portOne = 'https://policy.test:4200/objects/ports/one';
    const portTwo = 'https://other-policy.test:4200/objects/ports/two';

    await seedCapability(harness.application, {
      accountId: account.id, vesselId: vessel, authorityId: POLICY_AUTHORITY,
      state: { visits: [{ vessel, port: portOne, route: 'https://policy.test:4200/objects/routes/one', departed: false }] }
    });
    await seedCapability(harness.application, {
      accountId: account.id, vesselId: vessel, authorityId: OTHER_AUTHORITY,
      state: { visits: [{ vessel, port: portTwo, route: 'https://other-policy.test:4200/objects/routes/two', departed: false }] }
    });

    const positions = positionArray(await listPositions(harness.client.origin, token, account.id, vessel));
    assert.equal(positions.length, 2, 'each authority keeps its own position evidence');
    const first = positions.find((position) => position.authorityId === POLICY_AUTHORITY);
    const second = positions.find((position) => position.authorityId === OTHER_AUTHORITY);
    assert.equal(first?.source, capabilitySource(POLICY_AUTHORITY));
    assert.equal(first?.portId, portOne);
    assert.equal(second?.source, capabilitySource(OTHER_AUTHORITY));
    assert.equal(second?.portId, portTwo);
    assert.notEqual(first?.portId, second?.portId);
    assert.equal(harness.calls.length, 0);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('positions are filtered by both capability key and retained snapshot scope', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-position-scope-'));
  const storeFile = join(directory, 'client.store.json');
  const harness = await openHarness(storeFile);
  try {
    const first = makeAccount('account:scope-first', `https://${ACCOUNT_SERVER}/actors/sana`);
    const second = makeAccount('account:scope-second', `https://${ACCOUNT_SERVER}/actors/orla`);
    const tokens = await installAccounts(harness.application, [first, second]);
    const firstToken = tokens.get(first.id)!;
    const secondToken = tokens.get(second.id)!;
    const vessel = 'https://vessels.test/scope-one';
    const otherVessel = 'https://vessels.test/scope-two';
    const secondVessel = 'https://vessels.test/scope-second';
    const placeId = 'https://policy.test:4200/objects/ports/one';
    const port = 'https://policy.test:4200/objects/ports/one';
    const leakedPort = 'https://other-policy.test:4200/objects/ports/leaked';

    await seedCapability(harness.application, {
      accountId: first.id, vesselId: vessel, authorityId: POLICY_AUTHORITY,
      state: { visits: [{ vessel, port, route: 'https://policy.test:4200/objects/routes/one', departed: false }] }
    });
    await seedCapability(harness.application, {
      accountId: second.id, vesselId: secondVessel, authorityId: POLICY_AUTHORITY,
      state: { visits: [{ vessel: secondVessel, port: leakedPort, route: 'https://policy.test:4200/objects/routes/two', departed: false }] }
    });
    await seedCapability(harness.application, {
      accountId: first.id, vesselId: vessel, authorityId: OTHER_AUTHORITY, snapshotAccountId: second.id,
      state: { visits: [{ vessel, port: leakedPort, route: 'https://other-policy.test:4200/objects/routes/two', departed: false }] }
    });
    await seedCapability(harness.application, {
      accountId: first.id, vesselId: vessel, authorityId: 'https://third-policy.test:4200/actors/policy', snapshotVesselId: otherVessel,
      state: { visits: [{ vessel: otherVessel, port: leakedPort, route: 'https://third-policy.test:4200/objects/routes/two', departed: false }] }
    });
    await seedPlace(harness.application, { placeId, authorityId: POLICY_AUTHORITY });

    const scoped = positionArray(await listPositions(harness.client.origin, firstToken, first.id, vessel));
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]?.portId, port);
    assert.equal(scoped.some((position) => position.portId === leakedPort), false);

    const otherVesselBody = await listPositions(harness.client.origin, firstToken, first.id, otherVessel);
    assert.deepEqual(positionArray(otherVesselBody), []);

    const otherAccountBody = await listPositions(harness.client.origin, secondToken, second.id, vessel);
    assert.deepEqual(positionArray(otherAccountBody), []);

    const publicResponse = await fetch(new URL('/api/explore/places', harness.client.origin));
    assert.equal(publicResponse.status, 200);
    assert.deepEqual(positionArray(await readJson(publicResponse)), []);

    const noVesselResponse = await fetch(new URL(
      `/api/explore/places?accountId=${encodeURIComponent(first.id)}`,
      harness.client.origin
    ), { headers: bearer(firstToken) });
    assert.equal(noVesselResponse.status, 200);
    assert.deepEqual(positionArray(await readJson(noVesselResponse)), []);

    const detail = positionArray(await detailPositions(harness.client.origin, firstToken, placeId, first.id, otherVessel));
    assert.deepEqual(detail, []);

    const publicDetail = positionArray(await detailPositions(harness.client.origin, undefined, placeId, undefined, vessel));
    assert.deepEqual(publicDetail, []);
    assert.equal(harness.calls.length, 0);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed capability freshness is not overridden by an available legacy position observation', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-position-freshness-'));
  const storeFile = join(directory, 'client.store.json');
  const harness = await openHarness(storeFile);
  try {
    const account = makeAccount('account:freshness', `https://${ACCOUNT_SERVER}/actors/sana`);
    const tokens = await installAccounts(harness.application, [account]);
    const token = tokens.get(account.id)!;
    const staleVessel = 'https://vessels.test/freshness-stale';
    const unavailableVessel = 'https://vessels.test/freshness-unavailable';
    const legacySource = 'https://legacy.test/local/state';
    const legacyPort = 'https://legacy.test/objects/ports/old';
    const currentPort = 'https://policy.test:4200/objects/ports/current';

    for (const vessel of [staleVessel, unavailableVessel]) {
      await harness.application.observations.refresh({
        key: `position:${account.id}:${vessel}`,
        source: legacySource,
        load: async () => ({ vessel, placeId: legacyPort, status: 'berthed' })
      });
    }

    await seedCapability(harness.application, {
      accountId: account.id, vesselId: staleVessel, authorityId: POLICY_AUTHORITY,
      state: { visits: [{ vessel: staleVessel, port: currentPort, route: 'https://policy.test:4200/objects/routes/current', departed: false }] }
    });
    const staleKey = capabilityKey(account.id, staleVessel, POLICY_AUTHORITY);
    const staleSource = capabilitySource(POLICY_AUTHORITY);
    await harness.application.observations.refresh({
      key: staleKey,
      source: staleSource,
      load: async (): Promise<never> => { throw new Error('policy capability unavailable'); }
    });

    const unavailableKey = capabilityKey(account.id, unavailableVessel, POLICY_AUTHORITY);
    await harness.application.observations.refresh({
      key: unavailableKey,
      source: staleSource,
      load: async (): Promise<never> => { throw new Error('policy capability never observed'); }
    });

    const staleBody = await listPositions(harness.client.origin, token, account.id, staleVessel);
    const stalePositions = positionArray(staleBody);
    const stale = stalePositions.find((position) => position.source === staleSource);
    assert.ok(stale, 'expected the failed capability evidence');
    assert.equal(stale.state, 'stale');
    assert.equal(typeof stale.error, 'string');
    assert.equal(stalePositions.some((position) => position.vesselId === staleVessel && position.state === 'available'), false, 'legacy availability must not make the typed capability position available');
    const staleObservations = observationsOf(staleBody);
    assert.equal(Object.values(staleObservations).some((observation) => isRecord(observation) && observation.source === legacySource && observation.state === 'available'), true, 'the legacy observation remains retained evidence');

    const unavailableBody = await listPositions(harness.client.origin, token, account.id, unavailableVessel);
    const unavailablePositions = positionArray(unavailableBody);
    const unavailable = unavailablePositions.find((position) => position.source === staleSource);
    assert.ok(unavailable, 'expected an unavailable capability position');
    assert.equal(unavailable.state, 'unavailable');
    assert.equal(typeof unavailable.error, 'string');
    assert.equal(unavailable.portId, undefined);
    assert.equal(unavailable.status, 'unknown');
    assert.equal(unavailablePositions.some((position) => position.vesselId === unavailableVessel && position.state === 'available'), false);
    assert.equal(harness.calls.length, 0);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('retained list and detail positions survive restart without world IO', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-position-retained-'));
  const storeFile = join(directory, 'client.store.json');
  const account = makeAccount('account:retained-position', `https://${ACCOUNT_SERVER}/actors/sana`);
  const vessel = 'https://vessels.test/retained-position';
  const placeId = 'https://policy.test:4200/objects/ports/retained';
  const port = placeId;
  const seed = async (application: ClientApplication): Promise<void> => {
    await seedCapability(application, {
      accountId: account.id, vesselId: vessel, authorityId: POLICY_AUTHORITY,
      state: { visits: [{ vessel, port, route: 'https://policy.test:4200/objects/routes/retained', departed: false }] }
    });
    await seedPlace(application, { placeId, authorityId: POLICY_AUTHORITY });
  };

  const harness = await openHarness(storeFile);
  let reopened: Harness | undefined;
  try {
    const tokens = await installAccounts(harness.application, [account]);
    const token = tokens.get(account.id)!;
    await seed(harness.application);

    const list = positionArray(await listPositions(harness.client.origin, token, account.id, vessel));
    assert.equal(list[0]?.portId, port);
    assert.equal(harness.calls.length, 0, 'retained list read must not fetch');

    const detail = positionArray(await detailPositions(harness.client.origin, token, placeId, account.id, vessel));
    assert.equal(detail[0]?.portId, port);
    assert.equal(harness.calls.length, 0, 'retained detail read must not fetch');

    await harness.close();
    reopened = await openHarness(storeFile);
    const retainedList = positionArray(await listPositions(reopened.client.origin, token, account.id, vessel));
    assert.equal(retainedList[0]?.portId, port);
    const retainedDetail = positionArray(await detailPositions(reopened.client.origin, token, placeId, account.id, vessel));
    assert.equal(retainedDetail[0]?.portId, port);
    assert.equal(reopened.calls.length, 0, 'restart retained list/detail reads must not fetch');
  } finally {
    await reopened?.close();
    if (reopened === undefined) await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});
