import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import type { LogisticsVesselCandidate } from '@fctp/client-sdk';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureOrigin = 'http://fixture.invalid/';
const settleTimeout = 3_000;
const sessionToken = 'secret-client-token';
const observedAt = '2026-01-02T03:04:05.000Z';
const staleAt = '2026-01-01T00:00:00.000Z';
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

const actorA = 'https://home.test:4200/actors/alice';
const actorB = 'https://home.test:4200/actors/bob';
const homeAuthority = 'https://home.test:4200/actors/home';
const homeInfoUri = 'https://home.test:4200/local/info';
const registryId = 'https://home.test:4200/actors/registry';
const registryStateSource = 'https://home.test:4200/local/registry/state';
const territoryId = 'https://territory.test:4300/actors/territory';
const simulationId = 'https://simulation.test:4400/actors/territory';
const simulationId2 = 'https://simulation2.test:4500/actors/territory';
const eastId = 'https://territory.test:4300/objects/ports/east';
const westId = 'https://territory.test:4300/objects/ports/west';
const farId = 'https://territory.test:4300/objects/ports/far';
const boundaryWestId = 'https://territory.test:4300/objects/boundaries/west';
const areaId = 'https://territory.test:4300/objects/areas/island';
const mapId = 'https://territory.test:4300/objects/maps/territory';
const listingId = 'https://territory.test:4300/objects/listings/port';
const approachRouteId = 'https://territory.test:4300/objects/routes/approach';
const coastalRouteId = 'https://territory.test:4300/objects/routes/coastal';
const returnRouteId = 'https://territory.test:4300/objects/routes/return';
const farRouteId = 'https://territory.test:4300/objects/routes/far';
const policySource = 'https://territory.test:4300/local/actions';
const simulationSource = 'https://simulation.test:4400/local/actions';
const simulation2Source = 'https://simulation2.test:4500/local/actions';
const vesselAliceId = 'https://home.test:4200/objects/vessels/alice';
const vesselOutsiderId = 'https://home.test:4200/objects/vessels/outsider';
const vesselBrokenId = 'https://home.test:4200/objects/vessels/broken';
const vesselSecondId = 'https://home.test:4200/objects/vessels/second';
const vesselBId = 'https://home.test:4200/objects/vessels/bob';
const planId = 'route-plan:7f3a9c';
const activityId = 'https://activity.test:4600/actions/entry-1';

const accountA = {
  id: 'account-a',
  handle: '@alice@home.test:4200',
  homeServer: 'home.test:4200',
  actorId: actorA,
  homeAuthority,
  login: { status: 'signed-in' }
};

const accountNoActor = {
  id: 'account-no-actor',
  handle: '@nobody@home.test:4200',
  homeServer: 'home.test:4200',
  homeAuthority,
  login: { status: 'signed-in' }
};

const accountB = {
  id: 'account-b',
  handle: '@bob@home.test:4200',
  homeServer: 'home.test:4200',
  actorId: actorB,
  homeAuthority,
  login: { status: 'signed-in' }
};

const fixtureSource = String.raw`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Explore } from './apps/frontend/src/explore.tsx';
import { VesselTravel } from './apps/frontend/src/vessel-travel.tsx';

const initial = window.__travelFixtureConfig || {};
const fixture = {
  controls: null,
  events: { logistics: [], production: [], resources: [], context: [], explore: [], actions: [] }
};
window.__travelFixture = fixture;

function App() {
  const [screen, setScreen] = React.useState(initial.screen || 'explore');
  const [accountId, setAccountId] = React.useState(initial.accountId);
  const [account, setAccount] = React.useState(initial.account);
  const [context, setContext] = React.useState(initial.context);
  const [revision, setRevision] = React.useState(initial.selectionRevision || 0);
  const [mounted, setMounted] = React.useState(true);

  React.useEffect(() => {
    fixture.controls = { setScreen, setAccountId, setAccount, setContext, setRevision, setMounted };
  }, []);

  if (!mounted) return null;
  const callbacks = {
    onOpenLogistics: (value) => fixture.events.logistics.push(value),
    onOpenProduction: (value) => fixture.events.production.push(value),
    onReadResource: (value) => fixture.events.resources.push(value),
    onContextChange: (value) => fixture.events.context.push(value),
    onOpenExplore: (value) => fixture.events.explore.push(value),
    onOpenAction: (value) => fixture.events.actions.push(value)
  };

  if (screen === 'travel') {
    return React.createElement(VesselTravel, {
      account,
      context,
      selectionRevision: revision,
      onContextChange: callbacks.onContextChange,
      onOpenExplore: callbacks.onOpenExplore,
      onOpenAction: callbacks.onOpenAction,
      onReadResource: callbacks.onReadResource
    });
  }
  return React.createElement(Explore, {
    accountId,
    context,
    selectionRevision: revision,
    onOpenLogistics: callbacks.onOpenLogistics,
    onOpenProduction: callbacks.onOpenProduction,
    onReadResource: callbacks.onReadResource
  });
}

createRoot(document.getElementById('root')).render(React.createElement(App));
`;

interface RecordedRequest {
  method: string;
  pathname: string;
  search: Record<string, string>;
  body?: unknown;
  headers: Record<string, string>;
}

interface ServerResponse {
  status?: number;
  body: unknown;
}

type Handler = (request: RecordedRequest) => ServerResponse | Promise<ServerResponse> | undefined;

interface FixtureSetup {
  screen: 'explore' | 'travel';
  accountId?: string;
  account?: unknown;
  context?: unknown;
  selectionRevision?: number;
  seedSession?: boolean;
  handle: Handler;
}

