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
const observedAt = '2026-05-01T01:02:03.000Z';
const laterAt = '2026-05-02T02:03:04.000Z';
const freshAt = '2026-05-03T03:04:05.000Z';

const assetId = 'https://resources.invalid/assets/rope';
const otherAssetId = 'https://resources.invalid/assets/crates';
const toolId = 'https://resources.invalid/assets/press';
const varietyId = 'https://resources.invalid/varieties/alloy';
const oreId = 'https://resources.invalid/varieties/ore';
const catalystId = 'https://resources.invalid/varieties/catalyst';
const spareVarietyId = 'https://resources.invalid/varieties/spare';
const itemId = 'https://resources.invalid/items/catalyst-7';
const areaNorthId = 'https://places.invalid/areas/north-foundry';
const areaSouthId = 'https://places.invalid/areas/south-mine';
const areaEastId = 'https://places.invalid/areas/east-foundry';
const territoryId = 'https://places.invalid/territories/island';
const grantId = 'https://resources.invalid/grants/alloy';
const actionId = 'https://activity.invalid/actions/publish-alloy';
const evidenceSource = assetId;

const assetDraftId = 'draft:3f9c1a77';
const varietyDraftId = 'draft:8b2d4e10';
const productionDraftId = 'draft:5a6e0c31';
const pickerDraftId = 'draft:9d4f2b66';
const publicationDraftId = 'draft:1e7a3c90';
const secondDraftId = 'draft:6c0b5d42';
const accountBDraftId = 'draft:2f8e4a13';
const mismatchDraftId = 'draft:0a1b2c3d';

const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

const fixtureSource = String.raw`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Authoring } from './apps/frontend/src/authoring.tsx';

const params = new URLSearchParams(window.location.search);
const accountParam = params.get('account');
const initialAccount = accountParam === 'none' ? undefined : (accountParam || 'account-a');
const withCallbacks = params.get('callbacks') !== '0';
const fixture = { controls: null, reads: [], actions: [] };
window.__authoringFixture = fixture;

function App() {
  const [accountId, setAccountId] = React.useState(initialAccount);
  const [mounted, setMounted] = React.useState(true);
  const [visible, setVisible] = React.useState(true);

  React.useEffect(() => {
    fixture.controls = {
      setAccountId(value) { setAccountId(value); },
      setVisible(value) { setVisible(Boolean(value)); },
      unmount() { setMounted(false); },
      remount() { setMounted(true); }
    };
  }, []);

  const props = {
    ...(accountId === undefined ? {} : { accountId }),
    ...(withCallbacks ? {
      onOpenAction: (actionId) => { fixture.actions.push({ actionId }); },
      onReadResource: (reference) => { fixture.reads.push(reference); }
    } : {})
  };

  return React.createElement(
    'main',
    null,
    mounted
      ? React.createElement(
        'div',
        { style: { display: visible ? 'block' : 'none' } },
        React.createElement(Authoring, props)
      )
      : React.createElement('p', null, 'Authoring unmounted')
  );
}

createRoot(document.getElementById('root')).render(React.createElement(App));
`;

interface Observation {
  state: string;
  source: string;
  observedAt?: string;
  value?: unknown;
  error?: string;
}

interface RequestInfo {
  method: string;
  pathname: string;
  params: Record<string, string>;
  body?: unknown;
  headers: Record<string, string>;
}

interface ServerResponse {
  status?: number;
  body: unknown;
}

type Handler = (request: RequestInfo) => ServerResponse | Promise<ServerResponse>;

