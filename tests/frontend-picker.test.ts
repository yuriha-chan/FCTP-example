import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Locator, type Page } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureOrigin = 'http://fixture.invalid/';
const settleTimeout = 3_000;
const observedAt = '2026-01-02T03:04:05.000Z';
const laterAt = '2026-01-02T04:05:06.000Z';
const directAt = '2026-01-02T05:06:07.000Z';
const accountA = 'account-a';
const accountB = 'account-b';
const accountC = 'account-c';

const ropeId = 'https://resources.invalid/assets/9f3a2c';
const cratesId = 'https://resources.invalid/assets/crates';
const fiberId = 'https://resources.invalid/varieties/fiber';
const clothId = 'https://resources.invalid/varieties/cloth';
const inlineId = 'https://resources.invalid/assets/inline';
const itemsId = 'https://resources.invalid/assets/items';
const unmatchedId = 'https://resources.invalid/assets/unmatched';
const alphaPortId = 'https://places.invalid/ports/alpha';
const betaPortId = 'https://places.invalid/ports/beta';
const gammaPortId = 'https://places.invalid/ports/gamma';
const deltaPortId = 'https://places.invalid/ports/delta';
const northAreaId = 'https://places.invalid/areas/north';
const southAreaId = 'https://places.invalid/areas/south';
const territoryId = 'https://places.invalid/territories/tidal';
const catalogSource = 'https://authority.invalid/local/authoring';
const creationsSource = 'https://actor.invalid/actors/player/creations';
const creationsArraySource = 'https://actor.invalid/actors/player/creations-array';
const creationsItemsSource = 'https://actor.invalid/actors/player/creations-items';
const advertisementSource = 'https://actor.invalid/actors/player';
const decoySource = 'https://notes.invalid/unrelated';
const unavailableSource = 'https://actor.invalid/actors/player/creations-offline';
const notRetrievedSource = 'https://authority.invalid/catalog-missing';
const portsCollectionSource = 'https://territory.invalid/collections/ports';
const areasCollectionSource = 'https://territory.invalid/collections/areas';

const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