interface OpenedFixture {
  page: Page;
  requests: RecordedRequest[];
  errors: string[];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function pageResponse(data: unknown, observations: Record<string, unknown> = {}, context: Record<string, unknown> = {}): unknown {
  return { context, data, observations, actions: [] };
}

function resourcePage(id: string, value: unknown, authorityId?: string, observation?: Record<string, unknown>): unknown {
  return pageResponse(
    {
      resourceId: id,
      ...(authorityId === undefined ? {} : { authorityId }),
      value
    },
    {
      [id]: observation ?? { state: 'available', source: id, observedAt, value }
    },
    { resourceId: id }
  );
}

function placeRecords(): Record<string, unknown>[] {
  return [
    { id: eastId, type: 'Port', authorityId: territoryId, name: 'East Haven', territoryId, state: 'available' },
    { id: westId, type: 'Port', authorityId: territoryId, name: 'West Haven', territoryId, state: 'stale' },
    { id: farId, type: 'Port', authorityId: territoryId, name: 'Far Isle', territoryId, state: 'not-retrieved' }
  ];
}

function connectionRecords(): Record<string, unknown>[] {
  return [
    {
      id: approachRouteId, type: 'Route', from: boundaryWestId, to: eastId, territoryId, authorityId: territoryId,
      name: 'Island Approach', state: 'available'
    },
    {
      id: coastalRouteId, type: 'Route', from: eastId, to: westId, territoryId, authorityId: territoryId,
      name: 'Coastal Passage', state: 'available'
    },
    {
      id: returnRouteId, type: 'Route', from: westId, to: eastId, territoryId, authorityId: territoryId,
      name: 'Return Passage', state: 'stale', error: 'Return route evidence is stale'
    },
    {
      id: farRouteId, type: 'Route', from: eastId, to: farId, territoryId, authorityId: territoryId,
      name: 'Far Passage', state: 'not-retrieved', error: 'Far endpoint is unresolved'
    }
  ];
}

function listResponse(): unknown {
  return pageResponse(
    {
      places: placeRecords(),
      connections: connectionRecords(),
      areas: [{ id: areaId, type: 'Area', authorityId: territoryId, name: 'Island Area', state: 'stale', error: 'Area cache stale' }],
      maps: [{ id: mapId, type: 'MapDescriptor', authorityId: territoryId, name: 'Island Map', state: 'available' }],
      listings: [{ id: listingId, type: 'Listing', authorityId: territoryId, name: 'Port Listing', state: 'available' }],
      capabilities: [],
      blockers: []
    },
    {
      [`place:${eastId}`]: { state: 'available', source: eastId, observedAt, value: placeRecords()[0] },
      [`place:${westId}`]: { state: 'stale', source: westId, observedAt: staleAt, error: 'West Haven evidence is stale', value: placeRecords()[1] },
      [`resource:${areaId}`]: { state: 'stale', source: areaId, observedAt: staleAt, error: 'Area cache stale', value: { id: areaId } },
      [`connection:${returnRouteId}`]: { state: 'stale', source: returnRouteId, observedAt: staleAt, error: 'Return route evidence is stale', value: { id: returnRouteId } }
    },
    { accountId: 'account-a', vesselId: 'vessel-a' }
  );
}

function capabilityRecord(): Record<string, unknown> {
  return {
    id: 'mine',
    label: 'Mine ore',
    available: true,
    request: { method: 'POST', href: `${territoryId.replace('/actors/territory', '')}/local/mine`, body: { count: 1 } },
    effect: 'Adds ore to the shared stock'
  };
}

function detailResponse(): unknown {
  return pageResponse(
    {
      place: placeRecords()[0],
      onward: [placeRecords()[1]],
      connections: [
        {
          id: returnRouteId, type: 'Route', from: westId, to: eastId, territoryId, authorityId: territoryId,
          name: 'Return Passage', state: 'stale', error: 'Return route evidence is stale',
          endpoints: [
            { id: westId, state: 'stale', name: 'West Haven', error: 'West Haven evidence is stale' },
            { id: eastId, state: 'available', name: 'East Haven' }
          ]
        },
        {
          id: coastalRouteId, type: 'Route', from: eastId, to: westId, territoryId, authorityId: territoryId,
          name: 'Coastal Passage', state: 'available',
          endpoints: [
            { id: eastId, state: 'available', name: 'East Haven' },
            { id: westId, state: 'stale', name: 'West Haven', error: 'West Haven evidence is stale' }
          ]
        },
        {
          id: farRouteId, type: 'Route', from: eastId, to: farId, territoryId, authorityId: territoryId,
          name: 'Far Passage', state: 'not-retrieved',
          endpoints: [
            { id: eastId, state: 'available', name: 'East Haven' },
            { id: farId, state: 'not-retrieved' }
          ]
        }
      ],
      areas: [{ id: areaId, type: 'Area', authorityId: territoryId, name: 'Island Area', state: 'stale', error: 'Area cache stale' }],
      maps: [{ id: mapId, type: 'MapDescriptor', authorityId: territoryId, name: 'Island Map', state: 'available' }],
      listings: [{ id: listingId, type: 'Listing', authorityId: territoryId, name: 'Port Listing', state: 'available' }],
      capabilities: [capabilityRecord()],
      blockers: [{ id: farId, source: territoryId, message: 'Far Isle endpoint is not retrieved', state: 'not-retrieved' }]
    },
    {
      [`place:${eastId}`]: { state: 'available', source: eastId, observedAt, value: placeRecords()[0] },
      [`connection:${returnRouteId}`]: { state: 'stale', source: returnRouteId, observedAt: staleAt, error: 'Return route evidence is stale', value: { id: returnRouteId } }
    },
    { placeId: eastId, accountId: 'account-a', vesselId: 'vessel-a' }
  );
}

function listWithPositions(ports: [{ portId: string; source: string }, { portId: string; source: string }]): unknown {
  const base = listResponse() as { data: { positions?: unknown[] } };
  base.data.positions = ports.map(({ portId, source }) => ({
    accountId: 'account-a', vesselId: 'vessel-a', authorityId: territoryId,
    source, observedAt, state: 'available', status: 'active', portId
  }));
  return base;
}

function ownedCandidate(id = vesselAliceId, name = 'Alice Skiff', possessor = actorA): LogisticsVesselCandidate {
  return { id, name, registry: registryId, possessor, ownership: 'verified-owned', registrySupported: true, source: id, state: 'available', observedAt };
}

function candidateResponse(accountId = 'account-a', candidates: LogisticsVesselCandidate[] = [ownedCandidate()]): unknown {
  return pageResponse({ accountId, candidates, blockers: [] }, {
    publication: { source: homeInfoUri, state: 'available', observedAt, value: { vessels: {} } }
  }, { accountId });
}

function routePlanResponse(plan: Record<string, unknown> = routePlan()): unknown {
  return pageResponse({ plan }, {}, { accountId: 'account-a', routeId: plan.id });
}

function routePlan(): Record<string, unknown> {
  return {
    id: planId,
    accountId: 'account-a',
    from: eastId,
    to: westId,
    legs: [{ routeId: coastalRouteId, from: eastId, to: westId, territoryId }],
    blockers: [{ id: farId, source: territoryId, message: 'Far Isle endpoint is not retrieved', state: 'not-retrieved' }],
    createdAt: observedAt
  };
}

function journeyPlan(): Record<string, unknown> {
  return {
    id: planId,
    accountId: 'account-a',
    from: boundaryWestId,
    to: westId,
    legs: [
      { routeId: approachRouteId, from: boundaryWestId, to: eastId, territoryId },
      { routeId: coastalRouteId, from: eastId, to: westId, territoryId }
    ],
    blockers: [],
    createdAt: observedAt
  };
}

function vesselState(vesselId: string = vesselAliceId, cargoCount = 4): unknown {
  return pageResponse(
    {
      accountId: 'account-a',
      vesselId,
      vessel: { id: vesselId, registry: registryId, possessor: actorA, name: 'Alice Skiff' },
      registry: {
        authorityId: registryId,
        source: registryStateSource,
        state: 'available',
        observedAt,
        cargo: { entries: [{ variety: 'ore', count: cargoCount }] },
        adoption: true,
        location: { status: 'docked', port: eastId },
        pendingRequests: [{ id: 'entry-request-9', status: 'pending' }]
      },
      territories: [
        {
          authorityId: territoryId,
          kind: 'policy',
          source: policySource,
          state: 'available',
          observedAt,
          visit: { vessel: vesselId, port: westId, departed: false },
          cargo: { entries: [{ variety: 'ore', count: 2 }] },
          sharedStock: { warehouse: { ore: 10 }, port: { ore: 3 } }
        },
        {
          authorityId: simulationId,
          kind: 'simulation',
          source: simulationSource,
          state: 'unavailable',
          observedAt: staleAt,
          error: 'Simulation observations unavailable'
        },
        {
          authorityId: simulationId2,
          kind: 'simulation',
          source: simulation2Source,
          state: 'not-retrieved'
        }
      ]
    },
    {
      [registryStateSource]: { state: 'available', source: registryStateSource, observedAt, value: {} },
      [policySource]: { state: 'available', source: policySource, observedAt, value: {} },
      [simulationSource]: { state: 'unavailable', source: simulationSource, observedAt: staleAt, error: 'Simulation observations unavailable' },
      [simulation2Source]: { state: 'not-retrieved', source: simulation2Source }
    },
    { accountId: 'account-a', vesselId }
  );
}

function actionRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: activityId,
    statusUrl: `${activityId}/status`,
    accountId: 'account-a',
    targetId: territoryId,
    resultReferences: [{ kind: 'request', id: 'entry-request-1' }],
    intent: { kind: 'entry', inputs: {} },
    submittedAt: observedAt,
    submission: { status: 'accepted' },
    outcome: { status: 'pending', evidence: [] },
    ...overrides
  };
}

let browser: Browser | undefined;
let bundle: string | undefined;

