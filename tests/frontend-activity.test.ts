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
const submittedAt = '2026-04-01T01:02:03.000Z';
const evidenceAt = '2026-04-02T02:03:04.000Z';
const observationAt = '2026-04-03T03:04:05.000Z';
const defaultActionId = 'https://activity.invalid/actions/default';
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

const fixtureSource = String.raw`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Activity } from './apps/frontend/src/activity.tsx';

const params = new URLSearchParams(window.location.search);
const accountParam = params.get('account');
const initialAccount = accountParam === 'none' ? undefined : (accountParam ?? 'account-a');
const initialAction = params.get('action') ?? undefined;
const withCallbacks = params.get('callbacks') !== '0';
const fixture = { controls: null, reads: [], contexts: [] };
window.__activityFixture = fixture;

const onReadResource = (reference) => { fixture.reads.push(reference); };
const onOpenContext = (context) => { fixture.contexts.push(context); };

function App() {
  const [accountId, setAccountIdState] = React.useState(initialAccount);
  const [actionId, setActionIdState] = React.useState(initialAction);
  const [mounted, setMounted] = React.useState(true);
  React.useEffect(() => {
    fixture.controls = {
      setAccountId(value) { setAccountIdState(value); },
      setActionId(value) { setActionIdState(value === null ? undefined : value); },
      unmount() { setMounted(false); },
      remount() { setMounted(true); }
    };
  }, []);
  const props = {
    ...(accountId === undefined ? {} : { accountId }),
    ...(actionId === undefined ? {} : { actionId }),
    ...(withCallbacks ? { onReadResource, onOpenContext } : {})
  };
  return React.createElement(
    'main',
    null,
    mounted ? React.createElement(Activity, props) : React.createElement('p', null, 'Activity unmounted')
  );
}

createRoot(document.getElementById('root')).render(React.createElement(App));
`;

interface ActionEvidence {
  source: string;
  observedAt: string;
  changes?: Record<string, unknown>;
}

interface ActionReference {
  kind: 'request' | 'resource' | 'job' | 'event';
  id: string;
}

interface JourneyStep {
  routeId: string;
  from: string;
  to: string;
  territoryId: string;
  kind?: string;
  status: string;
  requestId?: string;
  eventId?: string;
  error?: string;
  observedAt?: string;
}

interface JourneyProgress {
  routePlanId: string;
  vesselId: string;
  status: string;
  legs: JourneyStep[];
  updatedAt: string;
  error?: string;
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
  journey?: JourneyProgress;
}

interface ActionOptions {
  id?: string;
  accountId?: string;
  targetId?: string;
  statusUrl?: string;
  resultReferences?: ActionReference[];
  intent?: { kind: string; inputs: Record<string, unknown> };
  submittedAt?: string;
  submission?: Partial<ActionRecord['submission']>;
  outcome?: Partial<ActionRecord['outcome']>;
  journey?: JourneyProgress;
}

interface Observation {
  state: string;
  source: string;
  observedAt?: string;
  value?: unknown;
  error?: string;
}

interface ActivityPage {
  context: { accountId?: string };
  data: unknown;
  observations: Record<string, Observation>;
  actions: unknown[];
}

type Outcome =
  | { kind: 'page'; page: ActivityPage }
  | { kind: 'failure'; status?: number; error: string }
  | { kind: 'abort' };

interface ActivityRequest {
  kind: 'list' | 'detail' | 'refresh';
  method: string;
  pathname: string;
  actionId?: string;
  accountId?: string;
  body?: unknown;
  headers: Record<string, string>;
}

type Handler = (request: ActivityRequest) => Outcome | Promise<Outcome>;

interface FixtureConfig {
  handler: Handler;
  accountId?: string | null;
  actionId?: string;
  callbacks?: boolean;
}