const fixtureSource = String.raw`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { ReferencePicker } from './apps/frontend/src/reference-picker.tsx';
import { readLibrary, refreshLibrary, readExplorePlaces, refreshExplorePlaces } from './apps/frontend/src/application-api.ts';

const fixture = { controls: null, selects: [], closes: 0, refreshes: 0 };
window.__pickerFixture = fixture;

const labels = { asset: 'Asset reference', variety: 'Variety reference', port: 'Entry destination', area: 'Production area' };

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const [accountId, setAccountIdState] = React.useState('account-a');
  const [selection, setSelection] = React.useState(undefined);
  const [position, setPosition] = React.useState(undefined);
  const [source, setSource] = React.useState({ kind: 'library', loading: true });
  const [refreshing, setRefreshing] = React.useState(false);
  const [values, setValues] = React.useState({ asset: 'none', variety: 'none', port: 'none', area: 'none' });
  const generation = React.useRef(0);

  const closePicker = () => {
    fixture.closes += 1;
    generation.current += 1;
    setSelection(undefined);
    setPosition(undefined);
    setRefreshing(false);
  };

  const open = (kind, fieldLabel, nextPosition, requestedSourceKind) => {
    const sourceKind = requestedSourceKind || ((kind === 'asset' || kind === 'variety') ? 'library' : 'explore');
    const requestGeneration = ++generation.current;
    setSelection({ kind, fieldLabel });
    setPosition(nextPosition);
    setRefreshing(false);
    setSource({ kind: sourceKind, loading: true });
    const settle = (response) => {
      if (generation.current !== requestGeneration) return;
      setSource({ kind: sourceKind, response, loading: false });
    };
    const fail = (error) => {
      if (generation.current !== requestGeneration) return;
      setSource({ kind: sourceKind, error: errorText(error), loading: false });
    };
    if (sourceKind === 'library') {
      if (accountId === undefined) {
        fail(new Error('An account is required'));
        return;
      }
      readLibrary(accountId).then(settle, fail);
      return;
    }
    readExplorePlaces(accountId, nextPosition === undefined ? undefined : nextPosition.vesselId).then(settle, fail);
  };

  const refresh = () => {
    if (selection === undefined || refreshing) return;
    fixture.refreshes += 1;
    const requestGeneration = ++generation.current;
    const sourceKind = source.kind;
    setRefreshing(true);
    const settle = (response) => {
      if (generation.current !== requestGeneration) return;
      setRefreshing(false);
      setSource({ kind: sourceKind, response });
    };
    const fail = (error) => {
      if (generation.current !== requestGeneration) return;
      setRefreshing(false);
      setSource({ kind: sourceKind, error: errorText(error) });
    };
    if (sourceKind === 'library') {
      if (accountId === undefined) return;
      refreshLibrary(accountId).then(settle, fail);
      return;
    }
    refreshExplorePlaces({
      ...(accountId === undefined ? {} : { accountId }),
      ...(position === undefined ? {} : { vesselId: position.vesselId })
    }).then(settle, fail);
  };

  const setAccount = (id) => {
    generation.current += 1;
    setAccountIdState(id);
  };

  const select = (id) => {
    if (selection === undefined) return;
    fixture.selects.push({ kind: selection.kind, fieldLabel: selection.fieldLabel, id });
    setValues((current) => ({ ...current, [selection.kind]: id }));
    closePicker();
  };

  React.useEffect(() => {
    fixture.controls = { open, setAccount };
  });

  const triggers = ['asset', 'variety', 'port', 'area'].map((kind) => React.createElement(
    'button',
    { key: kind, id: 'field-' + kind, type: 'button', onClick: () => open(kind, labels[kind]) },
    labels[kind]
  ));

  return React.createElement(
    'main',
    null,
    ...triggers,
    React.createElement('p', { id: 'value-asset' }, 'Asset value: ' + values.asset),
    React.createElement('p', { id: 'value-variety' }, 'Variety value: ' + values.variety),
    React.createElement('p', { id: 'value-port' }, 'Port value: ' + values.port),
    React.createElement('p', { id: 'value-area' }, 'Area value: ' + values.area),
    React.createElement(ReferencePicker, {
      accountId,
      selection,
      source,
      refreshing,
      onRefresh: refresh,
      onSelect: select,
      onClose: closePicker,
      ...(position === undefined ? {} : { position })
    })
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

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function available(source: string, value: unknown, at = observedAt): Observation {
  return { state: 'available', source, observedAt: at, value };
}

function stale(source: string, value: unknown, error: string | undefined, at = observedAt): Observation {
  return { state: 'stale', source, observedAt: at, value, ...(error === undefined ? {} : { error }) };
}

function unavailable(source: string, error: string, at?: string): Observation {
  return { state: 'unavailable', source, error, ...(at === undefined ? {} : { observedAt: at }) };
}

function notRetrieved(source: string): Observation {
  return { state: 'not-retrieved', source };
}

function libraryPage(
  accountId: string,
  assets: unknown[] = [],
  varieties: unknown[] = [],
  observations: Record<string, Observation> = {},
  extra: { grants?: unknown[]; drafts?: unknown[] } = {}
): ServerResponse {
  return {
    body: {
      context: { accountId },
      data: {
        assets,
        varieties,
        grants: extra.grants ?? [],
        drafts: extra.drafts ?? []
      },
      observations,
      actions: []
    }
  };
}

function explorePage(
  accountId: string | undefined,
  data: {
    places?: unknown[];
    connections?: unknown[];
    areas?: unknown[];
    maps?: unknown[];
    listings?: unknown[];
  } = {},
  observations: Record<string, Observation> = {}
): ServerResponse {
  return {
    body: {
      context: { ...(accountId === undefined ? {} : { accountId }) },
      data: {
        places: data.places ?? [],
        connections: data.connections ?? [],
        areas: data.areas ?? [],
        maps: data.maps ?? [],
        listings: data.listings ?? [],
        capabilities: [],
        blockers: []
      },
      observations,
      actions: []
    }
  };
}

function resourcePage(id: string, name: string, accountId?: string): ServerResponse {
  return {
    body: {
      context: { resourceId: id, ...(accountId === undefined ? {} : { accountId }) },
      data: { resourceId: id, value: { id, type: 'Asset', name } },
      observations: { [`resource\u0000${accountId ?? ''}\u0000${id}`]: available(id, { id, type: 'Asset', name }, directAt) },
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
      sourcefile: 'frontend-picker-fixture.js',
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

async function openFixture(t: TestContext, handler: Handler): Promise<OpenedFixture> {
  const activeBrowser = browser;
  const activeBundle = bundle;
  assert(activeBrowser, 'browser was not started');
  assert(activeBundle, 'fixture bundle was not built');

  const context = await activeBrowser.newContext();
  t.after(async () => { await context.close(); });
  const page = await context.newPage();
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

  await page.goto(fixtureOrigin);
  await page.waitForFunction(() => {
    const fixture = (window as unknown as { __pickerFixture?: { controls?: unknown } }).__pickerFixture;
    return Boolean(fixture && fixture.controls);
  });
  return { page, requests, errors };
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function actionPattern(action: 'Select' | 'Inspect', name: string): RegExp {
  const escaped = escapeRegExp(name);
  return new RegExp(`(?:^${action}\\b.*${escaped}|${escaped}.*\\b${action}$)`, 'i');
}

function picker(page: Page, fieldLabel: string): Locator {
  return page.getByRole('dialog', { name: new RegExp(escapeRegExp(fieldLabel), 'i') });
}

async function openPicker(
  page: Page,
  kind: 'asset' | 'variety' | 'port' | 'area',
  fieldLabel: string,
  options: { position?: { vesselId: string; portId: string }; sourceKind?: 'library' | 'explore' } = {}
): Promise<Locator> {
  await page.evaluate(({ kind, fieldLabel, position, sourceKind }) => {
    const fixture = (window as unknown as {
      __pickerFixture: {
        controls: {
          open(
            kind: string,
            fieldLabel: string,
            position?: { vesselId: string; portId: string },
            sourceKind?: string
          ): void;
        };
      };
    }).__pickerFixture;
    fixture.controls.open(kind, fieldLabel, position, sourceKind);
  }, {
    kind,
    fieldLabel,
    ...(options.position === undefined ? {} : { position: options.position }),
    ...(options.sourceKind === undefined ? {} : { sourceKind: options.sourceKind })
  });
  const dialog = picker(page, fieldLabel);
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  return dialog;
}

async function clickTrigger(page: Page, kind: 'asset' | 'variety' | 'port' | 'area'): Promise<Locator> {
  const trigger = page.locator(`#field-${kind}`);
  await trigger.focus();
  await trigger.click();
  const dialog = page.getByRole('dialog').first();
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  return dialog;
}

function selectButton(dialog: Locator, name: string): Locator {
  return dialog.getByRole('button', { name: actionPattern('Select', name) }).first();
}

function inspectButton(dialog: Locator, name: string): Locator {
  return dialog.getByRole('button', { name: actionPattern('Inspect', name) }).first();
}

function candidate(dialog: Locator, name: string): Locator {
  return selectButton(dialog, name)
    .locator('xpath=ancestor::*[self::li or self::article or @role="listitem" or @role="article"][1]');
}

async function waitForSelect(dialog: Locator, name: string): Promise<void> {
  await selectButton(dialog, name).waitFor({ state: 'visible', timeout: settleTimeout });
}

async function waitForNoSelect(dialog: Locator, name: string): Promise<void> {
  await selectButton(dialog, name).waitFor({ state: 'hidden', timeout: settleTimeout });
}

