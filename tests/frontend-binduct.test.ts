import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureOrigin = 'http://fixture.invalid/';
const settleTimeout = 2_000;
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

const fixtureSource = String.raw`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { binder, treeState, update } from 'binduct';
import { useBoundState } from './apps/frontend/src/use-bound-state.ts';

const { StrictMode, useEffect, useState } = React;

function makeService(build) {
  const stats = { setups: 0, disposals: 0, deliveries: 0, active: 0 };
  const subscribe = (setValue) => {
    stats.setups += 1;
    stats.active += 1;
    let stopped = false;
    const stop = build((value) => {
      stats.deliveries += 1;
      setValue(value);
    });
    return () => {
      if (stopped) return;
      stopped = true;
      stats.disposals += 1;
      stats.active -= 1;
      stop();
    };
  };
  return { subscribe, stats };
}

const leafService = (createBinding) => makeService((set) => createBinding()(set));

const arrayService = (createBinding) => makeService((set) => {
  const stopReplacement = createBinding()((value) => set(Array.from(value)));
  const stopUpdate = createBinding()[update]((updater) => set(updater));
  return () => {
    stopReplacement();
    stopUpdate();
  };
});

const treeA = treeState({ count: 0, list: ['a', 'b'] });
const treeB = treeState({ count: 100 });
const treeEmpty = treeState({ list: [] });
const treeNested = treeState({ nested: { label: 'alpha' } });
const detachedNested = treeNested.nested;
const treeRemovable = treeState({ value: 'r0' });

const countA = leafService(() => binder(treeA).count);
const countB = leafService(() => binder(treeB).count);
const switchA = leafService(() => binder(treeA).count);
const switchB = leafService(() => binder(treeB).count);
const nestedPath = leafService(() => binder(treeNested).nested.label);
const nestedDetached = leafService(() => binder(detachedNested).label);
const listA = arrayService(() => binder(treeA).list);
const emptyList = arrayService(() => binder(treeEmpty).list);
const removable = leafService(() => binder(treeRemovable).value);

const controllerFor = (read, service) => ({ read, subscribe: service.subscribe });
const countAController = controllerFor(() => treeA.count, countA);
const countBController = controllerFor(() => treeB.count, countB);
const switchAController = controllerFor(() => treeA.count, switchA);
const switchBController = controllerFor(() => treeB.count, switchB);
const nestedPathController = controllerFor(() => treeNested.nested.label, nestedPath);
const nestedDetachedController = controllerFor(() => detachedNested.label, nestedDetached);
const listAController = controllerFor(() => treeA.list, listA);
const emptyListController = controllerFor(() => treeEmpty.list, emptyList);
const removableController = controllerFor(() => treeRemovable.value, removable);

const fixture = {
  controls: null,
  stats: {
    countA: countA.stats,
    countB: countB.stats,
    switchA: switchA.stats,
    switchB: switchB.stats,
    nestedPath: nestedPath.stats,
    nestedDetached: nestedDetached.stats,
    listA: listA.stats,
    emptyList: emptyList.stats,
    removable: removable.stats
  }
};
window.__boundFixture = fixture;

function Bound(props) {
  const value = useBoundState(props.controller.read, props.controller.subscribe);
  return React.createElement('span', { id: props.id }, props.format ? props.format(value) : String(value));
}

function App() {
  const [source, setSource] = useState('a');
  const [removableMounted, setRemovableMounted] = useState(false);
  const switchController = source === 'a' ? switchAController : switchBController;

  useEffect(() => {
    fixture.controls = {
      setCountA: (value) => { treeA.count = value; },
      setCountB: (value) => { treeB.count = value; },
      setNestedLabel: (value) => { treeNested.nested.label = value; },
      setOldNestedLabel: (value) => { detachedNested.label = value; },
      replaceNested: (value) => { treeNested.nested = treeState({ label: value }); },
      pushListItem: (value) => { treeA.list.push(value); },
      popListItem: () => { treeA.list.pop(); },
      shiftListItem: () => { treeA.list.shift(); },
      unshiftListItem: (value) => { treeA.list.unshift(value); },
      spliceList: (start, deleteCount, ...items) => { treeA.list.splice(start, deleteCount, ...items); },
      replaceList: (items) => { treeA.list = treeState(items); },
      pushEmpty: (value) => { treeEmpty.list.push(value); },
      unshiftEmpty: (value) => { treeEmpty.list.unshift(value); },
      replaceEmpty: (items) => { treeEmpty.list = treeState(items); },
      mountRemovable: () => { setRemovableMounted(true); },
      unmountRemovable: () => { setRemovableMounted(false); },
      setRemovableValue: (value) => { treeRemovable.value = value; },
      setSource: (value) => { setSource(value); }
    };
  }, []);

  return React.createElement('div', null,
    React.createElement(Bound, { id: 'count-a', controller: countAController }),
    React.createElement(Bound, { id: 'count-b', controller: countBController }),
    React.createElement(Bound, { id: 'switch', controller: switchController }),
    React.createElement(Bound, { id: 'nested-path', controller: nestedPathController }),
    React.createElement(Bound, { id: 'nested-detached', controller: nestedDetachedController }),
    React.createElement(Bound, { id: 'list', controller: listAController, format: (value) => value.join('|') }),
    React.createElement(Bound, { id: 'empty-list', controller: emptyListController, format: (value) => value.join('|') }),
    removableMounted ? React.createElement(Bound, { id: 'removable', controller: removableController }) : null
  );
}

createRoot(document.getElementById('root')).render(
  React.createElement(StrictMode, null, React.createElement(App))
);
`;

