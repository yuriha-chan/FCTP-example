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
const vesselA = 'https://vessels.invalid/vessel-a';
const vesselB = 'https://vessels.invalid/vessel-b';
const policyAuthority = 'https://territories.invalid/actors/policy';
const simulationAuthority = 'https://territories.invalid/actors/simulation';
const absentAuthority = 'https://territories.invalid/actors/absent';
const observedAt = '2026-06-01T01:02:03.000Z';
const laterAt = '2026-06-01T02:03:04.000Z';
const evidenceAt = '2026-06-01T05:04:05.000Z';
const submittedAt = '2026-06-01T04:05:06.000Z';
const opMine = 'operation:policy-mine';
const opManufacture = 'operation:policy-manufacture';
const opTransfer = 'operation:policy-transfer';
const opLoad = 'operation:policy-load';
const opUnload = 'operation:policy-unload';
const opSimulationLoad = 'operation:simulation-load';
const varietyFiber = 'https://resources.invalid/varieties/fiber';
const varietyHull = 'https://resources.invalid/varieties/hull';
const varietyExtra = 'https://resources.invalid/varieties/extra';
const recipeCloth = 'https://resources.invalid/recipes/cloth';
const recipeLinen = 'https://resources.invalid/recipes/linen';
const jobPolicy = 'job:policy:12';
const jobSimulation = 'job:simulation:12';
const jobUnevidenced = 'job:policy:13';
const jobMissing = 'job:policy:missing';
const resourceResult = 'https://resources.invalid/results/production-ledger';
const actionProduction = 'https://activity.invalid/actions/production-1';
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

const fixtureSource = String.raw`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Production } from './apps/frontend/src/production.tsx';

const params = new URLSearchParams(window.location.search);
const accountParam = params.get('account');
const initialAccount = accountParam === 'none' ? undefined : (accountParam || 'account-a');
const vesselParam = params.get('vessel') || undefined;
const contextAccount = params.get('contextAccount');
const initialContext = vesselParam === undefined ? undefined : {
  accountId: contextAccount === null || contextAccount === 'none' ? (initialAccount || 'account-a') : contextAccount,
  vesselId: vesselParam,
  ...(params.get('authority') ? { authorityId: params.get('authority') } : {}),
  ...(params.get('operation') ? { operationId: params.get('operation') } : {}),
  ...(params.get('job') ? { jobId: params.get('job') } : {}),
  ...(params.get('place') ? { placeId: params.get('place') } : {}),
  ...(params.get('capability') ? { capabilityId: params.get('capability') } : {})
};
const initialRevision = Number(params.get('revision') || '0');
const withCallbacks = params.get('callbacks') !== '0';
const fixture = { controls: null, actions: [], resources: [] };
window.__productionFixture = fixture;

const onOpenAction = (actionId) => { fixture.actions.push(actionId); };
const onReadResource = (reference) => { fixture.resources.push(reference); };

function App() {
  const [accountId, setAccountIdState] = React.useState(initialAccount);
  const [context, setContextState] = React.useState(initialContext);
  const [selectionRevision, setSelectionRevision] = React.useState(initialRevision);
  const [mounted, setMounted] = React.useState(true);

  React.useEffect(() => {
    fixture.controls = {
      setAccountId(value) { setAccountIdState(value === null ? undefined : value); },
      setContext(value) { setContextState(value === null ? undefined : value); },
      setSelectionRevision(value) { setSelectionRevision(value); },
      unmount() { setMounted(false); },
      remount() { setMounted(true); }
    };
  }, []);

  const props = {
    ...(accountId === undefined ? {} : { accountId }),
    ...(context === undefined ? {} : { context }),
    ...(selectionRevision === 0 ? {} : { selectionRevision }),
    ...(withCallbacks ? { onOpenAction, onReadResource } : {})
  };

  return React.createElement(
    'main',
    null,
    mounted ? React.createElement(Production, props) : React.createElement('p', null, 'Production unmounted')
  );
}

createRoot(document.getElementById('root')).render(React.createElement(App));
`;

type OperationKind = 'mine' | 'manufacture' | 'transfer' | 'load' | 'unload';
type ObservationState = 'available' | 'empty' | 'stale' | 'not-retrieved' | 'unavailable';

interface OperationInputRecord {
  name: string;
  label: string;
  type: 'count' | 'choice';
  required: boolean;
  default?: string | number;
  minimum?: number;
  choices?: Array<{ value: string; label: string }>;
}

interface OperationRecord {
  operationId: string;
  authorityId: string;
  kind: OperationKind;
  label: string;
  effect: string;
  inputs: OperationInputRecord[];
  defaults: Record<string, string | number>;
  blockers: string[];
  available: boolean;
  outputDestination?: string;
  source: string;
  observedAt: string;
}

interface AuthorityRecord {
  authorityId: string;
  kind: 'policy' | 'simulation';
  source: string;
  state: ObservationState;
  name?: string;
  error?: string;
  observedAt?: string;
}

interface ActionEvidence {
  source: string;
  observedAt: string;
  changes?: Record<string, unknown>;
}

interface ActionReference {
  kind: 'request' | 'resource' | 'job' | 'event';
  id: string;
}

interface ActionRecord {
  id: string;
  statusUrl: string;
  accountId: string;
  targetId: string;
  resultReferences: ActionReference[];
  intent: { kind: string; inputs: Record<string, unknown> };
  submittedAt: string;
  submission: { status: string; result?: string; error?: string; evidenceBaseline?: ActionEvidence[] };
  outcome: { status: string; evidence: ActionEvidence[]; error?: string };
}

interface JobProgress {
  remainingTicks?: number;
  tick?: number;
  count?: number;
}

interface JobRecord {
  jobId: string;
  authorityId: string;
  accountId: string;
  vesselId: string;
  operation: OperationKind;
  status: string;
  source: string;
  observedAt: string;
  progress?: JobProgress;
  output?: string;
  evidence?: ActionEvidence[];
  error?: string;
}

interface ProductionPage {
  context: { accountId?: string; vesselId?: string };
  data: {
    accountId: string;
    vesselId: string;
    operations: OperationRecord[];
    authorities: AuthorityRecord[];
    jobs: JobRecord[];
  };
  observations: Record<string, unknown>;
  actions: unknown[];
}

interface ActionPage {
  context: { accountId?: string; vesselId?: string };
  data: { action: ActionRecord };
  observations: Record<string, unknown>;
  actions: unknown[];
}

interface ServerResponse {
  status?: number;
  body?: unknown;
  abort?: boolean;
}

interface ProductionRequest {
  kind: 'page' | 'refresh' | 'operation' | 'execute' | 'job' | 'job-refresh'
    | 'action-refresh' | 'library' | 'library-refresh' | 'resource' | 'resource-refresh' | 'other';
  method: string;
  pathname: string;
  params: Record<string, string>;
  operationId?: string;
  jobId?: string;
  actionId?: string;
  resourceId?: string;
  body?: unknown;
  headers: Record<string, string>;
}

type Handler = (request: ProductionRequest) => ServerResponse | Promise<ServerResponse>;

interface FixtureContext {
  accountId: string;
  vesselId: string;
  authorityId?: string;
  operationId?: string;
  jobId?: string;
  placeId?: string;
  capabilityId?: string;
}

interface FixtureConfig {
  handler: Handler;
  accountId?: string | null;
  context?: FixtureContext;
  revision?: number;
  callbacks?: boolean;
}

