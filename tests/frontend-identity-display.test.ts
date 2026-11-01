import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureOrigin = 'http://fixture.invalid/';
const actorId = 'https://alpha.test:4200/actors/sana';
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

const fixtureSource = String.raw`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { identityDisplay } from './apps/frontend/src/identity-display.ts';
import { readServers } from './apps/frontend/src/application-api.ts';
import { HandleLabel } from './apps/frontend/src/handle-label.tsx';
import { ObjectIdentifier } from './apps/frontend/src/object-identifier.tsx';
import { RegistryCard } from './apps/frontend/src/registry-card.tsx';

const fixture = { controls: null, clicks: 0 };
window.__identityDisplayFixture = fixture;

function IngestView() {
  const [loaded, setLoaded] = React.useState(false);
  React.useEffect(() => {
    readServers().then(() => setLoaded(true), () => setLoaded(true));
  }, []);
  return React.createElement(React.Fragment, null,
    React.createElement(HandleLabel, { actorId: ${JSON.stringify(actorId)} }),
    React.createElement('span', null, loaded ? ' loaded' : ' loading')
  );
}

function renderView(view) {
  if (view.kind === 'handle') return React.createElement(HandleLabel, view.props || {});
  if (view.kind === 'object') return React.createElement(ObjectIdentifier, view.props || {});
  if (view.kind === 'registry') {
    const onPress = view.clickable ? () => { fixture.clicks += 1; } : undefined;
    return React.createElement(RegistryCard, { ...(view.props || {}), ...(onPress ? { onPress } : {}) });
  }
  if (view.kind === 'ingest') return React.createElement(IngestView);
  return null;
}

function App() {
  const [view, setView] = React.useState({ kind: 'empty' });
  React.useEffect(() => {
    fixture.controls = {
      render(next) { setView(next); },
      register(records) { identityDisplay.registerRecords(records); },
      clear() { identityDisplay.clear(); }
    };
  }, []);
  return React.createElement(React.Fragment, null, renderView(view));
}

createRoot(document.getElementById('root')).render(React.createElement(App));
`;

interface OpenedFixture {
  page: Page;
  errors: string[];
}

let browser: Browser | undefined;
let bundle: string | undefined;