async function disclosureText(block: Locator): Promise<string> {
  const details = block.locator('details').first();
  await details.waitFor({ state: 'attached', timeout: settleTimeout });
  const open = await details.evaluate((element) => (element as HTMLDetailsElement).open);
  if (!open) await details.locator('summary').first().click();
  return (await details.textContent()) ?? '';
}

function sectionForHeading(dialog: Locator, name: RegExp): Locator {
  return dialog.getByRole('heading', { name }).first()
    .locator('xpath=ancestor::*[self::section or @role="region" or @role="group"][1]');
}

async function activeInside(scope: Locator): Promise<boolean> {
  return scope.evaluate((element) => element.contains(document.activeElement));
}

async function waitForCloses(page: Page, expected: number): Promise<void> {
  await page.waitForFunction((count) => {
    const fixture = (window as unknown as { __pickerFixture?: { closes?: number } }).__pickerFixture;
    return fixture?.closes === count;
  }, expected, { timeout: settleTimeout });
}

async function fixtureSnapshot(page: Page): Promise<{ selects: Array<{ kind: string; fieldLabel: string; id: string }>; closes: number; refreshes: number }> {
  return page.evaluate(() => {
    const fixture = (window as unknown as {
      __pickerFixture: {
        selects: Array<{ kind: string; fieldLabel: string; id: string }>;
        closes: number;
        refreshes: number;
      };
    }).__pickerFixture;
    return { selects: fixture.selects.slice(), closes: fixture.closes, refreshes: fixture.refreshes };
  });
}

async function setAccount(page: Page, accountId: string): Promise<void> {
  await page.evaluate((id) => {
    const fixture = (window as unknown as { __pickerFixture: { controls: { setAccount(value: string): void } } }).__pickerFixture;
    fixture.controls.setAccount(id);
  }, accountId);
}

async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

function assetEntries(): unknown[] {
  return [
    { id: ropeId, type: 'Asset', name: 'Rope', holder: 'https://actors.invalid/holder-rope' },
    { id: cratesId, type: 'Asset', name: 'Crates', holder: 'https://actors.invalid/holder-crates' }
  ];
}

function varietyEntries(): unknown[] {
  return [
    { id: fiberId, type: 'Variety', name: 'Fiber', asset: ropeId },
    { id: clothId, type: 'Variety', name: 'Cloth', asset: cratesId }
  ];
}

test('offers typed Asset and Variety candidates from matching Library data, filters retained data locally, and rejects mismatched sources', async (t) => {
  const { page, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library') return libraryPage(accountA, assetEntries(), varietyEntries());
    if (request.pathname === '/api/explore/places') {
      return explorePage(accountA, {
        places: [{ id: alphaPortId, type: 'Port', authorityId: territoryId, name: 'Alpha Harbor', territoryId }],
        areas: [{ id: northAreaId, type: 'Area', authorityId: territoryId, name: 'North Reach', territoryId }]
      });
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });

  const assetDialog = await clickTrigger(page, 'asset');
  assert.equal(await assetDialog.getByRole('heading', { name: /Asset reference/i }).count(), 1, 'the title must name the invoking field');
  await waitForSelect(assetDialog, 'Rope');
  await waitForSelect(assetDialog, 'Crates');
  await waitForNoSelect(assetDialog, 'Fiber');
  const retainedText = await assetDialog.innerText();
  assert.match(retainedText, /local/i, 'local filtering must be disclosed');
  assert.match(retainedText, /retained/i, 'retained candidate data must be disclosed');

  const search = assetDialog.getByLabel(/search/i);
  await search.fill('9f3a2c');
  await waitForSelect(assetDialog, 'Rope');
  await waitForNoSelect(assetDialog, 'Crates');
  await search.fill('holder-crates');
  await waitForSelect(assetDialog, 'Crates');
  await waitForNoSelect(assetDialog, 'Rope');
  await search.fill('no-such-asset');
  await assetDialog.getByText(/no .*match|no candidate|empty|nothing/i).first().waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await selectButton(assetDialog, 'Rope').count(), 0, 'an empty filter must not leave a stale candidate');
  await search.fill('');
  await waitForSelect(assetDialog, 'Rope');

  await assetDialog.getByRole('button', { name: 'Cancel' }).click();
  await assetDialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForCloses(page, 1);

  const varietyDialog = await clickTrigger(page, 'variety');
  await waitForSelect(varietyDialog, 'Fiber');
  await waitForSelect(varietyDialog, 'Cloth');
  await waitForNoSelect(varietyDialog, 'Rope');
  await varietyDialog.getByRole('button', { name: 'Cancel' }).click();
  await varietyDialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForCloses(page, 2);

  const mismatchedAsset = await openPicker(page, 'asset', 'Asset reference', { sourceKind: 'explore' });
  assert.equal(await selectButton(mismatchedAsset, 'Alpha Harbor').count(), 0, 'an Explore source must not offer Asset candidates');
  await mismatchedAsset.getByText(/mismatch|does not provide|not available|wrong source/i).first().waitFor({ state: 'visible', timeout: settleTimeout });
  await mismatchedAsset.getByRole('button', { name: 'Cancel' }).click();
  await mismatchedAsset.waitFor({ state: 'hidden', timeout: settleTimeout });

  const mismatchedPort = await openPicker(page, 'port', 'Entry destination', { sourceKind: 'library' });
  assert.equal(await selectButton(mismatchedPort, 'Rope').count(), 0, 'a Library source must not offer Port candidates');
  await mismatchedPort.getByRole('button', { name: 'Cancel' }).click();
  await mismatchedPort.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.deepEqual(errors, []);
});

