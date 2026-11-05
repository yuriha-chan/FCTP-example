import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureOrigin = 'http://fixture.invalid/';
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

const fixtureSource = String.raw`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { VarietyCard } from './apps/frontend/src/variety-card.tsx';
import { PlayerCard } from './apps/frontend/src/player-card.tsx';
import { VesselCard } from './apps/frontend/src/vessel-card.tsx';
import { TerritoryCard } from './apps/frontend/src/territory-card.tsx';
import { HomeCard } from './apps/frontend/src/home-card.tsx';
import { PortCard } from './apps/frontend/src/port-card.tsx';
import { AssetCard } from './apps/frontend/src/asset-card.tsx';
import { identityDisplay } from './apps/frontend/src/identity-display.ts';

const fixture = { controls: null, presses: [] };
window.__entityCardsFixture = fixture;

function renderEntry(entry, index) {
  const props = entry.props ?? {};
  switch (entry.component) {
    case 'variety':
      return React.createElement(VarietyCard, {
        key: index,
        ...props,
        ...(entry.press === undefined ? {} : { onPress: () => { fixture.presses.push(entry.press); } })
      });
    case 'player':
      return React.createElement(PlayerCard, { key: index, ...props });
    case 'vessel':
      return React.createElement(VesselCard, { key: index, ...props });
    case 'territory':
      return React.createElement(TerritoryCard, { key: index, ...props });
    case 'home':
      return React.createElement(HomeCard, { key: index, ...props });
    case 'port':
      return React.createElement(PortCard, { key: index, ...props });
    case 'asset':
      return React.createElement(AssetCard, {
        key: index,
        ...props,
        ...(entry.press === undefined ? {} : { onPress: () => { fixture.presses.push(entry.press); } })
      });
    default:
      throw new Error('unknown card ' + entry.component);
  }
}

function View({ view }) {
  if (view.kind === 'many') {
    return React.createElement(React.Fragment, null, view.entries.map(renderEntry));
  }
  return renderEntry({ component: view.component, props: view.props, press: view.press }, 0);
}

function App() {
  const [view, setView] = React.useState({ kind: 'many', entries: [] });
  React.useEffect(() => {
    fixture.controls = {
      render(next) { setView(next); },
      registerIdentities(records) { identityDisplay.registerRecords(records); }
    };
  }, []);
  return React.createElement(View, { view });
}

createRoot(document.getElementById('root')).render(React.createElement(App));
`;

type CardComponent = 'variety' | 'player' | 'vessel' | 'territory' | 'home' | 'port' | 'asset';

interface CardEntry {
  component: CardComponent;
  props: Record<string, unknown>;
  press?: string;
}

type CardView =
  | { kind: 'many'; entries: CardEntry[] }
  | { kind: 'one'; component: CardComponent; props: Record<string, unknown>; press?: string };

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
      sourcefile: 'frontend-entity-cards-fixture.js',
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
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/bundle.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: activeBundle });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await page.route('https://media.invalid/**/*.png', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==', 'base64')
    });
  });

  await page.goto(fixtureOrigin);
  await page.waitForFunction(() => {
    const fixture = (window as unknown as { __entityCardsFixture?: { controls?: unknown } }).__entityCardsFixture;
    return Boolean(fixture && fixture.controls);
  });
  return { page, errors };
}

async function render(page: Page, view: CardView): Promise<void> {
  await page.evaluate((next) => {
    const fixture = (window as unknown as {
      __entityCardsFixture: { controls: { render(value: unknown): void } };
    }).__entityCardsFixture;
    fixture.controls.render(next);
  }, view);
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function visibleText(page: Page): Promise<string> {
  return page.locator('#root').innerText();
}

async function registerIdentities(page: Page, records: unknown[]): Promise<void> {
  await page.evaluate((next) => {
    const fixture = (window as unknown as {
      __entityCardsFixture: { controls: { registerIdentities(value: unknown): void } };
    }).__entityCardsFixture;
    fixture.controls.registerIdentities(next);
  }, records);
}

async function recordedPresses(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const fixture = (window as unknown as { __entityCardsFixture: { presses: string[] } }).__entityCardsFixture;
    return fixture.presses.slice();
  });
}