type FixtureControls = {
  setCountA(value: number): void;
  setCountB(value: number): void;
  setNestedLabel(value: string): void;
  setOldNestedLabel(value: string): void;
  replaceNested(value: string): void;
  pushListItem(value: string): void;
  popListItem(): void;
  shiftListItem(): void;
  unshiftListItem(value: string): void;
  spliceList(start: number, deleteCount: number, ...items: string[]): void;
  replaceList(items: string[]): void;
  pushEmpty(value: string): void;
  unshiftEmpty(value: string): void;
  replaceEmpty(items: string[]): void;
  mountRemovable(): void;
  unmountRemovable(): void;
  setRemovableValue(value: string): void;
  setSource(source: 'a' | 'b'): void;
};

type FixtureStats = {
  setups: number;
  disposals: number;
  deliveries: number;
  active: number;
};

let browser: Browser | undefined;
let bundle: string | undefined;

before(async () => {
  const result = await build({
    stdin: {
      contents: fixtureSource,
      resolveDir: projectRoot,
      sourcefile: 'frontend-binduct-fixture.js',
      loader: 'js'
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    define: { 'process.env.NODE_ENV': '"development"' }
  });
  const output = result.outputFiles[0];
  assert(output, 'esbuild produced no fixture bundle');
  bundle = output.text;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

async function openFixture(t: TestContext): Promise<{ page: Page; errors: string[] }> {
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
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/bundle.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: activeBundle });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await page.goto(fixtureOrigin);
  await page.waitForFunction(() => {
    const fixture = (window as unknown as { __boundFixture?: { controls?: unknown } }).__boundFixture;
    return Boolean(fixture && fixture.controls);
  });
  return { page, errors };
}

async function call(page: Page, name: keyof FixtureControls, ...args: unknown[]): Promise<void> {
  await page.evaluate(({ name, args }) => {
    const fixture = (window as unknown as { __boundFixture: { controls: Record<string, (...input: unknown[]) => void> } }).__boundFixture;
    fixture.controls[name]!(...args);
  }, { name, args });
}

async function stats(page: Page, name: string): Promise<FixtureStats> {
  return page.evaluate((name) => {
    const fixture = (window as unknown as { __boundFixture: { stats: Record<string, FixtureStats> } }).__boundFixture;
    return fixture.stats[name]!;
  }, name);
}

async function expectText(page: Page, id: string, expected: string): Promise<void> {
  try {
    await page.waitForFunction(({ id, expected }) => document.getElementById(id)?.textContent === expected, { id, expected }, { timeout: settleTimeout });
  } catch (error) {
    const actual = await page.evaluate((id) => document.getElementById(id)?.textContent ?? null, id);
    throw new Error(`Expected #${id} to be ${JSON.stringify(expected)} but saw ${JSON.stringify(actual)}`, { cause: error });
  }
  assert.equal(await page.evaluate((id) => document.getElementById(id)?.textContent ?? null, id), expected);
}

test('reads initial values, follows leaf updates, and isolates independent trees', async (t) => {
  const { page, errors } = await openFixture(t);
  await expectText(page, 'count-a', '0');
  await expectText(page, 'count-b', '100');
  await expectText(page, 'switch', '0');
  await expectText(page, 'nested-path', 'alpha');
  await expectText(page, 'nested-detached', 'alpha');
  await expectText(page, 'list', 'a|b');
  await expectText(page, 'empty-list', '');

  await call(page, 'setCountA', 3);
  await expectText(page, 'count-a', '3');
  await expectText(page, 'switch', '3');
  await expectText(page, 'count-b', '100');

  await call(page, 'setCountB', 150);
  await expectText(page, 'count-b', '150');
  await expectText(page, 'switch', '3');
  await expectText(page, 'count-a', '3');

  assert.deepEqual(errors, []);
});

test('follows nested path replacement while detaching the old branch', async (t) => {
  const { page, errors } = await openFixture(t);
  await call(page, 'setOldNestedLabel', 'alpha-2');
  await expectText(page, 'nested-path', 'alpha-2');
  await expectText(page, 'nested-detached', 'alpha-2');

  await call(page, 'replaceNested', 'beta');
  await expectText(page, 'nested-path', 'beta');
  await expectText(page, 'nested-detached', 'alpha-2');

  await call(page, 'setOldNestedLabel', 'alpha-3');
  await expectText(page, 'nested-path', 'beta');
  await expectText(page, 'nested-detached', 'alpha-3');

  await call(page, 'setNestedLabel', 'beta-2');
  await expectText(page, 'nested-path', 'beta-2');
  await expectText(page, 'nested-detached', 'alpha-3');

  assert.deepEqual(errors, []);
});

test('renders whole-array replacement and ordinary array mutations as snapshots', async (t) => {
  const { page, errors } = await openFixture(t);
  await expectText(page, 'list', 'a|b');
  await expectText(page, 'empty-list', '');

  await call(page, 'pushListItem', 'c');
  await expectText(page, 'list', 'a|b|c');

  await call(page, 'popListItem');
  await expectText(page, 'list', 'a|b');

  await call(page, 'unshiftListItem', 'z');
  await expectText(page, 'list', 'z|a|b');

  await call(page, 'shiftListItem');
  await expectText(page, 'list', 'a|b');

  await call(page, 'spliceList', 1, 1, 'm', 'n');
  await expectText(page, 'list', 'a|m|n');

  await call(page, 'replaceList', ['x', 'y']);
  await expectText(page, 'list', 'x|y');

  await call(page, 'pushListItem', 'z');
  await expectText(page, 'list', 'x|y|z');

  await call(page, 'pushEmpty', 'e');
  await expectText(page, 'empty-list', 'e');

  await call(page, 'unshiftEmpty', 'd');
  await expectText(page, 'empty-list', 'd|e');

  await call(page, 'replaceEmpty', []);
  await expectText(page, 'empty-list', '');

  await call(page, 'replaceEmpty', ['q']);
  await expectText(page, 'empty-list', 'q');

  assert.deepEqual(errors, []);
});

test('keeps one active subscription per mounted binding under StrictMode replay', async (t) => {
  const { page, errors } = await openFixture(t);
  for (const name of ['countA', 'countB', 'switchA', 'nestedPath', 'nestedDetached', 'listA', 'emptyList']) {
    const current = await stats(page, name);
    assert.equal(current.active, 1, `${name} should have one active subscription`);
    assert.ok(current.setups >= 2, `${name} should have been replayed by StrictMode`);
  }
  const idleSwitchB = await stats(page, 'switchB');
  assert.equal(idleSwitchB.setups, 0);
  assert.equal(idleSwitchB.active, 0);
  assert.deepEqual(errors, []);
});

test('stops callbacks after unmount and remounts with current state', async (t) => {
  const { page, errors } = await openFixture(t);
  assert.equal(await page.locator('#removable').count(), 0);
  await call(page, 'mountRemovable');
  await expectText(page, 'removable', 'r0');
  assert.equal((await stats(page, 'removable')).active, 1);

  await call(page, 'unmountRemovable');
  await page.waitForFunction(() => {
    const fixture = (window as unknown as { __boundFixture: { stats: Record<string, { active: number }> } }).__boundFixture;
    return fixture.stats.removable?.active === 0 && document.getElementById('removable') === null;
  }, undefined, { timeout: settleTimeout });

  const deliveriesBefore = (await stats(page, 'removable')).deliveries;
  await call(page, 'setRemovableValue', 'r1');
  const afterUnmount = await stats(page, 'removable');
  assert.equal(afterUnmount.deliveries, deliveriesBefore, 'mutation after unmount must not reach a subscriber');
  assert.equal(afterUnmount.active, 0);

  await call(page, 'mountRemovable');
  await expectText(page, 'removable', 'r1');

  assert.deepEqual(errors, []);
});

test('switches subscription source and detaches the previous source', async (t) => {
  const { page, errors } = await openFixture(t);
  await expectText(page, 'switch', '0');
  assert.equal((await stats(page, 'switchA')).active, 1);
  assert.equal((await stats(page, 'switchB')).active, 0);

  await call(page, 'setCountB', 200);
  await expectText(page, 'switch', '0');
  await expectText(page, 'count-b', '200');

  await call(page, 'setSource', 'b');
  await expectText(page, 'switch', '200');
  assert.equal((await stats(page, 'switchA')).active, 0);
  assert.equal((await stats(page, 'switchB')).active, 1);

  await call(page, 'setCountA', 999);
  await expectText(page, 'switch', '200');
  await expectText(page, 'count-a', '999');

  await call(page, 'setSource', 'a');
  await expectText(page, 'switch', '999');
  assert.equal((await stats(page, 'switchA')).active, 1);
  assert.equal((await stats(page, 'switchB')).active, 0);

  await call(page, 'setCountB', 300);
  await expectText(page, 'switch', '999');
  await expectText(page, 'count-b', '300');

  assert.deepEqual(errors, []);
});
