import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureOrigin = 'http://fixture.invalid/';
const settleTimeout = 3_000;
const discoveryLabel = /server origin or account\/authority handle/i;
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

const fixtureSource = String.raw`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Connections } from './apps/frontend/src/connections.tsx';

const fixture = { controls: null };
window.__connectionsFixture = fixture;

function App() {
  const [accountId, setAccountId] = React.useState('account-a');
  React.useEffect(() => {
    fixture.controls = { setAccountId };
  }, []);
  return React.createElement(Connections, { accountId });
}

createRoot(document.getElementById('root')).render(React.createElement(App));
`;

interface ServerResponse {
  status?: number;
  body: unknown;
}

interface RequestInfo {
  call: number;
  body?: unknown;
  headers: Record<string, string>;
}

type Handler = (request: RequestInfo) => ServerResponse | Promise<ServerResponse>;

interface FixtureConfig {
  get?: Handler;
  post?: Handler;
  seedSession?: boolean;
}

interface RecordedRequest {
  method: string;
  pathname: string;
  body?: unknown;
  headers: Record<string, string>;
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

function directoryFor(origin: string): { servers: unknown[]; authorities: unknown[] } {
  const server = new URL(origin).host;
  const actorId = `${origin}/actors/registry`;
  return {
    servers: [{ server, origin, authorities: [actorId] }],
    authorities: [{ actorId, server, roles: ['registry'], name: 'Registry' }]
  };
}

const authorityA = {
  actorId: 'http://alpha.test:4200/actors/registry',
  server: 'alpha.test:4200',
  roles: ['registry', 'home'],
  name: 'Harbor Registry',
  handle: '@harbor.registry@alpha.test:4200'
};
const authorityB = {
  actorId: 'http://beta.test:4200/actors/registry',
  server: 'beta.test:4200',
  roles: ['registry'],
  name: 'Harbor Registry',
  handle: '@harbor.registry@beta.test:4200'
};
const authorityC = {
  actorId: 'http://gamma.test:4200/actors/mystery-actor',
  server: 'gamma.test:4200',
  roles: ['territory']
};
const serverA = { server: 'alpha.test:4200', origin: 'http://alpha.test:4200', authorities: [authorityA.actorId], name: 'Alpha Harbor' };
const serverB = { server: 'beta.test:4200', origin: 'http://beta.test:4200', authorities: [authorityB.actorId], name: 'Beta Harbor' };
const serverC = { server: 'gamma.test:4200', origin: 'http://gamma.test:4200', authorities: [authorityC.actorId] };

function sampleDirectory(): { servers: unknown[]; authorities: unknown[] } {
  return { servers: [serverA, serverB, serverC], authorities: [authorityA, authorityB, authorityC] };
}

let browser: Browser | undefined;
let bundle: string | undefined;

before(async () => {
  const result = await build({
    stdin: {
      contents: fixtureSource,
      resolveDir: projectRoot,
      sourcefile: 'frontend-connections-fixture.js',
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

async function openFixture(t: TestContext, config: FixtureConfig = {}): Promise<OpenedFixture> {
  const activeBrowser = browser;
  const activeBundle = bundle;
  assert(activeBrowser, 'browser was not started');
  assert(activeBundle, 'fixture bundle was not built');

  const context = await activeBrowser.newContext();
  t.after(async () => { await context.close(); });
  if (config.seedSession !== false) {
    await context.addInitScript(() => {
      localStorage.setItem('fctp.client-sessions', JSON.stringify([
        { accountId: 'account-a', handle: '@alpha.home@alpha.test:4200', clientToken: 'secret-client-token' }
      ]));
    });
  }

  const page = await context.newPage();
  const requests: RecordedRequest[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });

  let getCall = 0;
  let postCall = 0;
  await page.route(`${fixtureOrigin}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const bodyText = request.postData();
    const body: unknown = bodyText ? JSON.parse(bodyText) as unknown : undefined;
    requests.push({
      method: request.method(),
      pathname: url.pathname,
      ...(body === undefined ? {} : { body }),
      headers: request.headers()
    });

    if (url.pathname === '/bundle.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: activeBundle });
      return;
    }
    if (url.pathname === '/api/servers') {
      const info: RequestInfo = { call: request.method() === 'GET' ? getCall++ : postCall++, ...(body === undefined ? {} : { body }), headers: request.headers() };
      const handler = request.method() === 'GET' ? config.get : config.post;
      const response = handler === undefined
        ? { status: 200, body: { servers: [], authorities: [] } }
        : await handler(info);
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
    const fixture = (window as unknown as { __connectionsFixture?: { controls?: unknown } }).__connectionsFixture;
    return Boolean(fixture && fixture.controls);
  });
  return { page, requests, errors };
}

function region(page: Page) {
  return page.getByRole('region', { name: 'Connections' });
}

async function regionText(page: Page): Promise<string> {
  return region(page).innerText();
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

async function waitForRegionText(page: Page, expected: string | RegExp, message: string): Promise<string> {
  let last = '';
  try {
    await waitFor(async () => {
      last = await regionText(page);
      return typeof expected === 'string' ? last.includes(expected) : expected.test(last);
    }, message);
  } catch (error) {
    throw new Error(`${message}; last region text was ${JSON.stringify(last)}`, { cause: error });
  }
  return last;
}

async function setAccount(page: Page, accountId: string): Promise<void> {
  await page.evaluate((id) => {
    const fixture = (window as unknown as { __connectionsFixture: { controls: { setAccountId(value: string): void } } }).__connectionsFixture;
    fixture.controls.setAccountId(id);
  }, accountId);
}

function discoveryInput(page: Page) {
  return page.getByRole('textbox', { name: discoveryLabel });
}

async function submit(page: Page, value: string): Promise<void> {
  const input = discoveryInput(page);
  await input.fill(value);
  await input.press('Enter');
}

function posts(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => request.pathname === '/api/servers' && request.method === 'POST');
}

function gets(requests: readonly RecordedRequest[]): RecordedRequest[] {
  return requests.filter((request) => request.pathname === '/api/servers' && request.method === 'GET');
}

function occurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

test('reads the retained directory once on mount and never posts without explicit discovery', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    get: () => ({ status: 200, body: { servers: [], authorities: [] } })
  });

  await waitForRegionText(page, /no .*server/i, 'expected an empty directory message');
  await waitForRegionText(page, /retained/i, 'expected retained discovery to be stated');
  assert.equal(await discoveryInput(page).count(), 1, 'expected exactly one labelled discovery input');

  const apiRequests = requests.filter((request) => request.pathname.startsWith('/api/'));
  assert.equal(apiRequests.length, 1, 'only the retained directory read should occur');
  assert.equal(apiRequests[0]?.pathname, '/api/servers');
  assert.equal(apiRequests[0]?.method, 'GET');
  assert.equal(posts(requests).length, 0, 'mount must not submit discovery');

  await sleep(400);
  assert.equal(gets(requests).length, 1, 'the directory must not be polled automatically');
  assert.deepEqual(errors, []);
});

test('shows canonical server addresses and distinct published authorities without exposing actor IDs in primary copy', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    get: () => ({ status: 200, body: sampleDirectory() })
  });

  await waitForRegionText(page, 'http://alpha.test:4200', 'expected the first server address');
  const closedText = await regionText(page);
  for (const origin of ['http://alpha.test:4200', 'http://beta.test:4200', 'http://gamma.test:4200']) {
    assert.ok(closedText.includes(origin), `expected the canonical server origin ${origin}`);
  }
  assert.ok(closedText.includes('@harbor.registry@alpha.test:4200'), 'expected the first published handle');
  assert.ok(closedText.includes('@harbor.registry@beta.test:4200'), 'expected the second published handle');
  assert.ok(closedText.includes('registry'), 'expected published authority roles');
  assert.ok(closedText.includes('home'), 'expected every published authority role');
  assert.ok(closedText.includes('territory'), 'expected roles for an authority without a handle');
  assert.ok(occurrences(closedText, 'Harbor Registry') >= 2, 'same-named authorities on different hosts must both remain visible');
  assert.ok(!closedText.includes(authorityC.actorId), 'actor IDs belong in a disclosure, not primary copy');
  assert.ok(!closedText.includes('mystery-actor'), 'URL tails must not become inferred handles');
  assert.match(closedText, /unknown|unpublished|not published|authority/i, 'expected a neutral label for an authority without a published handle');
  for (const actorId of [authorityA.actorId, authorityB.actorId, authorityC.actorId]) {
    assert.equal(closedText.includes(actorId), false, `${actorId} must not appear before the disclosure is opened`);
  }

  const details = region(page).locator('details');
  await waitFor(async () => await details.count() >= 1, 'expected native details disclosures');
  const summaries = details.locator('summary');
  const count = await summaries.count();
  for (let index = 0; index < count; index += 1) await summaries.nth(index).click();

  const openedText = await regionText(page);
  for (const actorId of [authorityA.actorId, authorityB.actorId, authorityC.actorId]) {
    assert.ok(openedText.includes(actorId), `expected the exact actor ID ${actorId} in the disclosure`);
  }
  assert.equal(posts(requests).length, 0, 'viewing the retained directory must not submit discovery');
  assert.deepEqual(errors, []);
});

test('submits an @ handle or an origin exactly, trims browser input, and sends no credentials', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    get: () => ({ status: 200, body: { servers: [], authorities: [] } }),
    post: () => ({ status: 200, body: { servers: [], authorities: [] } })
  });

  await waitForRegionText(page, /retained/i, 'expected the retained directory read to complete');
  assert.equal(await discoveryInput(page).count(), 1, 'expected one labelled discovery input');

  await submit(page, '  @harbor.registry@alpha.test:4200  ');
  await waitFor(() => posts(requests).length === 1, 'expected a handle discovery POST after keyboard submission');
  assert.deepEqual(posts(requests)[0]?.body, { handle: '@harbor.registry@alpha.test:4200' });

  await submit(page, '  http://alpha.test:4200  ');
  await waitFor(() => posts(requests).length === 2, 'expected an origin discovery POST');
  assert.deepEqual(posts(requests)[1]?.body, { origin: 'http://alpha.test:4200' });

  for (const request of requests.filter((candidate) => candidate.pathname === '/api/servers')) {
    assert.equal(request.headers.authorization, undefined, 'public discovery must not attach a session credential');
  }
  assert.deepEqual(errors, []);
});

test('keeps the retained directory visible when discovery fails and reports the failure', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    get: () => ({ status: 200, body: sampleDirectory() }),
    post: () => ({ status: 400, body: { error: 'Discovery failed: server did not answer' } })
  });

  await waitForRegionText(page, 'http://alpha.test:4200', 'expected the retained directory to load');
  await submit(page, 'http://broken.test:4300');
  await waitForRegionText(page, /server did not answer/i, 'expected the failure to be shown to the user');

  const text = await regionText(page);
  assert.ok(text.includes('http://alpha.test:4200'), 'a failed discover must not erase the retained directory');
  assert.ok(text.includes('@harbor.registry@alpha.test:4200'), 'retained authority details must remain visible');
  assert.equal(posts(requests).length, 1);
  assert.deepEqual(posts(requests)[0]?.body, { origin: 'http://broken.test:4300' });
  assert.deepEqual(errors, []);
});

test('reports an unavailable retained directory while keeping explicit discovery available', async (t) => {
  const { page, requests, errors } = await openFixture(t, {
    get: () => ({ status: 503, body: { error: 'Directory unavailable' } })
  });

  await waitForRegionText(page, /directory unavailable/i, 'expected the retained read failure to be shown');
  assert.equal(await discoveryInput(page).count(), 1, 'discovery must remain available after a retained read failure');
  assert.equal(posts(requests).length, 0);
  assert.deepEqual(errors, []);
});

test('does not let an older POST or an older account-context read replace a newer presentation', async (t) => {
  const olderContext = deferred<ServerResponse>();
  const newerContext = deferred<ServerResponse>();
  const olderPost = deferred<ServerResponse>();
  const { page, requests, errors } = await openFixture(t, {
    get: ({ call }) => {
      if (call === 0) return { status: 200, body: directoryFor('http://initial.test:4200') };
      if (call === 1) return olderContext.promise;
      return newerContext.promise;
    },
    post: () => olderPost.promise
  });

  await waitForRegionText(page, 'http://initial.test:4200', 'expected the initial retained directory');
  await submit(page, '@older@alpha.test:4200');
  await waitFor(() => posts(requests).length === 1, 'expected the held discovery POST');

  await setAccount(page, 'account-b');
  await waitFor(() => gets(requests).length === 2, 'expected a retained read for the changed account');
  await setAccount(page, 'account-a');
  await waitFor(() => gets(requests).length === 3, 'expected a retained read for the restored account');

  olderContext.resolve({ status: 200, body: directoryFor('http://older-context.test:4200') });
  await sleep(150);
  assert.equal((await regionText(page)).includes('older-context'), false, 'an older account read must not replace the newer presentation');

  olderPost.resolve({ status: 200, body: directoryFor('http://older-post.test:4200') });
  await sleep(150);
  assert.equal((await regionText(page)).includes('older-post'), false, 'an older POST response must not replace the newer presentation');

  newerContext.resolve({ status: 200, body: directoryFor('http://current-context.test:4200') });
  await waitForRegionText(page, 'http://current-context.test:4200', 'expected the current account read');
  await sleep(150);
  const finalText = await regionText(page);
  assert.equal(finalText.includes('older-context'), false);
  assert.equal(finalText.includes('older-post'), false);
  assert.deepEqual(errors, []);
});

test('renders published labels as inert text rather than markup', async (t) => {
  const injected = '<img src=x onerror="window.__connectionsInjected = true">';
  const { page, errors } = await openFixture(t, {
    get: () => ({
      status: 200,
      body: {
        servers: [{ server: 'alpha.test:4200', origin: 'http://alpha.test:4200', authorities: ['http://alpha.test:4200/actors/registry'] }],
        authorities: [{ actorId: 'http://alpha.test:4200/actors/registry', server: 'alpha.test:4200', roles: ['registry'], name: injected }]
      }
    })
  });

  await waitForRegionText(page, '<img', 'expected the published label as literal text');
  assert.equal(await region(page).locator('img').count(), 0, 'published labels must not become markup');
  const injectedFlag = await page.evaluate(() => (window as unknown as { __connectionsInjected?: boolean }).__connectionsInjected);
  assert.equal(injectedFlag, undefined, 'published labels must not execute script');
  assert.deepEqual(errors, []);
});

test('a late initial directory read cannot overwrite a completed explicit discovery', async (t) => {
  const retained = deferred<ServerResponse>();
  const { page, requests, errors } = await openFixture(t, {
    get: () => retained.promise,
    post: () => ({ status: 200, body: directoryFor('https://discovered.example') })
  });
  await waitFor(() => gets(requests).length === 1, 'expected the held initial read');
  await submit(page, 'https://discovered.example');
  await waitForRegionText(page, 'https://discovered.example', 'expected the explicit discovery result');
  const completed = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/servers');
  retained.resolve({ status: 200, body: directoryFor('https://older.example') });
  await (await completed).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.ok((await regionText(page)).includes('https://discovered.example'));
  assert.equal((await regionText(page)).includes('https://older.example'), false);
  assert.deepEqual(errors, []);
});