test('renders the supplied distinct published name on each card', async (t) => {
  const { page, errors } = await openFixture(t);
  const entries: CardEntry[] = [
    { component: 'variety', props: { name: 'Amber Tide' } },
    { component: 'player', props: { handle: '@mariner@alpha.test:4200' } },
    { component: 'vessel', props: { name: 'Sea Lark' } },
    { component: 'territory', props: { name: 'North Reach' } },
    { component: 'home', props: { name: 'Wayfarer Home' } },
    { component: 'port', props: { name: 'Harbor Gate' } }
  ];

  await render(page, { kind: 'many', entries });
  const text = await visibleText(page);
  for (const entry of entries) {
    const expected = typeof entry.props.name === 'string'
      ? entry.props.name
      : typeof entry.props.handle === 'string' ? entry.props.handle : undefined;
    assert.ok(expected, 'fixture entry needs a published name or handle');
    assert.ok(text.includes(expected), `expected the published identity ${JSON.stringify(expected)} in ${JSON.stringify(text)}`);
  }
  assert.deepEqual(errors, []);
});

test('renders TerritoryCard name and handle as separate published fields', async (t) => {
  const { page, errors } = await openFixture(t);
  const name = 'North Reach';
  const handle = '@north.territory@alpha.test:4200';

  await render(page, { kind: 'one', component: 'territory', props: { name, handle } });
  const text = await visibleText(page);
  assert.ok(text.includes(name), `expected the Territory name ${JSON.stringify(name)} in ${JSON.stringify(text)}`);
  assert.ok(text.includes(handle), `expected the Territory handle ${JSON.stringify(handle)} in ${JSON.stringify(text)}`);
  assert.deepEqual(errors, []);
});

test('renders HomeCard name and handle as separate published fields', async (t) => {
  const { page, errors } = await openFixture(t);
  const name = 'Wayfarer Home';
  const handle = '@wayfarer.home@alpha.test:4200';

  await render(page, { kind: 'one', component: 'home', props: { name, handle } });
  const text = await visibleText(page);
  assert.ok(text.includes(name), `expected the Home name ${JSON.stringify(name)} in ${JSON.stringify(text)}`);
  assert.ok(text.includes(handle), `expected the Home handle ${JSON.stringify(handle)} in ${JSON.stringify(text)}`);
  assert.deepEqual(errors, []);
});

test('renders the complete published player handle without shortening or resolving it', async (t) => {
  const { page, errors } = await openFixture(t);
  const handle = '@harbor.registry@alpha.test:4200';

  await render(page, { kind: 'one', component: 'player', props: { handle } });
  const text = await visibleText(page);
  assert.ok(text.includes(handle), `expected the full handle ${JSON.stringify(handle)} in ${JSON.stringify(text)}`);
  assert.ok(text.includes('@alpha.test:4200'), 'expected the server portion to remain visible');
  assert.deepEqual(errors, []);
});

test('renders honest non-empty placeholders when optional names are missing', async (t) => {
  const { page, errors } = await openFixture(t);
  const components = ['variety', 'vessel', 'territory', 'home', 'port'] as const;

  for (const component of components) {
    await render(page, { kind: 'one', component, props: {} });
    const text = (await visibleText(page)).trim();
    assert.ok(text.length > 0, `expected visible placeholder text for a missing ${component} name`);
    assert.equal(text.includes('undefined'), false, `the missing ${component} name must not render undefined`);
    assert.equal(text.includes('null'), false, `the missing ${component} name must not render null`);
  }
  assert.deepEqual(errors, []);
});

test('treats a whitespace-only name as missing', async (t) => {
  const { page, errors } = await openFixture(t);

  await render(page, { kind: 'one', component: 'variety', props: { name: '   ' } });
  const text = (await visibleText(page)).trim();
  assert.ok(text.length > 0, 'expected visible placeholder text for a whitespace-only name');
  assert.equal(text.includes('undefined'), false);
  assert.equal(text.includes('null'), false);
  assert.deepEqual(errors, []);
});