interface OpenedFixture {
  page: Page;
  requests: RequestInfo[];
  errors: string[];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface ProductionEntryShape {
  type: string;
  duration: number;
  tool?: string;
  ingredients?: Array<Record<string, unknown>>;
  location?: Array<Record<string, unknown>>;
  yield: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface ProductionFields {
  name: string;
  mass: number;
  version: string;
  asset?: string;
  production?: ProductionEntryShape[];
  [key: string]: unknown;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function available(source: string, value: unknown, at = observedAt): Observation {
  return { state: 'available', source, observedAt: at, value };
}

function stale(source: string, value: unknown, error: string, at = observedAt): Observation {
  return { state: 'stale', source, observedAt: at, value, error };
}

function unavailable(source: string, error: string, at?: string): Observation {
  return { state: 'unavailable', source, error, ...(at === undefined ? {} : { observedAt: at }) };
}

function notRetrieved(source: string): Observation {
  return { state: 'not-retrieved', source };
}

interface LibraryOptions {
  assets?: unknown[];
  varieties?: unknown[];
  grants?: unknown[];
  drafts?: unknown[];
  observations?: Record<string, Observation>;
}

function libraryPage(accountId: string, options: LibraryOptions = {}): ServerResponse {
  return {
    body: {
      context: { accountId },
      data: {
        assets: options.assets ?? [],
        varieties: options.varieties ?? [],
        grants: options.grants ?? [],
        drafts: options.drafts ?? []
      },
      observations: options.observations ?? {},
      actions: []
    }
  };
}

interface DraftOptions {
  id: string;
  accountId?: string;
  kind: 'asset' | 'variety';
  fields: Record<string, unknown>;
  savedAt?: string;
  publication?: { actionId?: string; resourceIds?: string[] };
}

function makeDraft(options: DraftOptions): Record<string, unknown> {
  return {
    id: options.id,
    accountId: options.accountId ?? accountA,
    kind: options.kind,
    fields: options.fields,
    savedAt: options.savedAt ?? observedAt,
    ...(options.publication === undefined ? {} : { publication: options.publication })
  };
}

interface ActionOptions {
  id?: string;
  accountId?: string;
  targetId?: string;
  resultReferences?: Array<{ kind: string; id: string }>;
  intent?: { kind: string; inputs: Record<string, unknown> };
  submittedAt?: string;
  submission?: Record<string, unknown>;
  outcome?: Record<string, unknown>;
}

function makeAction(options: ActionOptions = {}): Record<string, unknown> {
  return {
    id: options.id ?? actionId,
    statusUrl: `https://activity.invalid/status/${encodeURIComponent(options.id ?? actionId)}`,
    accountId: options.accountId ?? accountA,
    targetId: options.targetId ?? assetId,
    resultReferences: options.resultReferences ?? [],
    intent: options.intent ?? { kind: 'authoring-publication', inputs: {} },
    submittedAt: options.submittedAt ?? observedAt,
    submission: { status: 'accepted', ...(options.submission ?? {}) },
    outcome: { status: 'pending', evidence: [], ...(options.outcome ?? {}) }
  };
}

function actionDetail(action: Record<string, unknown>): ServerResponse {
  return {
    body: {
      context: { accountId: typeof action.accountId === 'string' ? action.accountId : accountA },
      data: { action },
      observations: {},
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
      sourcefile: 'frontend-authoring-fixture.js',
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

async function openFixture(t: TestContext, handler: Handler, options: { accountId?: string | null; callbacks?: boolean } = {}): Promise<OpenedFixture> {
  const activeBrowser = browser;
  const activeBundle = bundle;
  assert(activeBrowser, 'browser was not started');
  assert(activeBundle, 'fixture bundle was not built');

  const context = await activeBrowser.newContext();
  t.after(async () => { await context.close(); });
  await context.addInitScript((sessions: unknown) => {
    localStorage.setItem('fctp.client-sessions', JSON.stringify(sessions));
  }, [
    { accountId: accountA, handle: '@alpha.home@alpha.test:4200', clientToken: 'token-a' },
    { accountId: accountB, handle: '@beta.home@beta.test:4200', clientToken: 'token-b' }
  ]);

  const page = await context.newPage();
  page.setDefaultTimeout(settleTimeout);
  const requests: RequestInfo[] = [];
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
    const info: RequestInfo = {
      method: request.method(),
      pathname: url.pathname,
      params: Object.fromEntries(url.searchParams),
      ...(body === undefined ? {} : { body }),
      headers: request.headers()
    };
    requests.push(info);
    const response = await handler(info);
    await route.fulfill({
      status: response.status ?? 200,
      contentType: 'application/json',
      body: JSON.stringify(response.body)
    });
  });

  const params = new URLSearchParams();
  params.set('account', options.accountId === null ? 'none' : options.accountId ?? accountA);
  if (options.callbacks === false) params.set('callbacks', '0');
  await page.goto(`${fixtureOrigin}?${params.toString()}`);
  await page.waitForFunction(() => {
    const fixture = (window as unknown as { __authoringFixture?: { controls?: unknown } }).__authoringFixture;
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

function authoringRegion(page: Page): Locator {
  return page.getByRole('region', { name: /Author & Publish/i }).first();
}

async function waitForRegion(page: Page): Promise<Locator> {
  const region = authoringRegion(page);
  try {
    await region.waitFor({ state: 'visible', timeout: settleTimeout });
  } catch (error) {
    throw new Error('expected the Author & Publish workspace', { cause: error });
  }
  return region;
}

async function waitForText(scope: Locator, expected: string | RegExp, message: string): Promise<string> {
  let last = '';
  try {
    await waitFor(async () => {
      last = await scope.innerText();
      return typeof expected === 'string' ? last.includes(expected) : expected.test(last);
    }, message);
  } catch (error) {
    throw new Error(`${message}; last text was ${JSON.stringify(last)}`, { cause: error });
  }
  return last;
}

async function waitForButton(scope: Locator, name: RegExp, message: string): Promise<Locator> {
  const button = scope.getByRole('button', { name }).first();
  try {
    await button.waitFor({ state: 'visible', timeout: settleTimeout });
  } catch (error) {
    let text = '';
    try { text = await scope.innerText(); } catch { text = '<unavailable>'; }
    throw new Error(`${message}; scope text was ${JSON.stringify(text)}`, { cause: error });
  }
  return button;
}

async function editorRegion(page: Page, kind: 'Asset' | 'Variety'): Promise<Locator> {
  const region = page.getByRole('region', { name: new RegExp(`^${kind} draft$`, 'i') }).first();
  try {
    await region.waitFor({ state: 'visible', timeout: settleTimeout });
  } catch (error) {
    throw new Error(`expected the ${kind} editor`, { cause: error });
  }
  return region;
}

function group(scope: Locator, name: string | RegExp): Locator {
  return scope.getByRole('group', { name }).first();
}

function button(scope: Locator, name: RegExp): Locator {
  return scope.getByRole('button', { name }).first();
}

function draftButton(page: Page, id: string): Locator {
  return page.getByRole('button', { name: new RegExp(`^Open draft ${escapeRegExp(id)}$`, 'i') }).first();
}

function resourceButton(page: Page, id: string): Locator {
  return page.getByRole('button', { name: new RegExp(`^Open resource ${escapeRegExp(id)}$`, 'i') }).first();
}

function publicationActionButton(page: Page, id: string): Locator {
  return page.getByRole('button', { name: new RegExp(`^Open publication action ${escapeRegExp(id)}$`, 'i') }).first();
}

function requestFields(request: RequestInfo): Record<string, unknown> {
  return asRecord(asRecord(request.body).fields);
}

function requestsFor(requests: readonly RequestInfo[], pathname: string, method?: string): RequestInfo[] {
  return requests.filter((request) => request.pathname === pathname && (method === undefined || request.method === method));
}

async function setAccount(page: Page, accountId: string): Promise<void> {
  await page.evaluate((id) => {
    const fixture = (window as unknown as { __authoringFixture: { controls: { setAccountId(value: string): void } } }).__authoringFixture;
    fixture.controls.setAccountId(id);
  }, accountId);
}

async function setVisible(page: Page, visible: boolean): Promise<void> {
  await page.evaluate((value) => {
    const fixture = (window as unknown as { __authoringFixture: { controls: { setVisible(value: boolean): void } } }).__authoringFixture;
    fixture.controls.setVisible(value);
  }, visible);
}

async function unmountAuthoring(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fixture = (window as unknown as { __authoringFixture: { controls: { unmount(): void } } }).__authoringFixture;
    fixture.controls.unmount();
  });
}

async function remountAuthoring(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fixture = (window as unknown as { __authoringFixture: { controls: { remount(): void } } }).__authoringFixture;
    fixture.controls.remount();
  });
}

async function fixtureSnapshot(page: Page): Promise<{ reads: Array<{ id: string; authorityId?: string }>; actions: Array<{ actionId: string }> }> {
  return page.evaluate(() => {
    const fixture = (window as unknown as {
      __authoringFixture: {
        reads: Array<{ id: string; authorityId?: string }>;
        actions: Array<{ actionId: string }>;
      };
    }).__authoringFixture;
    return { reads: fixture.reads.slice(), actions: fixture.actions.slice() };
  });
}

async function waitForActiveText(page: Page, expected: RegExp): Promise<void> {
  await page.waitForFunction((source) => {
    const active = document.activeElement;
    return active instanceof HTMLElement && new RegExp(source, 'i').test(active.textContent ?? '');
  }, expected.source, { timeout: settleTimeout });
}

function openPickerDialog(page: Page, fieldLabel: string): Locator {
  return page.getByRole('dialog', { name: new RegExp(escapeRegExp(fieldLabel), 'i') }).first();
}

test('preserves edits made during Save and does not adopt that Save into a later new draft', async (t) => {
  const pending = deferred<ServerResponse>();
  const draft = makeDraft({ id: assetDraftId, kind: 'asset', fields: { name: 'Original', text: '' } });
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library') return libraryPage(accountA, { drafts: [draft] });
    if (request.method === 'GET') return { body: { draft } };
    if (request.pathname === `/api/drafts/${encodeURIComponent(assetDraftId)}`) return pending.promise;
    if (request.pathname === '/api/drafts') return { body: { draft: makeDraft({ id: secondDraftId, kind: 'asset', fields: requestFields(request) }) } };
    return { status: 404, body: { error: 'unexpected request' } };
  });
  await draftButton(page, assetDraftId).click();
  const editor = await editorRegion(page, 'Asset');
  await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Submitted');
  await button(editor, /^Save draft$/i).click();
  await waitFor(() => requestsFor(requests, `/api/drafts/${encodeURIComponent(assetDraftId)}`, 'POST').length === 1, 'expected Save');
  await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Later edit');
  pending.resolve({ body: { draft: makeDraft({ id: assetDraftId, kind: 'asset', fields: { name: 'Submitted', text: '' }, savedAt: laterAt }) } });
  await button(editor, /^Save draft$/i).waitFor({ state: 'visible' });
  await waitFor(() => button(editor, /^Save draft$/i).isEnabled(), 'Save must settle');
  assert.equal(await editor.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Later edit');
  assert.equal(await button(editor, /^Publish draft$/i).isDisabled(), true, 'later edits remain unsaved');

  const pendingCreate = deferred<ServerResponse>();
  await page.route('**/api/drafts', async (route) => {
    const request = route.request();
    requests.push({ method: request.method(), pathname: '/api/drafts', params: {}, body: request.postDataJSON() as unknown, headers: request.headers() });
    const response = await pendingCreate.promise;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response.body) });
  });
  await button(authoringRegion(page), /^New Asset$/i).click();
  await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('First new draft');
  await button(editor, /^Save draft$/i).click();
  await waitFor(() => requestsFor(requests, '/api/drafts', 'POST').length === 1, 'expected create');
  await button(authoringRegion(page), /^New Asset$/i).click();
  await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Second new draft');
  pendingCreate.resolve({ body: { draft: makeDraft({ id: secondDraftId, kind: 'asset', fields: { name: 'First new draft', text: '' } }) } });
  await waitFor(() => button(editor, /^Save draft$/i).isEnabled(), 'create must settle');
  assert.equal(await editor.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Second new draft');
  assert.equal(await button(editor, /^Publish draft$/i).isDisabled(), true, 'later new editor must not adopt earlier draft identity');
  assert.deepEqual(errors, []);
});

test('resets same-kind draft JSON state and returns picker focus to the exact repeated field', async (t) => {
  const first = makeDraft({ id: varietyDraftId, kind: 'variety', fields: { name: 'First', production: [{ type: 'mine', duration: 1, yield: [{ probability: 1, count: 1, data: {} }] }] } });
  const second = makeDraft({ id: secondDraftId, kind: 'variety', fields: { name: 'Second', production: [{ type: 'mine', duration: 2, ingredients: [{ variety: oreId, count: 1, data: {} }, { variety: catalystId, count: 1, data: {} }], yield: [] }] } });
  const { page, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library') return libraryPage(accountA, { drafts: [first, second] });
    if (request.pathname === `/api/drafts/${encodeURIComponent(varietyDraftId)}`) return { body: { draft: first } };
    if (request.pathname === `/api/drafts/${encodeURIComponent(secondDraftId)}`) return { body: { draft: second } };
    return { status: 404, body: { error: 'unexpected request' } };
  });
  await draftButton(page, varietyDraftId).click();
  const editor = await editorRegion(page, 'Variety');
  await editor.getByRole('checkbox', { name: 'Advanced Production JSON' }).check();
  await editor.getByRole('textbox', { name: 'Production JSON', exact: true }).fill('{broken');
  await draftButton(page, secondDraftId).click();
  await waitFor(() => editor.getByRole('textbox', { name: 'Name', exact: true }).inputValue().then((value) => value === 'Second'), 'expected second draft');
  assert.equal(await editor.getByRole('checkbox', { name: 'Advanced Production JSON' }).isChecked(), false, 'draft-local invalid editor must not survive draft selection');
  const invoking = group(editor, 'Stack ingredient 1').getByRole('button', { name: 'Choose ingredient variety', exact: true });
  await invoking.click();
  const dialog = openPickerDialog(page, 'Ingredient variety');
  await dialog.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await waitFor(() => invoking.evaluate((element) => document.activeElement === element), 'picker must return focus to its first invoking field, not the last repeated field');
  assert.deepEqual(errors, []);
});

test('does not let an older retained Library read replace an explicit refresh', async (t) => {
  const pending = deferred<ServerResponse>();
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library') return pending.promise;
    if (request.pathname === '/api/library/refresh') return libraryPage(accountA, { assets: [{ id: assetId, type: 'Asset', name: 'Fresh resource' }] });
    return { status: 404, body: { error: 'unexpected request' } };
  });
  await waitFor(() => requestsFor(requests, '/api/library').length === 1, 'expected retained read');
  await button(authoringRegion(page), /^Refresh Library$/i).click();
  await waitForText(authoringRegion(page), 'Fresh resource', 'expected explicit result');
  pending.resolve(libraryPage(accountA, { assets: [{ id: otherAssetId, type: 'Asset', name: 'Older resource' }] }));
  await sleep(150);
  assert.ok((await authoringRegion(page).innerText()).includes('Fresh resource'));
  assert.equal((await authoringRegion(page).innerText()).includes('Older resource'), false);
  assert.deepEqual(errors, []);
});