test('offers distinct Port and Area candidates from Explore, with useful summaries, exact IDs, and local filtering', async (t) => {
  const { page, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/explore/places') {
      return explorePage(accountA, {
        places: [
          { id: alphaPortId, type: 'Port', authorityId: territoryId, name: 'Alpha Harbor', territoryId, areaId: northAreaId },
          { id: betaPortId, type: 'Port', authorityId: territoryId, name: 'Beta Harbor', territoryId }
        ],
        areas: [
          { id: northAreaId, type: 'Area', authorityId: territoryId, name: 'North Reach', territoryId },
          { id: southAreaId, type: 'Area', authorityId: territoryId, name: 'South Reach', territoryId }
        ]
      }, {
        [`explore\u0000resource\u0000${alphaPortId}`]: available(alphaPortId, { id: alphaPortId, type: 'Port', name: 'Alpha Harbor' }),
        [`explore\u0000resource\u0000${northAreaId}`]: available(northAreaId, { id: northAreaId, type: 'Area', name: 'North Reach' })
      });
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });

  const portDialog = await clickTrigger(page, 'port');
  await waitForSelect(portDialog, 'Alpha Harbor');
  await waitForSelect(portDialog, 'Beta Harbor');
  await waitForNoSelect(portDialog, 'North Reach');
  const alphaBlock = candidate(portDialog, 'Alpha Harbor');
  const alphaText = await alphaBlock.innerText();
  assert.match(alphaText, /tidal|territory/i, 'a Port summary must retain its territory context');
  assert.equal(await alphaBlock.locator('details').first().evaluate((element) => (element as HTMLDetailsElement).open), false, 'identifier disclosure starts closed; an identical source URI may still be visible as provenance');
  assert.ok((await disclosureText(alphaBlock)).includes(alphaPortId), 'the exact Port ID must be in the disclosure');

  const portSearch = portDialog.getByLabel(/search/i);
  await portSearch.fill('beta');
  await waitForSelect(portDialog, 'Beta Harbor');
  await waitForNoSelect(portDialog, 'Alpha Harbor');
  await portSearch.fill('no-such-port');
  await portDialog.getByText(/no .*match|no candidate|empty|nothing/i).first().waitFor({ state: 'visible', timeout: settleTimeout });
  await portDialog.getByRole('button', { name: 'Cancel' }).click();
  await portDialog.waitFor({ state: 'hidden', timeout: settleTimeout });

  const areaDialog = await clickTrigger(page, 'area');
  await waitForSelect(areaDialog, 'North Reach');
  await waitForSelect(areaDialog, 'South Reach');
  await waitForNoSelect(areaDialog, 'Alpha Harbor');
  const northBlock = candidate(areaDialog, 'North Reach');
  assert.match(await northBlock.innerText(), /tidal|territory/i, 'an Area summary must retain its territory context');
  assert.ok((await disclosureText(northBlock)).includes(northAreaId), 'the exact Area ID must be in the disclosure');
  await areaDialog.getByRole('button', { name: 'Cancel' }).click();
  await areaDialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.deepEqual(errors, []);
});