test('renders an Asset card with title, creator and holder handles, and retained text media without exposing addresses', async (t) => {
  const { page, errors } = await openFixture(t);
  const creatorOne = 'https://actors.invalid/crystal-smith';
  const creatorTwo = 'https://actors.invalid/glass-cutter';
  const holder = 'https://actors.invalid/throne-keeper';
  const mediaUrl = 'https://media.invalid/assets/throne.txt';
  const creatorOneHandle = '@crystal.smith@alpha.test:4200';
  const creatorTwoHandle = '@glass.cutter@alpha.test:4200';
  const holderHandle = '@throne.keeper@alpha.test:4200';
  const mediaText = 'The throne is cold.';

  await registerIdentities(page, [
    { actorId: creatorOne, verified: true, handle: creatorOneHandle },
    { actorId: creatorTwo, verified: true, handle: creatorTwoHandle },
    { actorId: holder, verified: true, handle: holderHandle }
  ]);
  await render(page, {
    kind: 'one',
    component: 'asset',
    props: {
      name: 'Throne of Crystal',
      creator: [creatorOne, creatorTwo],
      holder,
      media: [{ url: mediaUrl, mediaType: 'text/plain', state: 'available', value: mediaText }]
    }
  });

  const text = await visibleText(page);
  for (const expected of ['Throne of Crystal', creatorOneHandle, creatorTwoHandle, holderHandle, mediaText]) {
    assert.ok(text.includes(expected), `expected ${JSON.stringify(expected)} in ${JSON.stringify(text)}`);
  }
  for (const hidden of [mediaUrl, creatorOne, creatorTwo, holder]) {
    assert.equal(text.includes(hidden), false, `the Asset card must not expose ${JSON.stringify(hidden)} in its normal text`);
  }
  assert.equal(await page.getByRole('button', { name: /^Open resource/i }).count(), 0, 'the Asset card must not require an adjacent Open resource control');
  assert.deepEqual(errors, []);
});

test('renders image media directly on the Asset card', async (t) => {
  const { page, errors } = await openFixture(t);
  const mediaUrl = 'https://media.invalid/assets/throne.png';

  await render(page, {
    kind: 'one',
    component: 'asset',
    props: {
      name: 'Throne of Crystal',
      media: [{ url: mediaUrl, mediaType: 'image/png', state: 'unavailable' }]
    }
  });

  assert.equal(await page.locator(`img[src="${mediaUrl}"]`).count(), 1, 'expected the image media to render directly');
  assert.equal((await visibleText(page)).includes(mediaUrl), false, 'the image URL must not be rendered as text');
  assert.deepEqual(errors, []);
});

test('uses the Asset card itself as the press target when onPress is supplied', async (t) => {
  const { page, errors } = await openFixture(t);

  await render(page, { kind: 'one', component: 'asset', press: 'throne-card', props: { name: 'Throne of Crystal' } });
  const card = page.getByRole('button', { name: /Throne of Crystal/ }).first();
  await card.waitFor({ state: 'visible', timeout: 3_000 });
  await card.click();
  assert.deepEqual(await recordedPresses(page), ['throne-card']);
  assert.deepEqual(errors, []);
});

test('renders a Variety card with title, creator and holder handles, mass, version, and retained text media without exposing addresses', async (t) => {
  const { page, errors } = await openFixture(t);
  const creatorOne = 'https://actors.invalid/alloy-smith';
  const creatorTwo = 'https://actors.invalid/ore-cutter';
  const holder = 'https://actors.invalid/foundry-keeper';
  const oreId = 'https://resources.invalid/varieties/iron-ore';
  const mediaUrl = 'https://media.invalid/varieties/alloy.txt';
  const creatorOneHandle = '@alloy.smith@alpha.test:4200';
  const creatorTwoHandle = '@ore.cutter@alpha.test:4200';
  const holderHandle = '@foundry.keeper@alpha.test:4200';
  const mediaText = 'A dense alloy.';

  await registerIdentities(page, [
    { actorId: creatorOne, verified: true, handle: creatorOneHandle },
    { actorId: creatorTwo, verified: true, handle: creatorTwoHandle },
    { actorId: holder, verified: true, handle: holderHandle }
  ]);
  await render(page, {
    kind: 'one',
    component: 'variety',
    props: {
      name: 'Amber Alloy',
      creator: [creatorOne, creatorTwo],
      holder,
      mass: 2.5,
      version: '3.7.2',
      production: [{ type: 'manufacture', duration: 2, ingredients: [{ variety: oreId, count: 2, data: {} }], yield: [{ probability: 1, count: 1, data: {} }] }],
      referenceNames: { [oreId]: 'Iron Ore' },
      media: [{ url: mediaUrl, mediaType: 'text/plain', state: 'available', value: mediaText }]
    }
  });

  const text = await visibleText(page);
  for (const expected of ['Amber Alloy', creatorOneHandle, creatorTwoHandle, holderHandle, '2.5', '3.7.2', mediaText, 'Iron Ore', 'Manufactured', 'Asset Creator', 'Variety Manager']) {
    assert.ok(text.includes(expected), `expected ${JSON.stringify(expected)} in ${JSON.stringify(text)}`);
  }
  for (const hidden of [mediaUrl, creatorOne, creatorTwo, holder]) {
    assert.equal(text.includes(hidden), false, `the Variety card must not expose ${JSON.stringify(hidden)} in its normal text`);
  }
  assert.equal(text.includes('held by'), false, 'the Variety card must use the Variety Manager label instead of held by');
  assert.equal(text.includes(' by '), false, 'the Variety card must use the Asset Creator label instead of by');
  assert.deepEqual(errors, []);
});