test('does not apply an older publication check to a later selected publication', async (t) => {
  const pending = deferred<ServerResponse>();
  const otherActionId = 'action:other-publication';
  const first = makeDraft({ id: assetDraftId, kind: 'asset', fields: {}, publication: { actionId, resourceIds: [assetId] } });
  const second = makeDraft({ id: secondDraftId, kind: 'asset', fields: {}, publication: { actionId: otherActionId, resourceIds: [otherAssetId] } });
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library') return libraryPage(accountA, { drafts: [first, second] });
    if (request.pathname === `/api/activity/${encodeURIComponent(actionId)}/refresh`) return pending.promise;
    if (request.pathname === `/api/activity/${encodeURIComponent(actionId)}`) return actionDetail(makeAction({ resultReferences: [{ kind: 'resource', id: assetId }] }));
    if (request.pathname === `/api/activity/${encodeURIComponent(otherActionId)}`) return actionDetail(makeAction({ id: otherActionId, resultReferences: [{ kind: 'resource', id: otherAssetId }] }));
    return { status: 404, body: { error: 'unexpected request' } };
  });
  await publicationActionButton(page, actionId).click();
  const publication = page.getByRole('region', { name: 'Publication', exact: true });
  await waitForText(publication, actionId, 'expected first publication');
  await button(publication, /^Check publication$/i).click();
  await waitFor(() => requestsFor(requests, `/api/activity/${encodeURIComponent(actionId)}/refresh`).length === 1, 'expected check');
  await publicationActionButton(page, otherActionId).click();
  await waitForText(publication, otherActionId, 'expected second publication');
  pending.resolve(actionDetail(makeAction({ resultReferences: [{ kind: 'resource', id: assetId }] })));
  await sleep(150);
  assert.ok((await publication.innerText()).includes(otherActionId));
  assert.equal((await publication.innerText()).includes(assetId), false, 'older check must not contaminate the later resource set');
  assert.deepEqual(errors, []);
});

async function selectCandidate(dialog: Locator, name: string): Promise<void> {
  await button(dialog, new RegExp(`^Select ${escapeRegExp(name)}$`, 'i')).click();
}

test('retains one Library snapshot, keeps independent source states, and refreshes only when requested', async (t) => {
  const catalogSource = 'https://authority.invalid/local/authoring';
  const creationsSource = 'https://actor.invalid/actors/player/creations';
  let refreshCalls = 0;
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library' && request.method === 'GET') {
      return libraryPage(accountA, {
        assets: [{ id: assetId, type: 'Asset', name: 'Rope', holder: 'https://actors.invalid/player' }],
        varieties: [{ id: varietyId, type: 'Variety', name: 'Alloy', asset: assetId }],
        grants: [{ id: grantId, type: 'AssetGrant', name: 'Rope grant', grantee: 'https://actors.invalid/player', asset: assetId }],
        drafts: [makeDraft({ id: assetDraftId, kind: 'asset', fields: { name: 'Loose Rope', text: '' } })],
        observations: {
          [`authoring:${accountA}:catalog:${catalogSource}`]: stale(catalogSource, { assets: [] }, 'catalog observation is stale', observedAt),
          [`authoring:${accountA}:creations:${creationsSource}`]: unavailable(creationsSource, 'creations are unavailable', laterAt),
          [`authoring:${accountA}:missing`]: notRetrieved('https://authority.invalid/catalog-missing')
        }
      });
    }
    if (request.pathname === '/api/library/refresh' && request.method === 'POST') {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return libraryPage(accountA, {
          assets: [{ id: assetId, type: 'Asset', name: 'Fresh Rope' }],
          drafts: [makeDraft({ id: assetDraftId, kind: 'asset', fields: { name: 'Loose Rope', text: '' }, savedAt: freshAt })],
          observations: {
            [`authoring:${accountA}:catalog:${catalogSource}`]: available(catalogSource, { assets: [] }, freshAt)
          }
        });
      }
      return { status: 503, body: { error: 'refresh unavailable' } };
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });

  const region = await waitForRegion(page);
  const initial = await waitForText(region, 'Rope', 'expected retained Library assets');
  assert.ok(initial.includes('Alloy'), 'expected retained Library varieties');
  assert.ok(initial.includes('Rope grant'), 'expected retained Library grants');
  assert.ok(initial.includes('Loose Rope'), 'expected retained drafts by name');
  await draftButton(page, assetDraftId).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.ok(initial.includes(catalogSource), 'expected the stale catalog source');
  assert.ok(initial.includes(creationsSource), 'expected the unavailable creations source');
  assert.ok(initial.includes('catalog observation is stale'), 'expected the independent catalog error');
  assert.ok(initial.includes('creations are unavailable'), 'expected the independent creations error');
  assert.match(initial, /stale/i);
  assert.match(initial, /unavailable/i);
  assert.match(initial, /not.?retrieved/i);
  await waitForButton(region, /^New Asset$/i, 'expected a New Asset control');
  await waitForButton(region, /^New Variety$/i, 'expected a New Variety control');

  const reads = requestsFor(requests, '/api/library', 'GET');
  assert.equal(reads.length, 1, 'opening Authoring must read the retained Library exactly once');
  assert.equal(reads[0]?.params.accountId, accountA);
  assert.equal(reads[0]?.headers.authorization, 'Bearer token-a');
  assert.equal(requestsFor(requests, '/api/library/refresh').length, 0, 'opening Authoring must not observe the Library');

  await waitForButton(region, /^Refresh Library$/i, 'expected an explicit Library refresh control').then((entry) => entry.click());
  await waitForText(region, 'Fresh Rope', 'expected the explicit Library refresh result');
  const refreshes = requestsFor(requests, '/api/library/refresh', 'POST');
  assert.equal(refreshes.length, 1);
  assert.deepEqual(refreshes[0]?.body, { accountId: accountA });
  assert.equal(refreshes[0]?.headers.authorization, 'Bearer token-a');
  assert.equal(requestsFor(requests, '/api/library', 'GET').length, 1, 'explicit Refresh must not repeat the retained GET');

  await button(region, /^Refresh Library$/i).click();
  const failed = await waitForText(region, /refresh unavailable/i, 'expected the refresh failure');
  assert.ok(failed.includes('Fresh Rope'), 'a failed refresh must retain the prior Library data');
  assert.doesNotMatch(failed, /no assets|library is empty|no drafts/i, 'a refresh failure must not be presented as an empty Library');
  assert.equal(requestsFor(requests, '/api/library/refresh').length, 2);
  assert.equal(requestsFor(requests, '/api/library', 'GET').length, 1);
  assert.deepEqual(errors, []);
});

test('creates incomplete drafts in separate editors, reopens the exact retained draft, and preserves unknown extensions across hide/show and save', async (t) => {
  const reopenFields: Record<string, unknown> = {
    name: 'Loose Rope',
    text: '',
    tags: ['draft'],
    extensions: { nested: { keep: true } }
  };
  let assetStored = makeDraft({ id: assetDraftId, kind: 'asset', fields: reopenFields, savedAt: observedAt });
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library' && request.method === 'GET') {
      return libraryPage(accountA);
    }
    if (request.pathname === '/api/drafts' && request.method === 'POST') {
      const body = asRecord(request.body);
      const kind = body.kind === 'variety' ? 'variety' : 'asset';
      const draft = makeDraft({
        id: kind === 'asset' ? assetDraftId : varietyDraftId,
        kind,
        fields: kind === 'asset' ? { ...reopenFields, ...requestFields(request) } : requestFields(request),
        savedAt: observedAt
      });
      if (kind === 'asset') assetStored = draft;
      return { status: 201, body: { draft } };
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(assetDraftId)}` && request.method === 'GET') {
      return { body: { draft: assetStored } };
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(assetDraftId)}` && request.method === 'POST') {
      assetStored = makeDraft({ id: assetDraftId, kind: 'asset', fields: requestFields(request), savedAt: laterAt });
      return { body: { draft: assetStored } };
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });

  const region = await waitForRegion(page);
  await waitForText(region, /no assets|library is empty|nothing.*(asset|draft)/i, 'expected an honest empty Library state');
  await button(region, /^New Asset$/i).click();

  const assetEditor = await editorRegion(page, 'Asset');
  await waitForText(assetEditor, /Asset draft/i, 'expected the dedicated Asset editor');
  await assetEditor.getByLabel(/^Name$/i).fill('Loose Rope');
  await button(assetEditor, /^Save draft$/i).click();
  await waitFor(() => requestsFor(requests, '/api/drafts', 'POST').length === 1, 'expected the incomplete Asset draft to be created');
  const create = requestsFor(requests, '/api/drafts', 'POST')[0]!;
  assert.deepEqual(create.body && { accountId: asRecord(create.body).accountId, kind: asRecord(create.body).kind }, { accountId: accountA, kind: 'asset' });
  const createdFields = requestFields(create);
  assert.equal(createdFields.name, 'Loose Rope');
  assert.equal(createdFields.text, '');
  for (const forbidden of ['accountId', 'holder', 'endpoint', 'target']) {
    assert.equal(Object.hasOwn(createdFields, forbidden), false, `draft fields must not carry ${forbidden}`);
  }
  assert.equal(create.headers.authorization, 'Bearer token-a');
  await draftButton(page, assetDraftId).waitFor({ state: 'visible', timeout: settleTimeout });

  await button(assetEditor, /^Close editor$/i).click();
  await button(region, /^New Variety$/i).click();
  const varietyEditor = await editorRegion(page, 'Variety');
  await varietyEditor.getByLabel(/^Name$/i).fill('Alloy');
  assert.equal(await varietyEditor.getByLabel(/^Text$/i).count(), 0, 'the Variety editor must not expose Asset fields');
  await button(varietyEditor, /^Save draft$/i).click();
  await waitFor(() => requestsFor(requests, '/api/drafts', 'POST').length === 2, 'expected the incomplete Variety draft to be created');
  const varietyCreate = requestsFor(requests, '/api/drafts', 'POST')[1]!;
  assert.equal(asRecord(varietyCreate.body).kind, 'variety');
  assert.equal(requestFields(varietyCreate).name, 'Alloy');

  await button(varietyEditor, /^Close editor$/i).click();
  await draftButton(page, assetDraftId).click();
  await waitFor(() => requestsFor(requests, `/api/drafts/${encodeURIComponent(assetDraftId)}`, 'GET').length === 1, 'expected the retained draft GET');
  const read = requestsFor(requests, `/api/drafts/${encodeURIComponent(assetDraftId)}`, 'GET')[0]!;
  assert.equal(read.params.accountId, accountA);
  assert.equal(read.headers.authorization, 'Bearer token-a');
  const reopened = await editorRegion(page, 'Asset');
  assert.equal(await reopened.getByLabel(/^Name$/i).inputValue(), 'Loose Rope');
  assert.equal(await reopened.getByLabel(/^Text$/i).inputValue(), '');

  await button(reopened, /^Save draft$/i).click();
  await waitFor(() => requestsFor(requests, `/api/drafts/${encodeURIComponent(assetDraftId)}`, 'POST').length === 1, 'expected a no-op save');
  const noOp = requestsFor(requests, `/api/drafts/${encodeURIComponent(assetDraftId)}`, 'POST')[0]!;
  assert.deepEqual(requestFields(noOp), reopenFields, 'a no-op save must preserve every unknown top-level and nested extension');

  await reopened.getByLabel(/^Text$/i).fill('Edited text');
  await setVisible(page, false);
  await setVisible(page, true);
  assert.equal(await reopened.getByLabel(/^Text$/i).inputValue(), 'Edited text', 'hiding the tab must retain unsaved fields');
  assert.equal(requestsFor(requests, '/api/library', 'GET').length, 1, 'showing the tab again must not reread the Library');

  await button(reopened, /^Save draft$/i).click();
  await waitFor(() => requestsFor(requests, `/api/drafts/${encodeURIComponent(assetDraftId)}`, 'POST').length === 2, 'expected the edited draft save');
  const saved = requestsFor(requests, `/api/drafts/${encodeURIComponent(assetDraftId)}`, 'POST')[1]!;
  assert.deepEqual(requestFields(saved), { ...reopenFields, text: 'Edited text' }, 'editing one field must preserve the retained extensions');
  assert.equal(saved.headers.authorization, 'Bearer token-a');
  assert.deepEqual(errors, []);
});