before(async () => {
  const result = await build({
    stdin: {
      contents: fixtureSource,
      resolveDir: projectRoot,
      sourcefile: 'frontend-identity-display-fixture.js',
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

async function openFixture(t: TestContext): Promise<OpenedFixture> {
  const activeBrowser = browser;
  const activeBundle = bundle;
  assert(activeBrowser, 'browser was not started');
  assert(activeBundle, 'fixture bundle was not built');

  const context = await activeBrowser.newContext();
  t.after(async () => { await context.close(); });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });

  await page.route(`${fixtureOrigin}**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/bundle.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: activeBundle });
      return;
    }
    if (url.pathname === '/api/servers') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          servers: [],
          authorities: [],
          identities: [{
            actorId,
            source: actorId,
            state: 'available',
            verified: true,
            handle: '@sana@alpha.test:4200',
            name: 'Sana',
            observedAt: '2026-11-01T00:00:00Z'
          }]
        })
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });

  await page.goto(fixtureOrigin);
  await page.waitForFunction(() => {
    const fixture = (window as unknown as { __identityDisplayFixture?: { controls?: unknown } }).__identityDisplayFixture;
    return Boolean(fixture && fixture.controls);
  });
  return { page, errors };
}

async function render(page: Page, view: unknown): Promise<void> {
  await page.evaluate((next) => {
    const fixture = (window as unknown as {
      __identityDisplayFixture: { controls: { render(value: unknown): void } };
    }).__identityDisplayFixture;
    fixture.controls.render(next);
  }, view);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function register(page: Page, records: unknown[]): Promise<void> {
  await page.evaluate((values) => {
    const fixture = (window as unknown as {
      __identityDisplayFixture: { controls: { register(value: unknown[]): void; clear(): void } };
    }).__identityDisplayFixture;
    fixture.controls.clear();
    fixture.controls.register(values);
  }, records);
}

async function visibleText(page: Page): Promise<string> {
  return page.locator('#root').innerText();
}

test('renders the verified handle for a registered Actor without exposing the Actor URI', async (t) => {
  const { page, errors } = await openFixture(t);
  await register(page, [{
    actorId,
    source: actorId,
    state: 'available',
    verified: true,
    handle: '@sana@alpha.test:4200',
    name: 'Sana',
    observedAt: '2026-11-01T00:00:00Z'
  }]);
  await render(page, { kind: 'handle', props: { actorId } });

  const text = await visibleText(page);
  assert.ok(text.includes('@sana@alpha.test:4200'), `expected the verified handle in ${JSON.stringify(text)}`);
  assert.equal(text.includes(actorId), false, 'the Actor URI must not be primary copy');
  assert.deepEqual(errors, []);
});

test('renders a published name without fabricating a handle when verification is absent', async (t) => {
  const { page, errors } = await openFixture(t);
  await register(page, [{
    actorId,
    source: actorId,
    state: 'empty',
    verified: false,
    name: 'Sana',
    reason: 'webfinger-not-published'
  }]);
  await render(page, { kind: 'handle', props: { actorId } });

  const text = await visibleText(page);
  assert.ok(text.includes('Sana'), `expected the published name in ${JSON.stringify(text)}`);
  assert.equal(text.includes('@sana@'), false, 'an unverified handle must not be fabricated');
  assert.equal(text.includes(actorId), false, 'the Actor URI must not be primary copy');
  assert.deepEqual(errors, []);
});

test('renders an object as the owner handle plus path segments', async (t) => {
  const { page, errors } = await openFixture(t);
  await register(page, [{
    actorId,
    source: actorId,
    state: 'available',
    verified: true,
    handle: '@sana@alpha.test:4200',
    name: 'Sana',
    observedAt: '2026-11-01T00:00:00Z'
  }]);
  await render(page, {
    kind: 'object',
    props: { uri: 'https://alpha.test:4200/assets/throne-of-crystal', owner: actorId }
  });

  const text = await visibleText(page);
  assert.ok(text.includes('@sana@alpha.test:4200'), `expected the owner handle in ${JSON.stringify(text)}`);
  assert.ok(text.includes('assets'), `expected the object path in ${JSON.stringify(text)}`);
  assert.ok(text.includes('throne-of-crystal'), `expected the object path in ${JSON.stringify(text)}`);
  assert.equal(text.includes('https://alpha.test:4200/assets/throne-of-crystal'), false, 'the raw object URI must not be primary copy');
  assert.deepEqual(errors, []);
});

test('RegistryCard shows its published identity and performs the action when clicked', async (t) => {
  const { page, errors } = await openFixture(t);
  await render(page, {
    kind: 'registry',
    props: { name: 'Harbor Registry', handle: '@harbor.registry@alpha.test:4200' },
    clickable: true
  });

  const text = await visibleText(page);
  assert.ok(text.includes('Harbor Registry'));
  assert.ok(text.includes('@harbor.registry@alpha.test:4200'));

  await page.getByRole('button').first().click();
  assert.equal(await page.evaluate(() => {
    const fixture = window as unknown as { __identityDisplayFixture: { clicks: number } };
    return fixture.__identityDisplayFixture.clicks;
  }), 1);
  assert.deepEqual(errors, []);
});

test('RegistryCard renders an honest placeholder when no identity is published', async (t) => {
  const { page, errors } = await openFixture(t);
  await render(page, { kind: 'registry', props: {} });

  const text = (await visibleText(page)).trim();
  assert.ok(text.length > 0, 'expected visible placeholder text');
  assert.equal(text.includes('undefined'), false);
  assert.equal(text.includes('null'), false);
  assert.deepEqual(errors, []);
});

test('renders a handle ingested from a client backend response', async (t) => {
  const { page, errors } = await openFixture(t);
  await render(page, { kind: 'ingest' });
  await page.getByText('@sana@alpha.test:4200', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
  const text = await visibleText(page);
  assert.ok(text.includes('@sana@alpha.test:4200'), `expected the embedded handle in ${JSON.stringify(text)}`);
  assert.equal(text.includes(actorId), false, 'the embedded response must not require displaying the Actor URI');
  assert.deepEqual(errors, []);
});