test('uses the Variety card itself as the press target when onPress is supplied', async (t) => {
  const { page, errors } = await openFixture(t);

  await render(page, { kind: 'one', component: 'variety', press: 'alloy-card', props: { name: 'Amber Alloy' } });
  const card = page.getByRole('button', { name: /Amber Alloy/ }).first();
  await card.waitFor({ state: 'visible', timeout: 3_000 });
  await card.click();
  assert.deepEqual(await recordedPresses(page), ['alloy-card']);
  assert.deepEqual(errors, []);
});

test('renders image media directly on the Variety card', async (t) => {
  const { page, errors } = await openFixture(t);
  const mediaUrl = 'https://media.invalid/varieties/alloy.png';

  await render(page, {
    kind: 'one',
    component: 'variety',
    props: {
      name: 'Amber Alloy',
      media: [{ url: mediaUrl, mediaType: 'image/png', state: 'unavailable' }]
    }
  });

  assert.equal(await page.locator(`img[src="${mediaUrl}"]`).count(), 1, 'expected the image media to render directly');
  assert.equal((await visibleText(page)).includes(mediaUrl), false, 'the image URL must not be rendered as text');
  assert.deepEqual(errors, []);
});

test('renders the Variety reference layout with item heading, lore, recipes, weighted yields, and credits labels', async (t) => {
  const { page, errors } = await openFixture(t);
  const copperId = 'https://resources.invalid/varieties/copper';
  const glassId = 'https://resources.invalid/varieties/glass';
  const waxId = 'https://resources.invalid/varieties/beeswax';
  const oreId = 'https://resources.invalid/varieties/iron-ore';
  const itemId = 'https://resources.invalid/items/lantern-core';
  const artworkUrl = 'https://media.invalid/varieties/harbor-lantern.png';
  const lore = 'A lantern kept for the harbor watch on foggy nights.';

  await render(page, {
    kind: 'one',
    component: 'variety',
    props: {
      name: 'Harbor Lantern',
      production: [
        {
          type: 'manufacture',
          duration: 4,
          ingredients: [
            { variety: copperId, count: 2, data: {} },
            { variety: glassId, count: 1, data: {} },
            { id: itemId, variety: waxId, data: {} }
          ],
          yield: [{ probability: 0.8, count: 1, data: {} }, { probability: 0.2, count: 2, data: {} }]
        },
        {
          type: 'mine',
          duration: 1,
          ingredients: [{ variety: oreId, count: 3, data: {} }],
          yield: [{ probability: 1, count: 7, data: {} }]
        }
      ],
      referenceNames: {
        [copperId]: 'Copper',
        [glassId]: 'Glass',
        [waxId]: 'Beeswax',
        [oreId]: 'Iron Ore'
      },
      media: [
        { url: artworkUrl, mediaType: 'image/png', state: 'available' },
        { url: 'https://media.invalid/varieties/harbor-lantern.txt', mediaType: 'text/plain', state: 'available', value: lore }
      ]
    }
  });

  assert.equal(await page.locator(`img[src="${artworkUrl}"]`).count(), 1, 'expected the Variety artwork to render directly');
  const text = await visibleText(page);
  for (const expected of ['Harbor Lantern', lore, 'Item', 'Manufactured', 'Mined', 'Copper', 'Glass', 'Beeswax', 'Iron Ore', '0.8', '0.2', '7']) {
    assert.ok(text.includes(expected), `expected ${JSON.stringify(expected)} in ${JSON.stringify(text)}`);
  }
  assert.match(text, /Copper[^\d]{0,12}2/, 'expected the Copper ingredient count to remain visible');
  assert.match(text, /Glass[^\d]{0,12}1/, 'expected the Glass ingredient count to remain visible');
  assert.match(text, /Iron Ore[^\d]{0,12}3/, 'expected the Iron Ore ingredient count to remain visible');
  assert.doesNotMatch(text, /Beeswax[ \t]*(?:×|x|\*)[ \t]*\d/i, 'an Item ingredient without a count must not fabricate a count');
  assert.equal(text.includes('%'), false, 'probabilistic yields must not be presented as percentages');
  assert.equal(/install/i.test(text), false, 'the card must not claim installability without data');
  assert.doesNotMatch(text, /undefined|null|NaN/, 'malformed values must stay out of the visible card');
  assert.deepEqual(errors, []);
});