function initialProductionFields(): ProductionFields {
  return {
    name: 'Alloy',
    mass: 12.5,
    version: '1.2',
    asset: assetId,
    extensionTop: { keep: true },
    production: [
      {
        type: 'manufacture',
        duration: 4,
        tool: toolId,
        extensionEntry: { keep: 'entry' },
        ingredients: [
          { variety: oreId, count: 2, data: { grade: 'A' }, extensionStack: { keep: 'stack' } },
          { id: itemId, variety: catalystId, data: { reusable: false }, extensionItem: { keep: 'item' } }
        ],
        location: [
          { id: areaNorthId, name: 'North Foundry', territory: territoryId, extensionArea: { keep: 'area' } }
        ],
        yield: [
          { probability: 0.8, count: 1, data: { purity: 'standard' }, extensionYield: { keep: 'y1' } },
          { probability: 0.2, count: 2, data: { purity: 'high' } },
          { probability: -0.5, count: 1, data: {} },
          { probability: 2.5, count: 1, data: {} }
        ],
        extensionFlags: ['x']
      },
      {
        type: 'mine',
        duration: 1,
        yield: [{ probability: 1, count: 3, data: {} }],
        extensionSecond: { keep: true }
      }
    ]
  };
}

test('round-trips extension-bearing structured Production without normalizing probabilities or losing sibling entries', async (t) => {
  let stored = makeDraft({ id: productionDraftId, kind: 'variety', fields: initialProductionFields(), savedAt: observedAt });
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library' && request.method === 'GET') {
      return libraryPage(accountA, { drafts: [stored] });
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(productionDraftId)}` && request.method === 'GET') {
      return { body: { draft: stored } };
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(productionDraftId)}` && request.method === 'POST') {
      stored = makeDraft({ id: productionDraftId, kind: 'variety', fields: requestFields(request), savedAt: laterAt });
      return { body: { draft: stored } };
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });

  const region = await waitForRegion(page);
  await waitForText(region, 'Alloy', 'expected the retained Production draft');
  await draftButton(page, productionDraftId).click();
  const editor = await editorRegion(page, 'Variety');
  const entryOne = group(editor, /^Production entry 1$/i);
  const entryTwo = group(editor, /^Production entry 2$/i);
  await entryOne.waitFor({ state: 'visible', timeout: settleTimeout });
  await entryTwo.waitFor({ state: 'visible', timeout: settleTimeout });
  assert.match(await entryOne.innerText(), /manufacture/i);
  assert.match(await entryTwo.innerText(), /mine/i);
  assert.equal(await entryOne.getByLabel(/^Duration$/i).inputValue(), '4');
  assert.equal(await entryOne.getByLabel(/^Tool$/i).inputValue(), toolId);
  const stack = group(entryOne, /^Stack ingredient 1$/i);
  const item = group(entryOne, /^Item ingredient 1$/i);
  const location = group(entryOne, /^Location 1$/i);
  const yieldOne = group(entryOne, /^Yield 1$/i);
  const yieldTwo = group(entryOne, /^Yield 2$/i);
  assert.equal(await stack.getByLabel(/^Variety$/i).inputValue(), oreId);
  assert.equal(await stack.getByLabel(/^Count$/i).inputValue(), '2');
  assert.equal(await item.getByLabel(/^Item ID$/i).inputValue(), itemId);
  assert.equal(await item.getByLabel(/^Variety$/i).inputValue(), catalystId);
  assert.equal(await location.getByLabel(/^Area ID$/i).inputValue(), areaNorthId);
  assert.equal(await location.getByLabel(/^Area name$/i).inputValue(), 'North Foundry');
  assert.equal(await location.getByLabel(/^Territory$/i).inputValue(), territoryId);
  assert.equal(await yieldOne.getByLabel(/^Probability$/i).inputValue(), '0.8');
  assert.equal(await yieldTwo.getByLabel(/^Probability$/i).inputValue(), '0.2');

  await button(editor, /^Save draft$/i).click();
  await waitFor(() => requestsFor(requests, `/api/drafts/${encodeURIComponent(productionDraftId)}`, 'POST').length === 1, 'expected the no-op Production save');
  const noOp = requestsFor(requests, `/api/drafts/${encodeURIComponent(productionDraftId)}`, 'POST')[0]!;
  assert.deepEqual(requestFields(noOp), initialProductionFields(), 'a no-op save must preserve all extension fields and probability values');

  await entryTwo.getByLabel(/^Duration$/i).fill('7');
  await group(entryTwo, /^Yield 1$/i).getByLabel(/^Count$/i).fill('5');
  await button(entryOne, /^Add stack ingredient$/i).click();
  const stackTwo = group(entryOne, /^Stack ingredient 2$/i);
  await stackTwo.getByLabel(/^Variety$/i).fill(spareVarietyId);
  await stackTwo.getByLabel(/^Count$/i).fill('1');
  await stackTwo.getByLabel(/^Data$/i).fill('{"extra":true}');
  await button(entryOne, /^Add location$/i).click();
  const locationTwo = group(entryOne, /^Location 2$/i);
  await locationTwo.getByLabel(/^Area ID$/i).fill(areaSouthId);
  await locationTwo.getByLabel(/^Area name$/i).fill('South Mine');
  await locationTwo.getByLabel(/^Territory$/i).fill(territoryId);

  await button(editor, /^Save draft$/i).click();
  await waitFor(() => requestsFor(requests, `/api/drafts/${encodeURIComponent(productionDraftId)}`, 'POST').length === 2, 'expected the edited Production save');
  const expected = JSON.parse(JSON.stringify(initialProductionFields())) as ProductionFields;
  const first = expected.production![0]!;
  const second = expected.production![1]!;
  first.ingredients!.push({ variety: spareVarietyId, count: 1, data: { extra: true } });
  first.location!.push({ id: areaSouthId, name: 'South Mine', territory: territoryId });
  second.duration = 7;
  second.yield[0]!.count = 5;
  const edited = requestsFor(requests, `/api/drafts/${encodeURIComponent(productionDraftId)}`, 'POST')[1]!;
  assert.deepEqual(requestFields(edited), expected, 'editing one entry must not alter sibling entry extensions or normalize probabilities');

  await button(editor, /^Close editor$/i).click();
  await waitForText(region, 'Alloy', 'expected the updated retained draft');
  await draftButton(page, productionDraftId).click();
  const reopened = await editorRegion(page, 'Variety');
  await button(reopened, /^Save draft$/i).click();
  await waitFor(() => requestsFor(requests, `/api/drafts/${encodeURIComponent(productionDraftId)}`, 'POST').length === 3, 'expected the re-opened no-op save');
  const roundtrip = requestsFor(requests, `/api/drafts/${encodeURIComponent(productionDraftId)}`, 'POST')[2]!;
  assert.deepEqual(requestFields(roundtrip), expected, 'reopening and saving must preserve the edited extensions');
  assert.deepEqual(errors, []);
});