before(async () => {
  const result = await build({
    stdin: {
      contents: fixtureSource,
      resolveDir: projectRoot,
      sourcefile: 'frontend-travel-fixture.js',
      loader: 'js'
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{
      name: 'stub-styles',
      setup(builder) {
        builder.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'style-stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'style-stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
      }
    }]
  });
  const output = result.outputFiles[0];
  assert(output, 'esbuild produced no fixture bundle');
  bundle = output.text;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

async function openFixture(t: TestContext, setup: FixtureSetup): Promise<OpenedFixture> {
  const activeBrowser = browser;
  const activeBundle = bundle;
  assert(activeBrowser, 'browser was not started');
  assert(activeBundle, 'fixture bundle was not built');

  const context = await activeBrowser.newContext();
  t.after(async () => { await context.close(); });
  if (setup.seedSession !== false) {
    await context.addInitScript(() => {
      localStorage.setItem('fctp.client-sessions', JSON.stringify([
        { accountId: 'account-a', handle: '@alice@home.test:4200', clientToken: 'secret-client-token' },
        { accountId: 'account-b', handle: '@bob@home.test:4200', clientToken: 'secret-client-token-b' },
        { accountId: 'account-no-actor', handle: '@nobody@home.test:4200', clientToken: 'secret-client-token-no-actor' }
      ]));
    });
  }
  await context.addInitScript((value) => {
    (window as unknown as { __travelFixtureConfig?: unknown }).__travelFixtureConfig = value;
  }, {
    screen: setup.screen,
    accountId: setup.accountId,
    account: setup.account,
    context: setup.context,
    selectionRevision: setup.selectionRevision
  });

  const page = await context.newPage();
  const requests: RecordedRequest[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });

  await page.route(`${fixtureOrigin}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const raw = request.postData();
    let body: unknown;
    if (raw) {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        body = raw;
      }
    }
    const recorded: RecordedRequest = {
      method: request.method(),
      pathname: url.pathname,
      search: Object.fromEntries(url.searchParams),
      ...(body === undefined ? {} : { body }),
      headers: request.headers()
    };
    requests.push(recorded);

    if (url.pathname === '/bundle.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: activeBundle });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const response = await setup.handle(recorded) ?? (recorded.method === 'GET' && recorded.pathname === '/api/logistics/vessels'
        ? { body: candidateResponse(recorded.search.accountId, recorded.search.accountId === 'account-b' ? [ownedCandidate(vesselBId, 'Bob Cutter', actorB)] : []) }
        : undefined);
      if (response === undefined) {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `Unhandled fixture request ${recorded.method} ${recorded.pathname}` }) });
        return;
      }
      await route.fulfill({
        status: response.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(response.body)
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });

  await page.goto(fixtureOrigin);
  await page.waitForFunction(() => {
    const fixture = (window as unknown as { __travelFixture?: { controls?: unknown } }).__travelFixture;
    return Boolean(fixture && fixture.controls);
  });
  return { page, requests, errors };
}

function region(page: Page, name: 'Explore' | 'Vessel travel') {
  return page.getByRole('region', { name });
}

async function regionText(page: Page, name: 'Explore' | 'Vessel travel'): Promise<string> {
  return region(page, name).innerText();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate: () => Promise<boolean> | boolean, message: string, timeout = settleTimeout): Promise<void> {
  const started = Date.now();
  while (true) {
    if (await predicate()) return;
    if (Date.now() - started >= timeout) break;
    await sleep(25);
  }
  throw new Error(message);
}

async function waitForRegionText(page: Page, name: 'Explore' | 'Vessel travel', expected: string | RegExp, message: string): Promise<string> {
  let last = '';
  try {
    await waitFor(async () => {
      last = await regionText(page, name);
      return typeof expected === 'string' ? last.includes(expected) : expected.test(last);
    }, message);
  } catch (error) {
    throw new Error(`${message}; last ${name} text was ${JSON.stringify(last)}`, { cause: error });
  }
  return last;
}

async function controls(page: Page, name: string, ...args: unknown[]): Promise<void> {
  await page.evaluate(({ method, values }) => {
    const fixture = (window as unknown as { __travelFixture: { controls: Record<string, (...parameters: unknown[]) => void> } }).__travelFixture;
    const control = fixture.controls[method];
    if (control === undefined) throw new Error(`Missing fixture control ${method}`);
    control(...values);
  }, { method: name, values: args });
}

async function events(page: Page, name: 'logistics' | 'production' | 'resources' | 'context' | 'explore' | 'actions'): Promise<unknown[]> {
  return page.evaluate((eventName) => {
    const fixture = (window as unknown as { __travelFixture?: { events?: Record<string, unknown[]> } }).__travelFixture;
    return fixture?.events?.[eventName] ?? [];
  }, name);
}

function requestsFor(requests: readonly RecordedRequest[], method: string, pathname: string): RecordedRequest[] {
  return requests.filter((request) => request.method === method && request.pathname === pathname);
}

function encodedPath(id: string): string {
  return `/api/resources/${encodeURIComponent(id)}`;
}

function expectBearer(request: RecordedRequest, token = sessionToken): void {
  assert.equal(request.headers.authorization, `Bearer ${token}`);
}

async function clickButton(page: Page, name: string | RegExp): Promise<void> {
  await page.getByRole('button', { name, exact: typeof name === 'string' }).first().click();
}

async function openDetails(page: Page, name: 'Explore' | 'Vessel travel'): Promise<void> {
  const summaries = region(page, name).locator('details > summary');
  const count = await summaries.count();
  for (let index = 0; index < count; index += 1) await summaries.nth(index).click();
}

test('reads retained Explore places once with exact account and vessel scope, then refreshes only on request', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    screen: 'explore',
    accountId: 'account-a',
    context: { accountId: 'account-a', vesselId: 'vessel-a' },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === '/api/explore/places') return { body: listResponse() };
      if (request.method === 'POST' && request.pathname === '/api/explore/refresh') {
        const refreshed = listResponse() as { data: { places: Record<string, unknown>[] } };
        refreshed.data.places = [...refreshed.data.places, { id: 'https://territory.test:4300/objects/ports/new', type: 'Port', authorityId: territoryId, name: 'New Quay', territoryId, state: 'available' }];
        return { body: refreshed };
      }
      return undefined;
    }
  });

  await waitForRegionText(page, 'Explore', 'East Haven', 'expected the retained place list');
  const listed = await regionText(page, 'Explore');
  for (const expected of ['West Haven', 'Island Area', 'Island Map', 'Port Listing', 'Island Approach', 'Coastal Passage', 'Area cache stale', staleAt]) {
    assert.ok(listed.includes(expected), `expected retained Explore content ${expected}`);
  }

  const gets = requestsFor(requests, 'GET', '/api/explore/places');
  assert.equal(gets.length, 1, 'mount must read the retained place list once');
  assert.deepEqual(gets[0]?.search, { accountId: 'account-a', vesselId: 'vessel-a' });
  expectBearer(gets[0]!);
  assert.equal(requestsFor(requests, 'POST', '/api/explore/refresh').length, 0, 'mount must not refresh world observations');

  await clickButton(page, 'Refresh places');
  await waitForRegionText(page, 'Explore', 'New Quay', 'expected the explicit refresh result');
  const posts = requestsFor(requests, 'POST', '/api/explore/refresh');
  assert.equal(posts.length, 1, 'Refresh places must submit one explicit observation');
  expectBearer(posts[0]!);
  assert.deepEqual(posts[0]?.body, { accountId: 'account-a', vesselId: 'vessel-a' });
  assert.equal(requestsFor(requests, 'GET', '/api/explore/places').length, 1, 'explicit refresh must not add an automatic retained read');
  assert.deepEqual(errors, []);
});

test('keeps retained Explore geography when an explicit refresh fails and separates unavailable from empty', async (t) => {
  const { page, errors } = await openFixture(t, {
    screen: 'explore',
    accountId: 'account-a',
    context: { accountId: 'account-a', vesselId: 'vessel-a' },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === '/api/explore/places') return { body: listResponse() };
      if (request.method === 'POST' && request.pathname === '/api/explore/refresh') return { status: 503, body: { error: 'Places observation unavailable' } };
      return undefined;
    }
  });

  await waitForRegionText(page, 'Explore', 'East Haven', 'expected the retained place list');
  await clickButton(page, 'Refresh places');
  await waitForRegionText(page, 'Explore', /Places observation unavailable|HTTP 503/i, 'expected the explicit refresh failure');
  const retained = await regionText(page, 'Explore');
  assert.ok(retained.includes('East Haven'), 'a failed refresh must keep retained places');

  const empty = await openFixture(t, {
    screen: 'explore',
    accountId: 'account-a',
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === '/api/explore/places') {
        return { body: pageResponse({ places: [], connections: [], areas: [], maps: [], listings: [], capabilities: [], blockers: [] }) };
      }
      return undefined;
    }
  });
  await waitForRegionText(empty.page, 'Explore', /no retained places/i, 'expected an honest empty geography');
  const emptyText = await regionText(empty.page, 'Explore');
  assert.equal(/unavailable|could not be read/i.test(emptyText), false, 'empty geography must not be reported as a failed read');
  assert.equal(requestsFor(empty.requests, 'POST', '/api/explore/refresh').length, 0);
  assert.deepEqual(errors, []);
});

test('reports an unavailable retained Explore read distinctly and preserves explicit Refresh', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    screen: 'explore',
    accountId: 'account-a',
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === '/api/explore/places') return { status: 503, body: { error: 'Retained places unavailable' } };
      return undefined;
    }
  });

  await waitForRegionText(page, 'Explore', /Retained places unavailable/i, 'expected the retained read failure');
  const text = await regionText(page, 'Explore');
  assert.equal(/no retained places/i.test(text), false, 'a failed read is not an empty geography');
  await clickButton(page, 'Refresh places');
  await waitFor(() => requestsFor(requests, 'POST', '/api/explore/refresh').length === 1, 'Refresh must remain available after a retained read failure');
  assert.deepEqual(errors, []);
});

test('opens place detail with exact incoming and outgoing directions, unresolved endpoints, and linked reader targets', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    screen: 'explore',
    accountId: 'account-a',
    context: { accountId: 'account-a', vesselId: 'vessel-a' },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === '/api/explore/places') return { body: listResponse() };
      if (request.method === 'GET' && request.pathname === `/api/explore/places/${encodeURIComponent(eastId)}`) return { body: detailResponse() };
      if (request.method === 'GET' && request.pathname === encodedPath(areaId)) return { body: resourcePage(areaId, { id: areaId, name: 'Island Area' }, territoryId) };
      return undefined;
    }
  });

  await waitForRegionText(page, 'Explore', 'East Haven', 'expected the retained place list');
  await clickButton(page, 'Open East Haven');
  await waitForRegionText(page, 'Explore', /Incoming|Incoming connection/i, 'expected incoming connection evidence');
  const detailGets = requests.filter((request) => request.method === 'GET' && request.pathname === `/api/explore/places/${encodeURIComponent(eastId)}`);
  assert.equal(detailGets.length, 1, 'opening a place must use one retained detail read');
  expectBearer(detailGets[0]!);
  assert.deepEqual(detailGets[0]?.search, { accountId: 'account-a', vesselId: 'vessel-a' });

  const text = await regionText(page, 'Explore');
  assert.match(text, /incoming/i, 'the return edge must be labelled incoming');
  assert.match(text, /outgoing/i, 'forward edges must be labelled outgoing');
  assert.ok(text.includes('West Haven') && text.includes('East Haven'), 'incoming edge must show its exact endpoints');
  assert.ok(text.includes('Far Isle'), 'the unresolved outgoing endpoint must remain named');
  assert.match(text, /not retrieved|unresolved/i, 'a missing endpoint must not be presented as an established place');
  assert.equal(text.includes('West Haven → East Haven') && text.includes('East Haven → West Haven'), true, 'both directed connections must retain their original direction');
  assert.equal(requests.filter((request) => request.pathname.startsWith('/local/')).length, 0, 'published request hrefs must not be called as a browser proxy');

  await openDetails(page, 'Explore');
  const disclosed = await regionText(page, 'Explore');
  for (const exact of [eastId, westId, farId, returnRouteId, coastalRouteId, farRouteId]) {
    assert.ok(disclosed.includes(exact), `expected exact identity ${exact} in disclosures`);
  }

  await clickButton(page, /Open authority for East Haven/i);
  await clickButton(page, /Read Island Area/i);
  const readerEvents = await events(page, 'resources');
  assert.deepEqual(readerEvents[0], { id: territoryId, authorityId: territoryId });
  assert.deepEqual(readerEvents[1], { id: areaId, authorityId: territoryId });
  assert.deepEqual(errors, []);
});

test('capability continuation carries place, authority, vessel and capability identity without inventing a qualified operation ID', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    screen: 'explore',
    accountId: 'account-a',
    context: { accountId: 'account-a', vesselId: 'vessel-a' },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === '/api/explore/places') return { body: listResponse() };
      if (request.method === 'GET' && request.pathname === `/api/explore/places/${encodeURIComponent(eastId)}`) return { body: detailResponse() };
      return undefined;
    }
  });

  await waitForRegionText(page, 'Explore', 'East Haven', 'expected the retained place list');
  await clickButton(page, 'Open East Haven');
  await waitForRegionText(page, 'Explore', 'Mine ore', 'expected the place capability');
  await clickButton(page, /Continue to operations.*Mine ore/i);

  const productions = await events(page, 'production');
  assert.equal(productions.length, 1, 'capability continuation must invoke one exact callback');
  const handoff = productions[0] as Record<string, unknown>;
  assert.equal(handoff.accountId, 'account-a');
  assert.equal(handoff.vesselId, 'vessel-a');
  assert.equal(handoff.placeId, eastId);
  assert.equal(handoff.authorityId, territoryId);
  assert.equal(handoff.capabilityId, 'mine');
  assert.equal(handoff.operationId, undefined, 'Explore must not guess a qualified operation ID');
  assert.equal(requests.some((request) => request.pathname.startsWith('/local/')), false, 'capability request hrefs are descriptive, not executable browser proxies');
  assert.deepEqual(errors, []);
});

test('inserts the retained Port picker, inspects without selecting, cancels, and groups only directed nearby ports', async (t) => {
  const positioned = listWithPositions([
    { portId: westId, source: `${territoryId}/local/actions#primary` },
    { portId: westId, source: `${territoryId}/local/actions#secondary` }
  ]);
  const { page, requests, errors } = await openFixture(t, {
    screen: 'explore',
    accountId: 'account-a',
    context: { accountId: 'account-a', vesselId: 'vessel-a' },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === '/api/explore/places') return { body: positioned };
      if (request.method === 'GET' && request.pathname === encodedPath(westId)) return { body: resourcePage(westId, { id: westId, name: 'West Haven' }, territoryId) };
      return undefined;
    }
  });

  await waitForRegionText(page, 'Explore', 'East Haven', 'expected the retained place list');
  await clickButton(page, 'Choose destination');
  const dialog = page.getByRole('dialog', { name: 'Destination Port' });
  await dialog.waitFor({ state: 'visible' });
  const pickerText = await dialog.innerText();
  assert.ok(pickerText.includes('East Haven') && pickerText.includes('West Haven'), 'the picker must use the retained Port candidates');
  const nearby = dialog.getByRole('region', { name: /Nearby ports/i });
  await nearby.waitFor({ state: 'visible' });
  const nearbyText = await nearby.innerText();
  assert.match(nearbyText, /Nearby ports for vessel-a/i, 'agreeing position observations must enable nearby grouping');
  assert.ok(nearbyText.includes(`Directed connection from ${westId} to ${eastId}.`), 'nearby must show the exact outgoing connection from the supplied position');
  assert.equal(nearbyText.includes('Far Isle'), false, 'a connection leaving another port must not be presented as nearby from the current position');

  await dialog.getByRole('textbox', { name: /Search retained candidates/i }).fill('west');
  await waitFor(async () => await dialog.getByRole('button', { name: 'Select East Haven' }).count() === 0, 'local filtering must not contact the server');
  assert.equal(requestsFor(requests, 'GET', '/api/explore/places').length, 1, 'typing must not trigger another read');

  await dialog.getByRole('button', { name: 'Inspect West Haven' }).click();
  const reader = page.getByRole('dialog', { name: /West Haven|Resource/ });
  await reader.waitFor({ state: 'visible' });
  assert.equal((await events(page, 'logistics')).length, 0, 'inspection must not select or hand off a destination');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'visible' });

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await waitFor(async () => await dialog.count() === 0, 'Cancel must close the destination picker without selecting');
  assert.equal((await events(page, 'logistics')).length, 0, 'Cancel must not hand off a route');
  assert.deepEqual(errors, []);
});