test('attributes each Library candidate only from exact ID membership or direct observation, keeps all competing sources, and never borrows unrelated freshness', async (t) => {
  const catalogError = 'catalog refresh failed';
  const creationsError = 'creations refresh failed';
  const advertisementError = 'actor advertisement failed';
  const unavailableError = 'creations source unavailable';
  const { page, errors } = await openFixture(t, (request) => {
    if (request.pathname !== '/api/library') return { status: 404, body: { error: 'unexpected request' } };
    return libraryPage(
      accountA,
      [
        { id: ropeId, type: 'Asset', name: 'Rope', holder: 'https://actors.invalid/holder-rope' },
        { id: inlineId, type: 'Asset', name: 'Inline Rope' },
        { id: itemsId, type: 'Asset', name: 'Items Rope' },
        { id: unmatchedId, type: 'Asset', name: 'Unmatched Rope' }
      ],
      [{ id: fiberId, type: 'Variety', name: 'Fiber', asset: ropeId }],
      {
        [`authoring:${accountA}:catalog:${catalogSource}`]: stale(catalogSource, {
          assets: [{ id: ropeId, type: 'Asset', name: 'Rope' }],
          varieties: [{ id: fiberId, type: 'Variety', name: 'Fiber' }],
          grants: []
        }, catalogError, observedAt),
        [`authoring:${accountA}:creations:${creationsSource}`]: stale(creationsSource, {
          orderedItems: [{ id: ropeId, type: 'Asset', name: 'Rope' }]
        }, creationsError, laterAt),
        [`authoring:${accountA}:creations:${creationsArraySource}`]: available(creationsArraySource, [
          { id: inlineId, type: 'Asset', name: 'Inline Rope' }
        ], laterAt),
        [`authoring:${accountA}:creations:${creationsItemsSource}`]: available(creationsItemsSource, {
          items: [{ id: itemsId, type: 'Asset', name: 'Items Rope' }]
        }, laterAt),
        [`resource\u0000${accountA}\u0000${ropeId}`]: available(ropeId, { id: ropeId, type: 'Asset', name: 'Rope' }, directAt),
        [`authoring:${accountA}:advertisement`]: stale(advertisementSource, creationsSource, advertisementError, observedAt),
        [`authoring:${accountA}:offline`]: unavailable(unavailableSource, unavailableError, laterAt),
        [`authoring:${accountA}:missing`]: notRetrieved(notRetrievedSource),
        [`notes\u0000${fiberId}`]: stale(decoySource, { note: `References ${fiberId}` }, 'unrelated note failure', observedAt)
      }
    );
  });

  const dialog = await openPicker(page, 'asset', 'Asset reference');
  await waitForSelect(dialog, 'Rope');
  await waitForSelect(dialog, 'Inline Rope');
  await waitForSelect(dialog, 'Items Rope');
  await waitForSelect(dialog, 'Unmatched Rope');

  const ropeBlock = candidate(dialog, 'Rope');
  const ropeText = await ropeBlock.innerText();
  assert.ok(ropeText.includes(catalogSource), 'the stale catalog source must be named for Rope');
  assert.ok(ropeText.includes(creationsSource), 'the competing creations source must also be named for Rope');
  assert.ok(ropeText.includes(ropeId), 'the direct resource source must match the candidate ID');
  assert.match(ropeText, /stale/i, 'stale catalog provenance must remain visible');
  assert.match(ropeText, /available/i, 'available competing provenance must remain visible');
  assert.ok(ropeText.includes(observedAt), 'catalog observation time must be shown');
  assert.ok(ropeText.includes(laterAt), 'creations observation time must be shown');
  assert.ok(ropeText.includes(directAt), 'direct observation time must be shown');
  assert.ok(ropeText.includes(catalogError), 'catalog error must be shown independently');
  assert.ok(ropeText.includes(creationsError), 'creations error must be shown independently');
  assert.equal(await ropeBlock.getByText(advertisementSource, { exact: true }).count(), 0, 'the Actor advertisement must not be attributed as a candidate source');
  assert.equal(ropeText.includes(advertisementError), false, 'advertisement failure must not be attributed to a candidate');
  assert.equal(ropeText.includes(decoySource), false, 'arbitrary nested strings must not become candidate provenance');
  assert.ok((await disclosureText(ropeBlock)).includes(ropeId), 'the exact candidate ID must be available in its disclosure');

  const inlineBlock = candidate(dialog, 'Inline Rope');
  assert.ok((await inlineBlock.innerText()).includes(creationsArraySource), 'an inline creations array must supply provenance');
  const itemsBlock = candidate(dialog, 'Items Rope');
  assert.ok((await itemsBlock.innerText()).includes(creationsItemsSource), 'inline creations items must supply provenance');

  const unmatchedBlock = candidate(dialog, 'Unmatched Rope');
  const unmatchedText = await unmatchedBlock.innerText();
  assert.match(unmatchedText, /unknown|unattributed/i, 'a candidate with no matching observation must be labelled unknown');
  assert.equal(unmatchedText.includes(catalogSource), false, 'unmatched candidates must not borrow the catalog source');
  assert.equal(unmatchedText.includes(catalogError), false, 'unmatched candidates must not borrow catalog failures');
  assert.equal(unmatchedText.includes(observedAt), false, 'unmatched candidates must not borrow catalog time');

  const allText = await dialog.innerText();
  assert.ok(allText.includes(unavailableSource), 'an independently unavailable source must remain visible');
  assert.ok(allText.includes(unavailableError), 'an independent source failure must remain visible');
  assert.ok(allText.includes(notRetrievedSource), 'an independently not-retrieved source must remain visible');
  assert.match(allText, /not.?retrieved/i, 'not-retrieved source state must be stated');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  const varietyDialog = await clickTrigger(page, 'variety');
  await waitForSelect(varietyDialog, 'Fiber');
  const fiberBlock = candidate(varietyDialog, 'Fiber');
  const fiberText = await fiberBlock.innerText();
  assert.ok(fiberText.includes(catalogSource), 'a Variety must use its exact membership in catalog varieties');
  assert.equal(fiberText.includes(decoySource), false, 'a nested string mentioning Fiber must not match');
  assert.ok((await disclosureText(fiberBlock)).includes(fiberId));
  await varietyDialog.getByRole('button', { name: 'Cancel' }).click();
  await varietyDialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.deepEqual(errors, []);
});

test('attributes Explore candidates from direct observations and exact published collection membership without recursive string matching', async (t) => {
  const collectionError = 'port collection stale';
  const unavailableError = 'published geography unavailable';
  const decoyError = 'unrelated place note failure';
  const { page, errors } = await openFixture(t, (request) => {
    if (request.pathname !== '/api/explore/places') return { status: 404, body: { error: 'unexpected request' } };
    return explorePage(accountA, {
      places: [
        { id: alphaPortId, type: 'Port', authorityId: territoryId, name: 'Alpha Harbor', territoryId },
        { id: betaPortId, type: 'Port', authorityId: territoryId, name: 'Beta Harbor', territoryId }
      ],
      areas: [{ id: northAreaId, type: 'Area', authorityId: territoryId, name: 'North Reach', territoryId }]
    }, {
      [`explore\u0000place\u0000${alphaPortId}\u0000${alphaPortId}`]: available(alphaPortId, { id: alphaPortId, type: 'Port', name: 'Alpha Harbor' }, directAt),
      [`explore\u0000collection\u0000${portsCollectionSource}`]: stale(portsCollectionSource, {
        orderedItems: [{ id: alphaPortId, type: 'Port', name: 'Alpha Harbor' }]
      }, collectionError, laterAt),
      [`explore\u0000collection\u0000${areasCollectionSource}`]: available(areasCollectionSource, [
        { id: northAreaId, type: 'Area', name: 'North Reach' }
      ], laterAt),
      [`explore\u0000source\u0000offline`]: unavailable(unavailableSource, unavailableError, laterAt),
      [`explore\u0000notes\u0000decoy`]: stale(decoySource, { note: `See ${alphaPortId} for details` }, decoyError, observedAt)
    });
  });

  const portDialog = await openPicker(page, 'port', 'Entry destination');
  await waitForSelect(portDialog, 'Alpha Harbor');
  await waitForSelect(portDialog, 'Beta Harbor');
  const alphaBlock = candidate(portDialog, 'Alpha Harbor');
  const alphaText = await alphaBlock.innerText();
  assert.ok(alphaText.includes(alphaPortId), 'a direct resource observation must consent to the Port ID');
  assert.ok(alphaText.includes(portsCollectionSource), 'exact membership in the published Port collection must be shown');
  assert.ok(alphaText.includes(directAt), 'direct observation time must be shown');
  assert.ok(alphaText.includes(laterAt), 'collection observation time must be shown');
  assert.ok(alphaText.includes(collectionError), 'the independent collection error must be shown');
  assert.match(alphaText, /stale/i);
  assert.equal(alphaText.includes(decoySource), false, 'a nested place string must not become candidate provenance');

  const betaBlock = candidate(portDialog, 'Beta Harbor');
  const betaText = await betaBlock.innerText();
  assert.match(betaText, /unknown|unattributed/i, 'a Port with no matching evidence must be labelled unknown');
  assert.equal(betaText.includes(portsCollectionSource), false, 'unmatched Ports must not borrow the collection source');
  assert.equal(betaText.includes(collectionError), false, 'unmatched Ports must not borrow collection failures');

  const allPortText = await portDialog.innerText();
  assert.ok(allPortText.includes(unavailableSource), 'independent Explore source availability must remain visible');
  assert.ok(allPortText.includes(unavailableError), 'independent Explore source errors must remain visible');
  await portDialog.getByRole('button', { name: 'Cancel' }).click();
  await portDialog.waitFor({ state: 'hidden', timeout: settleTimeout });

  const areaDialog = await openPicker(page, 'area', 'Production area');
  await waitForSelect(areaDialog, 'North Reach');
  const northBlock = candidate(areaDialog, 'North Reach');
  assert.ok((await northBlock.innerText()).includes(areasCollectionSource), 'Area collection membership must be shown for an Area');
  assert.ok((await disclosureText(northBlock)).includes(northAreaId));
  await areaDialog.getByRole('button', { name: 'Cancel' }).click();
  await areaDialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.deepEqual(errors, []);
});