interface OpenedFixture {
  page: Page;
  requests: ProductionRequest[];
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

function authoritySource(authorityId: string): string {
  return `${authorityId}/local/actions`;
}

function operation(options: {
  operationId: string;
  authorityId: string;
  kind: OperationKind;
  label: string;
  inputs?: OperationInputRecord[];
  defaults?: Record<string, string | number>;
  blockers?: string[];
  available?: boolean;
  outputDestination?: string;
  effect?: string;
  source?: string;
  observedAt?: string;
}): OperationRecord {
  return {
    operationId: options.operationId,
    authorityId: options.authorityId,
    kind: options.kind,
    label: options.label,
    effect: options.effect ?? `${options.label} changes the observed world.`,
    inputs: options.inputs ?? [],
    defaults: options.defaults ?? {},
    blockers: options.blockers ?? [],
    available: options.available ?? true,
    ...(options.outputDestination === undefined ? {} : { outputDestination: options.outputDestination }),
    source: options.source ?? authoritySource(options.authorityId),
    observedAt: options.observedAt ?? observedAt
  };
}

function countInput(defaultValue = 1, minimum = 1, label = 'Quantity'): OperationInputRecord {
  return { name: 'count', label, type: 'count', required: true, default: defaultValue, minimum };
}

function choiceInput(
  name: string,
  label: string,
  choices: Array<{ value: string; label: string }>,
  defaultValue?: string
): OperationInputRecord {
  return {
    name,
    label,
    type: 'choice',
    required: true,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
    choices
  };
}

function actionRecord(options: {
  id?: string;
  accountId?: string;
  targetId?: string;
  resultReferences?: ActionReference[];
  intent?: { kind: string; inputs: Record<string, unknown> };
  submission?: Partial<ActionRecord['submission']>;
  outcome?: Partial<ActionRecord['outcome']>;
} = {}): ActionRecord {
  const id = options.id ?? actionProduction;
  return {
    id,
    statusUrl: `https://activity.invalid/status/${encodeURIComponent(id)}`,
    accountId: options.accountId ?? accountA,
    targetId: options.targetId ?? policyAuthority,
    resultReferences: options.resultReferences ?? [],
    intent: options.intent ?? { kind: 'production', inputs: {} },
    submittedAt,
    submission: { status: 'accepted', ...(options.submission ?? {}) } as ActionRecord['submission'],
    outcome: { status: 'pending', evidence: [], ...(options.outcome ?? {}) } as ActionRecord['outcome']
  };
}

function productionPage(options: {
  accountId?: string;
  vesselId?: string;
  operations?: OperationRecord[];
  authorities?: AuthorityRecord[];
  jobs?: JobRecord[];
} = {}): ProductionPage {
  const accountId = options.accountId ?? accountA;
  const vesselId = options.vesselId ?? vesselA;
  const authorities = options.authorities ?? [];
  const observations = Object.fromEntries(authorities.map((authority) => [
    authority.source,
    authority.state === 'available' || authority.state === 'stale'
      ? {
          state: authority.state,
          source: authority.source,
          observedAt: authority.observedAt ?? observedAt,
          value: { kind: authority.kind },
          ...(authority.error === undefined ? {} : { error: authority.error })
        }
      : authority.state === 'unavailable'
        ? { state: 'unavailable', source: authority.source, error: authority.error ?? 'Source unavailable' }
        : { state: 'not-retrieved', source: authority.source }
  ]));
  return {
    context: { accountId, vesselId },
    data: {
      accountId,
      vesselId,
      operations: options.operations ?? [],
      authorities,
      jobs: options.jobs ?? []
    },
    observations,
    actions: []
  };
}

function actionPage(action: ActionRecord): ActionPage {
  return {
    context: { accountId: action.accountId },
    data: { action },
    observations: {},
    actions: []
  };
}

function jobRecord(options: {
  jobId: string;
  authorityId: string;
  operation: OperationKind;
  status: string;
  accountId?: string;
  vesselId?: string;
  remainingTicks?: number;
  tick?: number;
  count?: number;
  source?: string;
  observedAt?: string;
  output?: string;
  evidence?: ActionEvidence[];
  error?: string;
}): JobRecord {
  const hasProgress = options.remainingTicks !== undefined || options.tick !== undefined || options.count !== undefined;
  return {
    jobId: options.jobId,
    authorityId: options.authorityId,
    accountId: options.accountId ?? accountA,
    vesselId: options.vesselId ?? vesselA,
    operation: options.operation,
    status: options.status,
    source: options.source ?? `${options.authorityId}/local/state`,
    observedAt: options.observedAt ?? observedAt,
    ...(hasProgress ? {
      progress: {
        ...(options.remainingTicks === undefined ? {} : { remainingTicks: options.remainingTicks }),
        ...(options.tick === undefined ? {} : { tick: options.tick }),
        ...(options.count === undefined ? {} : { count: options.count })
      }
    } : {}),
    ...(options.output === undefined ? {} : { output: options.output }),
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
    ...(options.error === undefined ? {} : { error: options.error })
  };
}

function resourcePage(id: string, name: string, accountId = accountA, authorityId?: string): ServerResponse {
  return {
    body: {
      context: { resourceId: id, accountId },
      data: { resourceId: id, ...(authorityId === undefined ? {} : { authorityId }), value: { id, type: 'Variety', name } },
      observations: {
        [`resource\u0000${accountId}\u0000${id}`]: { state: 'available', source: id, observedAt, value: { id, type: 'Variety', name } }
      },
      actions: []
    }
  };
}

function libraryPage(
  accountId: string,
  varieties: unknown[],
  observations: Record<string, unknown> = {}
): ServerResponse {
  return {
    body: {
      context: { accountId },
      data: { assets: [], varieties, grants: [], drafts: [] },
      observations,
      actions: []
    }
  };
}

let browser: Browser | undefined;
let bundle: string | undefined;

before(async () => {
  const result = await build({
    stdin: {
      contents: fixtureSource,
      resolveDir: projectRoot,
      sourcefile: 'frontend-production-fixture.js',
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

function routeKind(url: URL): {
  kind: ProductionRequest['kind'];
  operationId?: string;
  jobId?: string;
  actionId?: string;
  resourceId?: string;
} {
  const parts = url.pathname.split('/').filter((part) => part.length > 0);
  if (url.pathname === '/api/production') return { kind: 'page' };
  if (url.pathname === '/api/production/refresh') return { kind: 'refresh' };
  if (url.pathname === '/api/library') return { kind: 'library' };
  if (url.pathname === '/api/library/refresh') return { kind: 'library-refresh' };
  if (parts[0] === 'api' && parts[1] === 'production' && parts[2] === 'operations' && parts[3] !== undefined) {
    const operationId = decodeURIComponent(parts[3]);
    return { kind: parts[4] === 'execute' ? 'execute' : 'operation', operationId };
  }
  if (parts[0] === 'api' && parts[1] === 'production' && parts[2] === 'jobs' && parts[3] !== undefined) {
    const jobId = decodeURIComponent(parts[3]);
    return { kind: parts[4] === 'refresh' ? 'job-refresh' : 'job', jobId };
  }
  if (parts[0] === 'api' && parts[1] === 'activity' && parts[2] !== undefined && parts[3] === 'refresh') {
    return { kind: 'action-refresh', actionId: decodeURIComponent(parts[2]) };
  }
  if (parts[0] === 'api' && parts[1] === 'resources' && parts[2] !== undefined) {
    const resourceId = decodeURIComponent(parts[2]);
    return { kind: parts[3] === 'refresh' ? 'resource-refresh' : 'resource', resourceId };
  }
  return { kind: 'other' };
}

async function openFixture(t: TestContext, config: FixtureConfig): Promise<OpenedFixture> {
  const activeBrowser = browser;
  const activeBundle = bundle;
  assert(activeBrowser, 'browser was not started');
  assert(activeBundle, 'fixture bundle was not built');

  const context = await activeBrowser.newContext();
  t.after(async () => { await context.close(); });
  await context.addInitScript(() => {
    localStorage.setItem('fctp.client-sessions', JSON.stringify([
      { accountId: 'account-a', handle: '@alpha.home@alpha.test:4200', clientToken: 'token-a' },
      { accountId: 'account-b', handle: '@beta.home@beta.test:4200', clientToken: 'token-b' }
    ]));
  });

  const page = await context.newPage();
  const requests: ProductionRequest[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });

  await page.route(`${fixtureOrigin}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/bundle.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: activeBundle });
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }
    const bodyText = request.postData();
    let body: unknown;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText) as unknown;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    const parsed = routeKind(url);
    const recorded: ProductionRequest = {
      kind: parsed.kind,
      method: request.method(),
      pathname: url.pathname,
      params: Object.fromEntries(url.searchParams),
      ...(parsed.operationId === undefined ? {} : { operationId: parsed.operationId }),
      ...(parsed.jobId === undefined ? {} : { jobId: parsed.jobId }),
      ...(parsed.actionId === undefined ? {} : { actionId: parsed.actionId }),
      ...(parsed.resourceId === undefined ? {} : { resourceId: parsed.resourceId }),
      ...(body === undefined ? {} : { body }),
      headers: request.headers()
    };
    requests.push(recorded);

    const response = await config.handler(recorded);
    if (response.abort === true) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: response.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(response.body ?? {})
    });
  });

  const search = new URLSearchParams();
  search.set('account', config.accountId === null ? 'none' : config.accountId ?? accountA);
  if (config.context !== undefined) {
    search.set('contextAccount', config.context.accountId);
    search.set('vessel', config.context.vesselId);
    if (config.context.authorityId !== undefined) search.set('authority', config.context.authorityId);
    if (config.context.operationId !== undefined) search.set('operation', config.context.operationId);
    if (config.context.jobId !== undefined) search.set('job', config.context.jobId);
    if (config.context.placeId !== undefined) search.set('place', config.context.placeId);
    if (config.context.capabilityId !== undefined) search.set('capability', config.context.capabilityId);
  }
  if (config.revision !== undefined) search.set('revision', String(config.revision));
  if (config.callbacks === false) search.set('callbacks', '0');

  await page.goto(`${fixtureOrigin}?${search.toString()}`);
  await page.waitForFunction(() => {
    const fixture = (window as unknown as { __productionFixture?: { controls?: unknown } }).__productionFixture;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function productionRegion(page: Page): Locator {
  return page.getByRole('region', { name: /^Production$/i }).first();
}

async function waitForRegionText(scope: Locator, expected: string | RegExp, message: string): Promise<string> {
  let last = '';
  try {
    await waitFor(async () => {
      last = await scope.innerText();
      return typeof expected === 'string' ? last.includes(expected) : expected.test(last);
    }, message);
  } catch (error) {
    throw new Error(`${message}; last Production text was ${JSON.stringify(last)}`, { cause: error });
  }
  return last;
}

function statusPattern(label: string, value: string): RegExp {
  return new RegExp(`${label}[\\s\\S]{0,64}${value}`, 'i');
}

function operationButton(page: Page, label: string): Locator {
  return productionRegion(page)
    .getByRole('button', { name: new RegExp(`^(?!Execute\\b|Submit\\b).*${escapeRegExp(label)}`, 'i') })
    .first();
}

function submitButton(page: Page): Locator {
  return productionRegion(page).getByRole('button', { name: /^(Execute|Submit)\b/i }).first();
}

function quantityField(page: Page): Locator {
  return productionRegion(page).getByLabel(/quantity/i).first();
}

async function selectOperation(page: Page, label: string): Promise<void> {
  const button = operationButton(page, label);
  await button.waitFor({ state: 'visible', timeout: settleTimeout });
  await button.click();
  await quantityField(page).waitFor({ state: 'visible', timeout: settleTimeout });
}

async function waitForInputValue(scope: Locator, expected: string, message: string): Promise<void> {
  let last = '';
  try {
    await waitFor(async () => {
      last = await scope.inputValue();
      return last === expected;
    }, message);
  } catch (error) {
    throw new Error(`${message}; last value was ${JSON.stringify(last)}`, { cause: error });
  }
}

async function setAccount(page: Page, accountId: string | null): Promise<void> {
  await page.evaluate((value) => {
    const fixture = (window as unknown as { __productionFixture: { controls: { setAccountId(value: string | null): void } } }).__productionFixture;
    fixture.controls.setAccountId(value);
  }, accountId);
}

async function setContext(page: Page, context: FixtureContext | null): Promise<void> {
  await page.evaluate((value) => {
    const fixture = (window as unknown as { __productionFixture: { controls: { setContext(value: unknown): void } } }).__productionFixture;
    fixture.controls.setContext(value);
  }, context);
}

async function setRevision(page: Page, revision: number): Promise<void> {
  await page.evaluate((value) => {
    const fixture = (window as unknown as { __productionFixture: { controls: { setSelectionRevision(value: number): void } } }).__productionFixture;
    fixture.controls.setSelectionRevision(value);
  }, revision);
}

async function unmount(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fixture = (window as unknown as { __productionFixture: { controls: { unmount(): void } } }).__productionFixture;
    fixture.controls.unmount();
  });
}

async function remount(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fixture = (window as unknown as { __productionFixture: { controls: { remount(): void } } }).__productionFixture;
    fixture.controls.remount();
  });
}

async function callbackSnapshot(page: Page): Promise<{ actions: unknown[]; resources: unknown[] }> {
  return page.evaluate(() => {
    const fixture = (window as unknown as { __productionFixture: { actions: unknown[]; resources: unknown[] } }).__productionFixture;
    return { actions: fixture.actions.slice(), resources: fixture.resources.slice() };
  });
}

async function activeElement(page: Page): Promise<{ tag: string; label: string; text: string }> {
  return page.evaluate(() => {
    const element = document.activeElement;
    return {
      tag: element?.tagName ?? '',
      label: element?.getAttribute('aria-label') ?? '',
      text: (element?.textContent ?? '').slice(0, 240)
    };
  });
}

function requestsOfKind(requests: readonly ProductionRequest[], kind: ProductionRequest['kind']): ProductionRequest[] {
  return requests.filter((request) => request.kind === kind);
}

function recordItem(scope: Locator, text: string): Locator {
  return scope.getByText(text, { exact: false }).first()
    .locator('xpath=ancestor::*[self::li or self::article or @role="listitem" or @role="article"][1]');
}

function recent(requests: readonly ProductionRequest[], kind: ProductionRequest['kind']): ProductionRequest | undefined {
  return requestsOfKind(requests, kind).at(-1);
}

test('prompts for an account, a vessel, and a matching context without private reads', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    accountId: null,
    handler: () => ({ status: 500, body: { error: 'unexpected request' } })
  });

  const region = productionRegion(page);
  await waitForRegionText(region, /select an account|sign in|account.*(required|needed)/i, 'expected an account prompt');
  assert.equal(requests.length, 0, 'an anonymous Production view must not read private data');

  await setAccount(page, accountA);
  await waitForRegionText(region, /select a vessel|vessel.*(required|needed)|choose.*vessel/i, 'expected a vessel prompt');
  assert.equal(requests.length, 0, 'Production must not read without an exact vessel context');

  await setContext(page, { accountId: accountB, vesselId: vesselA });
  await waitForRegionText(region, /context.*(does not match|different)|account.*(does not match|different)|cross-account/i, 'expected a mismatched-context explanation');
  assert.equal(requests.length, 0, 'a context for another account must not trigger a private read');
  assert.deepEqual(errors, []);
});

test('reads the exact account and vessel once and shows independent authority observations with explicit selection', async (t) => {
  const policyMine = operation({
    operationId: opMine,
    authorityId: policyAuthority,
    kind: 'mine',
    label: 'Mine ore',
    effect: 'Adds ore to the shared Territory stock.',
    inputs: [countInput(1)],
    outputDestination: 'Shared Territory stock',
    available: false,
    blockers: ['The quarry is closed.']
  });
  const simulationLoad = operation({
    operationId: opSimulationLoad,
    authorityId: simulationAuthority,
    kind: 'load',
    label: 'Queue load',
    inputs: [countInput(1)],
    outputDestination: 'Vessel cargo'
  });
  const pageBody = productionPage({
    authorities: [
      { authorityId: policyAuthority, kind: 'policy', source: authoritySource(policyAuthority), state: 'available', name: 'Policy Works', observedAt },
      {
        authorityId: simulationAuthority,
        kind: 'simulation',
        source: authoritySource(simulationAuthority),
        state: 'stale',
        name: 'Simulation Works',
        observedAt: laterAt,
        error: 'Simulation observation is stale'
      }
    ],
    operations: [policyMine, simulationLoad]
  });
  const { page, requests, errors } = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA },
    handler: (request) => request.kind === 'page'
      ? { body: pageBody }
      : { status: 404, body: { error: 'unexpected request' } }
  });

  const region = productionRegion(page);
  const text = await waitForRegionText(region, 'Mine ore', 'expected the retained operation');
  assert.ok(text.includes(policyAuthority), 'expected the policy authority identity');
  assert.ok(text.includes(authoritySource(policyAuthority)), 'expected the policy source');
  assert.ok(text.includes(observedAt), 'expected the policy observation time');
  assert.ok(text.includes('Simulation Works'), 'expected the second authority independently');
  assert.ok(text.includes(authoritySource(simulationAuthority)), 'expected the simulation source');
  assert.ok(text.includes(laterAt), 'expected the simulation observation time');
  assert.match(text, /stale/i, 'expected the stale authority state');
  assert.ok(text.includes('Simulation observation is stale'), 'expected the independent authority error');
  assert.match(text, /quarry is closed/i, 'expected the advertised blocker');
  assert.match(text, /destination[\s\S]{0,48}shared territory stock/i, 'expected the output destination to be labelled separately');

  const read = recent(requests, 'page');
  assert(read, 'expected a retained production read');
  assert.equal(read.method, 'GET');
  assert.equal(read.pathname, '/api/production');
  assert.equal(read.params.accountId, accountA);
  assert.equal(read.params.vesselId, vesselA);
  assert.equal(read.headers.authorization, 'Bearer token-a');

  await region.getByRole('button', { name: /Simulation Works/i }).first().click();
  await waitForRegionText(region, 'Queue load', 'expected the explicitly selected authority operations');
  assert.equal(await region.getByText('Mine ore', { exact: true }).count(), 0, 'the other authority operation must not remain selected');

  await region.getByRole('button', { name: /Policy Works/i }).first().click();
  await waitForRegionText(region, 'Mine ore', 'expected the policy authority operations after selection');

  await sleep(400);
  assert.equal(requestsOfKind(requests, 'page').length, 1, 'the retained production read must not be polled');
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0, 'opening Production must not refresh');
  assert.deepEqual(errors, []);
});

test('reports a requested authority as unavailable without falling back to another authority', async (t) => {
  const pageBody = productionPage({
    authorities: [
      { authorityId: policyAuthority, kind: 'policy', source: authoritySource(policyAuthority), state: 'available', name: 'Policy Works', observedAt },
      {
        authorityId: simulationAuthority,
        kind: 'simulation',
        source: authoritySource(simulationAuthority),
        state: 'unavailable',
        name: 'Simulation Works',
        error: 'Simulation source is offline'
      }
    ],
    operations: [
      operation({ operationId: opMine, authorityId: policyAuthority, kind: 'mine', label: 'Mine ore', inputs: [countInput(1)] })
    ]
  });
  const { page, requests, errors } = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA, authorityId: absentAuthority },
    handler: (request) => request.kind === 'page'
      ? { body: pageBody }
      : { status: 404, body: { error: 'unexpected request' } }
  });

  const region = productionRegion(page);
  const text = await waitForRegionText(region, /requested authority[\s\S]{0,80}(unavailable|not advertised|not found|missing)|authority[\s\S]{0,40}(unavailable|not advertised|not found)/i, 'expected the absent requested authority to be explained');
  assert.equal(text.includes('Mine ore'), false, 'Production must not silently substitute another authority');
  assert.ok(text.includes('Simulation source is offline'), 'another authority failure must remain independently visible');

  await setContext(page, { accountId: accountA, vesselId: vesselA, authorityId: policyAuthority });
  await setRevision(page, 1);
  await waitForRegionText(region, 'Mine ore', 'expected the explicitly selected authority operations');
  assert.equal(requestsOfKind(requests, 'page').length, 1, 'the authority selection reuses the retained page read');
  assert.deepEqual(errors, []);
});

test('submits typed operation inputs, validates quantities, and distinguishes output destinations', async (t) => {
  const operations = [
    operation({
      operationId: opMine,
      authorityId: policyAuthority,
      kind: 'mine',
      label: 'Mine ore',
      inputs: [countInput(1)],
      defaults: { count: 1 },
      outputDestination: 'Shared Territory stock'
    }),
    operation({
      operationId: opManufacture,
      authorityId: policyAuthority,
      kind: 'manufacture',
      label: 'Manufacture cloth',
      inputs: [
        choiceInput('recipe', 'Recipe', [{ value: recipeLinen, label: 'Linen cloth' }, { value: recipeCloth, label: 'Heavy cloth' }], recipeLinen),
        countInput(1)
      ],
      defaults: { recipe: recipeLinen, count: 1 },
      outputDestination: 'Shared Territory stock'
    }),
    operation({
      operationId: opTransfer,
      authorityId: policyAuthority,
      kind: 'transfer',
      label: 'Transfer cloth',
      inputs: [
        choiceInput('direction', 'Direction', [{ value: 'to-port', label: 'To port' }, { value: 'to-warehouse', label: 'To warehouse' }], 'to-port'),
        choiceInput('variety', 'Variety', [{ value: varietyFiber, label: 'Fiber' }, { value: varietyHull, label: 'Hull' }], varietyFiber),
        countInput(1)
      ],
      defaults: { direction: 'to-port', variety: varietyFiber, count: 1 },
      outputDestination: 'Shared Territory stock'
    }),
    operation({
      operationId: opLoad,
      authorityId: policyAuthority,
      kind: 'load',
      label: 'Load cargo',
      inputs: [
        choiceInput('variety', 'Variety', [{ value: varietyFiber, label: 'Fiber' }, { value: varietyHull, label: 'Hull' }], varietyFiber),
        countInput(1)
      ],
      defaults: { variety: varietyFiber, count: 1 },
      outputDestination: 'Vessel cargo'
    }),
    operation({
      operationId: opUnload,
      authorityId: policyAuthority,
      kind: 'unload',
      label: 'Unload cargo',
      inputs: [
        choiceInput('variety', 'Variety', [{ value: varietyFiber, label: 'Fiber' }, { value: varietyHull, label: 'Hull' }], varietyFiber),
        countInput(1)
      ],
      defaults: { variety: varietyFiber, count: 1 },
      outputDestination: 'Shared Territory stock'
    })
  ];
  const pageBody = productionPage({
    authorities: [{ authorityId: policyAuthority, kind: 'policy', source: authoritySource(policyAuthority), state: 'available', name: 'Policy Works', observedAt }],
    operations
  });
  const { page, requests, errors } = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA, authorityId: policyAuthority },
    handler: (request) => {
      if (request.kind === 'page') return { body: pageBody };
      if (request.kind === 'execute' && request.operationId !== undefined) {
        return { body: { action: actionRecord({ id: `https://activity.invalid/actions/${encodeURIComponent(request.operationId)}`, intent: { kind: 'production', inputs: { operationId: request.operationId } } }) } };
      }
      return { status: 404, body: { error: 'unexpected request' } };
    }
  });

  const region = productionRegion(page);
  await waitForRegionText(region, 'Mine ore', 'expected operations');

  await selectOperation(page, 'Mine ore');
  await quantityField(page).fill('0');
  await submitButton(page).click();
  await waitForRegionText(region, /positive integer|at least 1|minimum|invalid/i, 'expected a quantity validation message');
  assert.equal(requestsOfKind(requests, 'execute').length, 0, 'an invalid quantity must not be submitted');

  await quantityField(page).fill('9007199254740993');
  await submitButton(page).click();
  await sleep(150);
  assert.equal(requestsOfKind(requests, 'execute').length, 0, 'an unsafe integer must not be rounded and submitted');

  await quantityField(page).fill('2');
  await submitButton(page).click();
  await waitFor(() => requestsOfKind(requests, 'execute').length === 1, 'expected the mine submission');
  let submitted = recent(requests, 'execute');
  assert(submitted, 'expected the mine submission');
  assert.equal(submitted.pathname, `/api/production/operations/${encodeURIComponent(opMine)}/execute`);
  assert.equal(submitted.method, 'POST');
  assert.equal(submitted.headers.authorization, 'Bearer token-a');
  assert.deepEqual(submitted.body, { accountId: accountA, vesselId: vesselA, inputs: { count: 2 } });

  await selectOperation(page, 'Manufacture cloth');
  await page.getByLabel(/recipe/i).selectOption(recipeCloth);
  await quantityField(page).fill('3');
  await submitButton(page).click();
  await waitFor(() => requestsOfKind(requests, 'execute').length === 2, 'expected the manufacture submission');
  submitted = recent(requests, 'execute');
  assert.equal(submitted?.pathname, `/api/production/operations/${encodeURIComponent(opManufacture)}/execute`);
  assert.deepEqual(submitted?.body, { accountId: accountA, vesselId: vesselA, inputs: { recipe: recipeCloth, count: 3 } });

  await selectOperation(page, 'Transfer cloth');
  await page.getByLabel(/direction/i).selectOption('to-warehouse');
  await page.getByLabel(/^variety$/i).selectOption(varietyHull);
  await quantityField(page).fill('4');
  await submitButton(page).click();
  await waitFor(() => requestsOfKind(requests, 'execute').length === 3, 'expected the transfer submission');
  submitted = recent(requests, 'execute');
  assert.equal(submitted?.pathname, `/api/production/operations/${encodeURIComponent(opTransfer)}/execute`);
  assert.deepEqual(submitted?.body, { accountId: accountA, vesselId: vesselA, inputs: { direction: 'to-warehouse', variety: varietyHull, count: 4 } });

  await selectOperation(page, 'Load cargo');
  await page.getByLabel(/^variety$/i).selectOption(varietyFiber);
  await quantityField(page).fill('5');
  const loadText = await waitForRegionText(region, /destination[\s\S]{0,48}vessel cargo/i, 'expected vessel cargo to be a separate output destination');
  assert.match(loadText, /destination[\s\S]{0,48}shared territory stock/i, 'expected the shared stock destination to remain distinct');
  await submitButton(page).click();
  await waitFor(() => requestsOfKind(requests, 'execute').length === 4, 'expected the load submission');
  submitted = recent(requests, 'execute');
  assert.equal(submitted?.pathname, `/api/production/operations/${encodeURIComponent(opLoad)}/execute`);
  assert.deepEqual(submitted?.body, { accountId: accountA, vesselId: vesselA, inputs: { variety: varietyFiber, count: 5 } });

  await selectOperation(page, 'Unload cargo');
  await page.getByLabel(/^variety$/i).selectOption(varietyHull);
  await quantityField(page).fill('6');
  await submitButton(page).click();
  await waitFor(() => requestsOfKind(requests, 'execute').length === 5, 'expected the unload submission');
  submitted = recent(requests, 'execute');
  assert.equal(submitted?.pathname, `/api/production/operations/${encodeURIComponent(opUnload)}/execute`);
  assert.deepEqual(submitted?.body, { accountId: accountA, vesselId: vesselA, inputs: { variety: varietyHull, count: 6 } });

  assert.equal(requestsOfKind(requests, 'page').length, 1, 'operation submissions must not poll the retained page');
  assert.deepEqual(errors, []);
});

test('constrains the Variety picker to exact advertised choices, retains an unmatched native choice, and restores focus', async (t) => {
  const pageBody = productionPage({
    authorities: [{ authorityId: policyAuthority, kind: 'policy', source: authoritySource(policyAuthority), state: 'available', name: 'Policy Works', observedAt }],
    operations: [
      operation({
        operationId: opLoad,
        authorityId: policyAuthority,
        kind: 'load',
        label: 'Load cargo',
        inputs: [
          choiceInput('variety', 'Variety', [{ value: varietyFiber, label: 'Fiber' }, { value: varietyHull, label: 'Hull' }], varietyHull),
          countInput(1)
        ],
        defaults: { variety: varietyHull, count: 1 },
        outputDestination: 'Vessel cargo'
      })
    ]
  });
  const { page, requests, errors } = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA, authorityId: policyAuthority, operationId: opLoad },
    handler: (request) => {
      if (request.kind === 'page') return { body: pageBody };
      if (request.kind === 'library') {
        return libraryPage(accountA, [
          { id: varietyFiber, type: 'Variety', name: 'Fiber' },
          { id: varietyExtra, type: 'Variety', name: 'Extra Fiber' }
        ]);
      }
      if (request.kind === 'resource' && request.resourceId === varietyFiber) {
        return resourcePage(varietyFiber, 'Fiber', accountA);
      }
      return { status: 404, body: { error: 'unexpected request' } };
    }
  });

  const region = productionRegion(page);
  await waitForRegionText(region, 'Load cargo', 'expected the operation');
  await quantityField(page).waitFor({ state: 'visible', timeout: settleTimeout });
  const variety = region.getByLabel(/^variety$/i).first();
  await waitForInputValue(variety, varietyHull, 'expected the advertised default Variety');

  const libraryTrigger = region.getByRole('button', { name: /choose.*variety|browse.*variety|library.*variety|variety.*library/i }).first();
  await libraryTrigger.click();
  const dialog = page.getByRole('dialog', { name: /variety/i }).first();
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });

  await dialog.getByRole('button', { name: /select fiber/i }).first().waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await dialog.getByRole('button', { name: /select extra fiber/i }).count(), 0, 'a Library URI outside the advertised choices must not be offered');
  const search = dialog.getByLabel(/search/i).first();
  await search.fill('Hull');
  await waitForRegionText(dialog, /no candidates match|no retained|no .*match/i, 'expected an explanation when the retained Library has no match');
  assert.equal(await dialog.getByRole('button', { name: /select hull/i }).count(), 0, 'an unmatched advertised choice must not be fabricated from Library data');

  await search.fill('Fiber');
  const inspect = dialog.getByRole('button', { name: /inspect fiber/i }).first();
  await inspect.click();
  await waitFor(() => requestsOfKind(requests, 'resource').length === 1, 'expected candidate inspection through the existing reader');
  const resourceRead = recent(requests, 'resource');
  assert.equal(resourceRead?.pathname, `/api/resources/${encodeURIComponent(varietyFiber)}`);
  assert.equal(resourceRead?.params.accountId, accountA);
  await page.getByRole('button', { name: /^close$/i }).last().click();
  await waitFor(async () => {
    const active = await activeElement(page);
    return /inspect fiber/i.test(`${active.label} ${active.text}`);
  }, 'closing inspection must return focus to its candidate');

  await dialog.getByRole('button', { name: /^cancel$/i }).first().click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  const active = await activeElement(page);
  assert.match(`${active.label} ${active.text}`, /variety/i, 'cancel must return focus to this operation field');

  await libraryTrigger.click();
  const secondDialog = page.getByRole('dialog', { name: /variety/i }).first();
  await secondDialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await secondDialog.getByRole('button', { name: /select fiber/i }).first().click();
  await secondDialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.equal(await variety.inputValue(), varietyFiber, 'the chosen exact advertised URI must reach the field');

  await variety.selectOption(varietyHull);
  assert.equal(await variety.inputValue(), varietyHull, 'an advertised native choice missing from Library must remain selectable');
  assert.equal(requestsOfKind(requests, 'library-refresh').length, 0, 'Library refresh must remain explicit');
  assert.equal(requestsOfKind(requests, 'execute').length, 0, 'opening the picker must not submit the operation');
  assert.deepEqual(errors, []);
});