test('does not derive a confident nearby origin when retained position observations conflict', async (t) => {
  const positioned = listWithPositions([
    { portId: westId, source: `${territoryId}/local/actions#primary` },
    { portId: eastId, source: `${territoryId}/local/actions#secondary` }
  ]);
  const { page, errors } = await openFixture(t, {
    screen: 'explore',
    accountId: 'account-a',
    context: { accountId: 'account-a', vesselId: 'vessel-a' },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === '/api/explore/places') return { body: positioned };
      return undefined;
    }
  });

  await waitForRegionText(page, 'Explore', 'East Haven', 'expected the retained place list');
  await clickButton(page, 'Choose destination');
  const dialog = page.getByRole('dialog', { name: 'Destination Port' });
  await dialog.waitFor({ state: 'visible' });
  const text = await dialog.innerText();
  assert.equal(/Nearby ports for/i.test(text), false, 'conflicting positions must not produce a nearby group');
  assert.match(text, /unavailable|conflict|disagree|cannot be confirmed|unknown/i, 'conflicting position evidence must be explained');
  assert.deepEqual(errors, []);
});

test('creates an exact directed route plan, hands off only exact workflow context, and reapplies a repeated recovery revision', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    screen: 'explore',
    accountId: 'account-a',
    context: { accountId: 'account-a', vesselId: 'vessel-a' },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === '/api/explore/places') return { body: listResponse() };
      if (request.method === 'POST' && request.pathname === '/api/explore/routes') return { body: routePlanResponse() };
      if (request.method === 'GET' && request.pathname === `/api/explore/routes/${encodeURIComponent(planId)}`) return { body: routePlanResponse() };
      return undefined;
    }
  });

  await waitForRegionText(page, 'Explore', 'East Haven', 'expected the retained place list');
  await clickButton(page, 'Set East Haven as origin');
  await clickButton(page, 'Choose destination');
  const dialog = page.getByRole('dialog', { name: 'Destination Port' });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: 'Select West Haven' }).click();
  await waitFor(async () => await dialog.count() === 0, 'selecting a destination must close the picker');
  await clickButton(page, 'Create route plan');

  await waitForRegionText(page, 'Explore', 'Coastal Passage', 'expected the proposed directed route');
  const created = requestsFor(requests, 'POST', '/api/explore/routes');
  assert.equal(created.length, 1, 'one explicit route plan must be retained');
  expectBearer(created[0]!);
  assert.deepEqual(created[0]?.body, { accountId: 'account-a', from: eastId, to: westId });
  await openDetails(page, 'Explore');
  const proposed = await regionText(page, 'Explore');
  assert.ok(proposed.includes(eastId) && proposed.includes(westId), 'the plan must retain exact origin and destination IDs');
  assert.ok(proposed.includes('Far Isle endpoint is not retrieved'), 'known route blockers must be visible');
  assert.equal(proposed.includes('https://territory.test:4300/local/mine'), false, 'advertised request hrefs must not become executable UI');

  await clickButton(page, 'Use this plan');
  const logistics = await events(page, 'logistics');
  assert.equal(logistics.length, 1, 'accepting the plan must invoke one exact handoff');
  const handoff = logistics[0] as Record<string, unknown>;
  assert.equal(handoff.accountId, 'account-a');
  assert.equal(handoff.vesselId, 'vessel-a');
  assert.equal(handoff.routePlanId, planId);
  assert.equal(handoff.operationId, undefined, 'route handoff must not invent an operation ID');

  await controls(page, 'setContext', { accountId: 'account-a', vesselId: 'vessel-a', routePlanId: planId });
  await controls(page, 'setRevision', 1);
  const recoveredRoute = (): RecordedRequest[] => requests.filter((request) => request.method === 'GET' && request.pathname === `/api/explore/routes/${encodeURIComponent(planId)}`);
  await waitFor(() => recoveredRoute().length >= 1, 'route context recovery must read the retained plan');
  await waitForRegionText(page, 'Explore', 'Coastal Passage', 'expected the recovered route plan');
  const firstRecoveryCount = recoveredRoute().length;

  await controls(page, 'setRevision', 2);
  await waitFor(() => recoveredRoute().length > firstRecoveryCount, 'a repeated selection revision must reapply the exact route handoff');
  for (const request of recoveredRoute()) {
    expectBearer(request);
    assert.deepEqual(request.search, { accountId: 'account-a' });
  }
  assert.deepEqual(errors, []);
});

test('reads typed published vessel candidates and refreshes only on request without selecting a vessel', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    screen: 'travel',
    account: accountA,
    handle: (request) => {
      if ((request.method === 'GET' && request.pathname === '/api/logistics/vessels')
        || (request.method === 'POST' && request.pathname === '/api/logistics/vessels/refresh')) {
        return { body: candidateResponse('account-a', [
          ownedCandidate(vesselAliceId, request.method === 'POST' ? 'Fresh Alice Skiff' : 'Alice Skiff'),
          { ...ownedCandidate(vesselOutsiderId, 'Bob Cutter', actorB), ownership: 'not-owned' },
          { id: vesselBrokenId, source: vesselBrokenId, state: 'unavailable', ownership: 'unverified', error: 'Vessel document unavailable' }
        ]) };
      }
      return undefined;
    }
  });

  await waitForRegionText(page, 'Vessel travel', /Alice Skiff|published vessel candidates/i, 'expected verified vessel candidates');
  const candidateReads = requestsFor(requests, 'GET', '/api/logistics/vessels');
  assert.equal(candidateReads.length, 1, 'the candidate page must use one retained application read');
  expectBearer(candidateReads[0]!);
  assert.deepEqual(candidateReads[0]?.search, { accountId: 'account-a' });

  const text = await regionText(page, 'Vessel travel');
  assert.ok(text.includes('Alice Skiff'), 'an exact owned candidate must be named');
  assert.ok(text.includes('Bob Cutter'), 'an other-account candidate must remain visible with its evidence');
  assert.match(text, /not owned|other account|unverified|cannot be verified/i, 'foreign ownership must be explained');
  assert.match(text, /unavailable|failed/i, 'a failed candidate document must be explained');
  assert.ok(text.includes(observedAt), 'candidate evidence time must remain visible');

  await openDetails(page, 'Vessel travel');
  const disclosed = await regionText(page, 'Vessel travel');
  for (const exact of [vesselAliceId, vesselOutsiderId, vesselBrokenId]) {
    assert.ok(disclosed.includes(exact), `expected exact candidate identity ${exact} in details`);
  }
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0, 'reading publication must not refresh world observations');
  assert.equal(requests.filter((request) => request.pathname.startsWith('/api/logistics/vessels/')).length, 0, 'a candidate list must not select the first vessel automatically');
  await clickButton(page, /Refresh vessel candidates/i);
  await waitForRegionText(page, 'Vessel travel', 'Fresh Alice Skiff', 'expected explicit candidate refresh');
  const refreshed = requestsFor(requests, 'POST', '/api/logistics/vessels/refresh');
  assert.equal(refreshed.length, 1);
  expectBearer(refreshed[0]!);
  assert.deepEqual(refreshed[0]?.body, { accountId: 'account-a' });
  assert.deepEqual(errors, []);
});