test('keeps invalid Production text editable, blocks publication without normalization, and lets advanced JSON stay invalid until corrected', async (t) => {
  const initial: ProductionFields = {
    name: 'Alloy',
    mass: 2,
    version: '1',
    production: [
      {
        type: 'manufacture',
        duration: 4,
        extensionEntry: { keep: true },
        ingredients: [{ variety: oreId, count: 2, data: {} }],
        yield: [{ probability: 0.8, count: 1, data: {} }]
      }
    ]
  };
  let stored = makeDraft({ id: varietyDraftId, kind: 'variety', fields: initial, savedAt: observedAt });
  let saveCalls = 0;
  let publishCalls = 0;
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library' && request.method === 'GET') {
      return libraryPage(accountA, { drafts: [stored] });
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(varietyDraftId)}` && request.method === 'GET') {
      return { body: { draft: stored } };
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(varietyDraftId)}` && request.method === 'POST') {
      saveCalls += 1;
      stored = makeDraft({ id: varietyDraftId, kind: 'variety', fields: requestFields(request), savedAt: laterAt });
      return { body: { draft: stored } };
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(varietyDraftId)}/publish` && request.method === 'POST') {
      publishCalls += 1;
      return {
        body: {
          action: makeAction({ id: actionId, submission: { status: 'accepted' }, outcome: { status: 'pending', evidence: [] } }),
          draft: makeDraft({ id: varietyDraftId, kind: 'variety', fields: stored.fields as Record<string, unknown>, publication: { actionId } })
        }
      };
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });

  const region = await waitForRegion(page);
  await waitForText(region, 'Alloy', 'expected the retained Variety draft');
  await draftButton(page, varietyDraftId).click();
  const editor = await editorRegion(page, 'Variety');
  const entry = group(editor, /^Production entry 1$/i);
  const stack = group(entry, /^Stack ingredient 1$/i);
  const yieldOne = group(entry, /^Yield 1$/i);

  await entry.getByLabel(/^Duration$/i).fill('-1');
  await button(editor, /^Save draft$/i).click();
  await waitFor(() => saveCalls === 1, 'expected an invalid draft to remain saveable');
  const invalidDurationSave = requestFields(requestsFor(requests, `/api/drafts/${encodeURIComponent(varietyDraftId)}`, 'POST')[0]!);
  assert.equal(Number((invalidDurationSave.production as ProductionEntryShape[])[0]!.duration), -1);

  await button(editor, /^Publish draft$/i).click();
  const durationError = await waitForText(editor, /duration.*(unsigned|non-negative|integer)|integer.*duration/i, 'expected duration validation');
  assert.ok(durationError.includes('Duration') || /production/i.test(durationError));
  assert.equal(publishCalls, 0, 'invalid duration must not publish');

  await entry.getByLabel(/^Duration$/i).fill('4');
  await yieldOne.getByLabel(/^Probability$/i).fill('');
  await button(editor, /^Save draft$/i).click();
  await waitFor(() => saveCalls === 2, 'expected the next draft save');
  await button(editor, /^Publish draft$/i).click();
  await waitForText(editor, /probability.*(finite|number|required)|(finite|number).*probability/i, 'expected probability validation');
  assert.equal(publishCalls, 0, 'a non-finite probability must not publish');

  await yieldOne.getByLabel(/^Probability$/i).fill('0.8');
  await yieldOne.getByLabel(/^Count$/i).fill('-2');
  await button(editor, /^Save draft$/i).click();
  await waitFor(() => saveCalls === 3, 'expected the next draft save');
  await button(editor, /^Publish draft$/i).click();
  await waitForText(editor, /count.*(unsigned|non-negative|integer)|integer.*count/i, 'expected count validation');
  assert.equal(publishCalls, 0, 'a negative yield count must not publish');

  await yieldOne.getByLabel(/^Count$/i).fill('1');
  await stack.getByLabel(/^Data$/i).fill('{bad');
  await button(editor, /^Save draft$/i).click();
  await waitForText(editor, /invalid JSON|JSON object/i, 'expected invalid quantity data to remain an error');
  assert.equal(saveCalls, 3, 'unparseable JSON must not be silently serialized or reset');
  assert.equal(await stack.getByLabel(/^Data$/i).inputValue(), '{bad', 'invalid JSON must remain editable');
  await stack.getByLabel(/^Data$/i).fill('{}');

  const advanced = editor.getByRole('checkbox', { name: /Advanced Production JSON/i });
  await advanced.check();
  const productionJson = editor.getByLabel(/^Production JSON$/i);
  const raw = await productionJson.inputValue();
  assert.match(raw, /manufacture/i);
  assert.match(raw, /extensionEntry/);
  await productionJson.fill('[');
  await waitForText(editor, /invalid JSON/i, 'expected advanced JSON validation');
  assert.equal(saveCalls, 3, 'invalid advanced JSON must not save');
  assert.equal(await productionJson.inputValue(), '[', 'invalid advanced JSON must not be reset');
  await advanced.uncheck();
  await group(editor, /^Production entry 1$/i).waitFor({ state: 'visible', timeout: settleTimeout });
  await advanced.check();
  assert.equal(await productionJson.inputValue(), '[', 'switching modes must retain the invalid advanced buffer');
  await advanced.uncheck();

  await button(editor, /^Save draft$/i).click();
  await waitFor(() => saveCalls === 4, 'expected the corrected structured save');
  await button(editor, /^Publish draft$/i).click();
  await waitFor(() => publishCalls === 1, 'expected a valid draft to publish');
  assert.deepEqual(errors, []);
});

test('validates retained Production shapes before publishing without rejecting supported extensions or finite probabilities', async (t) => {
  const valid = {
    type: 'mine', duration: 0,
    ingredients: [{ id: itemId, variety: oreId, count: 2, data: {}, extension: true }],
    location: [{ id: areaNorthId, name: '', territory: territoryId, extension: true }],
    tool: 'urn:tool:press',
    yield: [{ probability: -0.5, count: 0, data: {} }, { probability: 2.5, count: 1, data: {} }],
    extension: { keep: true }
  };
  const invalid: Record<string, unknown>[] = [
    { ...valid, type: 'execute' },
    { ...valid, ingredients: {} },
    { ...valid, location: {} },
    { ...valid, yield: undefined },
    { ...valid, tool: '/relative/tool' },
    { ...valid, ingredients: [{ variety: '/relative/variety', count: 1, data: {} }] },
    { ...valid, ingredients: [{ id: '/relative/item', variety: oreId, data: {} }] },
    { ...valid, ingredients: [{ variety: oreId, count: 1, data: [] }] },
    { ...valid, location: [{ id: areaNorthId }] },
    { ...valid, yield: [{ probability: 1, count: 1 }] }
  ];
  const drafts = [...invalid, valid].map((entry, index) => makeDraft({
    id: `validation:${index}`, kind: 'variety', fields: { name: `Validation ${index}`, mass: 1, version: '1', production: [entry] }
  }));
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library') return libraryPage(accountA, { drafts });
    const draft = drafts.find((entry) => request.pathname === `/api/drafts/${encodeURIComponent(String(entry.id))}`);
    if (draft) return { body: { draft } };
    if (request.pathname.endsWith('/publish')) {
      return { body: { draft: drafts.at(-1), action: makeAction({ id: actionId }) } };
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });
  await waitForRegion(page);
  await waitForText(authoringRegion(page), 'Validation 0', 'expected validation drafts');
  for (let index = 0; index < invalid.length; index += 1) {
    await draftButton(page, `validation:${index}`).click();
    const editor = await editorRegion(page, 'Variety');
    await waitFor(async () => await editor.getByLabel(/^Name$/i).inputValue() === `Validation ${index}`, 'expected selected validation draft');
    await button(editor, /^Publish draft$/i).click();
    await waitFor(async () => await editor.getByRole('alert').count() > 0, `expected validation error for shape ${index}`);
    assert.equal(requests.filter((request) => request.pathname.endsWith('/publish')).length, 0, `invalid shape ${index} must not publish`);
  }
  await draftButton(page, `validation:${invalid.length}`).click();
  const editor = await editorRegion(page, 'Variety');
  await waitFor(async () => await editor.getByLabel(/^Name$/i).inputValue() === `Validation ${invalid.length}`, 'expected valid draft');
  await button(editor, /^Publish draft$/i).click();
  await waitFor(() => requests.filter((request) => request.pathname.endsWith('/publish')).length === 1, 'supported Production must publish');
  assert.deepEqual(errors, []);
});

test('returns each Asset, tool, Variety, and Area selection to its exact field and preserves Area extensions and picker state', async (t) => {
  const pickerFields: ProductionFields = {
    name: 'Alloy',
    mass: 2,
    version: '1',
    asset: assetId,
    production: [
      {
        type: 'manufacture',
        duration: 4,
        tool: toolId,
        ingredients: [
          { variety: oreId, count: 2, data: { grade: 'A' } },
          { id: itemId, variety: catalystId, data: { reusable: false } }
        ],
        location: [{ id: areaNorthId, name: 'North Foundry', territory: territoryId, extensionArea: { keep: 'area' } }],
        yield: [{ probability: 0.8, count: 1, data: {} }]
      }
    ]
  };
  let stored = makeDraft({ id: pickerDraftId, kind: 'variety', fields: pickerFields, savedAt: observedAt });
  let exploreRefreshes = 0;
  const exploreAreas = [
    { id: areaNorthId, type: 'Area', authorityId: territoryId, name: 'North Foundry', territoryId, extensionExplore: { keep: 'north' } },
    { id: areaSouthId, type: 'Area', authorityId: territoryId }
  ];
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library' && request.method === 'GET') {
      return libraryPage(accountA, {
        assets: [
          { id: assetId, type: 'Asset', name: 'Rope' },
          { id: otherAssetId, type: 'Asset', name: 'Crates' },
          { id: toolId, type: 'Asset', name: 'Press' }
        ],
        varieties: [
          { id: varietyId, type: 'Variety', name: 'Alloy', asset: assetId },
          { id: oreId, type: 'Variety', name: 'Ore' },
          { id: catalystId, type: 'Variety', name: 'Catalyst' },
          { id: spareVarietyId, type: 'Variety', name: 'Spare' }
        ],
        drafts: [stored]
      });
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(pickerDraftId)}` && request.method === 'GET') {
      return { body: { draft: stored } };
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(pickerDraftId)}` && request.method === 'POST') {
      stored = makeDraft({ id: pickerDraftId, kind: 'variety', fields: requestFields(request), savedAt: laterAt });
      return { body: { draft: stored } };
    }
    if (request.pathname === '/api/explore/places' && request.method === 'GET') {
      return {
        body: {
          context: { accountId: accountA },
          data: { places: [], connections: [], areas: exploreAreas, maps: [], listings: [], capabilities: [], blockers: [] },
          observations: {},
          actions: []
        }
      };
    }
    if (request.pathname === '/api/explore/refresh' && request.method === 'POST') {
      exploreRefreshes += 1;
      return {
        body: {
          context: { accountId: accountA },
          data: {
            places: [],
            connections: [],
            areas: [...exploreAreas, { id: areaEastId, type: 'Area', authorityId: territoryId, name: 'East Foundry', territoryId }],
            maps: [],
            listings: [],
            capabilities: [],
            blockers: []
          },
          observations: {},
          actions: []
        }
      };
    }
    if (request.pathname === `/api/resources/${encodeURIComponent(assetId)}` && request.method === 'GET') {
      return {
        body: {
          context: { resourceId: assetId, accountId: accountA },
          data: { resourceId: assetId, value: { id: assetId, type: 'Asset', name: 'Rope Details' } },
          observations: { direct: available(assetId, { id: assetId, type: 'Asset', name: 'Rope Details' }) },
          actions: []
        }
      };
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });

  const region = await waitForRegion(page);
  await waitForText(region, 'Alloy', 'expected the retained picker draft');
  await draftButton(page, pickerDraftId).click();
  const editor = await editorRegion(page, 'Variety');
  const entry = group(editor, /^Production entry 1$/i);
  const stack = group(entry, /^Stack ingredient 1$/i);
  const item = group(entry, /^Item ingredient 1$/i);
  const location = group(entry, /^Location 1$/i);

  await editor.getByRole('button', { name: /^Choose variety asset$/i }).click();
  let dialog = openPickerDialog(page, 'Variety asset');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await button(dialog, /^Inspect Rope$/i).click();
  await waitFor(() => requestsFor(requests, `/api/resources/${encodeURIComponent(assetId)}`, 'GET').length === 1, 'expected inspection through the existing reader API');
  const inspect = requestsFor(requests, `/api/resources/${encodeURIComponent(assetId)}`, 'GET')[0]!;
  assert.equal(inspect.params.accountId, accountA);
  assert.equal(inspect.headers.authorization, 'Bearer token-a');
  const reader = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Rope Details' }) });
  await reader.waitFor({ state: 'visible', timeout: settleTimeout });
  await button(reader, /^Close$/i).click();
  await reader.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForActiveText(page, /Inspect Rope/i);
  await button(dialog, /^Cancel$/i).click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForActiveText(page, /Choose variety asset/i);
  assert.equal(await editor.getByLabel(/^Asset$/i).inputValue(), assetId);

  await editor.getByRole('button', { name: /^Choose variety asset$/i }).click();
  dialog = openPickerDialog(page, 'Variety asset');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await selectCandidate(dialog, 'Crates');
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.equal(await editor.getByLabel(/^Asset$/i).inputValue(), otherAssetId, 'Asset selection must reach only the Variety asset field');

  await entry.getByRole('button', { name: /^Choose tool asset$/i }).click();
  dialog = openPickerDialog(page, 'Tool asset');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await selectCandidate(dialog, 'Rope');
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.equal(await entry.getByLabel(/^Tool$/i).inputValue(), assetId, 'tool selection must reach only the tool field');
  assert.equal(await editor.getByLabel(/^Asset$/i).inputValue(), otherAssetId, 'the Variety asset must not change with the tool');

  await stack.getByRole('button', { name: /^Choose ingredient variety$/i }).click();
  dialog = openPickerDialog(page, 'Ingredient variety');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await selectCandidate(dialog, 'Spare');
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.equal(await stack.getByLabel(/^Variety$/i).inputValue(), spareVarietyId);
  assert.equal(await stack.getByLabel(/^Count$/i).inputValue(), '2');
  assert.match(await stack.getByLabel(/^Data$/i).inputValue(), /grade/);
  assert.equal(await stack.getByLabel(/^Item ID$/i).count(), 0, 'a Stack has no Item ID');

  await item.getByRole('button', { name: /^Choose ingredient variety$/i }).click();
  dialog = openPickerDialog(page, 'Ingredient variety');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await selectCandidate(dialog, 'Spare');
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.equal(await item.getByLabel(/^Variety$/i).inputValue(), spareVarietyId);
  assert.equal(await item.getByLabel(/^Item ID$/i).inputValue(), itemId, 'an Item ID must never be inferred from a Variety');

  await location.getByRole('button', { name: /^Choose location area$/i }).click();
  dialog = openPickerDialog(page, 'Location area');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await waitFor(() => requestsFor(requests, '/api/explore/places', 'GET').length === 1, 'expected the retained Explore read');
  const exploreRead = requestsFor(requests, '/api/explore/places', 'GET')[0]!;
  assert.equal(exploreRead.params.accountId, accountA);
  assert.equal(exploreRead.headers.authorization, 'Bearer token-a');
  assert.equal(requestsFor(requests, '/api/explore/refresh').length, 0, 'opening the Area picker must not observe Explore');
  await selectCandidate(dialog, 'North Foundry');
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.equal(await location.getByLabel(/^Area ID$/i).inputValue(), areaNorthId);
  assert.equal(await location.getByLabel(/^Area name$/i).inputValue(), 'North Foundry');
  assert.equal(await location.getByLabel(/^Territory$/i).inputValue(), territoryId);

  await location.getByRole('button', { name: /^Choose location area$/i }).click();
  dialog = openPickerDialog(page, 'Location area');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await button(dialog, /^Refresh$/i).click();
  await waitFor(() => exploreRefreshes === 1, 'expected an explicit Explore refresh');
  const exploreRefresh = requestsFor(requests, '/api/explore/refresh', 'POST')[0]!;
  assert.deepEqual(exploreRefresh.body, { accountId: accountA });
  assert.equal(exploreRefresh.headers.authorization, 'Bearer token-a');
  await waitForText(dialog, 'East Foundry', 'expected the refreshed Area candidates');
  await selectCandidate(dialog, areaSouthId);
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.equal(await location.getByLabel(/^Area ID$/i).inputValue(), areaSouthId);
  assert.equal(await location.getByLabel(/^Area name$/i).inputValue(), '');
  assert.equal(await location.getByLabel(/^Territory$/i).inputValue(), '');
  const missingAreaText = await location.innerText();
  assert.match(missingAreaText, /missing.*(name|territory)|(name|territory).*missing/i, 'missing Area metadata must stay explicit');

  await button(editor, /^Save draft$/i).click();
  await waitFor(() => requestsFor(requests, `/api/drafts/${encodeURIComponent(pickerDraftId)}`, 'POST').length === 1, 'expected the picker edits to save');
  const savedFields = requestFields(requestsFor(requests, `/api/drafts/${encodeURIComponent(pickerDraftId)}`, 'POST')[0]!) as ProductionFields;
  const savedProduction = savedFields.production![0]!;
  assert.equal(savedProduction.tool, assetId);
  assert.equal(savedFields.asset, otherAssetId);
  assert.equal((savedProduction.ingredients![0] as Record<string, unknown>).variety, spareVarietyId);
  assert.equal((savedProduction.ingredients![1] as Record<string, unknown>).variety, spareVarietyId);
  assert.equal((savedProduction.ingredients![1] as Record<string, unknown>).id, itemId);
  const savedArea = savedProduction.location![0] as Record<string, unknown>;
  assert.equal(savedArea.id, areaSouthId);
  assert.deepEqual(savedArea.extensionArea, { keep: 'area' }, 'selecting an Area must not replace unknown Area extensions');
  assert.ok(savedArea.name === undefined || savedArea.name === '', 'a missing Area name must not be fabricated');
  assert.ok(savedArea.territory === undefined || savedArea.territory === '', 'a missing Territory must not be fabricated');
  assert.equal(requestsFor(requests, '/api/library', 'GET').length, 1, 'field pickers must reuse the workspace Library snapshot');
  assert.equal(requestsFor(requests, '/api/explore/places', 'GET').length, 1, 'the Area picker must use one retained Explore read');
  assert.deepEqual(errors, []);
});

test('publishes only saved fields, keeps acknowledgment distinct from evidenced readback, and never republishes after a failed check', async (t) => {
  let stored = makeDraft({
    id: publicationDraftId,
    kind: 'asset',
    fields: { name: 'Rope', text: 'A useful rope.' },
    savedAt: observedAt
  });
  let publishCalls = 0;
  let refreshCalls = 0;
  let readCalls = 0;
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library' && request.method === 'GET') {
      return libraryPage(accountA, { drafts: [stored] });
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(publicationDraftId)}` && request.method === 'GET') {
      return { body: { draft: stored } };
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(publicationDraftId)}` && request.method === 'POST') {
      stored = makeDraft({ id: publicationDraftId, kind: 'asset', fields: requestFields(request), savedAt: laterAt });
      return { body: { draft: stored } };
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(publicationDraftId)}/publish` && request.method === 'POST') {
      publishCalls += 1;
      const action = makeAction({
        id: actionId,
        resultReferences: [
          { kind: 'resource', id: assetId },
          { kind: 'resource', id: grantId }
        ],
        submission: { status: 'accepted' },
        outcome: { status: 'pending', evidence: [] }
      });
      stored = makeDraft({
        id: publicationDraftId,
        kind: 'asset',
        fields: stored.fields as Record<string, unknown>,
        savedAt: laterAt,
        publication: { actionId, resourceIds: [assetId, grantId] }
      });
      return { body: { action, draft: stored } };
    }
    if (request.pathname === `/api/activity/${encodeURIComponent(actionId)}/refresh` && request.method === 'POST') {
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return actionDetail(makeAction({
          id: actionId,
          resultReferences: [
            { kind: 'resource', id: assetId },
            { kind: 'resource', id: grantId }
          ],
          submission: { status: 'accepted' },
          outcome: {
            status: 'completed',
            evidence: [
              { source: evidenceSource, observedAt: freshAt, changes: { id: assetId, type: 'Asset' } },
              { source: grantId, observedAt: freshAt, changes: { id: grantId, type: 'AssetGrant' } }
            ]
          }
        }));
      }
      return { status: 503, body: { error: 'readback unavailable' } };
    }
    if (request.pathname === `/api/activity/${encodeURIComponent(actionId)}` && request.method === 'GET') {
      readCalls += 1;
      return actionDetail(makeAction({
        id: actionId,
        resultReferences: [
          { kind: 'resource', id: assetId },
          { kind: 'resource', id: grantId }
        ],
        submission: { status: 'accepted' },
        outcome: { status: 'pending', evidence: [] }
      }));
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });

  const region = await waitForRegion(page);
  await waitForText(region, 'Rope', 'expected the retained publication draft');
  await draftButton(page, publicationDraftId).click();
  const editor = await editorRegion(page, 'Asset');
  await waitFor(async () => (await editor.getByLabel(/^Name$/i).inputValue()) === 'Rope', 'expected the retained draft fields');
  const publish = button(editor, /^Publish draft$/i);
  assert.equal(await publish.isDisabled(), false, 'a clean saved draft may publish without edits');
  await editor.getByLabel(/^Name$/i).fill('Rope Prime');
  await waitForText(editor, /save.*(before|first).*publish|unsaved changes/i, 'expected save-before-publish guidance');
  assert.equal(await publish.isDisabled(), true, 'unsaved fields must not publish');
  assert.equal(publishCalls, 0);

  await button(editor, /^Save draft$/i).click();
  await waitFor(() => requestsFor(requests, `/api/drafts/${encodeURIComponent(publicationDraftId)}`, 'POST').length === 1, 'expected the publication draft save');
  await waitFor(async () => !(await publish.isDisabled()), 'expected Publish after saving');
  assert.equal(requestFields(requestsFor(requests, `/api/drafts/${encodeURIComponent(publicationDraftId)}`, 'POST')[0]!).name, 'Rope Prime');
  assert.equal(publishCalls, 0, 'saving must be distinct from publishing');

  await publish.click();
  await waitFor(() => publishCalls === 1, 'expected one publish request');
  const publishRequest = requestsFor(requests, `/api/drafts/${encodeURIComponent(publicationDraftId)}/publish`, 'POST')[0]!;
  assert.equal(publishRequest.headers.authorization, 'Bearer token-a');
  assert.deepEqual(publishRequest.body, { accountId: accountA });
  const accepted = await waitForText(region, actionId, 'expected the accepted publication action');
  assert.ok(accepted.includes(assetId), 'expected the returned resource reference');
  assert.ok(accepted.includes(grantId), 'expected the returned grant reference');
  assert.match(accepted, /accepted/i);
  assert.doesNotMatch(accepted, /outcome[\s\S]{0,60}completed/i, 'an acknowledgment is not completion');
  await sleep(300);
  assert.equal(refreshCalls, 0, 'publishing must not automatically read back');
  assert.equal(publishCalls, 1);

  await resourceButton(page, assetId).click();
  await resourceButton(page, grantId).click();
  await button(region, /^Open Activity$/i).click();
  const calls = await fixtureSnapshot(page);
  assert.deepEqual(calls.reads, [{ id: assetId }, { id: grantId }], 'resource and grant references must use their exact IDs');
  assert.deepEqual(calls.actions, [{ actionId }], 'Activity must open the exact publication action');

  await button(region, /^Check publication$/i).click();
  await waitFor(() => refreshCalls === 1, 'expected the explicit publication readback');
  const refresh = requestsFor(requests, `/api/activity/${encodeURIComponent(actionId)}/refresh`, 'POST')[0]!;
  assert.deepEqual(refresh.body, { accountId: accountA });
  assert.equal(refresh.headers.authorization, 'Bearer token-a');
  const verified = await waitForText(region, `Evidence ${evidenceSource}`, 'expected evidenced readback');
  assert.match(verified, /completed|verified/i);
  assert.ok(verified.includes(assetId), 'readback must retain the resource reference');

  await button(region, /^Check publication$/i).click();
  const failed = await waitForText(region, /readback unavailable|refresh failed|could not refresh/i, 'expected the failed readback');
  assert.ok(failed.includes(assetId), 'failed readback must retain the resource reference');
  assert.ok(failed.includes(grantId), 'failed readback must retain the grant reference');
  assert.equal(publishCalls, 1, 'failed readback must not republish');
  assert.equal(refreshCalls, 2);

  await button(editor, /^Close editor$/i).click();
  await publicationActionButton(page, actionId).click();
  await waitFor(() => readCalls === 1, 'expected the retained publication action read');
  const read = requestsFor(requests, `/api/activity/${encodeURIComponent(actionId)}`, 'GET')[0]!;
  assert.equal(read.params.accountId, accountA);
  assert.equal(read.headers.authorization, 'Bearer token-a');
  assert.equal(refreshCalls, 2, 'reopening the publication action must use the retained GET, not refresh');
  assert.deepEqual(errors, []);
});