test('inspects a candidate with the existing ResourceReader without selecting, retaining the picker query and returning focus', async (t) => {
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library') return libraryPage(accountA, assetEntries(), [], {
      [`authoring:${accountA}:catalog:${catalogSource}`]: available(catalogSource, {
        assets: assetEntries(),
        varieties: [],
        grants: []
      })
    });
    if (request.pathname === `/api/resources/${encodeURIComponent(ropeId)}`) return resourcePage(ropeId, 'Rope Details', accountA);
    return { status: 404, body: { error: 'unexpected request' } };
  });

  const dialog = await clickTrigger(page, 'asset');
  await waitForSelect(dialog, 'Rope');
  const search = dialog.getByLabel(/search/i);
  await search.fill('rop');
  await inspectButton(dialog, 'Rope').click();

  const reader = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Rope Details' }) });
  await reader.waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal((await fixtureSnapshot(page)).selects.length, 0, 'inspection must never select a candidate');
  const resourceRequest = requests.find((request) => request.pathname === `/api/resources/${encodeURIComponent(ropeId)}`);
  assert(resourceRequest, 'inspection must use the existing resource-reader retained API');
  assert.equal(resourceRequest.method, 'GET');
  assert.equal(resourceRequest.params.accountId, accountA);
  assert.equal(await dialog.isVisible(), true, 'the picker must remain open while inspecting');
  assert.equal(await search.inputValue(), 'rop', 'inspection must retain the caller query');

  await reader.getByRole('button', { name: 'Close' }).click();
  await reader.waitFor({ state: 'hidden', timeout: settleTimeout });
  await page.waitForFunction(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && /inspect/i.test(active.textContent ?? '') && /rope/i.test(active.textContent ?? '');
  }, undefined, { timeout: settleTimeout });
  assert.equal(await search.inputValue(), 'rop', 'returning from the reader must keep the local query');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.deepEqual(errors, []);
});

test('returns selection to the exact invoking field and restores focus there for two different fields', async (t) => {
  const { page, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library') return libraryPage(accountA, assetEntries(), varietyEntries());
    return { status: 404, body: { error: 'unexpected request' } };
  });

  const assetTrigger = page.locator('#field-asset');
  await assetTrigger.focus();
  await assetTrigger.click();
  const assetDialog = picker(page, 'Asset reference');
  await waitForSelect(assetDialog, 'Rope');
  await selectButton(assetDialog, 'Rope').click();
  await assetDialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await page.waitForFunction(() => document.activeElement?.id === 'field-asset', undefined, { timeout: settleTimeout });
  assert.match(await page.locator('#value-asset').innerText(), new RegExp(escapeRegExp(ropeId)), 'the Asset field must receive the exact selected URI');
  assert.equal(await page.locator('#value-variety').innerText(), 'Variety value: none');

  const varietyTrigger = page.locator('#field-variety');
  await varietyTrigger.focus();
  await varietyTrigger.click();
  const varietyDialog = picker(page, 'Variety reference');
  await waitForSelect(varietyDialog, 'Fiber');
  await selectButton(varietyDialog, 'Fiber').click();
  await varietyDialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await page.waitForFunction(() => document.activeElement?.id === 'field-variety', undefined, { timeout: settleTimeout });
  assert.match(await page.locator('#value-variety').innerText(), new RegExp(escapeRegExp(fiberId)), 'the Variety field must receive its own exact URI');
  assert.match(await page.locator('#value-asset').innerText(), new RegExp(escapeRegExp(ropeId)), 'the Asset field must not change');
  assert.equal(await page.locator('#value-port').innerText(), 'Port value: none');

  const snapshot = await fixtureSnapshot(page);
  assert.deepEqual(snapshot.selects, [
    { kind: 'asset', fieldLabel: 'Asset reference', id: ropeId },
    { kind: 'variety', fieldLabel: 'Variety reference', id: fiberId }
  ]);
  assert.deepEqual(errors, []);
});