test('selects a verified candidate into retained vessel state and communicates the exact context', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    screen: 'travel',
    account: accountA,
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === '/api/logistics/vessels') return { body: candidateResponse() };
      if (request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`) {
        return { body: vesselState(vesselAliceId) };
      }
      return undefined;
    }
  });

  await waitForRegionText(page, 'Vessel travel', 'Alice Skiff', 'expected the owned candidate');
  await clickButton(page, 'Select Alice Skiff');
  await waitForRegionText(page, 'Vessel travel', /Registry cargo/i, 'selecting a candidate must read retained vessel state');

  const reads = requests.filter((request) => request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`);
  assert.equal(reads.length, 1, 'selection must use one retained vessel read');
  expectBearer(reads[0]!);
  assert.deepEqual(reads[0]?.search, { accountId: 'account-a' });
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0, 'selection must not refresh or mutate the world');

  const contexts = await events(page, 'context');
  assert.equal(contexts.length, 1, 'selecting a vessel must communicate one exact parent context');
  assert.deepEqual(contexts[0], { accountId: 'account-a', vesselId: vesselAliceId });
  assert.deepEqual(errors, []);
});

test('keeps a known vessel reference usable when the candidate publication is unavailable and explains missing Actor identity', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    screen: 'travel',
    account: accountA,
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === '/api/logistics/vessels') return { body: pageResponse({
        accountId: 'account-a', candidates: [], blockers: ['Home publication unavailable; this does not prove the account owns no vessels.']
      }, { publication: { source: homeInfoUri, state: 'unavailable', error: 'Home publication unavailable' } }, { accountId: 'account-a' }) };
      if (request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`) return { body: vesselState(vesselAliceId) };
      return undefined;
    }
  });

  await waitForRegionText(page, 'Vessel travel', /Home publication unavailable|publication.*unavailable/i, 'expected the candidate publication failure');
  const unavailableText = await regionText(page, 'Vessel travel');
  assert.match(unavailableText, /not the same as owning no vessels|does not prove|no published candidates/i, 'a publication failure must not claim the account has no vessels');

  await page.getByRole('textbox', { name: /Known vessel ID/i }).fill(vesselAliceId);
  await clickButton(page, /Open known vessel reference/i);
  await waitForRegionText(page, 'Vessel travel', /Registry cargo/i, 'the known vessel reference must open independently of publication');
  const knownReads = requests.filter((request) => request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`);
  assert.equal(knownReads.length, 1, 'the known reference must use the retained vessel page');
  expectBearer(knownReads[0]!);
  assert.deepEqual(knownReads[0]?.search, { accountId: 'account-a' });

  const noActor = await openFixture(t, {
    screen: 'travel',
    account: accountNoActor,
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === '/api/logistics/vessels') return { body: pageResponse({
        accountId: accountNoActor.id,
        candidates: [{ ...ownedCandidate(), ownership: 'unverified' }],
        blockers: ['Missing Actor ID; ownership cannot be verified.']
      }, {}, { accountId: accountNoActor.id }) };
      return undefined;
    }
  });
  await waitForRegionText(noActor.page, 'Vessel travel', /Actor ID|ownership cannot be verified/i, 'missing Actor identity must be explained');
  const noActorText = await regionText(noActor.page, 'Vessel travel');
  assert.match(noActorText, /cannot be verified|missing Actor ID/i);
  assert.equal(noActorText.includes('Select Alice Skiff'), false, 'an unverifiable candidate must not be selectable');
  assert.deepEqual(errors, []);
});

test('renders Registry and Territory ledgers independently, shows unknown versus empty, and keeps retained data when refresh fails', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    screen: 'travel',
    account: accountA,
    context: { accountId: 'account-a', vesselId: vesselAliceId },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`) return { body: vesselState(vesselAliceId) };
      if (request.method === 'POST' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/refresh`) {
        return { status: 502, body: { error: 'Registry observation failed' } };
      }
      return undefined;
    }
  });

  await waitForRegionText(page, 'Vessel travel', /Registry cargo/i, 'expected retained vessel state');
  const text = await regionText(page, 'Vessel travel');
  assert.match(text, /adoption/i, 'Registry adoption must be separate');
  assert.match(text, /Registry location/i, 'Registry location must be labelled');
  assert.match(text, /pending/i, 'pending Registry requests must be shown');
  assert.match(text, /Territory.*visit/i, 'Territory visit must be labelled separately');
  assert.match(text, /Territory.*cargo/i, 'Territory cargo must be separate from Registry cargo');
  assert.match(text, /Shared stock/i, 'shared Territory stock must be visible');
  for (const source of [registryStateSource, policySource, simulationSource]) {
    assert.ok(text.includes(source), `expected independent source ${source}`);
  }
  assert.ok(text.includes(observedAt) && text.includes(staleAt), 'each ledger must retain its own observation time');
  assert.match(text, /unavailable/i, 'a failed Territory source must remain distinct');
  assert.match(text, /not retrieved|unknown/i, 'an unobserved Territory must be unknown rather than empty');
  assert.match(text, /docked|Registry location/i, 'Registry location must remain its own record');
  assert.match(text, /West Haven|visit/i, 'a competing Territory visit must remain visible instead of being flattened');

  const reads = requests.filter((request) => request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`);
  assert.equal(reads.length, 1, 'exact vessel context must use one retained read');
  assert.equal(requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/refresh`).length, 0, 'context must not automatically refresh');

  await clickButton(page, /Refresh vessel/i);
  await waitForRegionText(page, 'Vessel travel', /Registry observation failed/i, 'expected the explicit refresh failure');
  const retained = await regionText(page, 'Vessel travel');
  assert.ok(retained.includes('Registry cargo') && retained.includes(policySource), 'a failed refresh must keep retained ledgers');
  const refreshes = requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/refresh`);
  assert.equal(refreshes.length, 1, 'Refresh vessel must submit one explicit observation');
  expectBearer(refreshes[0]!);
  assert.deepEqual(refreshes[0]?.body, { accountId: 'account-a' });
  assert.deepEqual(errors, []);
});

test('drops late vessel results across account and vessel changes and restores the current state after A to B to A', async (t) => {
  const firstA = deferred<ServerResponse>();
  const firstB = deferred<ServerResponse>();
  const currentA = deferred<ServerResponse>();
  const secondVessel = deferred<ServerResponse>();
  let aGets = 0;
  let bGets = 0;
  let secondGets = 0;

  const { page, errors } = await openFixture(t, {
    screen: 'travel',
    account: accountA,
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`) {
        aGets += 1;
        return aGets === 1 ? firstA.promise : currentA.promise;
      }
      if (request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselSecondId)}`) {
        secondGets += 1;
        return secondVessel.promise;
      }
      if (request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselBId)}`) {
        bGets += 1;
        return firstB.promise;
      }
      return undefined;
    }
  });

  await controls(page, 'setContext', { accountId: 'account-a', vesselId: vesselAliceId });
  await waitFor(() => aGets === 1, 'expected the first A vessel read');
  await controls(page, 'setContext', { accountId: 'account-a', vesselId: vesselSecondId });
  await waitFor(() => secondGets === 1, 'expected a same-account second vessel read');
  await controls(page, 'setAccount', accountB);
  await controls(page, 'setContext', { accountId: 'account-b', vesselId: vesselBId });
  await waitFor(() => bGets === 1, 'expected the B vessel read');
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const bMasked = await regionText(page, 'Vessel travel');
  assert.equal(bMasked.includes('Alice Skiff'), false, 'a mismatching account must immediately mask the old A state');

  await controls(page, 'setContext', { accountId: 'account-a', vesselId: vesselAliceId });
  await controls(page, 'setAccount', accountA);
  await waitFor(() => aGets === 2, 'expected a fresh A vessel read after returning from B');

  firstA.resolve({ body: vesselState(vesselAliceId, 111) });
  secondVessel.resolve({ body: vesselState(vesselSecondId, 222) });
  firstB.resolve({ body: vesselState(vesselBId, 333) });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const late = await regionText(page, 'Vessel travel');
  assert.equal(late.includes('111'), false, 'a late A response from before the vessel change must not return');
  assert.equal(late.includes('222'), false, 'a late same-account second vessel response must not replace the current vessel');
  assert.equal(late.includes('333'), false, 'a late B response must not replace the current account');

  currentA.resolve({ body: vesselState(vesselAliceId, 444) });
  await waitForRegionText(page, 'Vessel travel', '444', 'expected the current A state after A to B to A');
  assert.deepEqual(errors, []);
});