test('keeps a fixed Simulation Variety and avoids invented inputs absent from descriptors', async (t) => {
  const pageBody = productionPage({
    authorities: [{ authorityId: simulationAuthority, kind: 'simulation', source: authoritySource(simulationAuthority), state: 'available', name: 'Simulation Works', observedAt }],
    operations: [
      operation({
        operationId: opSimulationLoad,
        authorityId: simulationAuthority,
        kind: 'load',
        label: 'Queue load',
        inputs: [
          choiceInput('variety', 'Variety', [{ value: varietyHull, label: 'Hull' }], varietyHull),
          countInput(1),
          { name: 'duration', label: 'Duration', type: 'count', required: true, default: 1, minimum: 1 }
        ],
        defaults: { variety: varietyHull, count: 1, duration: 1 },
        outputDestination: 'Vessel cargo'
      })
    ]
  });
  const { page, requests, errors } = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA, authorityId: simulationAuthority, operationId: opSimulationLoad },
    handler: (request) => {
      if (request.kind === 'page') return { body: pageBody };
      if (request.kind === 'execute') {
        return { body: { action: actionRecord({ id: 'https://activity.invalid/actions/simulation-load' }) } };
      }
      return { status: 404, body: { error: 'unexpected request' } };
    }
  });

  const region = productionRegion(page);
  const text = await waitForRegionText(region, 'Hull', 'expected the fixed Simulation Variety to be visible');
  await quantityField(page).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await page.getByLabel(/^(area|tool|recipe|direction)$/i).count(), 0, 'inputs absent from the descriptors must not be invented');

  await page.getByLabel(/quantity/i).first().fill('2');
  await page.getByLabel(/duration/i).first().fill('3');
  await submitButton(page).click();
  await waitFor(() => requestsOfKind(requests, 'execute').length === 1, 'expected the Simulation submission');
  const submitted = recent(requests, 'execute');
  assert.equal(submitted?.pathname, `/api/production/operations/${encodeURIComponent(opSimulationLoad)}/execute`);
  assert.deepEqual(submitted?.body, { accountId: accountA, vesselId: vesselA, inputs: { variety: varietyHull, count: 2, duration: 3 } });
  assert.match(text, /vessel cargo/i, 'expected the Simulation output destination');
  assert.deepEqual(errors, []);
});