interface OpenedFixture {
  page: Page;
  requests: ActivityRequest[];
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

function makeAction(options: ActionOptions = {}): ActionRecord {
  const id = options.id ?? defaultActionId;
  const journey = options.journey;
  return {
    id,
    statusUrl: options.statusUrl ?? `https://world.invalid/status/${encodeURIComponent(id)}`,
    accountId: options.accountId ?? accountA,
    targetId: options.targetId ?? 'https://places.invalid/ports/alpha',
    resultReferences: options.resultReferences ?? [],
    intent: options.intent ?? { kind: 'entry-request', inputs: {} },
    submittedAt: options.submittedAt ?? submittedAt,
    submission: { status: 'accepted', ...(options.submission ?? {}) } as ActionRecord['submission'],
    outcome: { status: 'pending', evidence: [], ...(options.outcome ?? {}) } as ActionRecord['outcome'],
    ...(journey === undefined ? {} : { journey })
  };
}

function listPage(actions: ActionRecord[], accountId = accountA): ActivityPage {
  return { context: { accountId }, data: { actions }, observations: {}, actions: [] };
}

function detailPage(action: ActionRecord, observations: Record<string, Observation> = {}): ActivityPage {
  return { context: { accountId: action.accountId }, data: { action }, observations, actions: [] };
}

let browser: Browser | undefined;
let bundle: string | undefined;

before(async () => {
  const result = await build({
    stdin: {
      contents: fixtureSource,
      resolveDir: projectRoot,
      sourcefile: 'frontend-activity-fixture.js',
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
  await context.addInitScript(() => {
    localStorage.setItem('fctp.client-sessions', JSON.stringify([
      { accountId: 'account-a', handle: '@alpha.home@alpha.test:4200', clientToken: 'token-a' },
      { accountId: 'account-b', handle: '@beta.home@beta.test:4200', clientToken: 'token-b' }
    ]));
  });

  const page = await context.newPage();
  const requests: ActivityRequest[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });

  await page.route(`${fixtureOrigin}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/bundle.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: activeBundle });
      return;
    }

    const isList = url.pathname === '/api/activity';
    const refreshMatch = /^\/api\/activity\/([^/]+)\/refresh$/.exec(url.pathname);
    const detailMatch = /^\/api\/activity\/([^/]+)$/.exec(url.pathname);
    if (!isList && refreshMatch === null && detailMatch === null) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }

    const bodyText = request.postData();
    const parsedBody: unknown = bodyText ? JSON.parse(bodyText) as unknown : undefined;
    const body = typeof parsedBody === 'object' && parsedBody !== null ? parsedBody as Record<string, unknown> : undefined;
    const kind: ActivityRequest['kind'] = isList ? 'list' : refreshMatch !== null ? 'refresh' : 'detail';
    const actionId = kind === 'list' ? undefined : decodeURIComponent((kind === 'refresh' ? refreshMatch : detailMatch)![1]!);
    const accountId = kind === 'refresh'
      ? (typeof body?.accountId === 'string' ? body.accountId : undefined)
      : (url.searchParams.get('accountId') ?? undefined);
    const recorded: ActivityRequest = {
      kind,
      method: request.method(),
      pathname: url.pathname,
      ...(actionId === undefined ? {} : { actionId }),
      ...(accountId === undefined ? {} : { accountId }),
      ...(parsedBody === undefined ? {} : { body: parsedBody }),
      headers: request.headers()
    };
    requests.push(recorded);

    const outcome = await config.handler(recorded);
    if (outcome.kind === 'abort') {
      await route.abort('failed');
      return;
    }
    if (outcome.kind === 'failure') {
      await route.fulfill({
        status: outcome.status ?? 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: outcome.error })
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(outcome.page) });
  });

  const params = new URLSearchParams();
  params.set('account', config.accountId === null ? 'none' : config.accountId ?? accountA);
  if (config.actionId !== undefined) params.set('action', config.actionId);
  if (config.callbacks === false) params.set('callbacks', '0');
  await page.goto(`${fixtureOrigin}?${params.toString()}`);
  await page.waitForFunction(() => {
    const fixture = (window as unknown as { __activityFixture?: { controls?: unknown } }).__activityFixture;
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

async function waitForRegionText(scope: Locator, expected: string | RegExp, message: string): Promise<string> {
  let last = '';
  try {
    await waitFor(async () => {
      last = await scope.innerText();
      return typeof expected === 'string' ? last.includes(expected) : expected.test(last);
    }, message);
  } catch (error) {
    throw new Error(`${message}; last region text was ${JSON.stringify(last)}`, { cause: error });
  }
  return last;
}

async function waitForRegion(page: Page, name: string | RegExp, message: string): Promise<Locator> {
  const region = page.getByRole('region', { name });
  try {
    await region.first().waitFor({ state: 'visible', timeout: settleTimeout });
  } catch (error) {
    throw new Error(message, { cause: error });
  }
  return region.first();
}

async function waitForButton(scope: Locator, name: string | RegExp, message: string): Promise<Locator> {
  const button = scope.getByRole('button', { name });
  try {
    await button.first().waitFor({ state: 'visible', timeout: settleTimeout });
  } catch (error) {
    let text = '';
    try { text = await scope.innerText(); } catch (inner) { text = `<unavailable: ${String(inner)}>`; }
    throw new Error(`${message}; scope text was ${JSON.stringify(text)}`, { cause: error });
  }
  return button.first();
}

async function expandAllDetails(scope: Locator): Promise<void> {
  const details = scope.locator('details');
  const count = await details.count();
  for (let index = 0; index < count; index += 1) {
    const item = details.nth(index);
    const open = await item.evaluate((element) => (element as HTMLDetailsElement).open);
    if (!open) await item.locator('summary').first().click();
  }
}

async function setAccount(page: Page, accountId: string): Promise<void> {
  await page.evaluate((id) => {
    const fixture = (window as unknown as { __activityFixture: { controls: { setAccountId(value: string): void } } }).__activityFixture;
    fixture.controls.setAccountId(id);
  }, accountId);
}

async function setAction(page: Page, actionId: string | undefined): Promise<void> {
  await page.evaluate((id) => {
    const fixture = (window as unknown as { __activityFixture: { controls: { setActionId(value: string | null): void } } }).__activityFixture;
    fixture.controls.setActionId(id);
  }, actionId ?? null);
}

async function unmountActivity(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fixture = (window as unknown as { __activityFixture: { controls: { unmount(): void } } }).__activityFixture;
    fixture.controls.unmount();
  });
}

async function remountActivity(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fixture = (window as unknown as { __activityFixture: { controls: { remount(): void } } }).__activityFixture;
    fixture.controls.remount();
  });
}

async function recoveryCalls(page: Page): Promise<{ reads: unknown[]; contexts: unknown[] }> {
  return page.evaluate(() => {
    const fixture = (window as unknown as { __activityFixture: { reads: unknown[]; contexts: unknown[] } }).__activityFixture;
    return { reads: fixture.reads, contexts: fixture.contexts };
  });
}

function activityRegion(page: Page): Locator {
  return page.getByRole('region', { name: 'Activity' });
}

function statusPattern(label: string, value: string): RegExp {
  return new RegExp(`${label}[\\s\\S]{0,48}${value}`, 'i');
}

function isoDates(text: string): string[] {
  return text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g) ?? [];
}

function recentRequest(requests: readonly ActivityRequest[], kind: ActivityRequest['kind']): ActivityRequest | undefined {
  return requests.filter((request) => request.kind === kind).at(-1);
}

test('prompts for an account and performs no private Activity requests when anonymous', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    accountId: null,
    handler: () => ({ kind: 'page', page: listPage([]) })
  });

  await waitForRegionText(activityRegion(page), /sign in|select an account|account.*(required|needed)|choose.*account/i, 'expected an account prompt');
  assert.equal(requests.filter((request) => request.pathname.startsWith('/api/activity')).length, 0, 'anonymous Activity must not read private data');
  assert.deepEqual(errors, []);
});

test('reads the retained activity list once with exact account scope and shows an honest empty state', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    handler: () => ({ kind: 'page', page: listPage([]) })
  });

  await waitForRegionText(activityRegion(page), /no (activity|actions|records)|nothing .*activity|empty/i, 'expected an empty activity state');
  await waitFor(() => requests.some((request) => request.kind === 'list'), 'expected a retained activity list read');
  const read = recentRequest(requests, 'list');
  assert(read, 'expected a list request');
  assert.equal(read.method, 'GET');
  assert.equal(read.pathname, '/api/activity');
  assert.equal(read.accountId, accountA);
  assert.equal(read.headers.authorization, 'Bearer token-a');

  await sleep(400);
  assert.equal(requests.filter((request) => request.kind === 'list').length, 1, 'the retained list must not be polled');
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0, 'opening Activity must not reconcile through POST');
  assert.deepEqual(errors, []);
});

test('keeps a list read failure distinct from an empty history', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    handler: () => ({ kind: 'failure', status: 503, error: 'Activity storage unavailable' })
  });

  const text = await waitForRegionText(activityRegion(page), /unavailable|could not|failed to (read|load)|error/i, 'expected a readable list failure');
  assert.doesNotMatch(text, /no (actions|activity|records|results)|nothing (recorded|found)|history is empty/i, 'a failure must not be presented as an empty history');
  assert.equal(requests.filter((request) => request.kind === 'list').length, 1);
  assert.deepEqual(errors, []);
});

test('lists readable summaries only for the exact account and renders unknown text inertly', async (t) => {
  const injected = '<img src=x onerror="window.__activityInjected = true">';
  const own = makeAction({
    id: 'https://activity.invalid/actions/own',
    targetId: injected,
    intent: { kind: 'entry-request', inputs: {} }
  });
  const foreign = makeAction({
    id: 'https://activity.invalid/actions/foreign',
    accountId: accountB,
    targetId: 'foreign-account-target-marker'
  });
  const { page, requests, errors } = await openFixture(t, {
    handler: () => ({ kind: 'page', page: listPage([own, foreign]) })
  });

  const region = activityRegion(page);
  const text = await waitForRegionText(region, injected, 'expected the owned action summary as literal text');
  assert.match(text, /entry[-\s]?request/i, 'expected the action kind');
  assert.ok(text.includes(submittedAt), 'expected the submission time');
  assert.match(text, statusPattern('submission', 'accepted'), 'expected submission status separately');
  assert.match(text, statusPattern('outcome', 'pending'), 'expected outcome status separately');
  assert.equal(text.includes('foreign-account-target-marker'), false, 'another account\'s action must not be listed');
  assert.equal(await region.locator('img').count(), 0, 'unknown text must remain inert');
  assert.equal(await page.evaluate(() => (window as unknown as { __activityInjected?: boolean }).__activityInjected), undefined);

  const read = recentRequest(requests, 'list');
  assert(read, 'expected a list request');
  assert.equal(read.accountId, accountA);
  assert.equal(read.headers.authorization, 'Bearer token-a');
  assert.deepEqual(errors, []);
});

test('opens a labeled detail from the activity list using a retained scoped GET', async (t) => {
  const action = makeAction({
    id: 'https://activity.invalid/actions/navigate',
    targetId: 'https://places.invalid/ports/alpha',
    intent: { kind: 'entry-request', inputs: { destination: 'Port Alpha', count: 2 } }
  });
  const { page, requests, errors } = await openFixture(t, {
    handler: (request) => request.kind === 'list'
      ? { kind: 'page', page: listPage([action]) }
      : { kind: 'page', page: detailPage(action) }
  });

  const region = activityRegion(page);
  await waitForRegionText(region, action.targetId, 'expected the action target in the list');
  const open = await waitForButton(region, /view (action )?details|open action|view details/i, 'expected an accessible detail control');
  await open.click();

  const detail = await waitForRegion(page, /action details/i, 'expected a labeled action detail');
  await waitForRegionText(detail, action.targetId, 'expected the detail target');
  await waitForRegionText(detail, /entry[-\s]?request/i, 'expected the intent kind');
  await waitForRegionText(detail, 'Port Alpha', 'expected the input summary');
  await waitForRegionText(detail, /count/i, 'expected input names');

  const read = recentRequest(requests, 'detail');
  assert(read, 'expected a retained detail GET');
  assert.equal(read.method, 'GET');
  assert.equal(read.pathname, `/api/activity/${encodeURIComponent(action.id)}`);
  assert.equal(read.accountId, accountA);
  assert.equal(read.headers.authorization, 'Bearer token-a');
  assert.equal(await detail.getByRole('button', { name: /submit|resubmit|retry|replay/i }).count(), 0, 'Activity must not offer a resubmit control');
  assert.deepEqual(errors, []);
});

test('opens an exact initial actionId and keeps result references and the status URL in technical disclosure', async (t) => {
  const resourceId = 'https://resources.invalid/assets/alpha';
  const requestId = 'https://requests.invalid/entries/1';
  const jobId = 'job-1';
  const eventId = 'https://events.invalid/entries/1';
  const statusUrl = 'https://world.invalid/status/initial-action';
  const action = makeAction({
    id: 'https://activity.invalid/actions/initial',
    targetId: 'target-initial',
    statusUrl,
    resultReferences: [
      { kind: 'resource', id: resourceId },
      { kind: 'request', id: requestId },
      { kind: 'job', id: jobId },
      { kind: 'event', id: eventId }
    ]
  });
  const { page, requests, errors } = await openFixture(t, {
    actionId: action.id,
    handler: (request) => request.kind === 'list'
      ? { kind: 'page', page: listPage([]) }
      : { kind: 'page', page: detailPage(action) }
  });

  const detail = await waitForRegion(page, /action details/i, 'expected the initial action detail');
  await waitForRegionText(detail, action.targetId, 'expected the exact initial action');
  await waitFor(() => requests.some((request) => request.kind === 'detail'), 'expected a retained detail read for the initial actionId');
  const read = recentRequest(requests, 'detail');
  assert(read, 'expected a detail request');
  assert.equal(read.pathname, `/api/activity/${encodeURIComponent(action.id)}`);
  assert.equal(read.accountId, accountA);
  assert.equal(read.headers.authorization, 'Bearer token-a');

  const primary = await detail.innerText();
  for (const reference of [resourceId, requestId, jobId, eventId, statusUrl]) {
    assert.equal(primary.includes(reference), false, `${reference} belongs in technical disclosure`);
  }
  await expandAllDetails(detail);
  const expanded = await detail.innerText();
  for (const reference of [resourceId, requestId, jobId, eventId, statusUrl]) {
    assert.ok(expanded.includes(reference), `expected ${reference} in technical disclosure`);
  }

  await sleep(400);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0, 'opening a detail must not reconcile automatically');
  assert.equal(await detail.getByRole('button', { name: /submit|resubmit|retry|replay/i }).count(), 0);
  assert.deepEqual(errors, []);
});

test('does not claim completion from acceptance alone', async (t) => {
  const action = makeAction({
    id: 'https://activity.invalid/actions/accepted-only',
    targetId: 'target-accepted-only',
    submission: { status: 'accepted' },
    outcome: { status: 'pending', evidence: [] }
  });
  const { page, errors } = await openFixture(t, {
    actionId: action.id,
    handler: () => ({ kind: 'page', page: detailPage(action) })
  });

  const detail = await waitForRegion(page, /action details/i, 'expected the action detail');
  const text = await waitForRegionText(detail, action.targetId, 'expected the action target');
  assert.match(text, statusPattern('submission', 'accepted'), 'expected the accepted submission');
  assert.match(text, statusPattern('outcome', 'pending'), 'expected the pending outcome');
  assert.doesNotMatch(text, statusPattern('outcome', 'completed'), 'acceptance alone is not completion');
  assert.deepEqual(errors, []);
});

test('distinguishes rejected, failed, and unverified states', async (t) => {
  const rejected = makeAction({
    id: 'https://activity.invalid/actions/rejected',
    targetId: 'target-rejected',
    submission: { status: 'rejected', error: 'Registry rejected the request' },
    outcome: { status: 'failed', evidence: [], error: 'Request was rejected' }
  });
  const unverified = makeAction({
    id: 'https://activity.invalid/actions/unverified',
    targetId: 'target-unverified',
    submission: { status: 'unverified', error: 'No acknowledgment was observed' },
    outcome: { status: 'unverified', evidence: [], error: 'Outcome was not verified' }
  });
  const { page, errors } = await openFixture(t, {
    actionId: rejected.id,
    handler: (request) => ({ kind: 'page', page: detailPage(request.actionId === unverified.id ? unverified : rejected) })
  });

  const detail = await waitForRegion(page, /action details/i, 'expected the action detail');
  let text = await waitForRegionText(detail, rejected.targetId, 'expected the rejected action');
  assert.match(text, statusPattern('submission', 'rejected'), 'expected the rejected submission');
  assert.match(text, statusPattern('outcome', 'failed'), 'expected the failed outcome');
  assert.ok(text.includes('Registry rejected the request'), 'expected the submission error');
  assert.ok(text.includes('Request was rejected'), 'expected the outcome error');

  await setAction(page, unverified.id);
  text = await waitForRegionText(detail, unverified.targetId, 'expected the unverified action');
  assert.match(text, statusPattern('submission', 'unverified'), 'expected the unverified submission');
  assert.match(text, statusPattern('outcome', 'unverified'), 'expected the unverified outcome');
  assert.ok(text.includes('No acknowledgment was observed'), 'expected the unverified submission error');
  assert.ok(text.includes('Outcome was not verified'), 'expected the unverified outcome error');
  assert.deepEqual(errors, []);
});

test('claims completion only when the SDK marks the action complete', async (t) => {
  const evidenced = makeAction({
    id: 'https://activity.invalid/actions/evidenced',
    targetId: 'target-evidenced',
    submission: { status: 'accepted' },
    outcome: {
      status: 'completed',
      evidence: [{ source: 'https://evidence.invalid/one', observedAt: evidenceAt, changes: { location: 'Port Alpha', cargo: 2 } }]
    }
  });
  const unevidenced = makeAction({
    id: 'https://activity.invalid/actions/unevidenced',
    targetId: 'target-unevidenced',
    submission: { status: 'accepted' },
    outcome: { status: 'completed', evidence: [] }
  });
  const { page, errors } = await openFixture(t, {
    actionId: unevidenced.id,
    handler: (request) => ({ kind: 'page', page: detailPage(request.actionId === evidenced.id ? evidenced : unevidenced) })
  });

  const detail = await waitForRegion(page, /action details/i, 'expected the action detail');
  let text = await waitForRegionText(detail, unevidenced.targetId, 'expected the unevidenced result');
  assert.match(text, /outcome[\s\S]{0,80}(unverified|not verified|incomplete|not complete|evidence)/i, 'completed without evidence must not be reported as complete');
  assert.doesNotMatch(text, statusPattern('outcome', 'completed'), 'completed without evidence must not be claimed');

  await setAction(page, evidenced.id);
  text = await waitForRegionText(detail, evidenced.targetId, 'expected the evidenced result');
  assert.match(text, statusPattern('outcome', 'completed'), 'expected an evidenced completion');
  assert.ok(text.includes('https://evidence.invalid/one'), 'expected the evidence source');
  assert.ok(text.includes(evidenceAt), 'expected the evidence time');
  assert.ok(text.includes('Port Alpha'), 'expected evidence changes');
  assert.deepEqual(errors, []);
});

test('shows evidence provenance and independent observation state without inventing timestamps', async (t) => {
  const action = makeAction({
    id: 'https://activity.invalid/actions/provenance',
    targetId: 'target-provenance',
    submittedAt,
    submission: { status: 'accepted' },
    outcome: {
      status: 'completed',
      evidence: [{ source: 'https://evidence.invalid/provenance', observedAt: evidenceAt, changes: { location: 'Port Alpha', cargo: 2 } }]
    }
  });
  const observationSource = 'https://world.invalid/activity/provenance';
  const { page, errors } = await openFixture(t, {
    actionId: action.id,
    handler: () => ({
      kind: 'page',
      page: detailPage(action, {
        'action:provenance': {
          state: 'stale',
          source: observationSource,
          observedAt: observationAt,
          value: { status: 'retained' },
          error: 'Last reconciliation failed'
        },
        'action:provenance:stream': {
          state: 'not-retrieved',
          source: 'https://world.invalid/activity/provenance/events'
        }
      })
    })
  });

  const detail = await waitForRegion(page, /action details/i, 'expected the action detail');
  const text = await waitForRegionText(detail, 'Last reconciliation failed', 'expected the independent observation failure');
  assert.ok(text.includes('https://evidence.invalid/provenance'), 'expected the evidence source');
  assert.ok(text.includes(evidenceAt), 'expected the evidence time');
  assert.ok(text.includes('Port Alpha'), 'expected evidence changes');
  assert.match(text, /stale/i, 'expected the independent observation state');
  assert.ok(text.includes(observationSource), 'expected the observation source');
  assert.ok(text.includes(observationAt), 'expected the observation time');
  for (const date of isoDates(text)) {
    assert.ok([submittedAt, evidenceAt, observationAt].includes(date), `unexpected inferred timestamp ${date}`);
  }
  assert.deepEqual(errors, []);
});

test('shows retained journey legs with directed endpoints and per-leg evidence', async (t) => {
  const action = makeAction({
    id: 'https://activity.invalid/actions/journey',
    targetId: 'target-journey',
    intent: { kind: 'travel', inputs: { vesselId: 'vessel-1' } },
    journey: {
      routePlanId: 'route-plan-1',
      vesselId: 'vessel-1',
      status: 'pending',
      updatedAt: '2026-04-04T04:05:06.000Z',
      legs: [
        {
          routeId: 'route-leg-1',
          from: 'Port Alpha',
          to: 'Port Beta',
          territoryId: 'territory-1',
          kind: 'local-movement',
          status: 'completed',
          requestId: 'request-leg-1',
          eventId: 'event-leg-1',
          observedAt: '2026-04-04T04:05:07.000Z'
        },
        {
          routeId: 'route-leg-2',
          from: 'Port Beta',
          to: 'Port Gamma',
          territoryId: 'territory-2',
          kind: 'entry',
          status: 'failed',
          requestId: 'request-leg-2',
          eventId: 'event-leg-2',
          error: 'route blocked',
          observedAt: '2026-04-04T04:05:08.000Z'
        }
      ]
    }
  });
  const { page, errors } = await openFixture(t, {
    actionId: action.id,
    handler: () => ({ kind: 'page', page: detailPage(action) })
  });

  const detail = await waitForRegion(page, /action details/i, 'expected the journey detail');
  await waitForRegionText(detail, action.targetId, 'expected the journey action');
  await expandAllDetails(detail);
  const text = await detail.innerText();

  for (const value of ['Port Alpha', 'Port Beta', 'Port Gamma', 'route-plan-1', 'vessel-1']) {
    assert.ok(text.includes(value), `expected ${value} in the journey presentation`);
  }
  assert.match(text, /local[-\s]?movement/i, 'expected the first leg operation');
  assert.match(text, /\bentry\b/i, 'expected the second leg operation');
  assert.match(text, /completed/i, 'expected the completed leg status');
  assert.match(text, /failed/i, 'expected the failed leg status');
  for (const value of ['request-leg-1', 'event-leg-1', 'request-leg-2', 'event-leg-2', 'route blocked']) {
    assert.ok(text.includes(value), `expected per-leg evidence ${value}`);
  }
  assert.deepEqual(errors, []);
});

test('refreshes detail only on explicit Refresh with exact account scope and never replays the submission', async (t) => {
  const action = makeAction({
    id: 'https://activity.invalid/actions/refresh',
    targetId: 'target-before-refresh'
  });
  const refreshed = makeAction({
    id: action.id,
    targetId: 'target-after-refresh',
    outcome: { status: 'completed', evidence: [{ source: 'https://evidence.invalid/refresh', observedAt: evidenceAt }] }
  });
  const { page, requests, errors } = await openFixture(t, {
    actionId: action.id,
    handler: (request) => ({ kind: 'page', page: detailPage(request.kind === 'refresh' ? refreshed : action) })
  });

  const detail = await waitForRegion(page, /action details/i, 'expected the action detail');
  await waitForRegionText(detail, action.targetId, 'expected the retained detail');
  await sleep(300);
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0, 'opening Activity must not reconcile automatically');
  assert.equal(requests.filter((request) => request.kind === 'detail').length, 1, 'opening Activity must not poll detail');

  const refresh = await waitForButton(detail, /^refresh$/i, 'expected an explicit Refresh control');
  await refresh.click();
  await waitForRegionText(detail, refreshed.targetId, 'expected the refreshed detail');

  const posts = requests.filter((request) => request.kind === 'refresh');
  assert.equal(posts.length, 1, 'expected exactly one explicit reconciliation POST');
  const post = posts[0]!;
  assert.equal(post.method, 'POST');
  assert.equal(post.pathname, `/api/activity/${encodeURIComponent(action.id)}/refresh`);
  assert.equal(post.accountId, accountA);
  assert.deepEqual(post.body, { accountId: accountA });
  assert.equal(post.headers.authorization, 'Bearer token-a');

  await sleep(400);
  assert.equal(requests.filter((request) => request.kind === 'refresh').length, 1, 'Refresh must not repeat automatically');
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1, 'no other submission or replay POST may occur');
  assert.equal(await detail.getByRole('button', { name: /submit|resubmit|retry|replay/i }).count(), 0);
  assert.deepEqual(errors, []);
});

test('retains current detail with an error when explicit refresh fails', async (t) => {
  const action = makeAction({
    id: 'https://activity.invalid/actions/refresh-failure',
    targetId: 'target-retained'
  });
  const { page, requests, errors } = await openFixture(t, {
    actionId: action.id,
    handler: (request) => request.kind === 'refresh'
      ? { kind: 'failure', status: 503, error: 'Refresh is unavailable' }
      : { kind: 'page', page: detailPage(action) }
  });

  const detail = await waitForRegion(page, /action details/i, 'expected the action detail');
  await waitForRegionText(detail, action.targetId, 'expected the retained detail');
  const refresh = await waitForButton(detail, /^refresh$/i, 'expected an explicit Refresh control');
  await refresh.click();

  const text = await waitForRegionText(detail, /refresh (failed|is unavailable)|could not refresh/i, 'expected the refresh failure');
  assert.ok(text.includes(action.targetId), 'a failed refresh must not erase retained detail');
  assert.match(text, /stale|retained|last known|previous|older/i, 'expected stale or retained context after the failure');
  assert.doesNotMatch(text, /no (actions|activity|records|results)|nothing (recorded|found)|history is empty/i);
  assert.equal(requests.filter((request) => request.kind === 'refresh').length, 1);
  assert.deepEqual(errors, []);
});

test('supersedes a slow initial detail read with an explicit refresh', async (t) => {
  const initial = deferred<Outcome>();
  const action = makeAction({
    id: 'https://activity.invalid/actions/slow-initial',
    targetId: 'target-stale-initial'
  });
  const refreshed = makeAction({
    id: action.id,
    targetId: 'target-refreshed'
  });
  const { page, requests, errors } = await openFixture(t, {
    actionId: action.id,
    handler: (request) => request.kind === 'refresh'
      ? { kind: 'page', page: detailPage(refreshed) }
      : initial.promise
  });

  const detail = await waitForRegion(page, /action details/i, 'expected the detail while its retained read is pending');
  const refresh = await waitForButton(detail, /^refresh$/i, 'expected Refresh while the initial detail is pending');
  await refresh.click();
  await waitForRegionText(detail, refreshed.targetId, 'expected the refreshed detail');

  initial.resolve({ kind: 'page', page: detailPage(action) });
  await sleep(200);
  const text = await detail.innerText();
  assert.ok(text.includes(refreshed.targetId), 'the refreshed detail must remain');
  assert.equal(text.includes(action.targetId), false, 'a slow initial detail must not overwrite a newer refresh');
  assert.equal(requests.filter((request) => request.kind === 'refresh').length, 1);
  assert.deepEqual(errors, []);
});

test('drops a stale list response after the account changes', async (t) => {
  const oldList = deferred<Outcome>();
  const current = makeAction({
    id: 'https://activity.invalid/actions/account-b',
    accountId: accountB,
    targetId: 'account-b-target'
  });
  const { page, requests, errors } = await openFixture(t, {
    handler: (request) => {
      if (request.kind !== 'list') return { kind: 'failure', error: 'unexpected detail read' };
      return request.accountId === accountB
        ? { kind: 'page', page: listPage([current], accountB) }
        : oldList.promise;
    }
  });

  await waitFor(() => requests.some((request) => request.kind === 'list' && request.accountId === accountA), 'expected the initial account read');
  await setAccount(page, accountB);
  await waitForRegionText(activityRegion(page), current.targetId, 'expected the current account list');
  const read = recentRequest(requests, 'list');
  assert(read, 'expected the current list read');
  assert.equal(read.accountId, accountB);
  assert.equal(read.headers.authorization, 'Bearer token-b');

  oldList.resolve({ kind: 'page', page: listPage([makeAction({ id: 'https://activity.invalid/actions/late', targetId: 'late-account-a-target' })]) });
  await sleep(200);
  const text = await activityRegion(page).innerText();
  assert.ok(text.includes(current.targetId), 'the current account list must remain');
  assert.equal(text.includes('late-account-a-target'), false, 'an older account response must not replace the current list');
  assert.deepEqual(errors, []);
});

test('drops a stale detail response after the account changes and does not query it under the new account', async (t) => {
  const oldDetail = deferred<Outcome>();
  const action = makeAction({
    id: 'https://activity.invalid/actions/private',
    targetId: 'late-private-target'
  });
  const { page, requests, errors } = await openFixture(t, {
    actionId: action.id,
    handler: (request) => {
      if (request.kind === 'list') return { kind: 'page', page: listPage([], request.accountId ?? accountA) };
      if (request.accountId === accountA) return oldDetail.promise;
      return { kind: 'failure', status: 403, error: 'Not this account\'s action' };
    }
  });

  await waitFor(() => requests.some((request) => request.kind === 'detail' && request.accountId === accountA), 'expected the initial detail read');
  await setAccount(page, accountB);
  await waitFor(() => requests.some((request) => request.kind === 'list' && request.accountId === accountB), 'expected the new account list read');

  oldDetail.resolve({ kind: 'page', page: detailPage(action) });
  await sleep(200);
  const text = await page.locator('body').innerText();
  assert.equal(text.includes('late-private-target'), false, 'another account\'s late detail must not appear');
  assert.equal(requests.filter((request) => request.kind === 'detail' && request.accountId === accountB).length, 0, 'the old action must not be queried under the new account');
  assert.deepEqual(errors, []);
});

test('drops a slow initial actionId response after the action changes', async (t) => {
  const first = deferred<Outcome>();
  const firstAction = makeAction({
    id: 'https://activity.invalid/actions/first',
    targetId: 'late-first-target'
  });
  const secondAction = makeAction({
    id: 'https://activity.invalid/actions/second',
    targetId: 'current-second-target'
  });
  const { page, requests, errors } = await openFixture(t, {
    actionId: firstAction.id,
    handler: (request) => {
      if (request.kind === 'list') return { kind: 'page', page: listPage([]) };
      return request.actionId === secondAction.id
        ? { kind: 'page', page: detailPage(secondAction) }
        : first.promise;
    }
  });

  await waitFor(() => requests.some((request) => request.kind === 'detail' && request.actionId === firstAction.id), 'expected the initial detail read');
  await setAction(page, secondAction.id);
  const detail = await waitForRegion(page, /action details/i, 'expected the action detail');
  await waitForRegionText(detail, secondAction.targetId, 'expected the current action detail');

  first.resolve({ kind: 'page', page: detailPage(firstAction) });
  await sleep(200);
  const text = await detail.innerText();
  assert.ok(text.includes(secondAction.targetId), 'the current action detail must remain');
  assert.equal(text.includes(firstAction.targetId), false, 'a stale standalone action response must not replace the current action');
  assert.deepEqual(errors, []);
});

test('drops a late detail response after unmount and shows only fresh content after remount', async (t) => {
  const pending = deferred<Outcome>();
  const stale = makeAction({
    id: 'https://activity.invalid/actions/unmounted',
    targetId: 'late-unmounted-target'
  });
  const fresh = makeAction({
    id: stale.id,
    targetId: 'remounted-target'
  });
  let detailCalls = 0;
  const { page, requests, errors } = await openFixture(t, {
    actionId: stale.id,
    handler: (request) => {
      if (request.kind === 'list') return { kind: 'page', page: listPage([]) };
      detailCalls += 1;
      return detailCalls === 1 ? pending.promise : { kind: 'page', page: detailPage(fresh) };
    }
  });

  await waitFor(() => requests.some((request) => request.kind === 'detail'), 'expected the initial detail read');
  await unmountActivity(page);
  await waitForRegionText(page.locator('main'), /activity unmounted/i, 'expected the fixture to unmount Activity');

  pending.resolve({ kind: 'page', page: detailPage(stale) });
  await sleep(200);
  assert.equal((await page.locator('body').innerText()).includes(stale.targetId), false, 'a late response must not populate an unmounted Activity');

  await remountActivity(page);
  const detail = await waitForRegion(page, /action details/i, 'expected a fresh detail after remount');
  await waitForRegionText(detail, fresh.targetId, 'expected fresh content after remount');
  const text = await detail.innerText();
  assert.equal(text.includes(stale.targetId), false, 'remounting must not inherit the late response');
  assert.equal(requests.filter((request) => request.kind === 'detail').length, 2);
  assert.deepEqual(errors, []);
});

test('recovers exact resource, vessel, journey, and job context from a retained action', async (t) => {
  const resourceId = 'https://resources.invalid/assets/alpha';
  const jobId = 'job-1';
  const authorityId = 'https://authority.invalid/operations';
  const action = makeAction({
    id: 'https://activity.invalid/actions/recovery',
    targetId: 'target-recovery',
    intent: { kind: 'entry-request', inputs: { vesselId: 'vessel-1', authorityId } },
    resultReferences: [
      { kind: 'resource', id: resourceId },
      { kind: 'job', id: jobId },
      { kind: 'request', id: 'https://requests.invalid/entries/recovery' },
      { kind: 'event', id: 'https://events.invalid/entries/recovery' }
    ],
    journey: {
      routePlanId: 'route-plan-1',
      vesselId: 'vessel-1',
      status: 'pending',
      updatedAt: '2026-04-04T04:05:06.000Z',
      legs: []
    }
  });
  const { page, errors } = await openFixture(t, {
    actionId: action.id,
    handler: () => ({ kind: 'page', page: detailPage(action) })
  });

  const detail = await waitForRegion(page, /action details/i, 'expected the recovery detail');
  await waitForRegionText(detail, action.targetId, 'expected the recovery action');

  await (await waitForButton(detail, /^read resource$/i, 'expected an exact resource recovery control')).click();
  await (await waitForButton(detail, /vessel/i, 'expected a vessel recovery control')).click();
  await (await waitForButton(detail, /journey/i, 'expected a journey recovery control')).click();
  await (await waitForButton(detail, /job/i, 'expected a job recovery control')).click();

  const calls = await recoveryCalls(page);
  assert.deepEqual(calls.reads, [{ id: resourceId }], 'resource recovery must use the exact reference without an inherited audience');
  assert.deepEqual(calls.contexts, [
    { kind: 'vessel', vesselId: 'vessel-1' },
    { kind: 'journey', vesselId: 'vessel-1', routePlanId: 'route-plan-1' },
    { kind: 'job', jobId, vesselId: 'vessel-1', authorityId }
  ]);

  for (const id of ['https://requests.invalid/entries/recovery', 'https://events.invalid/entries/recovery']) {
    assert.equal(await detail.getByRole('button', { name: id }).count(), 0, 'request and event references must not become resource controls');
  }
  assert.deepEqual(errors, []);
});

test('opens administration only for administration intents and uses intent vessel context without a journey', async (t) => {
  const authorityId = 'https://authority.invalid/administration';
  const administrative = makeAction({
    id: 'https://activity.invalid/actions/administration',
    targetId: 'target-administration',
    intent: { kind: 'administration-control', inputs: { authorityId, control: 'admission', authorityKind: 'policy', inputs: { reviewMode: 'manual' } } }
  });
  const travel = makeAction({
    id: 'https://activity.invalid/actions/travel',
    targetId: 'target-travel',
    intent: { kind: 'entry-request', inputs: { vesselId: 'vessel-2', authorityId } }
  });
  const { page, errors } = await openFixture(t, {
    actionId: administrative.id,
    handler: (request) => ({ kind: 'page', page: detailPage(request.actionId === travel.id ? travel : administrative) })
  });

  let detail = await waitForRegion(page, /action details/i, 'expected the administrative detail');
  await waitForRegionText(detail, administrative.targetId, 'expected the administration action');
  await (await waitForButton(detail, /administration|authority/i, 'expected an administration recovery control')).click();
  let calls = await recoveryCalls(page);
  assert.deepEqual(calls.contexts.at(-1), { kind: 'administration', authorityId });

  await setAction(page, travel.id);
  detail = await waitForRegion(page, /action details/i, 'expected the travel detail');
  await waitForRegionText(detail, travel.targetId, 'expected the travel action');
  await (await waitForButton(detail, /vessel/i, 'expected vessel recovery from intent inputs')).click();
  calls = await recoveryCalls(page);
  assert.deepEqual(calls.contexts.at(-1), { kind: 'vessel', vesselId: 'vessel-2' });
  assert.equal(await detail.getByRole('button', { name: /administration|authority/i }).count(), 0, 'a non-administration intent must not offer an administration target');
  assert.deepEqual(errors, []);
});

test('keeps retained references instead of offering recovery controls without required context', async (t) => {
  const resourceId = 'https://resources.invalid/assets/no-context';
  const jobId = 'job-no-context';
  const requestId = 'https://requests.invalid/no-context';
  const eventId = 'https://events.invalid/no-context';
  const action = makeAction({
    id: 'https://activity.invalid/actions/no-context',
    targetId: 'target-no-context',
    intent: { kind: 'entry-request', inputs: {} },
    resultReferences: [
      { kind: 'resource', id: resourceId },
      { kind: 'job', id: jobId },
      { kind: 'request', id: requestId },
      { kind: 'event', id: eventId }
    ]
  });
  const { page, errors } = await openFixture(t, {
    actionId: action.id,
    handler: () => ({ kind: 'page', page: detailPage(action) })
  });

  const detail = await waitForRegion(page, /action details/i, 'expected the action detail');
  await waitForRegionText(detail, action.targetId, 'expected the action');
  await waitForButton(detail, /^read resource$/i, 'expected a resource reference control');
  for (const name of [/vessel/i, /journey/i, /job/i, /administration|authority/i]) {
    assert.equal(await detail.getByRole('button', { name }).count(), 0, `a control matching ${String(name)} requires known context`);
  }
  for (const id of [jobId, requestId, eventId]) {
    assert.equal(await detail.getByRole('button', { name: id }).count(), 0, `${id} must remain a retained reference`);
  }

  await expandAllDetails(detail);
  const text = await detail.innerText();
  for (const id of [resourceId, jobId, requestId, eventId]) {
    assert.ok(text.includes(id), `expected the retained reference ${id}`);
  }
  assert.deepEqual(errors, []);
});

test('shows retained references instead of dead controls when recovery callbacks are absent', async (t) => {
  const resourceId = 'https://resources.invalid/assets/no-callback';
  const action = makeAction({
    id: 'https://activity.invalid/actions/no-callback',
    targetId: 'target-no-callback',
    intent: { kind: 'entry-request', inputs: { vesselId: 'vessel-3' } },
    resultReferences: [{ kind: 'resource', id: resourceId }],
    journey: {
      routePlanId: 'route-plan-3',
      vesselId: 'vessel-3',
      status: 'pending',
      updatedAt: '2026-04-04T04:05:06.000Z',
      legs: []
    }
  });
  const { page, errors } = await openFixture(t, {
    actionId: action.id,
    callbacks: false,
    handler: () => ({ kind: 'page', page: detailPage(action) })
  });

  const detail = await waitForRegion(page, /action details/i, 'expected the action detail');
  await waitForRegionText(detail, action.targetId, 'expected the action');
  for (const name of [/^read resource$/i, /vessel/i, /journey/i, /job/i, /administration|authority/i]) {
    assert.equal(await detail.getByRole('button', { name }).count(), 0, 'absent callbacks must not create dead recovery controls');
  }

  await expandAllDetails(detail);
  const text = await detail.innerText();
  for (const value of [resourceId, 'vessel-3', 'route-plan-3']) {
    assert.ok(text.includes(value), `expected the retained value ${value}`);
  }
  assert.deepEqual(errors, []);
});

test('does not persist activity data in browser storage', async (t) => {
  const action = makeAction({
    id: 'https://activity.invalid/actions/storage',
    targetId: 'target-storage'
  });
  const { page, errors } = await openFixture(t, {
    actionId: action.id,
    handler: (request) => request.kind === 'list'
      ? { kind: 'page', page: listPage([action]) }
      : { kind: 'page', page: detailPage(action) }
  });

  const detail = await waitForRegion(page, /action details/i, 'expected the action detail');
  await waitForRegionText(detail, action.targetId, 'expected the action');

  const localKeys = await page.evaluate(() => Object.keys(localStorage).sort());
  const sessionKeys = await page.evaluate(() => Object.keys(sessionStorage));
  assert.deepEqual(localKeys, ['fctp.client-sessions'], 'Activity must not add browser-local persistence');
  assert.deepEqual(sessionKeys, [], 'Activity must not add session persistence');
  assert.deepEqual(errors, []);
});

test('reports a malformed retained list as unavailable rather than an empty history', async (t) => {
  const { page, errors } = await openFixture(t, {
    handler: () => ({ kind: 'page', page: { ...listPage([]), data: {} } })
  });
  const text = await waitForRegionText(activityRegion(page), /malformed|unavailable/i, 'expected malformed list failure');
  assert.doesNotMatch(text, /no activity is recorded/i);
  assert.deepEqual(errors, []);
});

test('does not show a mismatched action from either retained read or refresh', async (t) => {
  const requestedId = 'requested-action';
  const { page, errors } = await openFixture(t, {
    actionId: requestedId,
    handler: (request) => request.kind === 'list'
      ? { kind: 'page', page: listPage([]) }
      : { kind: 'page', page: detailPage(makeAction({ id: 'wrong-action', targetId: 'wrong-action-private-marker' })) }
  });
  const detail = await waitForRegion(page, /action details/i, 'expected the requested action detail');
  await waitForRegionText(detail, /not available|unavailable/i, 'expected mismatched retained action failure');
  assert.equal((await detail.innerText()).includes('wrong-action-private-marker'), false);
  await (await waitForButton(detail, /^refresh$/i, 'expected explicit Refresh')).click();
  await waitForRegionText(detail, /refresh failed/i, 'expected mismatched refreshed action failure');
  assert.equal((await detail.innerText()).includes('wrong-action-private-marker'), false);
  assert.deepEqual(errors, []);
});