test('ignores a late vessel response after unmount and shows only a fresh read after remount', async (t) => {
  const pending = deferred<ServerResponse>();
  let reads = 0;
  const { page, errors } = await openFixture(t, {
    screen: 'travel',
    account: accountA,
    context: { accountId: 'account-a', vesselId: vesselAliceId },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`) {
        reads += 1;
        return reads === 1 ? pending.promise : { body: vesselState(vesselAliceId, 444) };
      }
      return undefined;
    }
  });

  await waitFor(() => reads === 1, 'expected the initial vessel read');
  await controls(page, 'setMounted', false);
  pending.resolve({ body: vesselState(vesselAliceId, 555) });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await controls(page, 'setMounted', true);
  await waitFor(() => reads === 2, 'remount must perform a fresh retained read');
  await waitForRegionText(page, 'Vessel travel', '444', 'expected only the fresh post-remount state');
  assert.equal((await regionText(page, 'Vessel travel')).includes('555'), false, 'an unmounted response must never be displayed');
  assert.deepEqual(errors, []);
});

test('reads the exact route plan, displays directed legs, and submits only account, vessel and route plan identifiers', async (t) => {
  const pending = actionRecord({
    resultReferences: [{ kind: 'request', id: 'traverse-request-1' }],
    intent: { kind: 'traverse', inputs: { vesselId: vesselAliceId, routePlanId: planId } },
    journey: {
      routePlanId: planId,
      vesselId: vesselAliceId,
      status: 'pending',
      updatedAt: observedAt,
      legs: [
        { routeId: approachRouteId, from: boundaryWestId, to: eastId, territoryId, kind: 'entry', status: 'pending', requestId: 'berth-request-1' },
        { routeId: coastalRouteId, from: eastId, to: westId, territoryId, kind: 'local-movement', status: 'pending', requestId: 'movement-request-1' }
      ]
    }
  });
  const updated = actionRecord({
    resultReferences: [{ kind: 'event', id: 'berthing-event-1' }],
    intent: { kind: 'traverse', inputs: { vesselId: vesselAliceId, routePlanId: planId } },
    submission: { status: 'accepted' },
    outcome: { status: 'pending', evidence: [{ source: `${territoryId}/events/berthing/1`, observedAt, changes: { event: 'BerthingEvent' } }] },
    journey: {
      routePlanId: planId,
      vesselId: vesselAliceId,
      status: 'pending',
      updatedAt: observedAt,
      legs: [
        { routeId: approachRouteId, from: boundaryWestId, to: eastId, territoryId, kind: 'entry', status: 'completed', eventId: 'berthing-event-1' },
        { routeId: coastalRouteId, from: eastId, to: westId, territoryId, kind: 'local-movement', status: 'pending', requestId: 'movement-request-2', error: 'Manual review is pending' },
        { routeId: farRouteId, from: westId, to: farId, territoryId, kind: 'entry', status: 'failed', error: 'EntryRejected' },
        { routeId: returnRouteId, from: farId, to: westId, territoryId, kind: 'departure', status: 'unverified', error: 'Readback failed' }
      ]
    }
  });

  const { page, requests, errors } = await openFixture(t, {
    screen: 'travel',
    account: accountA,
    context: { accountId: 'account-a', vesselId: vesselAliceId, routePlanId: planId },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === `/api/explore/routes/${encodeURIComponent(planId)}`) return { body: routePlanResponse(journeyPlan()) };
      if (request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`) return { body: vesselState(vesselAliceId) };
      if (request.method === 'POST' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/traverse`) return { body: { action: pending } };
      if (request.method === 'POST' && request.pathname === `/api/activity/${encodeURIComponent(activityId)}/refresh`) {
        return { body: pageResponse({ action: updated }, {}, { accountId: 'account-a', actionId: activityId }) };
      }
      return undefined;
    }
  });

  await waitForRegionText(page, 'Vessel travel', coastalRouteId, 'expected the recovered route plan and directed legs');
  const planGets = requests.filter((request) => request.method === 'GET' && request.pathname === `/api/explore/routes/${encodeURIComponent(planId)}`);
  assert.equal(planGets.length, 1, 'exact route context must read the retained plan once');
  expectBearer(planGets[0]!);
  await openDetails(page, 'Vessel travel');
  const planText = await regionText(page, 'Vessel travel');
  for (const exact of [boundaryWestId, eastId, westId, approachRouteId, coastalRouteId]) {
    assert.ok(planText.includes(exact), `expected exact directed plan identity ${exact}`);
  }

  await clickButton(page, /Traverse selected route/i);
  const traverses = requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/traverse`);
  assert.equal(traverses.length, 1, 'traverse must submit exactly one action');
  expectBearer(traverses[0]!);
  assert.deepEqual(traverses[0]?.body, { accountId: 'account-a', routePlanId: planId });
  await waitForRegionText(page, 'Vessel travel', /Accepted/i, 'accepted submission must be shown');
  const accepted = await regionText(page, 'Vessel travel');
  assert.match(accepted, /Pending/i, 'accepted and pending must both remain visible');
  assert.equal(/Completed/i.test(accepted), false, 'acceptance alone must not claim completion');
  assert.ok(accepted.includes('berth-request-1') && accepted.includes('movement-request-1'), 'each pending leg must retain its request evidence');

  await clickButton(page, /Open Activity/i);
  assert.deepEqual(await events(page, 'actions'), [activityId]);

  await clickButton(page, /Refresh status/i);
  const refreshes = requestsFor(requests, 'POST', `/api/activity/${encodeURIComponent(activityId)}/refresh`);
  assert.equal(refreshes.length, 1, 'status reconciliation must require an explicit request');
  expectBearer(refreshes[0]!);
  assert.deepEqual(refreshes[0]?.body, { accountId: 'account-a' });
  await waitForRegionText(page, 'Vessel travel', /Readback failed/i, 'expected per-leg reconciled evidence');
  const reconciled = await regionText(page, 'Vessel travel');
  assert.ok(reconciled.includes('berthing-event-1'), 'the completed leg must show its event evidence');
  assert.ok(reconciled.includes('movement-request-2'), 'the pending leg must retain request evidence');
  assert.match(reconciled, /Manual review/i, 'manual review must remain distinct from berthing');
  assert.match(reconciled, /EntryRejected/i, 'a rejected leg must stay rejected');
  assert.ok(reconciled.includes('Readback failed'), 'an unverified leg must stay unverified');
  assert.equal(requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/traverse`).length, 1, 'refreshing status must never replay the traverse');
  assert.equal(requests.some((request) => request.pathname.includes('/local/tick')), false, 'page reads and reconciliation must not advance simulation time');
  assert.deepEqual(errors, []);
});

test('keeps an unverified traverse unverified and never automatically resubmits it', async (t) => {
  const unverified = actionRecord({
    resultReferences: [{ kind: 'request', id: 'traverse-request-unverified' }],
    intent: { kind: 'traverse', inputs: { vesselId: vesselAliceId, routePlanId: planId } },
    submission: { status: 'unverified', error: 'Send outcome could not be read' },
    outcome: { status: 'unverified', evidence: [], error: 'Readback failed' },
    journey: {
      routePlanId: planId,
      vesselId: vesselAliceId,
      status: 'unverified',
      updatedAt: observedAt,
      error: 'Readback failed',
      legs: [{ routeId: coastalRouteId, from: eastId, to: westId, territoryId, kind: 'local-movement', status: 'unverified', requestId: 'traverse-request-unverified', error: 'Readback failed' }]
    }
  });
  const { page, requests, errors } = await openFixture(t, {
    screen: 'travel',
    account: accountA,
    context: { accountId: 'account-a', vesselId: vesselAliceId, routePlanId: planId },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === `/api/explore/routes/${encodeURIComponent(planId)}`) return { body: routePlanResponse(journeyPlan()) };
      if (request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`) return { body: vesselState(vesselAliceId) };
      if (request.method === 'POST' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/traverse`) return { body: { action: unverified } };
      if (request.method === 'POST' && request.pathname === `/api/activity/${encodeURIComponent(activityId)}/refresh`) {
        return { body: pageResponse({ action: unverified }, {}, { accountId: 'account-a', actionId: activityId }) };
      }
      return undefined;
    }
  });

  await waitForRegionText(page, 'Vessel travel', coastalRouteId, 'expected the retained route plan');
  await clickButton(page, /Traverse selected route/i);
  await waitForRegionText(page, 'Vessel travel', /Unverified/i, 'the unverified send must be reported');
  const text = await regionText(page, 'Vessel travel');
  assert.match(text, /Readback failed/i, 'the uncertain outcome must keep its readable error');
  assert.equal(/Completed/i.test(text), false, 'an unverified send must not be completed');

  await sleep(400);
  assert.equal(requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/traverse`).length, 1, 'an uncertain send must never be replayed automatically');
  assert.equal(requests.filter((request) => request.method === 'POST' && request.pathname.includes('/api/activity/')).length, 0, 'reconciliation must remain explicit');

  await clickButton(page, /Refresh status/i);
  await waitFor(() => requests.filter((request) => request.method === 'POST' && request.pathname === `/api/activity/${encodeURIComponent(activityId)}/refresh`).length === 1, 'explicit refresh must reconcile the uncertain action');
  await waitForRegionText(page, 'Vessel travel', /Unverified/i, 'reconciliation still unverified must remain visible');
  assert.equal(requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/traverse`).length, 1, 'reconciliation must not resubmit the traverse');
  assert.equal(requests.some((request) => request.pathname.includes('/local/tick')), false, 'reconciliation must not advance simulation time');
  assert.deepEqual(errors, []);
});

test('submits an exact entry request and keeps acceptance, manual review and berthing evidence distinct', async (t) => {
  const pending = actionRecord({
    resultReferences: [{ kind: 'request', id: 'entry-request-1' }],
    intent: { kind: 'entry', inputs: { vesselId: vesselAliceId, territoryId, portId: eastId, routeId: approachRouteId } },
    submission: { status: 'accepted', result: 'entry-request-1' },
    outcome: { status: 'pending', evidence: [] },
    journey: {
      routePlanId: planId,
      vesselId: vesselAliceId,
      status: 'pending',
      updatedAt: observedAt,
      legs: [{ routeId: approachRouteId, from: boundaryWestId, to: eastId, territoryId, kind: 'entry', status: 'pending', requestId: 'entry-request-1', error: 'Manual review is pending' }]
    }
  });
  const berthed = actionRecord({
    resultReferences: [{ kind: 'request', id: 'entry-request-1' }, { kind: 'event', id: 'berthing-event-1' }],
    intent: { kind: 'entry', inputs: { vesselId: vesselAliceId, territoryId, portId: eastId, routeId: approachRouteId } },
    submission: { status: 'accepted', result: 'entry-request-1' },
    outcome: { status: 'completed', evidence: [{ source: `${territoryId}/events/berthing/1`, observedAt, changes: { event: 'BerthingEvent' } }] },
    journey: {
      routePlanId: planId,
      vesselId: vesselAliceId,
      status: 'completed',
      updatedAt: observedAt,
      legs: [{ routeId: approachRouteId, from: boundaryWestId, to: eastId, territoryId, kind: 'entry', status: 'completed', requestId: 'entry-request-1', eventId: 'berthing-event-1' }]
    }
  });
  const { page, requests, errors } = await openFixture(t, {
    screen: 'travel',
    account: accountA,
    context: { accountId: 'account-a', vesselId: vesselAliceId },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`) return { body: vesselState(vesselAliceId) };
      if (request.method === 'POST' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/entry`) return { body: { action: pending } };
      if (request.method === 'POST' && request.pathname === `/api/activity/${encodeURIComponent(activityId)}/refresh`) {
        return { body: pageResponse({ action: berthed }, {}, { accountId: 'account-a', actionId: activityId }) };
      }
      return undefined;
    }
  });

  await waitForRegionText(page, 'Vessel travel', /Registry cargo/i, 'expected retained vessel state');
  await page.getByRole('textbox', { name: /Territory ID/i }).fill(territoryId);
  await page.getByRole('textbox', { name: /Port ID/i }).fill(eastId);
  await page.getByRole('textbox', { name: /Route ID/i }).fill(approachRouteId);
  await clickButton(page, /Request entry/i);

  const entries = requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/entry`);
  assert.equal(entries.length, 1, 'entry must submit one exact request');
  expectBearer(entries[0]!);
  assert.deepEqual(entries[0]?.body, { accountId: 'account-a', territoryId, portId: eastId, routeId: approachRouteId });

  await waitForRegionText(page, 'Vessel travel', /Accepted/i, 'entry acceptance must be shown');
  const accepted = await regionText(page, 'Vessel travel');
  assert.match(accepted, /Pending/i, 'pending review must remain distinct from berthing');
  assert.match(accepted, /Manual review/i, 'manual review must be named');
  assert.equal(/BerthingEvent|Berthed/i.test(accepted), false, 'acceptance alone must not claim berthing');
  assert.ok(accepted.includes('entry-request-1'), 'the request reference must remain visible');

  await clickButton(page, /Refresh status/i);
  await waitForRegionText(page, 'Vessel travel', /berthing-event-1/i, 'explicit reconciliation must show berthing evidence');
  const reconciled = await regionText(page, 'Vessel travel');
  assert.ok(reconciled.includes('entry-request-1'), 'the request reference must remain after reconciliation');
  assert.match(reconciled, /Completed/i, 'verified berthing completes the entry');
  assert.equal(requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/entry`).length, 1, 'reconciliation must not resubmit entry');
  assert.deepEqual(errors, []);
});

test('distinguishes departure evidence from a signed exit and never replays departure', async (t) => {
  const pending = actionRecord({
    id: 'https://activity.test:4600/actions/departure-1',
    resultReferences: [{ kind: 'request', id: 'departure-request-1' }],
    intent: { kind: 'departure', inputs: { vesselId: vesselAliceId, territoryId, portId: westId, routeId: returnRouteId } },
    submission: { status: 'accepted', result: 'departure-request-1' },
    outcome: { status: 'pending', evidence: [] }
  });
  const departed = actionRecord({
    ...pending,
    resultReferences: [{ kind: 'request', id: 'departure-request-1' }, { kind: 'event', id: 'exit-looking-reference-is-not-evidence' }],
    outcome: {
      status: 'pending',
      evidence: [{ source: `${territoryId}/events/departure/1`, observedAt, changes: { event: { type: 'DepartureEvent', id: 'departure-event-1' } } }]
    }
  });
  const exited = actionRecord({
    ...departed,
    resultReferences: [{ kind: 'request', id: 'departure-request-1' }, { kind: 'event', id: 'exit-event-1' }],
    outcome: {
      status: 'completed',
      evidence: [
        { source: `${territoryId}/events/departure/1`, observedAt, changes: { event: { type: 'DepartureEvent', id: 'departure-event-1' } } },
        { source: `${territoryId}/events/exit/1`, observedAt, changes: { event: { type: 'ExitEvent', id: 'exit-event-1' } } }
      ]
    }
  });
  let refreshCall = 0;
  const { page, requests, errors } = await openFixture(t, {
    screen: 'travel',
    account: accountA,
    context: { accountId: 'account-a', vesselId: vesselAliceId },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`) return { body: vesselState(vesselAliceId) };
      if (request.method === 'POST' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/departure`) return { body: { action: pending } };
      if (request.method === 'POST' && request.pathname === `/api/activity/${encodeURIComponent('https://activity.test:4600/actions/departure-1')}/refresh`) {
        refreshCall += 1;
        return { body: pageResponse({ action: refreshCall === 1 ? departed : exited }, {}, { accountId: 'account-a' }) };
      }
      return undefined;
    }
  });

  await waitForRegionText(page, 'Vessel travel', /Registry cargo/i, 'expected retained vessel state');
  await page.getByRole('textbox', { name: /Territory ID/i }).fill(territoryId);
  await page.getByRole('textbox', { name: /Port ID/i }).fill(westId);
  await page.getByRole('textbox', { name: /Route ID/i }).fill(returnRouteId);
  await clickButton(page, /Request departure/i);
  const departures = requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/departure`);
  assert.equal(departures.length, 1, 'departure must submit one exact request');
  assert.deepEqual(departures[0]?.body, { accountId: 'account-a', territoryId, portId: westId, routeId: returnRouteId });

  await waitForRegionText(page, 'Vessel travel', /Pending/i, 'departure acknowledgment must not be completion');
  await clickButton(page, /Refresh status/i);
  await waitForRegionText(page, 'Vessel travel', /events\/departure\/1/i, 'expected departure evidence');
  const departureOnly = await regionText(page, 'Vessel travel');
  assert.match(departureOnly, /DepartureEvent/i, 'departure evidence must be named');
  assert.equal(departureOnly.includes('events/exit/1'), false, 'departure must not imply a signed exit');
  assert.match(departureOnly, /signed exit|exit not evidenced|not exited/i, 'missing signed exit evidence must be explicit');
  assert.ok(departureOnly.includes('Signed exit: not evidenced.'), 'an exit-looking reference must not count as evidence');

  await clickButton(page, /Refresh status/i);
  await waitForRegionText(page, 'Vessel travel', /events\/exit\/1/i, 'expected the signed exit evidence');
  const exitedText = await regionText(page, 'Vessel travel');
  assert.match(exitedText, /ExitEvent|signed exit/i, 'signed exit must be named');
  assert.equal(requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/departure`).length, 1, 'reconciliation must never replay departure');
  assert.deepEqual(errors, []);
});

test('selects exact published directed entry and departure routes without retyping identifiers', async (t) => {
  const outboundId = 'https://territory.test:4300/objects/routes/outbound';
  const published = listResponse() as { data: { connections: Record<string, unknown>[] } };
  published.data.connections.push({
    id: outboundId, type: 'Route', from: westId, to: boundaryWestId,
    territoryId, authorityId: territoryId, name: 'West Outbound', state: 'available'
  });
  const { page, requests, errors } = await openFixture(t, {
    screen: 'travel', account: accountA,
    context: { accountId: 'account-a', vesselId: vesselAliceId },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`) return { body: vesselState(vesselAliceId) };
      if (request.method === 'GET' && request.pathname === '/api/explore/places') return { body: published };
      if (request.method === 'POST' && /\/(entry|departure)$/.test(request.pathname)) {
        return { body: { action: actionRecord({ intent: { kind: request.pathname.endsWith('/entry') ? 'entry' : 'departure', inputs: request.body as Record<string, unknown> } }) } };
      }
      return undefined;
    }
  });

  await waitForRegionText(page, 'Vessel travel', /Registry cargo/i, 'expected the selected vessel');
  await clickButton(page, /Browse published routes/i);
  const entry = region(page, 'Vessel travel').getByRole('combobox', { name: /^Published entry route$/i });
  await entry.waitFor({ state: 'visible', timeout: settleTimeout });
  await entry.selectOption(approachRouteId);
  assert.equal(await page.getByRole('textbox', { name: /Territory ID/i }).inputValue(), territoryId);
  assert.equal(await page.getByRole('textbox', { name: /Port ID/i }).inputValue(), eastId);
  assert.equal(await page.getByRole('textbox', { name: /Route ID/i }).inputValue(), approachRouteId);
  await clickButton(page, /Request entry/i);
  await waitFor(() => requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/entry`).length === 1, 'expected the published entry selection');
  assert.deepEqual(requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/entry`)[0]?.body, { accountId: 'account-a', territoryId, portId: eastId, routeId: approachRouteId });

  const departure = region(page, 'Vessel travel').getByRole('combobox', { name: /^Published departure route$/i });
  assert.equal(await departure.locator(`option[value="${approachRouteId}"]`).count(), 0, 'the incoming boundary route must not become an invented reverse departure');
  await departure.selectOption(outboundId);
  assert.equal(await page.getByRole('textbox', { name: /Port ID/i }).inputValue(), westId);
  await clickButton(page, /Request departure/i);
  await waitFor(() => requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/departure`).length === 1, 'expected the published departure selection');
  const sent = requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/departure`)[0]!;
  assert.deepEqual(sent.body, { accountId: 'account-a', territoryId, portId: westId, routeId: outboundId });
  expectBearer(sent);
  const read = requestsFor(requests, 'GET', '/api/explore/places')[0]!;
  assert.equal(read.search.accountId, 'account-a');
  assert.equal(read.search.vesselId, vesselAliceId);
  expectBearer(read);
  assert.equal(requestsFor(requests, 'POST', '/api/explore/refresh').length, 0, 'browsing retained routes must not observe the world');
  assert.deepEqual(errors, []);
});

