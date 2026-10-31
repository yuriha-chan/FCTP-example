import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Locator, type Page } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureOrigin = 'http://fixture.invalid/';
const settleTimeout = 3_000;
const accountA = 'account-a';
const accountB = 'account-b';
const handleA = '@alpha.home@alpha.test:4200';
const handleB = '@beta.home@alpha.test:4200';
const handleInactive = '@inactive.home@alpha.test:4200';
const authorityPolicy = 'https://alpha.test/actors/territory';
const authoritySimulation = 'https://beta.test/actors/territory';
const authorityRegistry = 'https://registry.test/actors/registry';
const authorityHome = 'https://alpha.test/actors/home';
const observedAt = '2026-05-01T01:02:03.000Z';
const refreshedAt = '2026-05-02T02:03:04.000Z';
const registryA = 'https://registry.test/actors/registry';
const territoryA = 'https://territory.test/actors/territory';
const portA = 'https://places.invalid/ports/alpha';
const routeA = 'https://places.invalid/routes/alpha-beta';
const vesselA = 'https://vessels.invalid/alpha';
const vesselB = 'https://vessels.invalid/beta';
const terminalVessel = 'https://vessels.invalid/terminal';
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

const fixtureSource = String.raw`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Administration } from './apps/frontend/src/administration.tsx';

const params = new URLSearchParams(window.location.search);
const accountParam = params.get('account');
const initialAccount = accountParam === 'none' ? undefined : (accountParam ?? 'account-a');
const initialHandle = params.get('handle') ?? undefined;
const initialAuthority = params.get('authority') ?? undefined;
const fixture = { controls: null, reads: [], actions: [] };
window.__administrationFixture = fixture;

function App() {
  const [accountId, setAccountIdState] = React.useState(initialAccount);
  const [accountHandle, setAccountHandleState] = React.useState(initialHandle);
  const [authorityId, setAuthorityIdState] = React.useState(initialAuthority);
  React.useEffect(() => {
    fixture.controls = {
      setAccountId(value) { setAccountIdState(value === null ? undefined : value); },
      setAccountHandle(value) { setAccountHandleState(value === null ? undefined : value); },
      setAuthorityId(value) { setAuthorityIdState(value === null ? undefined : value); }
    };
  }, []);
  return React.createElement(Administration, {
    ...(accountId === undefined ? {} : { accountId }),
    ...(accountHandle === undefined ? {} : { accountHandle }),
    ...(authorityId === undefined ? {} : { authorityId }),
    onOpenAction: (actionId) => { fixture.actions.push(actionId); },
    onReadResource: (reference) => { fixture.reads.push(reference); }
  });
}

createRoot(document.getElementById('root')).render(React.createElement(App));
`;

type AdministrationState = 'available' | 'empty' | 'stale' | 'not-retrieved' | 'unavailable';

interface TargetRecord {
  authorityId: string;
  server: string;
  roles: string[];
  name?: string;
  kind?: string;
  source?: string;
  state: AdministrationState;
  observedAt?: string;
  error?: string;
}

interface ControlInput {
  name: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'choice' | 'json';
  required?: boolean;
  choices?: string[];
}

interface ControlRecord {
  name: string;
  authorityId: string;
  label: string;
  inputs: ControlInput[];
}

interface RequestRecord {
  requestId: string;
  authorityId?: string;
  request: Record<string, unknown>;
  status: string;
  sender?: string;
  receivedAt?: string;
  decision?: Record<string, unknown>;
  event?: Record<string, unknown>;
}

interface AdministrationData {
  accountId: string;
  targets: TargetRecord[];
  controls: ControlRecord[];
  requests: RequestRecord[];
  states: Record<string, Record<string, unknown>>;
}

interface AdministrationPage {
  context: { accountId?: string };
  data: AdministrationData;
  observations: Record<string, unknown>;
  actions: unknown[];
}

interface ActionRecord {
  id: string;
  statusUrl: string;
  accountId: string;
  targetId: string;
  resultReferences: Array<{ kind: string; id: string }>;
  intent: { kind: string; inputs: Record<string, unknown> };
  submittedAt: string;
  submission: { status: string; result?: string; error?: string };
  outcome: { status: string; evidence: unknown[]; error?: string };
}

type RequestKind = 'read' | 'refresh' | 'control' | 'decision';

interface AdministrationRequest {
  kind: RequestKind;
  method: string;
  pathname: string;
  accountId?: string;
  authorityId?: string;
  control?: string;
  requestId?: string;
  decision?: string;
  inputs?: Record<string, unknown>;
  body?: unknown;
  headers: Record<string, string>;
}

interface FixtureControls {
  setAccountId(value: string | null): void;
  setAccountHandle(value: string | null): void;
  setAuthorityId(value: string | null): void;
}

interface AdministrationFixture {
  controls: FixtureControls | null;
  reads: Array<{ id: string; authorityId?: string }>;
  actions: string[];
}

interface ServerResponse {
  status?: number;
  body?: unknown;
  abort?: boolean;
}

type Handler = (request: AdministrationRequest) => ServerResponse | Promise<ServerResponse>;

interface FixtureConfig {
  handler: Handler;
  accountId?: string | null;
  accountHandle?: string | null;
  authorityId?: string;
  seedSessions?: boolean;
}

