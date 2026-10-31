import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Locator, type Page } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureOrigin = 'http://fixture.invalid/';
const settleTimeout = 3_000;
const observedAt = '2026-01-02T03:04:05.000Z';
const callerId = 'https://resources.invalid/assets/caller';
const callerAuthority = 'https://authority.invalid/home';
const opaqueId = 'https://resources.invalid/assets/7f3a9c';
const secondId = 'https://resources.invalid/assets/second';
const linkedHolderId = 'https://resources.invalid/actors/holder';
const linkedAssetId = 'https://resources.invalid/assets/linked';
const explicitAuthority = 'https://authority.invalid/assets';
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

const fixtureSource = String.raw`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { ResourceReader } from './apps/frontend/src/resource-reader.tsx';

const callerResource = { id: ${JSON.stringify(callerId)}, authorityId: ${JSON.stringify(callerAuthority)} };
const fixture = { controls: null, closes: 0 };
window.__readerFixture = fixture;

function App() {
  const [resource, setResource] = React.useState(undefined);
  const [accountId, setAccountId] = React.useState(undefined);

  React.useEffect(() => {
    fixture.controls = {
      open(id, authorityId) {
        setResource(authorityId === undefined ? { id } : { id, authorityId });
      },
      setResource(value) {
        setResource(value);
      },
      setAccount(value) {
        setAccountId(value);
      }
    };
  }, []);

  return React.createElement(
    'main',
    null,
    React.createElement('button', { id: 'caller-trigger', type: 'button', onClick: () => setResource(callerResource) }, 'Open resource reader'),
    React.createElement(ResourceReader, {
      resource,
      accountId,
      onClose: () => {
        fixture.closes += 1;
        setResource(undefined);
      }
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

interface ResourcePage {
  context: Record<string, unknown>;
  data: { resourceId: string; authorityId?: string; value?: unknown };
  observations: Record<string, Observation>;
  actions: unknown[];
}

interface ResourceRequest {
  id: string;
  refresh: boolean;
  method: string;
  pathname: string;
  accountId?: string;
  authorityId?: string;
  body?: unknown;
  headers: Record<string, string>;
}

type Outcome =
  | { kind: 'page'; page: ResourcePage }
  | { kind: 'failure'; status?: number; error: string }
  | { kind: 'abort' };

type Handler = (request: ResourceRequest) => Outcome | Promise<Outcome>;

interface OpenedFixture {
  page: Page;
  requests: ResourceRequest[];
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

function pageFor(id: string, observation: Observation, extra: Record<string, Observation> = {}, authorityId?: string): ResourcePage {
  const value = 'value' in observation ? observation.value : undefined;
  return {
    context: { resourceId: id },
    data: {
      resourceId: id,
      ...(authorityId === undefined ? {} : { authorityId }),
      ...(value === undefined ? {} : { value })
    },
    observations: { [`observation:${id}`]: observation, ...extra },
    actions: []
  };
}

function available(id: string, value: unknown, extra: Record<string, Observation> = {}, at = observedAt): ResourcePage {
  return pageFor(id, { state: 'available', source: id, observedAt: at, value }, extra);
}

function unavailable(id: string, error: string): ResourcePage {
  return pageFor(id, { state: 'unavailable', source: id, error, observedAt });
}

function notRetrieved(id: string): ResourcePage {
  return pageFor(id, { state: 'not-retrieved', source: id });
}

function objectBody(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

let browser: Browser | undefined;
let bundle: string | undefined;

before(async () => {
  const result = await build({
    stdin: {
      contents: fixtureSource,
      resolveDir: projectRoot,
      sourcefile: 'frontend-reader-fixture.js',
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
  const requests: ResourceRequest[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });

  await page.route(`${fixtureOrigin}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/bundle.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: activeBundle });
      return;
    }
    const match = /^\/api\/resources\/([^/]+)(\/refresh)?$/.exec(url.pathname);
    if (!match) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }
    const id = decodeURIComponent(match[1]!);
    const refresh = match[2] !== undefined;
    const bodyText = request.postData();
    const parsedBody: unknown = bodyText ? JSON.parse(bodyText) as unknown : undefined;
    const body = objectBody(parsedBody);
    const accountId = refresh
      ? (typeof body?.accountId === 'string' ? body.accountId : undefined)
      : (url.searchParams.get('accountId') ?? undefined);
    const authorityId = refresh
      ? (typeof body?.authorityId === 'string' ? body.authorityId : undefined)
      : (url.searchParams.get('authorityId') ?? undefined);
    const recorded: ResourceRequest = {
      id,
      refresh,
      method: request.method(),
      pathname: url.pathname,
      ...(accountId === undefined ? {} : { accountId }),
      ...(authorityId === undefined ? {} : { authorityId }),
      ...(parsedBody === undefined ? {} : { body: parsedBody }),
      headers: request.headers()
    };
    requests.push(recorded);
    const outcome = await handler(recorded);
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

  await page.goto(fixtureOrigin);
  await page.waitForFunction(() => {
    const fixture = (window as unknown as { __readerFixture?: { controls?: unknown } }).__readerFixture;
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

function reader(page: Page): Locator {
  return page.getByRole('dialog');
}

async function openReader(page: Page): Promise<Locator> {
  const dialog = reader(page);
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  return dialog;
}

async function waitForText(scope: Locator, text: string | RegExp, message: string): Promise<void> {
  try {
    await scope.getByText(text).first().waitFor({ state: 'visible', timeout: settleTimeout });
  } catch (error) {
    const actual = await scope.innerText();
    throw new Error(`${message}; reader text was ${JSON.stringify(actual)}`, { cause: error });
  }
}

async function openResource(page: Page, id: string, authorityId?: string): Promise<void> {
  await page.evaluate(({ id, authorityId }) => {
    const fixture = (window as unknown as { __readerFixture: { controls: { open(id: string, authorityId?: string): void } } }).__readerFixture;
    fixture.controls.open(id, authorityId);
  }, { id, authorityId });
}

async function setResource(page: Page, resource: { id: string; authorityId?: string } | undefined): Promise<void> {
  await page.evaluate((value) => {
    const fixture = (window as unknown as { __readerFixture: { controls: { setResource(value: unknown): void } } }).__readerFixture;
    fixture.controls.setResource(value);
  }, resource);
}

async function setAccount(page: Page, accountId: string): Promise<void> {
  await page.evaluate((id) => {
    const fixture = (window as unknown as { __readerFixture: { controls: { setAccount(value: string): void } } }).__readerFixture;
    fixture.controls.setAccount(id);
  }, accountId);
}

async function waitForCloses(page: Page, expected: number): Promise<void> {
  await page.waitForFunction((count) => {
    const fixture = (window as unknown as { __readerFixture?: { closes?: number } }).__readerFixture;
    return fixture?.closes === count;
  }, expected, { timeout: settleTimeout });
}

async function activeInside(scope: Locator): Promise<boolean> {
  return scope.evaluate((element) => element.contains(document.activeElement));
}

async function expandDetails(scope: Locator, contains: string): Promise<Locator> {
  const details = scope.locator('details').filter({ hasText: contains }).first();
  await details.waitFor({ state: 'attached', timeout: settleTimeout });
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await details.locator('summary').first().click();
  }
  return details;
}

test('opens from the caller into a named modal and returns focus on Escape and Close', async (t) => {
  const { page, errors } = await openFixture(t, ({ id }) => ({
    kind: 'page',
    page: available(id, { id, type: 'Asset', name: 'Rope' })
  }));

  const trigger = page.locator('#caller-trigger');
  await trigger.focus();
  await trigger.click();
  const dialog = await openReader(page);
  await dialog.getByRole('heading', { name: 'Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await dialog.getByRole('button', { name: 'Close' }).count(), 1);
  assert.equal(await dialog.getByRole('button', { name: 'Refresh' }).count(), 1);
  assert.equal(await activeInside(dialog), true, 'focus should move into the dialog');

  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press('Tab');
    assert.equal(await activeInside(dialog), true, 'Tab must remain inside the dialog');
  }
  await page.keyboard.press('Shift+Tab');
  assert.equal(await activeInside(dialog), true, 'Shift+Tab must remain inside the dialog');

  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForCloses(page, 1);
  await page.waitForFunction(() => document.activeElement?.id === 'caller-trigger', undefined, { timeout: settleTimeout });

  await trigger.click();
  const reopened = await openReader(page);
  await reopened.getByRole('heading', { name: 'Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });
  await reopened.getByRole('button', { name: 'Close' }).click();
  await reopened.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForCloses(page, 2);
  await page.waitForFunction(() => document.activeElement?.id === 'caller-trigger', undefined, { timeout: settleTimeout });
  assert.deepEqual(errors, []);
});

test('performs a retained GET on open and an explicit scoped POST only on Refresh', async (t) => {
  const { page, requests, errors } = await openFixture(t, (request) => ({
    kind: 'page',
    page: available(request.id, {
      id: request.id,
      type: 'Asset',
      name: request.refresh ? 'Refreshed Rope' : 'Rope'
    })
  }));

  await setAccount(page, 'acct-one');
  await openResource(page, callerId, callerAuthority);
  const dialog = await openReader(page);
  await dialog.getByRole('heading', { name: 'Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });

  assert.equal(requests.length, 1, 'opening should perform exactly one retained GET');
  const read = requests[0]!;
  assert.equal(read.method, 'GET');
  assert.equal(read.refresh, false);
  assert.equal(read.pathname, `/api/resources/${encodeURIComponent(callerId)}`);
  assert.equal(read.accountId, 'acct-one');
  assert.equal(read.authorityId, callerAuthority);

  await sleep(150);
  assert.equal(requests.filter((request) => request.refresh).length, 0, 'opening must not observe the world through POST');

  await dialog.getByRole('button', { name: 'Refresh' }).click();
  await dialog.getByRole('heading', { name: 'Refreshed Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(requests.length, 2);
  const refresh = requests[1]!;
  assert.equal(refresh.method, 'POST');
  assert.equal(refresh.refresh, true);
  assert.equal(refresh.pathname, `/api/resources/${encodeURIComponent(callerId)}/refresh`);
  assert.equal(refresh.accountId, 'acct-one');
  assert.equal(refresh.authorityId, callerAuthority);
  assert.deepEqual(refresh.body, { accountId: 'acct-one', authorityId: callerAuthority });
  assert.deepEqual(errors, []);
});

test('renders structured resource fields and descriptive production instead of a raw JSON dump', async (t) => {
  const value = {
    id: callerId,
    type: 'Asset',
    name: 'Rope',
    description: 'Braided line for rigging',
    mass: 2,
    production: [{
      type: 'weave',
      ingredients: [{ variety: 'https://resources.invalid/varieties/fiber', count: 2 }],
      duration: 3
    }]
  };
  const { page, errors } = await openFixture(t, ({ id }) => ({ kind: 'page', page: available(id, value) }));

  await openResource(page, callerId);
  const dialog = await openReader(page);
  await dialog.getByRole('heading', { name: 'Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });
  await waitForText(dialog, 'Braided line for rigging', 'expected the resource description');
  await waitForText(dialog, /Type:\s*Asset/i, 'expected the resource type');
  await waitForText(dialog, /Production/i, 'expected production information');
  await waitForText(dialog, /descriptive/i, 'expected production to remain descriptive');
  await waitForText(dialog, 'weave', 'expected the production entry');
  await waitForText(dialog, /Mass:\s*2/i, 'expected useful resource fields');
  assert.deepEqual(errors, []);
});

test('renders plain resource text inertly without executing markup or fetching media', async (t) => {
  const markup = '<b>bold text</b><script>window.__readerInjected = true;</script><img src="https://media.invalid/pixel" onerror="window.__readerInjected = true">';
  const { page, requests, errors } = await openFixture(t, ({ id }) => ({ kind: 'page', page: available(id, markup) }));

  await openResource(page, callerId);
  const dialog = await openReader(page);
  await waitForText(dialog, '<b>bold text</b>', 'expected the plain resource text literally');
  assert.equal(await dialog.locator('script, iframe, img, video, audio').count(), 0, 'resource text must not become active markup');
  const content = await dialog.textContent();
  assert.ok(content?.includes(markup), 'the entire plain resource text should remain inert');
  assert.equal(await page.evaluate(() => (window as unknown as { __readerInjected?: boolean }).__readerInjected), undefined);
  await sleep(150);
  assert.equal(requests.filter((request) => request.id === 'https://media.invalid/pixel').length, 0, 'inert text must not trigger media requests');
  assert.deepEqual(errors, []);
});

test('tells the user to Refresh when a retained read has no body and loads content only after Refresh', async (t) => {
  const { page, requests, errors } = await openFixture(t, ({ id, refresh }) => ({
    kind: 'page',
    page: refresh ? available(id, { id, type: 'Asset', name: 'Fresh Rope' }) : notRetrieved(id)
  }));

  await openResource(page, callerId);
  const dialog = await openReader(page);
  await waitForText(dialog, /not.?retrieved/i, 'expected the missing retained body to be named');
  assert.equal(await dialog.getByRole('heading', { name: 'Fresh Rope' }).count(), 0);

  await dialog.getByRole('button', { name: 'Refresh' }).click();
  await dialog.getByRole('heading', { name: 'Fresh Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(requests.filter((request) => request.refresh).length, 1);
  assert.deepEqual(errors, []);
});

test('reports an empty retained observation and offers explicit Refresh', async (t) => {
  const { page, requests, errors } = await openFixture(t, ({ id, refresh }) => ({
    kind: 'page',
    page: refresh
      ? available(id, { id, type: 'Asset', name: 'Populated Rope' })
      : pageFor(id, { state: 'empty', source: id, observedAt, value: [] })
  }));

  await openResource(page, callerId);
  const dialog = await openReader(page);
  await waitForText(dialog, /empty|no entries/i, 'expected the empty retained observation to be named');
  assert.equal(await dialog.getByRole('heading', { name: 'Populated Rope' }).count(), 0);

  await dialog.getByRole('button', { name: 'Refresh' }).click();
  await dialog.getByRole('heading', { name: 'Populated Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(requests.filter((request) => request.refresh).length, 1);
  assert.deepEqual(errors, []);
});

test('keeps stale content readable with state, time and error while raw IDs stay in disclosure', async (t) => {
  const { page, errors } = await openFixture(t, ({ id }) => ({
    kind: 'page',
    page: pageFor(id, {
      state: 'stale',
      source: id,
      observedAt,
      value: { id, type: 'Asset' },
      error: 'last refresh failed'
    })
  }));

  await openResource(page, opaqueId);
  const dialog = await openReader(page);
  await waitForText(dialog, /Type:\s*Asset/i, 'expected retained content');
  await waitForText(dialog, /stale/i, 'expected the stale state');
  await waitForText(dialog, observedAt, 'expected the observation time');
  await waitForText(dialog, 'last refresh failed', 'expected the stale error');

  const headings = await dialog.getByRole('heading').allTextContents();
  for (const heading of headings) assert.notEqual(heading.trim(), '7f3a9c', 'URL tails must not become resource names');

  const details = await expandDetails(dialog, opaqueId);
  const disclosure = await details.textContent();
  assert.ok(disclosure?.includes(opaqueId), 'expected the exact source URI in the disclosure');
  assert.deepEqual(errors, []);
});

test('shows separate media text and media failure without executing media', async (t) => {
  const mediaOk = 'https://media.invalid/caption.txt';
  const mediaBad = 'https://media.invalid/broken.bin';
  const { page, errors } = await openFixture(t, ({ id }) => ({
    kind: 'page',
    page: available(id, { id, type: 'Asset', name: 'Rope', media: [mediaOk, mediaBad] }, {
      [`media:${mediaOk}`]: { state: 'available', source: mediaOk, observedAt, value: 'Rope care instructions' },
      [`media:${mediaBad}`]: { state: 'unavailable', source: mediaBad, observedAt, error: 'media server timed out' }
    })
  }));

  await openResource(page, callerId);
  const dialog = await openReader(page);
  await dialog.getByRole('heading', { name: 'Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });
  await waitForText(dialog, 'Rope care instructions', 'expected readable media text');
  await waitForText(dialog, 'media server timed out', 'expected an independent media failure');
  assert.equal(await dialog.locator('img, video, audio, iframe').count(), 0, 'media observations must not auto-execute');
  assert.deepEqual(errors, []);
});

test('reads linked references in place, keeps the caller resource for reopen, and does not inherit parent authority', async (t) => {
  const { page, requests, errors } = await openFixture(t, ({ id }) => {
    if (id === callerId) {
      return {
        kind: 'page',
        page: available(id, {
          id,
          type: 'Asset',
          name: 'Rope',
          holder: linkedHolderId,
          asset: { id: linkedAssetId, authorityId: explicitAuthority },
          media: { caption: 'Care instructions', contentType: 'text/plain' }
        })
      };
    }
    if (id === linkedHolderId) {
      return { kind: 'page', page: available(id, { id, type: 'Actor', name: 'Harbor Holder' }) };
    }
    if (id === linkedAssetId) {
      return { kind: 'page', page: available(id, { id, type: 'Asset', name: 'Linked Asset' }) };
    }
    return { kind: 'page', page: notRetrieved(id) };
  });

  await setAccount(page, 'acct-one');
  await openResource(page, callerId, callerAuthority);
  let dialog = await openReader(page);
  await dialog.getByRole('heading', { name: 'Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });

  assert.equal(await dialog.getByRole('button', { name: /Read linked/i }).count(), 2, 'metadata text must not become resource links');
  await dialog.getByRole('button', { name: /Read linked asset/i }).click();
  await dialog.getByRole('heading', { name: 'Linked Asset' }).waitFor({ state: 'visible', timeout: settleTimeout });
  const assetRead = requests.filter((request) => request.id === linkedAssetId).at(-1);
  assert(assetRead, 'expected a read for the explicitly scoped linked asset');
  assert.equal(assetRead.accountId, 'acct-one');
  assert.equal(assetRead.authorityId, explicitAuthority, 'explicit reference provenance should be preserved');

  await dialog.getByRole('button', { name: 'Close' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForCloses(page, 1);

  await page.locator('#caller-trigger').click();
  dialog = await openReader(page);
  await dialog.getByRole('heading', { name: 'Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByRole('button', { name: /Read linked holder/i }).click();
  await dialog.getByRole('heading', { name: 'Harbor Holder' }).waitFor({ state: 'visible', timeout: settleTimeout });
  const holderRead = requests.filter((request) => request.id === linkedHolderId).at(-1);
  assert(holderRead, 'expected a read for the linked holder');
  assert.equal(holderRead.accountId, 'acct-one');
  assert.equal(holderRead.authorityId, undefined, 'the parent authority must not be reused for a foreign link');

  await dialog.getByRole('button', { name: 'Close' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForCloses(page, 2);

  await page.locator('#caller-trigger').click();
  dialog = await openReader(page);
  await dialog.getByRole('heading', { name: 'Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await dialog.getByRole('heading', { name: 'Harbor Holder' }).count(), 0, 'reopening should use the caller resource');
  assert.deepEqual(errors, []);
});

test('shows the current target while loading and drops an older refresh after a newer resource opens', async (t) => {
  const refreshed = deferred<Outcome>();
  const beta = deferred<Outcome>();
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.id === callerId && !request.refresh) {
      return { kind: 'page', page: available(callerId, { id: callerId, type: 'Asset', name: 'Alpha' }) };
    }
    if (request.id === callerId && request.refresh) return refreshed.promise;
    if (request.id === secondId && !request.refresh) return beta.promise;
    return { kind: 'page', page: notRetrieved(request.id) };
  });

  await openResource(page, callerId);
  const dialog = await openReader(page);
  await dialog.getByRole('heading', { name: 'Alpha' }).waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByRole('button', { name: 'Refresh' }).click();
  await waitFor(() => requests.some((request) => request.refresh), 'expected the held refresh request');

  await setResource(page, { id: secondId });
  await waitFor(() => requests.some((request) => request.id === secondId), 'expected a retained read for the newer resource');
  await waitFor(async () => {
    const text = await dialog.innerText();
    return !text.includes('Alpha') && (/loading|reading|retriev/i.test(text) || text.includes(secondId));
  }, 'expected the current resource identity or a loading state instead of old content');

  beta.resolve({ kind: 'page', page: available(secondId, { id: secondId, type: 'Asset', name: 'Beta' }) });
  await dialog.getByRole('heading', { name: 'Beta' }).waitFor({ state: 'visible', timeout: settleTimeout });

  refreshed.resolve({ kind: 'page', page: available(callerId, { id: callerId, type: 'Asset', name: 'Alpha Refreshed' }) });
  await sleep(200);
  await dialog.getByRole('heading', { name: 'Beta' }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await dialog.getByRole('heading', { name: 'Alpha Refreshed' }).count(), 0, 'an older refresh must not replace the newer resource');
  assert.deepEqual(errors, []);
});

test('drops a late initial read when a newer resource opens', async (t) => {
  const alpha = deferred<Outcome>();
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.id === callerId) return alpha.promise;
    if (request.id === secondId) {
      return { kind: 'page', page: available(secondId, { id: secondId, type: 'Asset', name: 'Beta' }) };
    }
    return { kind: 'page', page: notRetrieved(request.id) };
  });

  await openResource(page, callerId);
  const dialog = await openReader(page);
  await waitFor(() => requests.some((request) => request.id === callerId), 'expected the held initial read');

  await setResource(page, { id: secondId });
  await dialog.getByRole('heading', { name: 'Beta' }).waitFor({ state: 'visible', timeout: settleTimeout });

  alpha.resolve({ kind: 'page', page: available(callerId, { id: callerId, type: 'Asset', name: 'Alpha' }) });
  await sleep(200);
  await dialog.getByRole('heading', { name: 'Beta' }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await dialog.getByRole('heading', { name: 'Alpha' }).count(), 0, 'a late read must not replace the newer resource');
  assert.deepEqual(errors, []);
});

test('a close invalidates a pending retained read and cannot reopen the reader', async (t) => {
  const pending = deferred<Outcome>();
  const { page, errors } = await openFixture(t, () => pending.promise);

  await openResource(page, callerId);
  const dialog = await openReader(page);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForCloses(page, 1);

  pending.resolve({ kind: 'page', page: available(callerId, { id: callerId, type: 'Asset', name: 'Late Resource' }) });
  await sleep(200);
  assert.equal(await reader(page).isVisible(), false, 'a late result must not reopen the dialog');
  assert.equal(await page.getByText('Late Resource').isVisible(), false, 'closed private content must remain cleared');
  await waitForCloses(page, 1);
  assert.deepEqual(errors, []);
});

test('an account change closes the reader immediately, clears private content, and invalidates pending work', async (t) => {
  const pendingRefresh = deferred<Outcome>();
  const { page, requests, errors } = await openFixture(t, (request) => {
    if (request.refresh) return pendingRefresh.promise;
    return { kind: 'page', page: available(callerId, { id: callerId, type: 'Asset', name: 'Private Rope' }) };
  });

  await setAccount(page, 'acct-one');
  await openResource(page, callerId);
  const dialog = await openReader(page);
  await dialog.getByRole('heading', { name: 'Private Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByRole('button', { name: 'Refresh' }).click();
  await waitFor(() => requests.some((request) => request.refresh), 'expected the held refresh request');

  await setAccount(page, 'acct-two');
  await waitForCloses(page, 1);
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.equal(await page.getByText('Private Rope').isVisible(), false, 'private content must be cleared immediately');

  pendingRefresh.resolve({ kind: 'page', page: available(callerId, { id: callerId, type: 'Asset', name: 'Late Private Rope' }) });
  await sleep(200);
  assert.equal(await reader(page).isVisible(), false, 'a late private result must not reopen the dialog');
  assert.equal(await page.getByText('Late Private Rope').isVisible(), false);
  assert.equal(requests.filter((request) => request.accountId === 'acct-two').length, 0, 'the old resource must not be queried under the new account');
  await waitForCloses(page, 1);
  assert.deepEqual(errors, []);
});

test('anonymous reads omit account scope from both the retained GET and explicit Refresh', async (t) => {
  const { page, requests, errors } = await openFixture(t, ({ id, refresh }) => ({
    kind: 'page',
    page: available(id, { id, type: 'Asset', name: refresh ? 'Public Refresh' : 'Public Rope' })
  }));

  await openResource(page, callerId);
  const dialog = await openReader(page);
  await dialog.getByRole('heading', { name: 'Public Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });
  const read = requests[0]!;
  assert.equal(read.accountId, undefined, 'anonymous reads must not send an account ID');
  assert.equal(read.headers.authorization, undefined, 'anonymous reads must not attach a session credential');

  await dialog.getByRole('button', { name: 'Refresh' }).click();
  await dialog.getByRole('heading', { name: 'Public Refresh' }).waitFor({ state: 'visible', timeout: settleTimeout });
  const refresh = requests[1]!;
  assert.equal(refresh.accountId, undefined);
  assert.deepEqual(refresh.body, {});
  assert.equal(refresh.headers.authorization, undefined);
  assert.deepEqual(errors, []);
});

test('shows readable transport and unavailable states without inventing content', async (t) => {
  const { page, errors } = await openFixture(t, (request) => {
    if (request.id === callerId) return { kind: 'abort' };
    return { kind: 'page', page: unavailable(request.id, 'space server timed out') };
  });

  await openResource(page, callerId);
  const dialog = await openReader(page);
  await waitForText(dialog, /fail|unavailable|error|problem|could not/i, 'expected a readable transport failure');

  await setResource(page, { id: secondId });
  await waitForText(dialog, /unavailable/i, 'expected the unavailable state');
  await waitForText(dialog, 'space server timed out', 'expected the unavailable error');
  assert.equal(await dialog.getByRole('heading', { name: 'Untitled' }).count(), 0, 'an unavailable resource must not invent a name');
  assert.deepEqual(errors, []);
});

test('a media observation cannot supply the missing main resource observation status', async (t) => {
  const mediaId = 'https://media.invalid/independent.txt';
  const { page, errors } = await openFixture(t, ({ id }) => ({
    kind: 'page',
    page: {
      context: { resourceId: id },
      data: { resourceId: id },
      observations: { media: { state: 'available', source: mediaId, observedAt, value: 'Independent media body' } },
      actions: []
    }
  }));
  await openResource(page, callerId);
  const dialog = await openReader(page);
  await waitForText(dialog, 'Independent media body', 'expected independently retained media');
  await waitForText(dialog, /not.?retrieved/i, 'main resource state must remain unknown');
  const details = await expandDetails(dialog, callerId);
  assert.ok((await details.textContent())?.includes(`Source ${callerId}`));
  assert.deepEqual(errors, []);
});

test('an unrelated parent render preserves a pending refresh despite a fresh close callback', async (t) => {
  const pending = deferred<Outcome>();
  const { page, requests, errors } = await openFixture(t, ({ id, refresh }) => refresh
    ? pending.promise
    : { kind: 'page', page: available(id, { id, type: 'Asset', name: 'Retained Rope' }) });
  await openResource(page, callerId);
  const dialog = await openReader(page);
  await dialog.getByRole('heading', { name: 'Retained Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByRole('button', { name: 'Refresh' }).click();
  await waitFor(() => requests.some((request) => request.refresh), 'expected the pending refresh');
  await setResource(page, { id: callerId });
  await sleep(150);
  assert.equal(requests.filter((request) => !request.refresh).length, 1, 'parent rendering must not repeat the retained read');
  pending.resolve({ kind: 'page', page: available(callerId, { id: callerId, type: 'Asset', name: 'Refreshed Rope' }) });
  await dialog.getByRole('heading', { name: 'Refreshed Rope' }).waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByRole('button', { name: 'Close' }).click();
  await waitForCloses(page, 1);
  assert.deepEqual(errors, []);
});