test('changes cargo adoption only through an explicit boolean mutation', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    screen: 'travel',
    account: accountA,
    context: { accountId: 'account-a', vesselId: vesselAliceId },
    handle: (request) => {
      if (request.method === 'GET' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`) return { body: vesselState(vesselAliceId) };
      if (request.method === 'POST' && request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/adoption`) {
        const body = request.body as { adoption?: boolean };
        return { body: { action: actionRecord({ intent: { kind: 'adoption', inputs: { vesselId: vesselAliceId, adoption: body.adoption } } }) } };
      }
      return undefined;
    }
  });

  await waitForRegionText(page, 'Vessel travel', /Registry cargo/i, 'expected retained vessel state');
  assert.equal(requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/adoption`).length, 0, 'loading vessel state must not mutate adoption');
  const adoption = page.getByRole('checkbox', { name: /Cargo adoption/i });
  assert.equal(await adoption.count(), 1, 'adoption must be an explicit boolean control');
  await adoption.click();
  await clickButton(page, /Update adoption/i);
  const mutations = requestsFor(requests, 'POST', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}/adoption`);
  assert.equal(mutations.length, 1, 'adoption changes must be explicit');
  expectBearer(mutations[0]!);
  assert.deepEqual(mutations[0]?.body, { accountId: 'account-a', adoption: false });
  assert.deepEqual(errors, []);
});