test('separates an accepted submission from a pending outcome and refreshes the action explicitly with evidence', async (t) => {
  const accepted = actionRecord({
    id: actionProduction,
    resultReferences: [{ kind: 'job', id: jobPolicy }],
    intent: { kind: 'mine', inputs: { count: 2 } },
    submission: { status: 'accepted' },
    outcome: { status: 'pending', evidence: [] }
  });
  const completed = actionRecord({
    id: actionProduction,
    resultReferences: [{ kind: 'job', id: jobPolicy }],
    intent: { kind: 'mine', inputs: { count: 2 } },
    submission: { status: 'accepted' },
    outcome: {
      status: 'completed',
      evidence: [{ source: authoritySource(policyAuthority), observedAt: evidenceAt, changes: { sharedStock: 'ore +2' } }]
    }
  });
  const pageBody = productionPage({
    authorities: [{ authorityId: policyAuthority, kind: 'policy', source: authoritySource(policyAuthority), state: 'available', name: 'Policy Works', observedAt }],
    operations: [operation({ operationId: opMine, authorityId: policyAuthority, kind: 'mine', label: 'Mine ore', inputs: [countInput(1)], defaults: { count: 1 } })]
  });
  const { page, requests, errors } = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA, authorityId: policyAuthority },
    handler: (request) => {
      if (request.kind === 'page') return { body: pageBody };
      if (request.kind === 'execute') return { body: { action: accepted } };
      if (request.kind === 'action-refresh') return { body: actionPage(completed) };
      return { status: 404, body: { error: 'unexpected request' } };
    }
  });

  const region = productionRegion(page);
  await selectOperation(page, 'Mine ore');
  await quantityField(page).fill('2');
  await submitButton(page).click();
  await waitForRegionText(region, /submission[\s\S]{0,64}accepted/i, 'expected the accepted submission');
  let text = await region.innerText();
  assert.match(text, statusPattern('outcome', 'pending'), 'acceptance must remain a pending outcome');
  assert.ok(text.includes(jobPolicy), 'expected the exact qualified job result reference');

  await sleep(400);
  assert.equal(requestsOfKind(requests, 'action-refresh').length, 0, 'an accepted submission must not refresh automatically');
  assert.equal(requestsOfKind(requests, 'execute').length, 1, 'an accepted submission must not repeat');

  await region.getByRole('button', { name: /refresh.*(action|result|outcome)|check.*outcome/i }).first().click();
  await waitFor(() => requestsOfKind(requests, 'action-refresh').length === 1, 'expected the explicit action refresh');
  const refreshed = recent(requests, 'action-refresh');
  assert.equal(refreshed?.method, 'POST');
  assert.equal(refreshed?.pathname, `/api/activity/${encodeURIComponent(actionProduction)}/refresh`);
  assert.deepEqual(refreshed?.body, { accountId: accountA });
  assert.equal(refreshed?.headers.authorization, 'Bearer token-a');

  text = await waitForRegionText(region, /outcome[\s\S]{0,64}completed/i, 'expected the evidenced completion');
  assert.match(text, statusPattern('submission', 'accepted'), 'the accepted submission must remain visible');
  assert.ok(text.includes(authoritySource(policyAuthority)), 'expected the evidence source');
  assert.ok(text.includes(evidenceAt), 'expected the evidence observation time');
  assert.ok(text.includes('ore +2'), 'expected the evidence changes');
  await sleep(400);
  assert.equal(requestsOfKind(requests, 'execute').length, 1, 'refreshing the action must not resend the operation');
  assert.deepEqual(errors, []);
});