test('renders an Item heading without inventing production or installation claims when production is absent', async (t) => {
  const { page, errors } = await openFixture(t);

  await render(page, { kind: 'one', component: 'variety', props: { name: 'Plain Alloy' } });

  const text = await visibleText(page);
  assert.ok(text.includes('Plain Alloy'), `expected the title in ${JSON.stringify(text)}`);
  assert.match(text, /\bItem\b/i, 'expected an Item heading');
  for (const forbidden of ['Manufactured', 'Mined', 'Recipe', 'Installable', 'Asset Creator', 'Variety Manager']) {
    assert.equal(text.includes(forbidden), false, `the card must not claim ${JSON.stringify(forbidden)} without data`);
  }
  assert.doesNotMatch(text, /undefined|null|NaN/);
  assert.deepEqual(errors, []);
});

test('tolerates malformed and incomplete production entries while showing known recipe names', async (t) => {
  const { page, errors } = await openFixture(t);
  const knownId = 'https://resources.invalid/varieties/catalyst';
  const itemId = 'https://resources.invalid/items/frame';
  const lore = 'An alloy with incomplete records.';

  await render(page, {
    kind: 'one',
    component: 'variety',
    props: {
      name: 'Harbor Alloy',
      production: [
        null,
        'broken entry',
        {
          type: 'manufacture',
          duration: -1,
          ingredients: 'not-an-array',
          yield: [null, { probability: 0.5, count: 2, data: {} }, { probability: 'nope', count: '3', data: {} }]
        },
        {
          type: 'mine',
          ingredients: [null, { variety: knownId, count: '2', data: {} }, { id: itemId, variety: knownId }],
          yield: []
        }
      ],
      referenceNames: { [knownId]: 'Catalyst' },
      media: [
        { url: 'https://media.invalid/varieties/incomplete.txt', mediaType: 'text/plain', state: 'available', value: lore },
        { url: 'https://media.invalid/varieties/unobserved', state: 'not-retrieved' },
        { url: 'https://media.invalid/varieties/unsupported', mediaType: 'application/octet-stream', state: 'unavailable' }
      ]
    }
  });

  const text = await visibleText(page);
  for (const expected of ['Harbor Alloy', lore, 'Catalyst', 'Media not retrieved', 'Media unavailable']) {
    assert.ok(text.includes(expected), `expected ${JSON.stringify(expected)} in ${JSON.stringify(text)}`);
  }
  assert.doesNotMatch(text, /undefined|null|NaN/, 'malformed entries must not leak raw values into the card');
  assert.deepEqual(errors, []);
});

test('uses an honest unknown ingredient fallback instead of guessing from the reference URL', async (t) => {
  const { page, errors } = await openFixture(t);
  const unknownId = 'https://resources.invalid/varieties/mystery-substance';

  await render(page, {
    kind: 'one',
    component: 'variety',
    props: {
      name: 'Harbor Alloy',
      production: [
        {
          type: 'manufacture',
          duration: 1,
          ingredients: [{ variety: unknownId, count: 1, data: {} }],
          yield: [{ probability: 1, count: 1, data: {} }]
        }
      ],
      referenceNames: {}
    }
  });

  const text = await visibleText(page);
  assert.match(text, /unknown/i, 'expected an honest unknown reference fallback');
  assert.equal(text.includes('mystery-substance'), false, 'the reference URL tail must not be guessed as a name');
  assert.doesNotMatch(text, /undefined|null|NaN/);
  assert.deepEqual(errors, []);
});