test('cancel and Escape change nothing, return focus, and a pending Refresh cannot reopen or select old candidates', async (t) => {
  const pendingRefresh = deferred<ServerResponse>();
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library') return libraryPage(accountA, assetEntries(), []);
    if (request.pathname === '/api/library/refresh') return pendingRefresh.promise;
    return { status: 404, body: { error: 'unexpected request' } };
  });

  const trigger = page.locator('#field-asset');
  await trigger.focus();
  await trigger.click();
  let dialog = picker(page, 'Asset reference');
  await waitForSelect(dialog, 'Rope');
  await dialog.getByLabel(/search/i).fill('rop');
  await dialog.getByRole('button', { name: 'Refresh' }).click();
  await waitFor(() => requests.some((request) => request.pathname === '/api/library/refresh'), 'expected the held explicit refresh');
  assert.equal(await activeInside(dialog), true, 'focus must remain in the picker during an explicit refresh');
  assert.equal((await fixtureSnapshot(page)).refreshes, 1);

  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForCloses(page, 1);
  await page.waitForFunction(() => document.activeElement?.id === 'field-asset', undefined, { timeout: settleTimeout });
  assert.equal((await fixtureSnapshot(page)).selects.length, 0, 'Escape must not select');

  pendingRefresh.resolve(libraryPage(accountA, [{ id: ropeId, type: 'Asset', name: 'Late Rope' }], []));
  await nextFrames(page);
  assert.equal(await picker(page, 'Asset reference').isVisible(), false, 'a pending refresh must not reopen a closed picker');
  assert.equal(await page.getByText('Late Rope').isVisible().catch(() => false), false, 'late candidates must remain hidden');
  assert.equal((await fixtureSnapshot(page)).selects.length, 0);

  await trigger.focus();
  await trigger.click();
  dialog = picker(page, 'Asset reference');
  await waitForSelect(dialog, 'Rope');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForCloses(page, 2);
  await page.waitForFunction(() => document.activeElement?.id === 'field-asset', undefined, { timeout: settleTimeout });
  assert.equal((await fixtureSnapshot(page)).selects.length, 0, 'Cancel must change nothing');
  assert.deepEqual(errors, []);
});

test('performs scoped retained reads and only explicit Refresh observations for Library and Explore sources', async (t) => {
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library' && request.method === 'GET') {
      return libraryPage(accountA, assetEntries(), []);
    }
    if (request.pathname === '/api/library/refresh' && request.method === 'POST') {
      return libraryPage(accountA, [{ id: ropeId, type: 'Asset', name: 'Fresh Rope' }], []);
    }
    if (request.pathname === '/api/explore/places' && request.method === 'GET') {
      return explorePage(accountA, {
        places: [{ id: alphaPortId, type: 'Port', authorityId: territoryId, name: 'Alpha Harbor', territoryId }]
      });
    }
    if (request.pathname === '/api/explore/refresh' && request.method === 'POST') {
      return explorePage(accountA, {
        places: [{ id: alphaPortId, type: 'Port', authorityId: territoryId, name: 'Fresh Harbor', territoryId }]
      });
    }
    return { status: 404, body: { error: 'unexpected request' } };
  });

  const assetDialog = await clickTrigger(page, 'asset');
  await waitForSelect(assetDialog, 'Rope');
  const libraryReads = () => requests.filter((request) => request.pathname === '/api/library' && request.method === 'GET');
  assert.equal(libraryReads().length, 1);
  assert.equal(libraryReads()[0]?.params.accountId, accountA);
  assert.equal(requests.filter((request) => request.pathname === '/api/library/refresh').length, 0, 'opening must not observe the Library');
  await assetDialog.getByLabel(/search/i).fill('rope');
  await waitForSelect(assetDialog, 'Rope');
  assert.equal(libraryReads().length, 1, 'local filtering must not perform remote search');

  await assetDialog.getByRole('button', { name: 'Refresh' }).click();
  await waitForSelect(assetDialog, 'Fresh Rope');
  const libraryRefreshes = requests.filter((request) => request.pathname === '/api/library/refresh');
  assert.equal(libraryRefreshes.length, 1);
  assert.equal(libraryRefreshes[0]?.method, 'POST');
  assert.deepEqual(libraryRefreshes[0]?.body, { accountId: accountA });
  assert.equal(libraryReads().length, 1, 'explicit Refresh must not repeat the retained GET');
  await assetDialog.getByRole('button', { name: 'Cancel' }).click();
  await assetDialog.waitFor({ state: 'hidden', timeout: settleTimeout });

  const portDialog = await openPicker(page, 'port', 'Entry destination', { position: { vesselId: 'vessel-one', portId: alphaPortId } });
  await waitForSelect(portDialog, 'Alpha Harbor');
  const exploreReads = () => requests.filter((request) => request.pathname === '/api/explore/places' && request.method === 'GET');
  assert.equal(exploreReads().length, 1);
  assert.equal(exploreReads()[0]?.params.accountId, accountA);
  assert.equal(exploreReads()[0]?.params.vesselId, 'vessel-one');
  await portDialog.getByRole('button', { name: 'Refresh' }).click();
  await waitForSelect(portDialog, 'Fresh Harbor');
  const exploreRefreshes = requests.filter((request) => request.pathname === '/api/explore/refresh');
  assert.equal(exploreRefreshes.length, 1);
  assert.equal(exploreRefreshes[0]?.method, 'POST');
  assert.deepEqual(exploreRefreshes[0]?.body, { accountId: accountA, vesselId: 'vessel-one' });
  assert.equal(exploreReads().length, 1);
  await portDialog.getByRole('button', { name: 'Cancel' }).click();
  await portDialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.deepEqual(errors, []);
});