test('keeps a failed action readback distinct from acceptance and never replays the send', async (t) => {
  const accepted = actionRecord({
    id: actionProduction,
    resultReferences: [{ kind: 'job', id: jobPolicy }],
    intent: { kind: 'mine', inputs: { count: 2 } },
    submission: { status: 'accepted' },
    outcome: { status: 'pending', evidence: [] }
  });
  const pageBody = productionPage({
    authorities: [{ authorityId: policyAuthority, kind: 'policy', source: authoritySource(policyAuthority), state: 'available', name: 'Policy Works', observedAt }],
    operations: [operation({ operationId: opMine, authorityId: policyAuthority, kind: 'mine', label: 'Mine ore', inputs: [countInput(1)], defaults: { count: 1 } })]
  });
  const { page, requests, errors } = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA, authorityId: policyAuthority },
    handler: (request) => {
      if (request.kind === 'page') return { body: pageBody };
      if (request.kind === 'execute') return { body: { action: accepted } };
      if (request.kind === 'action-refresh') return { status: 503, body: { error: 'Outcome readback is unavailable' } };
      return { status: 404, body: { error: 'unexpected request' } };
    }
  });

  const region = productionRegion(page);
  await selectOperation(page, 'Mine ore');
  await quantityField(page).fill('2');
  await submitButton(page).click();
  await waitForRegionText(region, /submission[\s\S]{0,64}accepted/i, 'expected the accepted submission');

  await region.getByRole('button', { name: /refresh.*(action|result|outcome)|check.*outcome/i }).first().click();
  await waitFor(() => requestsOfKind(requests, 'action-refresh').length === 1, 'expected the explicit action refresh');
  const text = await waitForRegionText(region, /readback[\s\S]{0,80}(fail|unavailable)|refresh[\s\S]{0,80}(fail|unavailable)|could not[\s\S]{0,40}(read|refresh)/i, 'expected a distinct readback failure');
  assert.match(text, statusPattern('submission', 'accepted'), 'the accepted submission must be retained');
  assert.doesNotMatch(text, statusPattern('outcome', 'completed'), 'a failed readback must not report completion');
  assert.ok(text.includes(jobPolicy), 'the result reference must be retained');

  await sleep(400);
  assert.equal(requestsOfKind(requests, 'execute').length, 1, 'a failed readback must not replay the operation');
  assert.equal(requestsOfKind(requests, 'action-refresh').length, 1, 'failed readback must not retry automatically');
  assert.deepEqual(errors, []);
});