test('rejects returned drafts that are not owned by the requested account or do not match the exact draft being saved', async (t) => {
  const createFixture = await openFixture(t, (request) => {
    if (request.pathname === '/api/library' && request.method === 'GET') return libraryPage(accountA);
    if (request.pathname === '/api/drafts' && request.method === 'POST') {
      return {
        status: 201,
        body: {
          draft: makeDraft({
            id: mismatchDraftId,
            accountId: accountB,
            kind: 'asset',
            fields: requestFields(request),
            savedAt: observedAt
          })
        }
      };
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });
  const createRegion = await waitForRegion(createFixture.page);
  await (await waitForButton(createRegion, /^New Asset$/i, 'expected a New Asset control')).click();
  const createEditor = await editorRegion(createFixture.page, 'Asset');
  await createEditor.getByLabel(/^Name$/i).fill('Foreign draft');
  await button(createEditor, /^Save draft$/i).click();
  const ownershipError = await waitForText(createRegion, /mismatch|ownership|another account|not owned|unexpected draft/i, 'expected an ownership failure');
  assert.ok(ownershipError.includes('Foreign draft') || (await createEditor.getByLabel(/^Name$/i).inputValue()) === 'Foreign draft', 'failed ownership must retain the editable fields');
  assert.equal(await draftButton(createFixture.page, mismatchDraftId).count(), 0, 'a draft owned by another account must not be adopted');
  assert.deepEqual(createFixture.errors, []);

  const publishFixture = await openFixture(t, (request) => {
    if (request.pathname === '/api/library' && request.method === 'GET') {
      return libraryPage(accountA, {
        drafts: [makeDraft({ id: publicationDraftId, kind: 'variety', fields: { name: 'Alloy', mass: 2, version: '1' } })]
      });
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(publicationDraftId)}` && request.method === 'GET') {
      return { body: { draft: makeDraft({ id: publicationDraftId, kind: 'variety', fields: { name: 'Alloy', mass: 2, version: '1' } }) } };
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(publicationDraftId)}/publish` && request.method === 'POST') {
      return {
        body: {
          action: makeAction({ id: actionId, resultReferences: [{ kind: 'resource', id: assetId }] }),
          draft: makeDraft({
            id: secondDraftId,
            kind: 'variety',
            fields: { name: 'Alloy', mass: 2, version: '1' },
            publication: { actionId, resourceIds: [assetId] }
          })
        }
      };
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });
  await waitForRegion(publishFixture.page);
  await waitForText(authoringRegion(publishFixture.page), 'Alloy', 'expected the publication draft');
  await draftButton(publishFixture.page, publicationDraftId).click();
  const publishEditor = await editorRegion(publishFixture.page, 'Variety');
  await button(publishEditor, /^Publish draft$/i).click();
  await waitForText(authoringRegion(publishFixture.page), /mismatch|exact|unexpected draft|ownership/i, 'expected a mismatched publication draft to be rejected');
  assert.equal(await resourceButton(publishFixture.page, assetId).count(), 0, 'a mismatched draft must not expose returned references');
  assert.equal(await button(authoringRegion(publishFixture.page), /^Open Activity$/i).count(), 0, 'a mismatched draft must not expose a publication action');
  assert.deepEqual(publishFixture.errors, []);
});

test('locks simultaneous saves synchronously and discards a late same-draft response after another draft is opened', async (t) => {
  const draftOne = makeDraft({ id: assetDraftId, kind: 'asset', fields: { name: 'Draft One', text: 'a' }, savedAt: observedAt });
  const draftTwo = makeDraft({ id: secondDraftId, kind: 'asset', fields: { name: 'Draft Two', text: 'b' }, savedAt: laterAt });
  const pendingSave = deferred<ServerResponse>();
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library' && request.method === 'GET') {
      return libraryPage(accountA, { drafts: [draftOne, draftTwo] });
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(assetDraftId)}` && request.method === 'GET') {
      return { body: { draft: draftOne } };
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(secondDraftId)}` && request.method === 'GET') {
      return { body: { draft: draftTwo } };
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(assetDraftId)}` && request.method === 'POST') {
      return pendingSave.promise;
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });

  await waitForRegion(page);
  await waitForText(authoringRegion(page), 'Draft One', 'expected the first retained draft');
  await draftButton(page, assetDraftId).click();
  const editor = await editorRegion(page, 'Asset');
  await editor.getByLabel(/^Text$/i).fill('changed-one');
  const save = button(editor, /^Save draft$/i);
  await save.evaluate((element) => {
    const target = element as HTMLButtonElement;
    target.click();
    target.click();
  });
  await waitFor(() => requestsFor(requests, `/api/drafts/${encodeURIComponent(assetDraftId)}`, 'POST').length === 1, 'expected one locked save');
  await sleep(150);
  assert.equal(requestsFor(requests, `/api/drafts/${encodeURIComponent(assetDraftId)}`, 'POST').length, 1, 'a double click must not submit twice');

  await draftButton(page, secondDraftId).click();
  const secondEditor = await editorRegion(page, 'Asset');
  assert.equal(await secondEditor.getByLabel(/^Name$/i).inputValue(), 'Draft Two');

  pendingSave.resolve({
    body: {
      draft: makeDraft({ id: assetDraftId, kind: 'asset', fields: { name: 'Draft One', text: 'late-one-marker' }, savedAt: freshAt })
    }
  });
  await sleep(250);
  assert.equal(await secondEditor.getByLabel(/^Name$/i).inputValue(), 'Draft Two', 'a late response for another draft must not replace the open draft');
  assert.equal(await secondEditor.getByLabel(/^Text$/i).inputValue(), 'b');
  assert.equal((await page.locator('body').innerText()).includes('late-one-marker'), false, 'late same-draft fields must not resurrect');
  assert.deepEqual(errors, []);
});

test('clears private drafts across account A to B to A, ignores a late old-account save, and writes no browser draft storage', async (t) => {
  const pendingSave = deferred<ServerResponse>();
  const draftA = makeDraft({ id: assetDraftId, kind: 'asset', fields: { name: 'Account A draft', text: 'a-private' }, savedAt: observedAt });
  const draftB = makeDraft({ id: accountBDraftId, accountId: accountB, kind: 'asset', fields: { name: 'Account B draft', text: 'b-only' }, savedAt: laterAt });
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library' && request.method === 'GET') {
      return request.params.accountId === accountB
        ? libraryPage(accountB, { drafts: [draftB] })
        : libraryPage(accountA, { drafts: [draftA] });
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(assetDraftId)}` && request.method === 'GET') {
      return { body: { draft: draftA } };
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(accountBDraftId)}` && request.method === 'GET') {
      return { body: { draft: draftB } };
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(assetDraftId)}` && request.method === 'POST') {
      return pendingSave.promise;
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });

  await waitForRegion(page);
  await waitForText(authoringRegion(page), 'Account A draft', 'expected account A drafts');
  await draftButton(page, assetDraftId).click();
  const firstEditor = await editorRegion(page, 'Asset');
  assert.equal(await firstEditor.getByLabel(/^Text$/i).inputValue(), 'a-private');
  await firstEditor.getByLabel(/^Text$/i).fill('unsaved-a-marker');
  await button(firstEditor, /^Save draft$/i).click();
  await waitFor(() => requestsFor(requests, `/api/drafts/${encodeURIComponent(assetDraftId)}`, 'POST').length === 1, 'expected the account A save');

  await setAccount(page, accountB);
  await waitForText(authoringRegion(page), 'Account B draft', 'expected the account B Library');
  let visible = await page.locator('body').innerText();
  assert.equal(visible.includes('unsaved-a-marker'), false, 'account B must not show account A unsaved fields');
  assert.equal(visible.includes('a-private'), false, 'account B must not show account A retained fields');
  const libraryB = requestsFor(requests, '/api/library', 'GET').filter((request) => request.params.accountId === accountB);
  assert.equal(libraryB.length, 1);
  assert.equal(libraryB[0]?.headers.authorization, 'Bearer token-b');

  pendingSave.resolve({
    body: {
      draft: makeDraft({ id: assetDraftId, kind: 'asset', fields: { name: 'Late A', text: 'late-account-a-marker' }, savedAt: freshAt })
    }
  });
  await sleep(250);
  visible = await page.locator('body').innerText();
  assert.equal(visible.includes('late-account-a-marker'), false, 'a late old-account save must not leak into account B');
  assert.ok(visible.includes('Account B draft'));

  await setAccount(page, accountA);
  await waitFor(() => requestsFor(requests, '/api/library', 'GET').filter((request) => request.params.accountId === accountA).length === 2, 'expected a fresh account A read');
  await waitForText(authoringRegion(page), 'Account A draft', 'expected account A drafts after returning');
  visible = await page.locator('body').innerText();
  assert.equal(visible.includes('unsaved-a-marker'), false, 'old unsaved fields must not resurrect on A to B to A');
  assert.equal(visible.includes('late-account-a-marker'), false, 'a late save must not resurrect on A to B to A');
  const libraryA = requestsFor(requests, '/api/library', 'GET').filter((request) => request.params.accountId === accountA);
  assert.equal(libraryA.at(-1)?.headers.authorization, 'Bearer token-a');
  assert.equal(visible.includes('token-a'), false, 'the client token must never be rendered');

  const localKeys = await page.evaluate(() => Object.keys(localStorage).sort());
  const sessionKeys = await page.evaluate(() => Object.keys(sessionStorage));
  assert.deepEqual(localKeys, ['fctp.client-sessions'], 'Authoring must not persist drafts in browser storage');
  assert.deepEqual(sessionKeys, [], 'Authoring must not add session storage');
  assert.deepEqual(errors, []);
});