test('public Explore reads, opens and explicitly refreshes geography without an account', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    screen: 'explore', seedSession: false,
    handle: (request) => {
      if (request.pathname === '/api/explore/places') return { body: listResponse() };
      if (request.pathname === `/api/explore/places/${encodeURIComponent(eastId)}`) return { body: detailResponse() };
      if (request.pathname === '/api/explore/refresh') return { body: listResponse() };
      return undefined;
    }
  });
  await waitForRegionText(page, 'Explore', 'East Haven', 'expected public retained geography');
  await clickButton(page, 'Open East Haven');
  await page.getByRole('region', { name: 'Place detail', exact: true }).getByRole('heading', { name: 'East Haven', exact: true }).waitFor();
  await clickButton(page, 'Refresh places');
  await waitFor(() => requestsFor(requests, 'POST', '/api/explore/refresh').length === 1, 'expected explicit public refresh');
  for (const request of requests.filter((entry) => entry.pathname.startsWith('/api/'))) {
    assert.equal(request.search.accountId, undefined);
    assert.equal(request.headers.authorization, undefined);
  }
  assert.deepEqual(requestsFor(requests, 'POST', '/api/explore/refresh')[0]?.body, {});
  assert.deepEqual(errors, []);
});

test('late route creation cannot disclose an old account plan or hand it to a changed vessel', async (t) => {
  const creation = deferred<ServerResponse>();
  const { page, requests, errors } = await openFixture(t, {
    screen: 'explore', accountId: 'account-a', context: { accountId: 'account-a', vesselId: vesselAliceId },
    handle: (request) => {
      if (request.pathname === '/api/explore/places') return { body: listResponse() };
      if (request.pathname === '/api/explore/routes') return creation.promise;
      return undefined;
    }
  });
  await waitForRegionText(page, 'Explore', 'East Haven', 'expected geography');
  await clickButton(page, 'Set East Haven as origin');
  await clickButton(page, 'Choose destination');
  await page.getByRole('button', { name: 'Select West Haven', exact: true }).click();
  await clickButton(page, 'Create route plan');
  await waitFor(() => requestsFor(requests, 'POST', '/api/explore/routes').length === 1, 'expected pending creation');
  await controls(page, 'setAccountId', 'account-b');
  await controls(page, 'setContext', { accountId: 'account-b', vesselId: vesselBId });
  await waitFor(() => requestsFor(requests, 'GET', '/api/explore/places').some((entry) => entry.search.accountId === 'account-b'), 'expected new scope read');
  creation.resolve({ body: routePlanResponse() });
  await sleep(200);
  assert.equal((await regionText(page, 'Explore')).includes(planId), false, 'old private plan must not appear under another account');
  assert.equal(await page.getByRole('button', { name: 'Use this plan', exact: true }).count(), 0);
  assert.deepEqual(await events(page, 'logistics'), []);
  assert.deepEqual(errors, []);
});

test('manual vessel selection overrides earlier context and repeated handoff can restore it', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    screen: 'travel', account: accountA, context: { accountId: 'account-a', vesselId: vesselAliceId },
    handle: (request) => {
      if (request.pathname === '/api/logistics/vessels') return { body: candidateResponse('account-a', [ownedCandidate(vesselSecondId, 'Second Skiff')]) };
      if (request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`) return { body: vesselState(vesselAliceId) };
      if (request.pathname === `/api/logistics/vessels/${encodeURIComponent(vesselSecondId)}`) return { body: vesselState(vesselSecondId) };
      return undefined;
    }
  });
  await waitForRegionText(page, 'Vessel travel', 'Registry cargo', 'expected handoff vessel');
  await clickButton(page, 'Select Second Skiff');
  await waitFor(() => requestsFor(requests, 'GET', `/api/logistics/vessels/${encodeURIComponent(vesselSecondId)}`).length === 1, 'manual selection must load the second vessel');
  await controls(page, 'setRevision', 1);
  await waitFor(() => requestsFor(requests, 'GET', `/api/logistics/vessels/${encodeURIComponent(vesselAliceId)}`).length === 2, 'repeated handoff must restore the supplied vessel');
  assert.deepEqual(await events(page, 'context'), [{ accountId: 'account-a', vesselId: vesselSecondId }]);
  assert.deepEqual(errors, []);
});

test('explicit place refresh supersedes retained detail, preserves failures and ignores a later abandoned target', async (t) => {
  const retained = deferred<ServerResponse>();
  const abandoned = deferred<ServerResponse>();
  const detailPath = `/api/explore/places/${encodeURIComponent(eastId)}`;
  let refreshes = 0;
  const { page, requests, errors } = await openFixture(t, {
    screen: 'explore', accountId: 'account-a', context: { accountId: 'account-a', vesselId: 'vessel-a' },
    handle: (request) => {
      if (request.pathname === '/api/explore/places') return { body: listResponse() };
      if (request.pathname === detailPath) return retained.promise;
      if (request.pathname === `${detailPath}/refresh`) {
        refreshes += 1;
        if (refreshes === 2) return { status: 503, body: { error: 'Detail source timed out' } };
        if (refreshes === 3) return abandoned.promise;
        const body = detailResponse() as { data: { place: { name: string } } };
        body.data.place.name = 'Fresh East detail';
        return { body };
      }
      if (request.pathname === `/api/explore/places/${encodeURIComponent(westId)}`) {
        const body = detailResponse() as { data: { place: unknown } };
        body.data.place = placeRecords().find((entry) => entry.id === westId);
        return { body };
      }
      return undefined;
    }
  });
  await waitForRegionText(page, 'Explore', 'East Haven', 'expected geography');
  await clickButton(page, 'Open East Haven');
  await waitFor(() => requestsFor(requests, 'GET', detailPath).length === 1, 'expected retained detail read');
  await page.getByRole('button', { name: 'Refresh selected place', exact: true }).click({ timeout: settleTimeout });
  await waitForRegionText(page, 'Explore', 'Fresh East detail', 'expected fresh detail');
  retained.resolve({ body: detailResponse() });
  await sleep(100);
  const detail = page.getByRole('region', { name: 'Place detail', exact: true });
  assert.ok((await detail.innerText()).includes('Fresh East detail'), 'late retained GET must not overwrite explicit observation');
  const refresh = requestsFor(requests, 'POST', `${detailPath}/refresh`)[0]!;
  expectBearer(refresh);
  assert.deepEqual(refresh.body, { accountId: 'account-a', vesselId: 'vessel-a' });
  await clickButton(page, 'Refresh selected place');
  await waitForRegionText(page, 'Explore', 'Detail source timed out', 'expected independent refresh error');
  assert.ok((await detail.innerText()).includes('Fresh East detail'), 'failed refresh must preserve prior detail');
  await clickButton(page, 'Refresh selected place');
  await waitFor(() => refreshes === 3, 'expected pending refresh');
  await clickButton(page, 'Open West Haven');
  await detail.getByRole('heading', { name: 'West Haven', exact: true }).waitFor();
  const late = detailResponse() as { data: { place: { name: string } } };
  late.data.place.name = 'Abandoned private detail';
  abandoned.resolve({ body: late });
  await sleep(100);
  assert.equal((await detail.innerText()).includes('Abandoned private detail'), false);
  assert.equal(requestsFor(requests, 'POST', '/api/explore/refresh').length, 0);
  assert.deepEqual(errors, []);
});

test('shows independent typed vessel position evidence and explains conflicting current ports', async (t) => {
  const body = listWithPositions([
    { portId: westId, source: policySource },
    { portId: eastId, source: simulationSource }
  ]) as { data: { positions: unknown[] } };
  body.data.positions.push({
    accountId: 'account-a', vesselId: 'vessel-a', authorityId: simulationId2,
    source: simulation2Source, state: 'stale', observedAt: staleAt, status: 'unknown', error: 'Position source timed out'
  });
  const { page, errors } = await openFixture(t, {
    screen: 'explore', accountId: 'account-a', context: { accountId: 'account-a', vesselId: 'vessel-a' },
    handle: () => ({ body })
  });
  await waitForRegionText(page, 'Explore', 'East Haven', 'expected geography');
  const positions = page.getByRole('region', { name: 'Vessel position evidence', exact: true });
  await positions.waitFor({ timeout: settleTimeout });
  const text = await positions.innerText();
  for (const expected of [westId, eastId, policySource, simulationSource, simulation2Source, observedAt, staleAt, 'Position source timed out']) {
    assert.ok(text.includes(expected), `position evidence must retain ${expected}`);
  }
  assert.match(text, /conflicting current port/i);
  assert.match(text, /stale/i);
  await clickButton(page, 'Choose destination');
  assert.equal(await page.getByRole('region', { name: /Nearby ports for/ }).count(), 0);
  assert.deepEqual(errors, []);
});