test('an account change closes the picker and nested reader, hides private candidates, and owner generations discard obsolete results', async (t) => {
  const oldLibrary = deferred<ServerResponse>();
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.pathname === '/api/library') {
      if (request.params.accountId === accountA) return oldLibrary.promise;
      if (request.params.accountId === accountB) return libraryPage(accountB, [{ id: ropeId, type: 'Asset', name: 'Second Rope' }], []);
      return libraryPage(request.params.accountId ?? '', [], []);
    }
    if (request.pathname === `/api/resources/${encodeURIComponent(ropeId)}`) return resourcePage(ropeId, 'Second Rope Details', request.params.accountId);
    return { status: 404, body: { error: 'unexpected request' } };
  });

  await openPicker(page, 'asset', 'Asset reference');
  await setAccount(page, accountB);
  await waitForCloses(page, 1);
  assert.equal(await picker(page, 'Asset reference').isVisible(), false, 'an account change must close the picker immediately');

  oldLibrary.resolve(libraryPage(accountA, [{ id: ropeId, type: 'Asset', name: 'Private Rope' }], []));
  await nextFrames(page);
  assert.equal(await page.getByText('Private Rope').isVisible().catch(() => false), false, 'an obsolete old-account result must not become visible');
  assert.equal((await fixtureSnapshot(page)).selects.length, 0);

  const trigger = page.locator('#field-asset');
  await trigger.focus();
  await trigger.click();
  const dialog = picker(page, 'Asset reference');
  await waitForSelect(dialog, 'Second Rope');
  assert.equal(await selectButton(dialog, 'Private Rope').count(), 0);
  assert.ok(requests.some((request) => request.pathname === '/api/library' && request.params.accountId === accountB), 'the new account must use an exact scoped retained read');

  await inspectButton(dialog, 'Second Rope').click();
  const reader = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Second Rope Details' }) });
  await reader.waitFor({ state: 'visible', timeout: settleTimeout });

  await setAccount(page, accountC);
  await waitForCloses(page, 2);
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await reader.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.equal(await page.getByText('Second Rope').isVisible().catch(() => false), false, 'private candidate content must be cleared');
  assert.equal(await page.getByText('Second Rope Details').isVisible().catch(() => false), false, 'the nested reader must be cleared');
  assert.deepEqual(errors, []);
});

test('groups only directed outgoing nearby Ports with explicit admission uncertainty, and explains missing position or connectivity without inventing reachability', async (t) => {
  const routeError = 'route refresh failed';
  const { page, errors } = await openFixture(t, (request) => {
    if (request.pathname !== '/api/explore/places') return { status: 404, body: { error: 'unexpected request' } };
    return explorePage(accountA, {
      places: [
        { id: alphaPortId, type: 'Port', authorityId: territoryId, name: 'Alpha Harbor', territoryId },
        { id: betaPortId, type: 'Port', authorityId: territoryId, name: 'Beta Harbor', territoryId },
        { id: gammaPortId, type: 'Port', authorityId: territoryId, name: 'Gamma Harbor', territoryId },
        { id: deltaPortId, type: 'Port', authorityId: territoryId, name: 'Delta Harbor', territoryId }
      ],
      connections: [
        {
          id: 'route-outbound', type: 'Route', from: alphaPortId, to: betaPortId,
          territoryId, authorityId: territoryId, name: 'Tidal Passage', state: 'stale', error: routeError
        },
        {
          id: 'route-reverse-only', type: 'Route', from: gammaPortId, to: alphaPortId,
          territoryId, authorityId: territoryId, name: 'Inbound Passage', state: 'available'
        }
      ]
    });
  });

  const positioned = await openPicker(page, 'port', 'Entry destination', { position: { vesselId: 'vessel-one', portId: alphaPortId } });
  await waitForSelect(positioned, 'Beta Harbor');
  const nearby = sectionForHeading(positioned, /nearby/i);
  await nearby.waitFor({ state: 'visible', timeout: settleTimeout });
  const nearbyText = await nearby.innerText();
  assert.ok(nearbyText.includes('Beta Harbor'), 'an outgoing directed connection must place the destination in Nearby');
  assert.equal(nearbyText.includes('Gamma Harbor'), false, 'a reverse-only connection must not invent an outgoing nearby path');
  assert.equal(nearbyText.includes('Delta Harbor'), false, 'an unconnected Port must not be presented as nearby');
  assert.match(nearbyText, /directed|connection/i, 'the directed connection basis must be stated');
  assert.match(nearbyText, /admission.*unknown|unknown.*admission|permission.*unknown|unknown.*permission/i, 'admission must remain explicitly unknown');
  assert.match(nearbyText, /stale/i, 'stale route information must remain visible');
  assert.ok(nearbyText.includes(routeError), 'the route failure must remain visible');

  const gammaBlock = candidate(positioned, 'Gamma Harbor');
  const gammaText = await gammaBlock.innerText();
  assert.match(gammaText, /unknown|not known|no known/i, 'a reverse-only Port must have unknown connectivity');
  assert.equal(/unreachable/i.test(gammaText), false, 'missing outgoing connectivity must not be reported as unreachability');
  assert.equal(/nearby/i.test(gammaText), false, 'a reverse-only Port must not be labelled nearby');

  const deltaBlock = candidate(positioned, 'Delta Harbor');
  const deltaText = await deltaBlock.innerText();
  assert.match(deltaText, /unknown|not known|no known/i, 'a Port without a directed connection must have unknown connectivity');
  assert.equal(/unreachable/i.test(deltaText), false, 'missing directed connectivity must not be reported as unreachability');
  await positioned.getByRole('button', { name: 'Cancel' }).click();
  await positioned.waitFor({ state: 'hidden', timeout: settleTimeout });

  const unpositioned = await openPicker(page, 'port', 'Entry destination');
  await waitForSelect(unpositioned, 'Alpha Harbor');
  const unpositionedText = await unpositioned.innerText();
  assert.match(unpositionedText, /position.*(unavailable|unknown|not available|not supplied)|nearby.*(unavailable|unknown|not available)/i, 'missing position must be explained rather than guessed');
  assert.equal(await unpositioned.getByRole('heading', { name: /nearby ports for/i }).count(), 0, 'nearby grouping must not claim a vessel without position');
  await unpositioned.getByRole('button', { name: 'Cancel' }).click();
  await unpositioned.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.deepEqual(errors, []);
});