test('keeps qualified jobs from two authorities distinct and refreshes remaining time without advancing the world', async (t) => {
  const jobs = [
    jobRecord({
      jobId: jobPolicy,
      authorityId: policyAuthority,
      operation: 'mine',
      status: 'pending',
      remainingTicks: 5,
      tick: 10,
      count: 2
    }),
    jobRecord({
      jobId: jobSimulation,
      authorityId: simulationAuthority,
      operation: 'load',
      status: 'progress',
      remainingTicks: 8,
      tick: 10,
      count: 3
    }),
    jobRecord({
      jobId: jobUnevidenced,
      authorityId: policyAuthority,
      operation: 'manufacture',
      status: 'completed',
      count: 1,
      evidence: []
    })
  ];
  const pageBody = productionPage({
    authorities: [
      { authorityId: policyAuthority, kind: 'policy', source: authoritySource(policyAuthority), state: 'available', name: 'Policy Works', observedAt },
      { authorityId: simulationAuthority, kind: 'simulation', source: authoritySource(simulationAuthority), state: 'available', name: 'Simulation Works', observedAt }
    ],
    operations: [],
    jobs
  });
  const refreshedPolicyJob = jobRecord({
    jobId: jobPolicy,
    authorityId: policyAuthority,
    operation: 'mine',
    status: 'pending',
    remainingTicks: 3,
    tick: 10,
    count: 2
  });
  const { page, requests, errors } = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA, authorityId: policyAuthority },
    handler: (request) => {
      if (request.kind === 'page') return { body: pageBody };
      if (request.kind === 'job' && request.jobId === jobPolicy) {
        return { body: { context: { accountId: accountA, vesselId: vesselA }, data: { job: jobs[0] }, observations: {}, actions: [] } };
      }
      if (request.kind === 'job' && request.jobId === jobMissing) {
        return { status: 404, body: { error: 'Job is not retained for this target' } };
      }
      if (request.kind === 'job-refresh' && request.jobId === jobPolicy) {
        return { body: { context: { accountId: accountA, vesselId: vesselA }, data: { job: refreshedPolicyJob }, observations: {}, actions: [] } };
      }
      return { status: 404, body: { error: 'unexpected request' } };
    }
  });

  const region = productionRegion(page);
  const text = await waitForRegionText(region, jobPolicy, 'expected the retained pending job list');
  assert.ok(text.includes(jobSimulation), 'expected the same-numeric job at the other authority');
  assert.ok(text.includes(policyAuthority), 'expected the policy job authority');
  assert.ok(text.includes(simulationAuthority), 'expected the simulation job authority');
  assert.match(text, /mine/i, 'expected the job operation');
  assert.match(text, /load/i, 'expected the second job operation');
  assert.match(text, /remaining[\s\S]{0,24}5/i, 'expected the first remaining time');
  assert.match(text, /remaining[\s\S]{0,24}8/i, 'expected the second remaining time');
  assert.match(text, /tick[\s\S]{0,24}10/i, 'expected the observed tick');
  assert.match(text, /pending/i, 'expected the pending status');
  const unevidencedItem = recordItem(region, jobUnevidenced);
  const unevidencedText = await unevidencedItem.innerText();
  assert.match(unevidencedText, /unverified|not verified|without evidence/i, 'completed without evidence must not be presented as verified');
  await sleep(400);
  assert.equal(requestsOfKind(requests, 'job').length, 0, 'retained jobs must not be read automatically');
  assert.equal(requestsOfKind(requests, 'job-refresh').length, 0, 'retained jobs must not refresh automatically');

  const policyItem = recordItem(region, jobPolicy);
  await policyItem.getByRole('button').first().click();
  await waitFor(() => requestsOfKind(requests, 'job').length === 1, 'expected the selected job read');
  const jobRead = recent(requests, 'job');
  assert.equal(jobRead?.method, 'GET');
  assert.equal(jobRead?.pathname, `/api/production/jobs/${encodeURIComponent(jobPolicy)}`);
  assert.equal(jobRead?.params.accountId, accountA);
  assert.equal(jobRead?.params.vesselId, vesselA);
  assert.equal(jobRead?.headers.authorization, 'Bearer token-a');
  await waitForRegionText(region, /remaining[\s\S]{0,24}5/i, 'expected the exact selected job detail');

  await region.getByRole('button', { name: /refresh.*(selected )?job/i }).first().click();
  await waitFor(() => requestsOfKind(requests, 'job-refresh').length === 1, 'expected the explicit job refresh');
  const jobRefresh = recent(requests, 'job-refresh');
  assert.equal(jobRefresh?.method, 'POST');
  assert.equal(jobRefresh?.pathname, `/api/production/jobs/${encodeURIComponent(jobPolicy)}/refresh`);
  assert.deepEqual(jobRefresh?.body, { accountId: accountA, vesselId: vesselA });
  await waitForRegionText(region, /remaining[\s\S]{0,24}3/i, 'expected the refreshed remaining time');
  assert.equal(requestsOfKind(requests, 'refresh').length, 0, 'job refresh must not refresh every production source');
  assert.equal(requestsOfKind(requests, 'execute').length, 0, 'job refresh must not submit an operation');
  assert.equal(requests.some((request) => request.pathname.includes('/local/tick')), false, 'job refresh must never advance simulation time');

  await setContext(page, { accountId: accountA, vesselId: vesselA, authorityId: policyAuthority, jobId: jobMissing });
  await setRevision(page, 1);
  await waitFor(() => requestsOfKind(requests, 'job').some((request) => request.jobId === jobMissing), 'expected the missing job read');
  const missingText = await waitForRegionText(region, /missing[\s\S]{0,80}(unavailable|not found|not retained)|(?:unavailable|not found|not retained)[\s\S]{0,80}missing/i, 'expected a missing job explanation');
  assert.doesNotMatch(missingText, new RegExp(`${escapeRegExp(jobMissing)}[\\s\\S]{0,64}completed`, 'i'), 'a missing job must not be reported as complete');
  assert.deepEqual(errors, []);
});