interface OpenedFixture {
  page: Page;
  requests: AdministrationRequest[];
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

function objectBody(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function makeTarget(authorityId: string, options: {
  roles?: string[];
  name?: string;
  kind?: string;
  state?: AdministrationState;
  observedAt?: string;
  error?: string;
  source?: string;
} = {}): TargetRecord {
  return {
    authorityId,
    server: new URL(authorityId).host,
    roles: options.roles ?? ['territory'],
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.kind === undefined ? {} : { kind: options.kind }),
    source: options.source ?? `${authorityId}/local/state`,
    state: options.state ?? 'available',
    ...(options.observedAt === undefined ? {} : { observedAt: options.observedAt }),
    ...(options.error === undefined ? {} : { error: options.error })
  };
}

function control(name: string, authorityId: string, label: string, inputs: ControlInput[]): ControlRecord {
  return { name, authorityId, label, inputs };
}

function policyState(options: {
  policy?: Record<string, unknown>;
  admission?: Record<string, unknown>;
  requests?: unknown[];
} = {}): Record<string, unknown> {
  return {
    kind: 'policy',
    state: {
      policy: {
        miningPermitted: true,
        miningQuota: 20,
        oreReserve: 100,
        manufacturePermits: ['ore-to-metal'],
        recipes: [{ id: 'ore-to-metal', input: 'ore', output: 'metal' }],
        warehouseLimits: { ore: 55 },
        portLimits: { alpha: 4 },
        decisions: { entry: 'allow' },
        customFlag: 'keep-me',
        ...(options.policy ?? {})
      }
    },
    admission: {
      reviewMode: 'automatic',
      registryAcceptance: [registryA],
      territoryAcceptance: [territoryA],
      mismatchPolicy: 'reject',
      publicPorts: [portA],
      ...(options.admission ?? {})
    },
    requests: options.requests ?? []
  };
}

function simulationState(options: {
  admission?: Record<string, unknown>;
  config?: Record<string, unknown>;
  requests?: unknown[];
} = {}): Record<string, unknown> {
  return {
    kind: 'simulation',
    admission: {
      reviewMode: 'manual',
      acceptedRegistries: [registryA],
      acceptedTerritories: [territoryA],
      manifestPolicy: 'request',
      requireExitEvidence: true,
      ...(options.admission ?? {})
    },
    simulation: {
      tick: 7,
      config: {
        miningEnabled: true,
        miningCapacity: 5,
        manufacturingSlots: 2,
        manufacturingTime: 4,
        portCapacity: 3,
        berthCapacity: 2,
        ...(options.config ?? {})
      }
    },
    requests: options.requests ?? []
  };
}

function makeData(
  accountId: string,
  targets: TargetRecord[],
  controls: ControlRecord[],
  requests: RequestRecord[] = [],
  states: Record<string, Record<string, unknown>> = {}
): AdministrationData {
  return { accountId, targets, controls, requests, states };
}

function pageOf(data: AdministrationData): AdministrationPage {
  return { context: { accountId: data.accountId }, data, observations: {}, actions: [] };
}

function makeAction(id: string, options: {
  submission?: { status?: string; result?: string; error?: string };
  outcome?: { status?: string; evidence?: unknown[]; error?: string };
  resultReferences?: Array<{ kind: string; id: string }>;
} = {}): ActionRecord {
  return {
    id,
    statusUrl: `https://activity.invalid/status/${encodeURIComponent(id)}`,
    accountId: accountA,
    targetId: authorityPolicy,
    resultReferences: options.resultReferences ?? [],
    intent: { kind: 'administration-entry-request', inputs: {} },
    submittedAt: '2026-05-03T03:04:05.000Z',
    submission: { status: 'accepted', ...(options.submission ?? {}) },
    outcome: { status: 'pending', evidence: [], ...(options.outcome ?? {}) }
  };
}

function makeRequest(options: {
  requestId: string;
  authorityId: string;
  vesselId: string;
  status?: string;
  decision?: Record<string, unknown>;
  event?: Record<string, unknown>;
}): RequestRecord {
  return {
    requestId: options.requestId,
    authorityId: options.authorityId,
    status: options.status ?? 'pending',
    sender: `https://actors.invalid/${encodeURIComponent(options.vesselId)}`,
    receivedAt: observedAt,
    request: {
      id: options.requestId,
      vessel: { id: options.vesselId, registry: registryA, name: 'Requesting vessel' },
      destination: { territory: options.authorityId, port: portA },
      route: routeA
    },
    ...(options.decision === undefined ? {} : { decision: options.decision }),
    ...(options.event === undefined ? {} : { event: options.event })
  };
}

let browser: Browser | undefined;
let bundle: string | undefined;

before(async () => {
  const result = await build({
    stdin: {
      contents: fixtureSource,
      resolveDir: projectRoot,
      sourcefile: 'frontend-administration-fixture.js',
      loader: 'js'
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
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

async function openFixture(t: TestContext, config: FixtureConfig): Promise<OpenedFixture> {
  const activeBrowser = browser;
  const activeBundle = bundle;
  assert(activeBrowser, 'browser was not started');
  assert(activeBundle, 'fixture bundle was not built');

  const context = await activeBrowser.newContext();
  t.after(async () => { await context.close(); });
  if (config.seedSessions !== false) {
    await context.addInitScript(() => {
      localStorage.setItem('fctp.client-sessions', JSON.stringify([
        { accountId: 'account-a', handle: '@alpha.home@alpha.test:4200', clientToken: 'token-a' },
        { accountId: 'account-b', handle: '@beta.home@alpha.test:4200', clientToken: 'token-b' }
      ]));
    });
  }

  const page = await context.newPage();
  const requests: AdministrationRequest[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });

  await page.route(`${fixtureOrigin}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/bundle.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: activeBundle });
      return;
    }

    const bodyText = request.postData();
    const parsedBody: unknown = bodyText ? JSON.parse(bodyText) as unknown : undefined;
    const body = objectBody(parsedBody);
    let recorded: AdministrationRequest | undefined;

    if (url.pathname === '/api/administration' && request.method() === 'GET') {
      const accountId = url.searchParams.get('accountId') ?? undefined;
      recorded = {
        kind: 'read',
        method: request.method(),
        pathname: url.pathname,
        ...(accountId === undefined ? {} : { accountId }),
        ...(parsedBody === undefined ? {} : { body: parsedBody }),
        headers: request.headers()
      };
    } else if (url.pathname === '/api/administration/refresh' && request.method() === 'POST') {
      const accountId = typeof body?.accountId === 'string' ? body.accountId : undefined;
      const authorityId = typeof body?.authorityId === 'string' ? body.authorityId : undefined;
      recorded = {
        kind: 'refresh',
        method: request.method(),
        pathname: url.pathname,
        ...(accountId === undefined ? {} : { accountId }),
        ...(authorityId === undefined ? {} : { authorityId }),
        ...(parsedBody === undefined ? {} : { body: parsedBody }),
        headers: request.headers()
      };
    } else if (url.pathname === '/api/administration/controls' && request.method() === 'POST') {
      const accountId = typeof body?.accountId === 'string' ? body.accountId : undefined;
      const authorityId = typeof body?.authorityId === 'string' ? body.authorityId : undefined;
      const controlName = typeof body?.control === 'string' ? body.control : undefined;
      const inputs = objectBody(body?.inputs);
      recorded = {
        kind: 'control',
        method: request.method(),
        pathname: url.pathname,
        ...(accountId === undefined ? {} : { accountId }),
        ...(authorityId === undefined ? {} : { authorityId }),
        ...(controlName === undefined ? {} : { control: controlName }),
        ...(inputs === undefined ? {} : { inputs }),
        ...(parsedBody === undefined ? {} : { body: parsedBody }),
        headers: request.headers()
      };
    } else {
      const match = /^\/api\/administration\/entry-requests\/([^/]+)\/(approve|reject)$/.exec(url.pathname);
      if (match && request.method() === 'POST') {
        const accountId = typeof body?.accountId === 'string' ? body.accountId : undefined;
        const authorityId = typeof body?.authorityId === 'string' ? body.authorityId : undefined;
        recorded = {
          kind: 'decision',
          method: request.method(),
          pathname: url.pathname,
          requestId: decodeURIComponent(match[1]!),
          decision: match[2]!,
          ...(accountId === undefined ? {} : { accountId }),
          ...(authorityId === undefined ? {} : { authorityId }),
          ...(parsedBody === undefined ? {} : { body: parsedBody }),
          headers: request.headers()
        };
      }
    }

    if (recorded === undefined) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }

    requests.push(recorded);
    const response = await config.handler(recorded);
    if (response.abort === true) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: response.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(response.body ?? null)
    });
  });

  const params = new URLSearchParams();
  if (config.accountId === null) params.set('account', 'none');
  else params.set('account', config.accountId ?? accountA);
  if (config.accountHandle === null) params.set('handle', 'none');
  else if (config.accountHandle !== undefined) params.set('handle', config.accountHandle);
  if (config.authorityId !== undefined) params.set('authority', config.authorityId);
  const search = params.toString();
  await page.goto(`${fixtureOrigin}${search ? `?${search}` : ''}`);
  await page.waitForFunction(() => {
    const fixture = (window as unknown as { __administrationFixture?: AdministrationFixture }).__administrationFixture;
    return Boolean(fixture && fixture.controls);
  });
  return { page, requests, errors };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeout = settleTimeout): Promise<void> {
  const started = Date.now();
  while (true) {
    if (await predicate()) return;
    if (Date.now() - started >= timeout) break;
    await sleep(25);
  }
  throw new Error(message);
}

function administration(page: Page): Locator {
  return page.getByRole('region', { name: 'Administration' });
}

async function regionText(page: Page): Promise<string> {
  return administration(page).innerText();
}

async function waitForText(scope: Locator, expected: string | RegExp, message: string): Promise<void> {
  try {
    await scope.getByText(expected).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: settleTimeout });
  } catch (error) {
    const actual = await scope.innerText();
    throw new Error(`${message}; region text was ${JSON.stringify(actual)}`, { cause: error });
  }
}

async function fixtureOf(page: Page): Promise<AdministrationFixture> {
  return page.evaluate(() => (window as unknown as { __administrationFixture: AdministrationFixture }).__administrationFixture);
}

async function setAccount(page: Page, accountId: string | null): Promise<void> {
  await page.evaluate((value) => {
    const fixture = (window as unknown as { __administrationFixture: AdministrationFixture }).__administrationFixture;
    fixture.controls?.setAccountId(value);
  }, accountId);
}

async function waitForFixtureReads(page: Page, expected: number): Promise<void> {
  await page.waitForFunction((count) => {
    const fixture = (window as unknown as { __administrationFixture?: AdministrationFixture }).__administrationFixture;
    return (fixture?.reads.length ?? 0) === count;
  }, expected, { timeout: settleTimeout });
}

async function waitForFixtureActions(page: Page, expected: number): Promise<void> {
  await page.waitForFunction((count) => {
    const fixture = (window as unknown as { __administrationFixture?: AdministrationFixture }).__administrationFixture;
    return (fixture?.actions.length ?? 0) === count;
  }, expected, { timeout: settleTimeout });
}

const policyControl = control('policy', authorityPolicy, 'Policy', [
  { name: 'policy', label: 'Policy values (JSON)', type: 'json', required: true }
]);
const policyAdmissionControl = control('admission', authorityPolicy, 'Admission', [
  { name: 'reviewMode', label: 'Review mode', type: 'choice', choices: ['automatic', 'manual'] },
  { name: 'registryAcceptance', label: 'Accepted Registries (comma separated)', type: 'text' },
  { name: 'territoryAcceptance', label: 'Accepted Territories (comma separated)', type: 'text' },
  { name: 'mismatchPolicy', label: 'Mismatch policy', type: 'choice', choices: ['declared', 'evidence', 'reject'] },
  { name: 'publicPorts', label: 'Public ports (comma separated)', type: 'text' }
]);
const simulationAdmissionControl = control('admission', authoritySimulation, 'Admission', [
  { name: 'reviewMode', label: 'Review mode', type: 'choice', choices: ['automatic', 'manual'] },
  { name: 'acceptedRegistries', label: 'Accepted Registries (comma separated)', type: 'text' },
  { name: 'acceptedTerritories', label: 'Accepted Territories (comma separated)', type: 'text' },
  { name: 'manifestPolicy', label: 'Manifest policy', type: 'choice', choices: ['request', 'evidence', 'reject-difference'] },
  { name: 'requireExitEvidence', label: 'Require exit evidence', type: 'boolean' }
]);
const facilitiesControl = control('facilities', authoritySimulation, 'Facilities', [
  { name: 'miningEnabled', label: 'Mining enabled', type: 'boolean' },
  { name: 'miningCapacity', label: 'Mining capacity', type: 'number' },
  { name: 'manufacturingSlots', label: 'Manufacturing slots', type: 'number' },
  { name: 'manufacturingTime', label: 'Manufacturing time', type: 'number' },
  { name: 'portCapacity', label: 'Port capacity', type: 'number' },
  { name: 'berthCapacity', label: 'Berth capacity', type: 'number' }
]);
const tickControl = control('tick', authoritySimulation, 'Advance simulation tick', []);
const adoptionControl = control('adoption', authorityRegistry, 'Adoption', [
  { name: 'vesselId', label: 'Vessel URI', type: 'text', required: true },
  { name: 'adoption', label: 'Adoption', type: 'boolean', required: true }
]);
const availabilityControl = control('availability', authorityHome, 'Account availability', [
  { name: 'handle', label: 'Account handle', type: 'text', required: true },
  { name: 'available', label: 'Available', type: 'boolean', required: true }
]);

test('shows an account requirement and performs no private administration IO without an account', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    accountId: null,
    handler: () => ({ body: pageOf(makeData(accountA, [], [])) })
  });

  const region = administration(page);
  await region.waitFor({ state: 'visible', timeout: settleTimeout });
  await waitForText(region, /sign in|account/i, 'expected an account requirement instead of private content');

  await sleep(150);
  assert.equal(requests.length, 0, 'anonymous administration must not perform private reads');
  assert.deepEqual(errors, []);
});

test('performs one retained read on open and renders target-owned scope without an implicit refresh', async (t) => {
  const targetA = makeTarget(authorityPolicy, { name: 'Alpha Territory', kind: 'policy', observedAt });
  const targetB = makeTarget(authoritySimulation, { name: 'Beta Territory', kind: 'simulation', roles: ['territory'], observedAt });
  const data = makeData(accountA, [targetA, targetB], [policyControl, policyAdmissionControl, facilitiesControl, tickControl], [], {
    [authorityPolicy]: policyState(),
    [authoritySimulation]: simulationState()
  });
  const { page, requests, errors } = await openFixture(t, {
    accountId: accountA,
    handler: (request) => request.kind === 'read'
      ? { body: pageOf(data) }
      : { status: 500, body: { error: 'unexpected request' } }
  });

  const region = administration(page);
  await waitForText(region, 'Alpha Territory', 'expected the selected target name');
  await waitForText(region, observedAt, 'expected the target observation time');
  await waitForText(region, /policy/i, 'expected the target kind');
  await waitForText(region, `${authorityPolicy}/local/state`, 'expected the exact observed source');

  assert.equal(requests.length, 1, 'opening should perform exactly one retained read');
  const read = requests[0]!;
  assert.equal(read.kind, 'read');
  assert.equal(read.method, 'GET');
  assert.equal(read.pathname, '/api/administration');
  assert.equal(read.accountId, accountA);
  assert.equal(read.headers.authorization, 'Bearer token-a');

  const targetSelect = region.getByLabel('Administration target');
  await targetSelect.waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await targetSelect.inputValue(), authorityPolicy);
  assert.equal(await region.getByRole('button', { name: 'Apply policy' }).count(), 1);
  assert.equal(await region.getByRole('button', { name: /Apply facilities/i }).count(), 0, 'foreign target controls must not render');

  await targetSelect.selectOption(authoritySimulation);
  await waitForText(region, 'Beta Territory', 'expected the newly selected target');
  assert.equal(await region.getByRole('button', { name: /Apply facilities/i }).count(), 1);
  assert.equal(await region.getByRole('button', { name: 'Apply policy' }).count(), 0);
  assert.equal(requests.filter((request) => request.kind !== 'read').length, 0, 'target selection must not observe the world');
  assert.deepEqual(errors, []);
});

test('refreshes only the selected target explicitly and retains observed values after a failed refresh', async (t) => {
  const original = makeTarget(authorityPolicy, { name: 'Alpha Territory', kind: 'policy', observedAt });
  const originalData = makeData(accountA, [original], [policyControl], [], { [authorityPolicy]: policyState() });
  const stale = makeTarget(authorityPolicy, {
    name: 'Alpha Territory', kind: 'policy', state: 'stale', observedAt: refreshedAt, error: 'source refresh lagged'
  });
  const refreshedData = makeData(accountA, [stale], [policyControl], [], {
    [authorityPolicy]: policyState({ policy: { miningQuota: 42 } })
  });
  let refreshes = 0;
  const { page, requests, errors } = await openFixture(t, {
    accountId: accountA,
    handler: (request) => {
      if (request.kind === 'read') return { body: pageOf(originalData) };
      if (request.kind === 'refresh') {
        refreshes += 1;
        return refreshes === 1
          ? { body: pageOf(refreshedData) }
          : { status: 503, body: { error: 'source offline' } };
      }
      return { status: 500, body: { error: 'unexpected request' } };
    }
  });

  const region = administration(page);
  await waitForText(region, 'Alpha Territory', 'expected the retained target');
  const quota = region.getByLabel('Mining quota');
  assert.equal(await quota.inputValue(), '20');

  await region.getByRole('button', { name: 'Refresh administration' }).click();
  await waitForText(region, 'source refresh lagged', 'expected the stale refresh result');
  await waitForText(region, /stale/i, 'expected the stale state warning');
  await waitForText(region, refreshedAt, 'expected the refreshed observation time');
  assert.equal(await quota.inputValue(), '42');

  const refresh = requests.find((request) => request.kind === 'refresh');
  assert(refresh, 'expected an explicit refresh request');
  assert.equal(refresh.method, 'POST');
  assert.equal(refresh.pathname, '/api/administration/refresh');
  assert.deepEqual(refresh.body, { accountId: accountA, authorityId: authorityPolicy });

  await region.getByRole('button', { name: 'Refresh administration' }).click();
  await waitForText(region, 'source offline', 'expected the failed refresh error');
  assert.equal(await quota.inputValue(), '42', 'a failed refresh must retain the last observed value');
  await waitForText(region, /stale/i, 'a failed refresh must retain the observed stale state');
  assert.equal(requests.filter((request) => request.kind === 'control').length, 0, 'refresh must not submit a control');
  assert.deepEqual(errors, []);
});

test('renders only supported target controls and requires explicit refresh for unobserved, unavailable, or empty targets', async (t) => {
  const targetA = makeTarget(authorityPolicy, { name: 'Alpha Territory', kind: 'policy', observedAt });
  const targetB = makeTarget(authoritySimulation, { name: 'Beta Territory', kind: 'simulation', state: 'not-retrieved' });
  const targetC = makeTarget('https://gamma.test/actors/territory', {
    name: 'Gamma Territory', kind: 'policy', state: 'unavailable', error: 'territory source unreachable'
  });
  const targetD = makeTarget('https://delta.test/actors/territory', {
    name: 'Delta Territory', kind: 'policy', state: 'empty'
  });
  const initial = makeData(
    accountA,
    [targetA, targetB, targetC, targetD],
    [policyControl, facilitiesControl, tickControl],
    [],
    { [authorityPolicy]: policyState() }
  );
  const simulation = simulationState();
  const refreshed = makeData(
    accountA,
    [targetA, makeTarget(authoritySimulation, { name: 'Beta Territory', kind: 'simulation', observedAt }), targetC, targetD],
    [policyControl, facilitiesControl, tickControl],
    [],
    { [authorityPolicy]: policyState(), [authoritySimulation]: simulation }
  );
  const { page, requests, errors } = await openFixture(t, {
    accountId: accountA,
    handler: (request) => {
      if (request.kind === 'read') return { body: pageOf(initial) };
      if (request.kind === 'refresh') return { body: pageOf(refreshed) };
      return { status: 500, body: { error: 'unexpected control' } };
    }
  });

  const region = administration(page);
  await waitForText(region, 'Alpha Territory', 'expected the first target');
  assert.equal(await region.getByRole('button', { name: /Apply facilities/i }).count(), 0);

  const targetSelect = region.getByLabel('Administration target');
  await targetSelect.selectOption('https://gamma.test/actors/territory');
  await waitForText(region, 'territory source unreachable', 'expected the unavailable target error');

  await targetSelect.selectOption('https://delta.test/actors/territory');
  await waitForText(region, /empty/i, 'expected the empty target state');

  await targetSelect.selectOption(authoritySimulation);
  await waitForText(region, 'Beta Territory', 'expected the unobserved target');
  await waitForText(region, /not.?retrieved/i, 'expected the missing retained body to be named');
  assert.equal(await region.getByRole('button', { name: /Apply facilities/i }).count(), 0, 'unobserved targets must not expose fabricated defaults');
  assert.equal(await region.getByLabel('Mining capacity').count(), 0);
  assert.equal(await region.getByRole('button', { name: /Advance tick/i }).count(), 0, 'unobserved targets must not offer an incidental tick');

  await region.getByRole('button', { name: 'Refresh administration' }).click();
  await waitForText(region, 'Beta Territory', 'expected the refreshed target');
  await waitFor(() => requests.some((request) => request.kind === 'refresh'), 'expected an explicit target refresh');
  await waitFor(async () => await region.getByRole('button', { name: /Apply facilities/i }).count() === 1, 'expected controls after explicit observation');
  assert.equal(await region.getByLabel('Mining capacity').inputValue(), '5');
  assert.equal(requests.filter((request) => request.kind === 'control').length, 0, 'opening and selection must not mutate the world');
  assert.deepEqual(errors, []);
});

test('submits flattened policy fields with advanced extensions and rejects invalid JSON locally', async (t) => {
  const target = makeTarget(authorityPolicy, { name: 'Alpha Territory', kind: 'policy', observedAt });
  const data = makeData(accountA, [target], [policyControl], [], { [authorityPolicy]: policyState() });
  const action = makeAction('https://activity.invalid/actions/policy-1');
  const { page, requests, errors } = await openFixture(t, {
    accountId: accountA,
    handler: (request) => request.kind === 'read'
      ? { body: pageOf(data) }
      : request.kind === 'control'
        ? { body: { action } }
        : { status: 500, body: { error: 'unexpected request' } }
  });

  const region = administration(page);
  await waitForText(region, 'Alpha Territory', 'expected the policy target');
  const miningPermitted = region.getByLabel('Mining permitted');
  const quota = region.getByLabel('Mining quota');
  const reserve = region.getByLabel('Ore reserve');
  const permits = region.getByLabel('Manufacture permits');
  const advanced = region.getByLabel(/advanced policy/i);

  assert.equal(await miningPermitted.isChecked(), true);
  assert.equal(await quota.inputValue(), '20');
  assert.equal(await reserve.inputValue(), '100');
  assert.equal(await permits.inputValue(), 'ore-to-metal');

  const initialAdvanced = await advanced.inputValue();
  for (const expected of ['keep-me', 'recipes', 'warehouseLimits', 'portLimits', 'decisions']) {
    assert.ok(initialAdvanced.includes(expected), `advanced policy overlay must retain ${expected}`);
  }

  await advanced.fill('{ not json');
  await region.getByRole('button', { name: 'Apply policy' }).click();
  await waitForText(region, /invalid|unexpected|json|parse/i, 'expected local JSON validation');
  assert.equal(requests.filter((request) => request.kind === 'control').length, 0, 'invalid JSON must not be submitted');

  const parsed = JSON.parse(initialAdvanced) as Record<string, unknown>;
  const limits = parsed.warehouseLimits as Record<string, unknown>;
  limits.ore = 70;
  parsed.customFlag = 'edited';
  await advanced.fill(JSON.stringify(parsed));
  await miningPermitted.uncheck();
  await quota.fill('30');
  await reserve.fill('90');
  await permits.fill('ore-to-metal, metal-to-tool');
  await region.getByRole('button', { name: 'Apply policy' }).click();

  await waitFor(() => requests.some((request) => request.kind === 'control'), 'expected a policy control submission');
  const submitted = requests.find((request) => request.kind === 'control')!;
  assert.equal(submitted.accountId, accountA);
  assert.equal(submitted.authorityId, authorityPolicy);
  assert.equal(submitted.control, 'policy');
  assert.deepEqual(submitted.inputs, {
    ...parsed,
    miningPermitted: false,
    miningQuota: 30,
    oreReserve: 90,
    manufacturePermits: ['ore-to-metal', 'metal-to-tool']
  });
  assert.equal(Object.prototype.hasOwnProperty.call(submitted.inputs, 'policy'), false, 'policy payload must not be wrapped');
  await waitForText(region, /accepted/i, 'expected the submission result separately from the payload');
  assert.deepEqual(errors, []);
});

test('submits admission with comma-separated lists converted to string arrays', async (t) => {
  const target = makeTarget(authoritySimulation, { name: 'Beta Territory', kind: 'simulation', observedAt });
  const data = makeData(
    accountA,
    [makeTarget(authorityPolicy, { name: 'Alpha Territory', kind: 'policy', observedAt }), target],
    [simulationAdmissionControl],
    [],
    { [authorityPolicy]: policyState(), [authoritySimulation]: simulationState() }
  );
  const action = makeAction('https://activity.invalid/actions/admission-1');
  const { page, requests, errors } = await openFixture(t, {
    accountId: accountA,
    handler: (request) => request.kind === 'read'
      ? { body: pageOf(data) }
      : request.kind === 'control'
        ? { body: { action } }
        : { status: 500, body: { error: 'unexpected request' } }
  });

  const region = administration(page);
  await waitForText(region, 'Alpha Territory', 'expected the initial administration target');
  await region.getByLabel('Administration target').selectOption(authoritySimulation);
  await waitForText(region, 'Beta Territory', 'expected the simulation target');
  await region.getByLabel('Accepted Registries (comma separated)').fill('https://reg.one, https://reg.two');
  await region.getByLabel('Accepted Territories (comma separated)').fill('https://territory.one,https://territory.two');
  await region.getByRole('button', { name: 'Apply admission' }).click();

  await waitFor(() => requests.some((request) => request.kind === 'control'), 'expected an admission submission');
  const submitted = requests.find((request) => request.kind === 'control')!;
  assert.equal(submitted.control, 'admission');
  assert.deepEqual(submitted.inputs, {
    reviewMode: 'manual',
    acceptedRegistries: ['https://reg.one', 'https://reg.two'],
    acceptedTerritories: ['https://territory.one', 'https://territory.two'],
    manifestPolicy: 'request',
    requireExitEvidence: true
  });
  assert.deepEqual(errors, []);
});

test('writes nested facilities and sends an empty deliberate tick payload', async (t) => {
  const target = makeTarget(authoritySimulation, { name: 'Beta Territory', kind: 'simulation', observedAt });
  const data = makeData(accountA, [target], [facilitiesControl, tickControl], [], {
    [authoritySimulation]: simulationState()
  });
  const action = makeAction('https://activity.invalid/actions/facilities-1');
  const { page, requests, errors } = await openFixture(t, {
    accountId: accountA,
    handler: (request) => request.kind === 'read'
      ? { body: pageOf(data) }
      : request.kind === 'control'
        ? { body: { action } }
        : { status: 500, body: { error: 'unexpected request' } }
  });

  const region = administration(page);
  await waitForText(region, 'Beta Territory', 'expected the simulation target');
  assert.equal(requests.filter((request) => request.kind === 'control').length, 0, 'opening must not tick or mutate');

  await region.getByLabel('Mining enabled').uncheck();
  await region.getByLabel('Mining capacity').fill('8');
  await region.getByLabel('Manufacturing slots').fill('3');
  await region.getByLabel('Manufacturing time').fill('9');
  await region.getByLabel('Port capacity').fill('4');
  await region.getByLabel('Berth capacity').fill('6');
  await region.getByRole('button', { name: 'Apply facilities' }).click();

  await waitFor(() => requests.some((request) => request.kind === 'control'), 'expected a facilities submission');
  const facilities = requests.find((request) => request.kind === 'control')!;
  assert.equal(facilities.control, 'facilities');
  assert.deepEqual(facilities.inputs, {
    mining: { enabled: false, capacity: 8 },
    manufacturing: { slots: 3, time: 9 },
    port: { capacity: 4, berths: 6 }
  });
  assert.equal(Object.prototype.hasOwnProperty.call(facilities.inputs, 'miningEnabled'), false, 'facilities must not be flat config fields');

  await region.getByRole('button', { name: 'Advance tick' }).click();
  await waitFor(() => requests.filter((request) => request.kind === 'control').length === 2, 'expected a deliberate tick submission');
  const tick = requests.filter((request) => request.kind === 'control')[1]!;
  assert.equal(tick.control, 'tick');
  assert.deepEqual(tick.inputs, {});
  assert.deepEqual(errors, []);
});

test('submits registry adoption for the observed vessel and current adoption', async (t) => {
  const target = makeTarget(authorityRegistry, { name: 'Harbor Registry', kind: 'registry', roles: ['registry'], observedAt });
  const data = makeData(accountA, [target], [adoptionControl], [], {
    [authorityRegistry]: {
      kind: 'registry',
      fleet: {
        [vesselA]: { vessel: { id: vesselA, name: 'Coastal Barge' }, adoption: false },
        [vesselB]: { vessel: { id: vesselB, name: 'Harbor Barge' }, adoption: true }
      }
    }
  });
  const action = makeAction('https://activity.invalid/actions/adoption-1');
  const { page, requests, errors } = await openFixture(t, {
    accountId: accountA,
    handler: (request) => request.kind === 'read'
      ? { body: pageOf(data) }
      : request.kind === 'control'
        ? { body: { action } }
        : { status: 500, body: { error: 'unexpected request' } }
  });

  const region = administration(page);
  await waitForText(region, 'Harbor Registry', 'expected the registry target');
  const vessel = region.getByLabel('Fleet vessel');
  const adoption = region.getByLabel('Adoption');
  await vessel.selectOption(vesselB);
  assert.equal(await adoption.inputValue(), 'true', 'the observed current adoption must be selected');
  await adoption.selectOption('false');
  await region.getByRole('button', { name: 'Apply adoption' }).click();

  await waitFor(() => requests.some((request) => request.kind === 'control'), 'expected an adoption submission');
  const submitted = requests.find((request) => request.kind === 'control')!;
  assert.equal(submitted.control, 'adoption');
  assert.deepEqual(submitted.inputs, { vesselId: vesselB, adoption: false });
  assert.deepEqual(errors, []);
});

test('shows observed Home accounts and prevents disabling the caller while allowing another account', async (t) => {
  const target = makeTarget(authorityHome, { name: 'Alpha Home', kind: 'home', roles: ['home'], observedAt });
  const data = makeData(accountA, [target], [availabilityControl], [], {
    [authorityHome]: {
      kind: 'home',
      accounts: [
        { handle: handleA, actorId: 'https://actors.invalid/alpha-home', available: true },
        { handle: handleB, actorId: 'https://actors.invalid/beta-home', available: true },
        { handle: handleInactive, actorId: 'https://actors.invalid/inactive-home', available: false }
      ]
    }
  });
  const action = makeAction('https://activity.invalid/actions/availability-1');
  const { page, requests, errors } = await openFixture(t, {
    accountId: accountA,
    accountHandle: handleA,
    handler: (request) => request.kind === 'read'
      ? { body: pageOf(data) }
      : request.kind === 'control'
        ? { body: { action } }
        : { status: 500, body: { error: 'unexpected request' } }
  });

  const region = administration(page);
  for (const expected of [handleA, handleB, handleInactive, 'https://actors.invalid/alpha-home', 'https://actors.invalid/beta-home']) {
    await waitForText(region, expected, `expected observed Home field ${expected}`);
  }
  await waitForText(region, /your account/i, 'expected the caller account to be labeled');

  const own = region.getByLabel(`Available for ${handleA}`);
  assert.equal(await own.isDisabled(), true, 'the caller account must not be disabled from the observed handle');
  assert.equal(await own.isChecked(), true);

  const other = region.getByLabel(`Available for ${handleB}`);
  await other.uncheck();
  await region.getByRole('button', { name: `Apply availability for ${handleB}` }).click();

  await waitFor(() => requests.some((request) => request.kind === 'control'), 'expected an availability submission');
  const submitted = requests.find((request) => request.kind === 'control')!;
  assert.equal(submitted.control, 'availability');
  assert.deepEqual(submitted.inputs, { handle: handleB, available: false });
  assert.deepEqual(errors, []);
});

test('reports a backend self-disable rejection when the caller handle is absent', async (t) => {
  const target = makeTarget(authorityHome, { name: 'Alpha Home', kind: 'home', roles: ['home'], observedAt });
  const data = makeData(accountA, [target], [availabilityControl], [], {
    [authorityHome]: {
      kind: 'home',
      accounts: [
        { handle: handleA, actorId: 'https://actors.invalid/alpha-home', available: true },
        { handle: handleB, actorId: 'https://actors.invalid/beta-home', available: true }
      ]
    }
  });
  const { page, requests, errors } = await openFixture(t, {
    accountId: accountA,
    accountHandle: null,
    handler: (request) => request.kind === 'read'
      ? { body: pageOf(data) }
      : request.kind === 'control'
        ? { status: 409, body: { error: 'self-disable-rejected' } }
        : { status: 500, body: { error: 'unexpected request' } }
  });

  const region = administration(page);
  await waitForText(region, handleA, 'expected the observed Home accounts');
  await region.getByLabel(`Available for ${handleA}`).uncheck();
  await region.getByRole('button', { name: `Apply availability for ${handleA}` }).click();

  await waitFor(() => requests.some((request) => request.kind === 'control'), 'expected the rejected availability attempt');
  const submitted = requests.find((request) => request.kind === 'control')!;
  assert.deepEqual(submitted.inputs, { handle: handleA, available: false });
  await waitForText(region, /self-disable-rejected|self-disable|disable.*own|rejected/i, 'expected the backend rejection to be reported');
  await waitForText(region, handleB, 'observed accounts must remain readable after a rejected submission');
  assert.deepEqual(errors, []);
});

test('filters entry requests by exact authority, submits a retained pending decision once, and links Activity', async (t) => {
  const targetA = makeTarget(authorityPolicy, { name: 'Alpha Territory', kind: 'policy', observedAt });
  const targetB = makeTarget(authoritySimulation, { name: 'Beta Territory', kind: 'simulation', observedAt });
  const requestsData = [
    makeRequest({ requestId: 'collision', authorityId: authorityPolicy, vesselId: vesselA }),
    makeRequest({
      requestId: 'terminal', authorityId: authorityPolicy, vesselId: terminalVessel, status: 'accepted',
      decision: { accepted: true, reason: 'route verified' },
      event: { id: 'https://events.invalid/berth-1', type: 'BerthingEvent' }
    }),
    makeRequest({ requestId: 'collision', authorityId: authoritySimulation, vesselId: vesselB })
  ];
  const data = makeData(accountA, [targetA, targetB], [policyControl], requestsData, {
    [authorityPolicy]: policyState({ requests: requestsData.filter((request) => request.authorityId === authorityPolicy) }),
    [authoritySimulation]: simulationState({ requests: requestsData.filter((request) => request.authorityId === authoritySimulation) })
  });
  const action = makeAction('https://activity.invalid/actions/decision-1', { resultReferences: [{ kind: 'request', id: 'collision' }] });
  const decisionResponse = deferred<ServerResponse>();
  const { page, requests, errors } = await openFixture(t, {
    accountId: accountA,
    handler: (request) => {
      if (request.kind === 'read') return { body: pageOf(data) };
      if (request.kind === 'refresh') return { body: pageOf(data) };
      if (request.kind === 'decision') return decisionResponse.promise;
      return { status: 500, body: { error: 'unexpected request' } };
    }
  });

  const region = administration(page);
  await waitForText(region, vesselA, 'expected the pending request for the selected target');
  await waitForText(region, terminalVessel, 'expected the terminal request for the selected target');
  assert.equal((await regionText(page)).includes(vesselB), false, 'requests from another authority must be filtered out');
  assert.equal(await region.getByRole('button', { name: 'Approve' }).count(), 1, 'only retained pending requests may be approved');
  assert.equal(await region.getByRole('button', { name: 'Reject' }).count(), 1, 'only retained pending requests may be rejected');
  assert.equal(await region.getByRole('button', { name: /replay|reverse/i }).count(), 0);
  await waitForText(region, /BerthingEvent/, 'terminal decisions must show the actual event without replay');

  const pending = region.locator('article').filter({ hasText: vesselA }).first();
  await pending.waitFor({ state: 'visible', timeout: settleTimeout });
  for (const reference of ['vessel', 'registry', 'route', 'port']) {
    assert.equal(await pending.getByRole('button', { name: new RegExp(`read ${reference}`, 'i') }).count(), 1, `expected a readable ${reference} reference`);
  }
  await pending.getByRole('button', { name: /read vessel/i }).click();
  await waitForFixtureReads(page, 1);
  await pending.getByRole('button', { name: /read port/i }).click();
  await waitForFixtureReads(page, 2);
  const fixture = await fixtureOf(page);
  assert.equal(fixture.reads[0]?.id, vesselA, 'the original pending vessel reference must be readable in context');
  assert.equal(fixture.reads[1]?.id, portA, 'the original pending port reference must be readable in context');
  await pending.getByLabel(/reason/i).fill('Inspect cargo');
  await pending.getByRole('button', { name: 'Approve' }).evaluate((element) => {
    (element as HTMLElement).click();
    (element as HTMLElement).click();
  });

  await waitFor(() => requests.filter((request) => request.kind === 'decision').length >= 1, 'expected a decision submission');
  await sleep(150);
  const decisions = requests.filter((request) => request.kind === 'decision');
  assert.equal(decisions.length, 1, 'duplicate pending clicks must submit only once');
  assert.equal(decisions[0]!.method, 'POST');
  assert.equal(decisions[0]!.pathname, '/api/administration/entry-requests/collision/approve');
  assert.equal(decisions[0]!.accountId, accountA);
  assert.equal(decisions[0]!.authorityId, authorityPolicy);
  assert.deepEqual(decisions[0]!.body, { accountId: accountA, authorityId: authorityPolicy, reason: 'Inspect cargo' });

  decisionResponse.resolve({ body: { action } });
  await region.getByRole('button', { name: 'Open Activity' }).waitFor({ state: 'visible', timeout: settleTimeout });
  const text = await regionText(page);
  assert.match(text, /submission[^\n]*accepted/i, 'submission acceptance must be shown separately');
  assert.match(text, /outcome[^\n]*pending/i, 'approval must remain pending until actual evidence');
  assert.match(text, /not[^\n]*berth|berthing event/i, 'approval must not be presented as berthing');
  assert.doesNotMatch(text, /outcome[^\n]*completed/i);
  assert.equal(requests.filter((request) => request.kind === 'refresh').length, 0, 'a decision must not refresh the world automatically');
  assert.equal(requests.filter((request) => request.kind === 'control').length, 0);

  await region.getByRole('button', { name: 'Open Activity' }).click();
  await waitForFixtureActions(page, 1);
  const after = await fixtureOf(page);
  assert.deepEqual(after.actions, [action.id]);

  await region.getByRole('button', { name: 'Refresh administration' }).click();
  await waitFor(() => requests.some((request) => request.kind === 'refresh'), 'expected an explicit target refresh');
  await waitForText(region, /outcome[^\n]*pending/i, 'target refresh alone must not change the retained decision outcome');
  assert.doesNotMatch(await regionText(page), /outcome[^\n]*completed/i);
  assert.deepEqual(errors, []);
});

test('drops a late account response so another account scope cannot be overwritten', async (t) => {
  const alpha = deferred<ServerResponse>();
  const betaData = makeData(accountB, [
    makeTarget('https://beta.test/actors/territory', { name: 'Beta Administration', kind: 'policy', observedAt })
  ], [policyControl], [], {
    'https://beta.test/actors/territory': policyState({ policy: { miningQuota: 30 } })
  });
  const alphaData = makeData(accountA, [
    makeTarget(authorityPolicy, { name: 'Alpha Administration', kind: 'policy', observedAt })
  ], [policyControl], [], { [authorityPolicy]: policyState({ policy: { miningQuota: 88 } }) });
  const { page, requests, errors } = await openFixture(t, {
    accountId: accountA,
    handler: (request) => request.kind === 'read' && request.accountId === accountA
      ? alpha.promise
      : request.kind === 'read'
        ? { body: pageOf(betaData) }
        : { status: 500, body: { error: 'unexpected request' } }
  });

  await waitFor(() => requests.some((request) => request.kind === 'read' && request.accountId === accountA), 'expected the held account read');
  await setAccount(page, accountB);
  await waitForText(administration(page), 'Beta Administration', 'expected the newer account scope');

  alpha.resolve({ body: pageOf(alphaData) });
  await sleep(200);
  const region = administration(page);
  await waitForText(region, 'Beta Administration', 'the newer account scope must remain visible');
  assert.equal((await regionText(page)).includes('Alpha Administration'), false, 'a late account response must not overwrite another scope');
  assert.equal(await region.getByLabel('Administration target').inputValue(), 'https://beta.test/actors/territory');
  const betaRead = requests.find((request) => request.kind === 'read' && request.accountId === accountB);
  assert(betaRead, 'expected a read scoped to the newer account');
  assert.equal(betaRead.headers.authorization, 'Bearer token-b');
  assert.deepEqual(errors, []);
});

test('drops a late target refresh response after another target is selected', async (t) => {
  const targetA = makeTarget(authorityPolicy, { name: 'Alpha Territory', kind: 'policy', observedAt });
  const targetB = makeTarget(authoritySimulation, { name: 'Beta Territory', kind: 'simulation', observedAt });
  const initial = makeData(accountA, [targetA, targetB], [policyControl, facilitiesControl], [], {
    [authorityPolicy]: policyState({ policy: { miningQuota: 20 } }),
    [authoritySimulation]: simulationState()
  });
  const late = makeData(accountA, [
    makeTarget(authorityPolicy, { name: 'Alpha Territory', kind: 'policy', state: 'stale', observedAt: refreshedAt }),
    targetB
  ], [policyControl, facilitiesControl], [], {
    [authorityPolicy]: policyState({ policy: { miningQuota: 99 } }),
    [authoritySimulation]: simulationState()
  });
  const refreshResponse = deferred<ServerResponse>();
  const { page, requests, errors } = await openFixture(t, {
    accountId: accountA,
    handler: (request) => {
      if (request.kind === 'read') return { body: pageOf(initial) };
      if (request.kind === 'refresh') return refreshResponse.promise;
      return { status: 500, body: { error: 'unexpected request' } };
    }
  });

  const region = administration(page);
  await waitForText(region, 'Alpha Territory', 'expected the first target');
  await region.getByRole('button', { name: 'Refresh administration' }).click();
  await waitFor(() => requests.some((request) => request.kind === 'refresh'), 'expected the held target refresh');

  const targetSelect = region.getByLabel('Administration target');
  await targetSelect.selectOption(authoritySimulation);
  await waitForText(region, 'Beta Territory', 'expected the newer target');
  assert.equal(await region.getByLabel('Mining capacity').inputValue(), '5');

  refreshResponse.resolve({ body: pageOf(late) });
  await sleep(200);
  assert.equal(await targetSelect.inputValue(), authoritySimulation, 'a late refresh must not change the selected target');
  await waitForText(region, 'Beta Territory', 'the newer target must remain visible');
  assert.equal((await regionText(page)).includes('99'), false, 'another target must not be overwritten by a late refresh');
  assert.equal(await region.getByLabel('Mining capacity').inputValue(), '5');
  assert.deepEqual(errors, []);
});

test('selects exact supplied administration recovery context on open and subsequent handoff without observing the world', async (t) => {
  const data = makeData(accountA, [
    makeTarget(authorityPolicy, { name: 'Alpha Territory', kind: 'policy', observedAt }),
    makeTarget(authoritySimulation, { name: 'Beta Territory', kind: 'simulation', observedAt })
  ], [policyControl, facilitiesControl], [], {
    [authorityPolicy]: policyState(), [authoritySimulation]: simulationState()
  });
  const { page, requests, errors } = await openFixture(t, {
    authorityId: authoritySimulation,
    handler: () => ({ body: pageOf(data) })
  });
  const region = administration(page);
  const select = region.getByLabel('Administration target');
  await waitForText(region, 'Beta Territory', 'expected supplied recovery target');
  assert.equal(await select.inputValue(), authoritySimulation);
  assert.match(await select.locator(`option[value="${authorityPolicy}"]`).innerText(), /Alpha Territory/);
  await page.evaluate((id) => {
    (window as unknown as { __administrationFixture: AdministrationFixture }).__administrationFixture.controls?.setAuthorityId(id);
  }, authorityPolicy);
  await waitForText(region, 'Alpha Territory', 'expected updated recovery target');
  assert.equal(await select.inputValue(), authorityPolicy);
  assert.equal(requests.filter((request) => request.kind !== 'read').length, 0);
  assert.deepEqual(errors, []);
});

test('never carries edited settings into another target with the same supported control', async (t) => {
  const other = 'https://other.test/actors/territory';
  const data = makeData(accountA, [
    makeTarget(authorityPolicy, { name: 'Alpha Territory', observedAt }),
    makeTarget(other, { name: 'Other Territory', observedAt })
  ], [policyControl, { ...policyControl, authorityId: other }], [], {
    [authorityPolicy]: policyState(), [other]: policyState({ policy: { miningQuota: 77 } })
  });
  const { page, requests, errors } = await openFixture(t, { handler: () => ({ body: pageOf(data) }) });
  const region = administration(page);
  await waitForText(region, 'Alpha Territory', 'expected first target');
  await region.getByLabel('Mining quota').fill('999');
  await region.getByLabel('Administration target').selectOption(other);
  await waitForText(region, 'Other Territory', 'expected other target');
  assert.equal(await region.getByLabel('Mining quota').inputValue(), '77', 'target inputs must start from that target observation');
  assert.equal(requests.filter((request) => request.kind !== 'read').length, 0);
  assert.deepEqual(errors, []);
});

test('does not resurrect a late submission after leaving and returning to the same account', async (t) => {
  const held = deferred<ServerResponse>();
  const data = (id: string) => makeData(id, [makeTarget(authorityPolicy, { name: 'Alpha Territory', observedAt })],
    [policyControl], [], { [authorityPolicy]: policyState() });
  const { page, requests, errors } = await openFixture(t, {
    handler: (request) => request.kind === 'control' ? held.promise : { body: pageOf(data(request.accountId!)) }
  });
  const region = administration(page);
  await waitForText(region, 'Alpha Territory', 'expected first account');
  await region.getByRole('button', { name: 'Apply policy', exact: true }).click();
  await waitFor(() => requests.some((request) => request.kind === 'control'), 'expected held send');
  await setAccount(page, accountB);
  await waitFor(() => requests.some((request) => request.kind === 'read' && request.accountId === accountB), 'expected second account');
  await waitForText(region, 'Alpha Territory', 'expected second account read');
  await setAccount(page, accountA);
  await waitFor(() => requests.filter((request) => request.kind === 'read' && request.accountId === accountA).length === 2, 'expected returned account read');
  await waitForText(region, 'Alpha Territory', 'expected returned account');
  held.resolve({ body: { action: makeAction('late-action') } });
  await sleep(200);
  assert.equal(await region.getByRole('region', { name: 'Submission result' }).count(), 0, 'obsolete sends must not render in a later account generation');
  assert.deepEqual(errors, []);
});