test('discards a late save after unmount and shows only fresh server fields after remount', async (t) => {
  const pendingSave = deferred<ServerResponse>();
  const draft = makeDraft({ id: assetDraftId, kind: 'asset', fields: { name: 'Account A draft', text: 'server-text' }, savedAt: observedAt });
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library' && request.method === 'GET') {
      return libraryPage(accountA, { drafts: [draft] });
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(assetDraftId)}` && request.method === 'GET') {
      return { body: { draft } };
    }
    if (request.pathname === `/api/drafts/${encodeURIComponent(assetDraftId)}` && request.method === 'POST') {
      return pendingSave.promise;
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });

  await waitForRegion(page);
  await waitForText(authoringRegion(page), 'Account A draft', 'expected the retained draft');
  await draftButton(page, assetDraftId).click();
  const editor = await editorRegion(page, 'Asset');
  await editor.getByLabel(/^Text$/i).fill('unsaved-unmounted');
  await button(editor, /^Save draft$/i).click();
  await waitFor(() => requestsFor(requests, `/api/drafts/${encodeURIComponent(assetDraftId)}`, 'POST').length === 1, 'expected the save before unmount');
  await unmountAuthoring(page);
  await waitForText(page.locator('main'), /Authoring unmounted/i, 'expected the fixture to unmount Authoring');

  pendingSave.resolve({
    body: {
      draft: makeDraft({ id: assetDraftId, kind: 'asset', fields: { name: 'Late', text: 'late-unmounted-marker' }, savedAt: freshAt })
    }
  });
  await sleep(250);
  assert.equal((await page.locator('body').innerText()).includes('late-unmounted-marker'), false, 'a late save must not populate an unmounted workspace');

  await remountAuthoring(page);
  await waitForRegion(page);
  await waitForText(authoringRegion(page), 'Account A draft', 'expected a fresh Library after remount');
  assert.equal((await page.locator('body').innerText()).includes('late-unmounted-marker'), false, 'remounting must not inherit the late response');
  await draftButton(page, assetDraftId).click();
  const reopened = await editorRegion(page, 'Asset');
  assert.equal(await reopened.getByLabel(/^Text$/i).inputValue(), 'server-text', 'remounting must show fresh retained server fields');
  assert.deepEqual(errors, []);
});

test('uses the workspace-owned contextual ResourceReader when the caller does not provide a read callback', async (t) => {
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library' && request.method === 'GET') {
      return libraryPage(accountA, {
        assets: [{ id: assetId, type: 'Asset', name: 'Rope' }]
      });
    }
    if (request.pathname === `/api/resources/${encodeURIComponent(assetId)}` && request.method === 'GET') {
      return {
        body: {
          context: { resourceId: assetId, accountId: accountA },
          data: { resourceId: assetId, value: { id: assetId, type: 'Asset', name: 'Rope Details' } },
          observations: { direct: available(assetId, { id: assetId, type: 'Asset', name: 'Rope Details' }) },
          actions: []
        }
      };
    }
    return { status: 404, body: { error: 'unexpected request' } };
  }, { callbacks: false });

  const region = await waitForRegion(page);
  await waitForText(region, 'Rope', 'expected the retained asset');
  await resourceButton(page, assetId).click();
  const reader = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Rope Details' }) });
  await reader.waitFor({ state: 'visible', timeout: settleTimeout });
  const read = requestsFor(requests, `/api/resources/${encodeURIComponent(assetId)}`, 'GET')[0];
  assert(read, 'expected the contextual reader GET');
  assert.equal(read.params.accountId, accountA);
  assert.equal(read.headers.authorization, 'Bearer token-a');
  assert.deepEqual(errors, []);
});