test('uses exact Activity and resource callbacks, with the retained local reader as the fallback', async (t) => {
  const accepted = actionRecord({
    id: actionProduction,
    resultReferences: [
      { kind: 'resource', id: resourceResult },
      { kind: 'job', id: jobPolicy },
      { kind: 'request', id: 'https://requests.invalid/production/1' }
    ],
    intent: { kind: 'mine', inputs: { count: 2 } },
    submission: { status: 'accepted' },
    outcome: { status: 'pending', evidence: [] }
  });
  const pageBody = productionPage({
    authorities: [{ authorityId: policyAuthority, kind: 'policy', source: authoritySource(policyAuthority), state: 'available', name: 'Policy Works', observedAt }],
    operations: [operation({ operationId: opMine, authorityId: policyAuthority, kind: 'mine', label: 'Mine ore', inputs: [countInput(1)], defaults: { count: 1 } })]
  });
  const handler: Handler = (request) => {
    if (request.kind === 'page') return { body: pageBody };
    if (request.kind === 'execute') return { body: { action: accepted } };
    if (request.kind === 'resource' && request.resourceId === resourceResult) return resourcePage(resourceResult, 'Produce ledger', accountA, policyAuthority);
    return { status: 404, body: { error: 'unexpected request' } };
  };

  const callbackFixture = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA, authorityId: policyAuthority },
    handler
  });
  const callbackRegion = productionRegion(callbackFixture.page);
  await selectOperation(callbackFixture.page, 'Mine ore');
  await quantityField(callbackFixture.page).fill('2');
  await submitButton(callbackFixture.page).click();
  await waitForRegionText(callbackRegion, /submission[\s\S]{0,64}accepted/i, 'expected the accepted submission');

  await callbackRegion.getByRole('button', { name: /open activity/i }).first().click();
  await callbackRegion.getByRole('button', { name: /read resource/i }).first().click();
  const callbacks = await callbackSnapshot(callbackFixture.page);
  assert.deepEqual(callbacks.actions, [actionProduction], 'Open Activity must receive the exact action ID');
  assert.deepEqual(callbacks.resources, [{ id: resourceResult, authorityId: policyAuthority }], 'Read resource must receive the exact result reference');
  assert.equal(requestsOfKind(callbackFixture.requests, 'resource').length, 0, 'a supplied reader callback must own the read');
  assert.equal(callbackFixture.requests.some((request) => request.pathname.startsWith('/api/activity')), false, 'Opening Activity must not create another action history');

  const localFixture = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA, authorityId: policyAuthority },
    handler,
    callbacks: false
  });
  const localRegion = productionRegion(localFixture.page);
  await selectOperation(localFixture.page, 'Mine ore');
  await quantityField(localFixture.page).fill('2');
  await submitButton(localFixture.page).click();
  await waitForRegionText(localRegion, /submission[\s\S]{0,64}accepted/i, 'expected the accepted submission');
  await localRegion.getByRole('button', { name: /read resource/i }).first().click();
  await waitFor(() => requestsOfKind(localFixture.requests, 'resource').length === 1, 'expected the local reader to read the result resource');
  const localRead = recent(localFixture.requests, 'resource');
  assert.equal(localRead?.pathname, `/api/resources/${encodeURIComponent(resourceResult)}`);
  assert.equal(localRead?.params.accountId, accountA);
  assert.equal(localRead?.params.authorityId, policyAuthority);
  await localFixture.page.getByText('Produce ledger', { exact: true }).first().waitFor({ state: 'visible', timeout: settleTimeout });
  await localFixture.page.getByRole('button', { name: /^close$/i }).last().click();
  const localCallbacks = await callbackSnapshot(localFixture.page);
  assert.deepEqual(localCallbacks, { actions: [], resources: [] });
  assert.deepEqual(callbackFixture.errors, []);
  assert.deepEqual(localFixture.errors, []);
});

test('reapplies a repeated operation handoff after manual changes and resets form state across account A to B to A', async (t) => {
  const pageFor = (accountId: string, defaultCount: number): ProductionPage => productionPage({
    accountId,
    vesselId: vesselA,
    authorities: [{ authorityId: policyAuthority, kind: 'policy', source: authoritySource(policyAuthority), state: 'available', name: 'Policy Works', observedAt }],
    operations: [
      operation({ operationId: opMine, authorityId: policyAuthority, kind: 'mine', label: 'Mine ore', inputs: [countInput(defaultCount)], defaults: { count: defaultCount } }),
      operation({ operationId: opManufacture, authorityId: policyAuthority, kind: 'manufacture', label: 'Manufacture cloth', inputs: [countInput(1)], defaults: { count: 1 } })
    ]
  });
  const { page, requests, errors } = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA, authorityId: policyAuthority, operationId: opMine },
    handler: (request) => {
      if (request.kind !== 'page') return { status: 404, body: { error: 'unexpected request' } };
      return { body: pageFor(request.params.accountId ?? accountA, (request.params.accountId ?? accountA) === accountA ? 1 : 3) };
    }
  });

  const region = productionRegion(page);
  await waitForRegionText(region, 'Mine ore', 'expected the context operation');
  await waitForInputValue(quantityField(page), '1', 'expected the initial operation default');
  await quantityField(page).fill('9');

  await selectOperation(page, 'Manufacture cloth');
  await submitButton(page).waitFor({ state: 'visible', timeout: settleTimeout });
  await waitFor(async () => /manufacture cloth/i.test(await submitButton(page).innerText()), 'expected the manual operation selection');

  await setRevision(page, 1);
  await waitFor(async () => /mine ore/i.test(await submitButton(page).innerText()), 'a repeated handoff must reselect the contextual operation');
  await waitForInputValue(quantityField(page), '1', 'the contextual operation must reset to its own defaults');

  await setAccount(page, accountB);
  await setContext(page, { accountId: accountB, vesselId: vesselA, authorityId: policyAuthority, operationId: opMine });
  await setRevision(page, 2);
  await waitFor(() => requestsOfKind(requests, 'page').length === 2, 'expected the second account production read');
  const second = requestsOfKind(requests, 'page')[1];
  assert.equal(second?.params.accountId, accountB, 'the second read must use the exact context account');
  await waitForInputValue(quantityField(page), '3', 'the second account operation must use its own defaults');

  await setAccount(page, accountA);
  await setContext(page, { accountId: accountA, vesselId: vesselA, authorityId: policyAuthority, operationId: opMine });
  await setRevision(page, 3);
  await waitFor(() => requestsOfKind(requests, 'page').length === 3, 'expected the returning account production read');
  const third = requestsOfKind(requests, 'page')[2];
  assert.equal(third?.params.accountId, accountA, 'the returning read must use the exact original account');
  await waitForInputValue(quantityField(page), '1', 'returning to the account must not inherit the earlier edit');
  assert.deepEqual(errors, []);
});

test('late production reads and refreshes cannot overwrite a changed target, and late results are ignored after unmount', async (t) => {
  const marker = (label: string, accountId = accountA): ProductionPage => productionPage({
    accountId,
    authorities: [{ authorityId: policyAuthority, kind: 'policy', source: authoritySource(policyAuthority), state: 'available', name: 'Policy Works', observedAt }],
    operations: [operation({ operationId: opMine, authorityId: policyAuthority, kind: 'mine', label, inputs: [countInput(1)], defaults: { count: 1 } })]
  });
  const lateA = deferred<ServerResponse>();
  const lateRefreshB = deferred<ServerResponse>();
  const lateB = deferred<ServerResponse>();
  let aCalls = 0;
  let bCalls = 0;
  const { page, requests, errors } = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA, authorityId: policyAuthority, operationId: opMine },
    handler: (request) => {
      if (request.kind === 'page' && request.params.accountId === accountA) {
        aCalls += 1;
        if (aCalls === 1) return lateA.promise;
        return { body: marker(aCalls === 2 ? 'A production re-read' : 'A production remount') };
      }
      if (request.kind === 'page' && request.params.accountId === accountB) {
        bCalls += 1;
        if (bCalls === 1) return { body: marker('B production', accountB) };
        if (bCalls === 2) return lateB.promise;
        return { body: marker('B production remount', accountB) };
      }
      if (request.kind === 'refresh') return lateRefreshB.promise;
      return { status: 404, body: { error: 'unexpected request' } };
    }
  });

  const region = productionRegion(page);
  await waitFor(() => requestsOfKind(requests, 'page').length === 1, 'expected the first production read');
  await setAccount(page, accountB);
  await setContext(page, { accountId: accountB, vesselId: vesselA, authorityId: policyAuthority, operationId: opMine });
  await setRevision(page, 1);
  await waitForRegionText(region, 'B production', 'expected the changed target to render');

  lateA.resolve({ body: marker('A late production') });
  await sleep(250);
  let text = await region.innerText();
  assert.ok(text.includes('B production'), 'a late read for the old target must not replace the current target');
  assert.equal(text.includes('A late production'), false, 'the old target response must be suppressed');

  await region.getByRole('button', { name: /^refresh( production)?$/i }).first().click();
  await waitFor(() => requestsOfKind(requests, 'refresh').length === 1, 'expected an explicit Production refresh');
  const refresh = recent(requests, 'refresh');
  assert.equal(refresh?.method, 'POST');
  assert.deepEqual(refresh?.body, { accountId: accountB, vesselId: vesselA });

  await setAccount(page, accountA);
  await setContext(page, { accountId: accountA, vesselId: vesselA, authorityId: policyAuthority, operationId: opMine });
  await setRevision(page, 2);
  await waitForRegionText(region, 'A production re-read', 'expected the new target read');
  lateRefreshB.resolve({ body: marker('B late refresh', accountB) });
  await sleep(250);
  text = await region.innerText();
  assert.ok(text.includes('A production re-read'), 'a late refresh for the old target must not replace the current target');
  assert.equal(text.includes('B late refresh'), false, 'the old refresh response must be suppressed');

  await setAccount(page, accountB);
  await setContext(page, { accountId: accountB, vesselId: vesselA, authorityId: policyAuthority, operationId: opMine });
  await setRevision(page, 3);
  await waitFor(() => bCalls === 2, 'expected the pending production read');
  await unmount(page);
  await page.getByText('Production unmounted', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  lateB.resolve({ body: marker('B late unmounted production', accountB) });
  await sleep(250);
  assert.equal(await page.getByText('B late unmounted production', { exact: true }).count(), 0, 'an unmounted Production must ignore late data');

  await remount(page);
  await waitForRegionText(region, 'B production remount', 'expected a fresh read after remount');
  assert.deepEqual(errors, []);
});

test('ignores a late execute result after the account and vessel target changes', async (t) => {
  const pageFor = (accountId: string, label: string): ProductionPage => productionPage({
    accountId,
    vesselId: accountId === accountB ? vesselB : vesselA,
    authorities: [{ authorityId: policyAuthority, kind: 'policy', source: authoritySource(policyAuthority), state: 'available', name: 'Policy Works', observedAt }],
    operations: [operation({ operationId: opMine, authorityId: policyAuthority, kind: 'mine', label, inputs: [countInput(1)], defaults: { count: 1 } })]
  });
  const lateExecute = deferred<ServerResponse>();
  const { page, requests, errors } = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA, authorityId: policyAuthority, operationId: opMine },
    handler: (request) => {
      if (request.kind === 'page' && request.params.accountId === accountA) return { body: pageFor(accountA, 'A production') };
      if (request.kind === 'page' && request.params.accountId === accountB) return { body: pageFor(accountB, 'B production') };
      if (request.kind === 'execute') return lateExecute.promise;
      return { status: 404, body: { error: 'unexpected request' } };
    }
  });

  const region = productionRegion(page);
  await waitForRegionText(region, 'A production', 'expected the original target');
  await quantityField(page).fill('2');
  await submitButton(page).click();
  await waitFor(() => requestsOfKind(requests, 'execute').length === 1, 'expected the pending submission');

  await setAccount(page, accountB);
  await setContext(page, { accountId: accountB, vesselId: vesselB, authorityId: policyAuthority, operationId: opMine });
  await setRevision(page, 1);
  await waitForRegionText(region, 'B production', 'expected the changed target');
  assert.equal(recent(requests, 'page')?.params.vesselId, vesselB, 'the new read must use the changed vessel');

  const lateAction = actionRecord({
    id: 'https://activity.invalid/actions/late-target',
    accountId: accountA,
    targetId: policyAuthority,
    resultReferences: [{ kind: 'job', id: jobPolicy }],
    intent: { kind: 'mine', inputs: { count: 2 } },
    submission: { status: 'accepted' },
    outcome: { status: 'pending', evidence: [] }
  });
  lateExecute.resolve({ body: { action: lateAction } });
  await sleep(250);
  const text = await region.innerText();
  assert.equal(text.includes(lateAction.id), false, 'a late submission result for the old target must not appear');
  assert.equal(text.includes(jobPolicy), false, 'a late result reference for the old target must not appear');
  assert.doesNotMatch(text, /submission[\s\S]{0,64}accepted/i, 'a late acceptance must not be claimed for the new target');
  assert.equal(requestsOfKind(requests, 'execute').length, 1, 'changing target must not resend the operation');
  assert.deepEqual(errors, []);
});

test('late execution cannot replace a later operation selection or release its send lock', async (t) => {
  const first = deferred<ServerResponse>();
  const second = deferred<ServerResponse>();
  const pageBody = productionPage({ operations: [
    operation({ operationId: opMine, authorityId: policyAuthority, kind: 'mine', label: 'Mine ore', inputs: [countInput()] }),
    operation({ operationId: opLoad, authorityId: policyAuthority, kind: 'load', label: 'Load cargo', inputs: [countInput()] })
  ] });
  let sends = 0;
  const { page, requests, errors } = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA },
    handler: (request) => {
      if (request.kind === 'page') return { body: pageBody };
      if (request.kind === 'execute') return ++sends === 1 ? first.promise : second.promise;
      return { status: 404 };
    }
  });
  await selectOperation(page, 'Mine ore');
  await submitButton(page).click();
  await waitFor(() => sends === 1, 'expected first send');
  await selectOperation(page, 'Load cargo');
  await selectOperation(page, 'Mine ore');
  await submitButton(page).click();
  await waitFor(() => sends === 2, 'expected later send after explicit reselection');
  const obsoleteId = 'https://activity.invalid/actions/obsolete-selection';
  first.resolve({ body: { action: actionRecord({ id: obsoleteId }) } });
  await sleep(200);
  assert.equal((await productionRegion(page).innerText()).includes(obsoleteId), false, 'returning to the same operation must not revive an old send result');
  assert.equal(await submitButton(page).getAttribute('data-pending'), 'true', 'old completion must not release the newer send lock');
  second.resolve({ body: { action: actionRecord({ id: actionProduction }) } });
  await waitForRegionText(productionRegion(page), actionProduction, 'expected current send result');
  assert.equal(requestsOfKind(requests, 'execute').length, 2);
  assert.deepEqual(errors, []);
});

test('old action reconciliation cannot replace the action from a later submission', async (t) => {
  const check = deferred<ServerResponse>();
  let sends = 0;
  const newerId = 'https://activity.invalid/actions/newer-submission';
  const { page, requests, errors } = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA },
    handler: (request) => {
      if (request.kind === 'page') return { body: productionPage({ operations: [operation({ operationId: opMine, authorityId: policyAuthority, kind: 'mine', label: 'Mine ore', inputs: [countInput()] })] }) };
      if (request.kind === 'execute') return { body: { action: actionRecord({ id: ++sends === 1 ? actionProduction : newerId }) } };
      if (request.kind === 'action-refresh') return check.promise;
      return { status: 404 };
    }
  });
  const region = productionRegion(page);
  await selectOperation(page, 'Mine ore');
  await submitButton(page).click();
  await waitForRegionText(region, actionProduction, 'expected original action');
  await region.getByRole('button', { name: 'Refresh action', exact: true }).click();
  await waitFor(() => requestsOfKind(requests, 'action-refresh').length === 1, 'expected pending check');
  await submitButton(page).click();
  await waitForRegionText(region, newerId, 'expected later explicit submission');
  check.resolve({ body: actionPage(actionRecord({ id: actionProduction, outcome: { status: 'completed', evidence: [{ source: policyAuthority, observedAt: evidenceAt }] } })) });
  await sleep(200);
  const text = await region.innerText();
  assert.ok(text.includes(newerId), 'late check must retain the current action');
  assert.equal(text.includes(actionProduction), false, 'late check must not restore the old action');
  assert.equal(requestsOfKind(requests, 'execute').length, 2);
  assert.deepEqual(errors, []);
});

test('a newer production observation is not masked by an older selected job detail', async (t) => {
  const oldJob = jobRecord({ jobId: jobPolicy, authorityId: policyAuthority, operation: 'mine', status: 'pending', remainingTicks: 5 });
  const freshJob = { ...oldJob, observedAt: laterAt, progress: { remainingTicks: 1 } };
  const { page, errors } = await openFixture(t, {
    context: { accountId: accountA, vesselId: vesselA },
    handler: (request) => {
      if (request.kind === 'page') return { body: productionPage({ jobs: [oldJob] }) };
      if (request.kind === 'job') return { body: { data: { job: oldJob }, observations: {}, actions: [] } };
      if (request.kind === 'refresh') return { body: productionPage({ jobs: [freshJob] }) };
      return { status: 404 };
    }
  });
  const region = productionRegion(page);
  await region.getByRole('button', { name: `Select job ${jobPolicy}`, exact: true }).click();
  const selected = region.getByRole('region', { name: 'Selected job', exact: true });
  await waitForRegionText(selected, 'Remaining ticks: 5', 'expected retained detail');
  await region.getByRole('button', { name: 'Refresh production', exact: true }).click();
  await waitForRegionText(selected, 'Remaining ticks: 1', 'expected newer page observation in selected job');
  assert.equal((await region.getByRole('region', { name: 'Production jobs', exact: true }).innerText()).includes('Remaining ticks: 5'), false, 'old detail must not mask refreshed list data');
  assert.deepEqual(errors, []);
});
