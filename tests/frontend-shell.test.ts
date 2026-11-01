import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request as PlaywrightRequest } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureOrigin = 'http://shell.invalid/';
const sessionKey = 'fctp.client-sessions';
const sessionChangeEvent = 'fctp-client-sessions-changed';
const settleTimeout = 5_000;

const topicLabels = {
  connections: 'Connections',
  explore: 'Explore',
  logistics: 'Logistics & Production',
  authoring: 'Author & Publish',
  activity: 'Activity',
  administration: 'Administration'
};

const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

const fixtureSource = String.raw`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell } from './apps/frontend/src/app-shell.tsx';
import { readActivity } from './apps/frontend/src/application-api.ts';

const { StrictMode, useEffect, useState } = React;

const TOPIC_LABELS = ${JSON.stringify(topicLabels)};

function TopicPanel({ topic, accountId }) {
  const [activity, setActivity] = useState('pending');

  useEffect(() => {
    if (!accountId) {
      setActivity('none');
      return;
    }
    readActivity(accountId).then(
      (response) => {
        const ids = (response && response.data && response.data.actions ? response.data.actions : []).map((action) => action.id);
        setActivity(ids.join(','));
      },
      (error) => {
        setActivity('error:' + (error && error.message ? error.message : String(error)));
      }
    );
  }, [accountId]);

  return React.createElement('div', { 'data-topic': topic, 'data-account-id': accountId || '' },
    React.createElement('h2', null, TOPIC_LABELS[topic]),
    accountId
      ? React.createElement('p', { 'data-account-label': 'true' }, 'Account ' + accountId)
      : React.createElement('p', null, 'No account selected'),
    accountId
      ? React.createElement('input', { 'aria-label': 'Draft ' + topic, defaultValue: '' })
      : null,
    React.createElement('p', { 'data-activity': 'true' }, 'Activity ' + activity)
  );
}

const renderTopic = (topic, context) => React.createElement(TopicPanel, { topic, accountId: context.accountId });

const shellCount = new URLSearchParams(location.search).get('shells') === '2' ? 2 : 1;

function App() {
  const shells = [];
  for (let index = 1; index <= shellCount; index += 1) {
    shells.push(React.createElement('section', { key: index, 'data-shell': String(index) },
      React.createElement(AppShell, { renderTopic })
    ));
  }
  return React.createElement(React.Fragment, null, shells);
}

window.__shellFixture = { ready: true };

createRoot(document.getElementById('root')).render(
  React.createElement(StrictMode, null, React.createElement(App))
);
`;

interface StoredSession {
  accountId: string;
  handle: string;
  clientToken: string;
}

interface MockRequest {
  method: string;
  path: string;
  search: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
  authorization: string | undefined;
}

interface MockResponse {
  status?: number;
  json?: unknown;
  text?: string;
  contentType?: string;
  abort?: boolean;
}

function accountRecord(id: string, status: 'signed-in' | 'signed-out' | 'authentication-rejected' = 'signed-in'): Record<string, unknown> {
  return {
    id,
    handle: id,
    homeServer: `home.${id.split('@').at(-1) ?? 'example'}`,
    login: status === 'signed-in' ? { status } : { status, reason: 'not signed in' }
  };
}

function activityResponse(accountId: string): Record<string, unknown> {
  return {
    context: {},
    data: { actions: [{ id: `${accountId}-action` }] },
    observations: {},
    actions: []
  };
}

function logoutPath(accountId: string): string {
  return `/api/accounts/${encodeURIComponent(accountId)}/logout`;
}

class ShellMock {
  readonly requests: MockRequest[] = [];
  private readonly accounts = new Map<string, { id: string; handle: string }>();
  private readonly tokenAccounts = new Map<string, string>();
  private readonly waiters: Array<() => void> = [];

  onLogin: (body: Record<string, unknown>) => MockResponse | Promise<MockResponse> = () => ({ status: 404, json: { error: 'unexpected-login' } });
  onLogout: (accountId: string, request: MockRequest) => MockResponse | Promise<MockResponse> = (accountId) => ({ json: { account: accountRecord(accountId) } });
  onActivity: (request: MockRequest, accountId: string | undefined) => void | Promise<void> = () => undefined;

  seed(sessions: readonly StoredSession[]): void {
    for (const session of sessions) {
      this.accounts.set(session.accountId, { id: session.accountId, handle: session.handle });
      this.tokenAccounts.set(session.clientToken, session.accountId);
    }
  }

  record(request: PlaywrightRequest, url: URL): MockRequest {
    const headers = request.headers();
    const record: MockRequest = {
      method: request.method(),
      path: url.pathname,
      search: url.search,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      body: request.postData(),
      authorization: headers.authorization
    };
    this.requests.push(record);
    for (const waiter of this.waiters.splice(0)) waiter();
    return record;
  }

  waitFor(predicate: (request: MockRequest) => boolean = () => true): Promise<MockRequest> {
    const existing = this.requests.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<MockRequest>((resolve) => {
      const check = (): void => {
        const match = this.requests.find(predicate);
        if (match) resolve(match);
        else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
  }

  async handle(request: MockRequest): Promise<MockResponse> {
    if (request.method === 'POST' && request.path === '/api/accounts/login') {
      const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
      const response = await this.onLogin(body);
      const payload = response.json as { status?: unknown; account?: { id?: unknown; handle?: unknown }; clientToken?: unknown } | undefined;
      if (payload && payload.status === 'signed-in'
        && typeof payload.account?.id === 'string'
        && typeof payload.account.handle === 'string'
        && typeof payload.clientToken === 'string') {
        this.accounts.set(payload.account.id, { id: payload.account.id, handle: payload.account.handle });
        this.tokenAccounts.set(payload.clientToken, payload.account.id);
      }
      return response;
    }

    const logoutMatch = /^\/api\/accounts\/([^/]+)\/logout$/.exec(request.path);
    if (request.method === 'POST' && logoutMatch) {
      return this.onLogout(decodeURIComponent(logoutMatch[1]!), request);
    }

    if (request.method === 'GET' && request.path === '/api/accounts') {
      const accountId = this.accountFor(request);
      const account = accountId === undefined ? undefined : this.accounts.get(accountId);
      if (!account) return { status: 401, json: { error: 'rejected-session' } };
      return { json: { accounts: [accountRecord(account.id)] } };
    }

    if (request.method === 'GET' && request.path === '/api/activity') {
      const accountId = this.accountFor(request);
      if (accountId === undefined) return { status: 401, json: { error: 'rejected-session' } };
      await this.onActivity(request, accountId);
      return { json: activityResponse(accountId) };
    }

    return { status: 404, json: { error: 'unexpected-request' } };
  }

  private accountFor(request: MockRequest): string | undefined {
    const token = request.authorization?.replace(/^Bearer /, '');
    return token === undefined ? undefined : this.tokenAccounts.get(token);
  }
}

let browser: Browser | undefined;
let bundle: string | undefined;

before(async () => {
  const result = await build({
    stdin: {
      contents: fixtureSource,
      resolveDir: projectRoot,
      sourcefile: 'frontend-shell-fixture.js',
      loader: 'js'
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    outdir: join(tmpdir(), 'fctp-frontend-shell-fixture'),
    loader: { '.css': 'local-css' },
    define: { 'process.env.NODE_ENV': '"development"' }
  });
  const output = result.outputFiles.find((file) => file.path.endsWith('.js'));
  assert(output, 'esbuild produced no shell fixture bundle');
  bundle = output.text;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

interface OpenOptions {
  sessions?: readonly StoredSession[];
  shellCount?: number;
  path?: string;
  configureMock?: (mock: ShellMock) => void;
}

async function openShellPage(t: TestContext, options: OpenOptions = {}): Promise<{ page: Page; mock: ShellMock; errors: string[]; context: BrowserContext }> {
  const activeBrowser = browser;
  const activeBundle = bundle;
  assert(activeBrowser, 'browser was not started');
  assert(activeBundle, 'shell fixture bundle was not built');
  const context = await activeBrowser.newContext();
  t.after(async () => { await context.close(); });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });
  const mock = new ShellMock();
  options.configureMock?.(mock);
  if (options.sessions) mock.seed(options.sessions);

  await page.route(`${fixtureOrigin}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/bundle.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: activeBundle });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const record = mock.record(request, url);
      const response = await mock.handle(record);
      if (response.abort) {
        await route.abort('failed');
        return;
      }
      if (response.text !== undefined) {
        await route.fulfill({ status: response.status ?? 200, contentType: response.contentType ?? 'text/plain', body: response.text });
        return;
      }
      await route.fulfill({ status: response.status ?? 200, contentType: 'application/json', body: JSON.stringify(response.json ?? {}) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });

  const shellCount = options.shellCount ?? 1;
  const target = new URL(options.path ?? '/', fixtureOrigin);
  if (shellCount === 2) target.searchParams.set('shells', '2');
  await page.goto(target.toString());
  if (options.sessions) {
    await storeSessions(page, options.sessions);
    await page.reload();
  }
  await waitForFixture(page, shellCount);
  return { page, mock, errors, context };
}

async function waitForFixture(page: Page, shellCount = 1): Promise<void> {
  await page.waitForFunction((count) => {
    const fixture = (window as unknown as { __shellFixture?: { ready?: boolean } }).__shellFixture;
    return Boolean(fixture && fixture.ready) && document.querySelectorAll('[data-shell]').length === count;
  }, shellCount, { timeout: settleTimeout });
}

function session(accountId: string, clientToken: string): StoredSession {
  return { accountId, handle: accountId, clientToken };
}

async function storeSessions(page: Page, sessions: readonly StoredSession[]): Promise<void> {
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: sessionKey, value: JSON.stringify(sessions) });
}

async function readSessions(page: Page): Promise<StoredSession[]> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), sessionKey);
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  assert.ok(Array.isArray(parsed));
  return parsed as StoredSession[];
}

function shellRoot(page: Page, index = 1): Locator {
  return page.locator(`[data-shell="${index}"]`);
}

function accountMenuButton(root: Locator): Locator {
  return root.getByRole('button', { name: 'Account menu' });
}

async function openAccountMenu(page: Page, index = 1): Promise<Locator> {
  const button = accountMenuButton(shellRoot(page, index));
  await button.waitFor({ state: 'visible', timeout: settleTimeout });
  await button.click();
  const menu = page.getByRole('menu');
  await menu.waitFor({ state: 'visible', timeout: settleTimeout });
  return menu;
}

function accountMenuItem(menu: Locator, handle: string): Locator {
  return menu.getByRole('menuitem').filter({ hasText: handle });
}

async function waitForAccount(page: Page, handle: string, index = 1): Promise<void> {
  const menu = await openAccountMenu(page, index);
  const item = accountMenuItem(menu, handle);
  await item.waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await item.count(), 1, `expected one account menu item for ${handle}`);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden', timeout: settleTimeout });
}

async function selectAccount(page: Page, handle: string, index = 1): Promise<void> {
  const menu = await openAccountMenu(page, index);
  const item = accountMenuItem(menu, handle);
  await item.waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await item.count(), 1, `expected one account menu item for ${handle}`);
  await item.click();
  await waitForVisibleAccount(page, handle, index);
}

async function waitForVisibleAccount(page: Page, accountId: string, index = 1): Promise<void> {
  try {
    await page.waitForFunction(({ selector, expected }) => {
      const root = document.querySelector(selector);
      if (!root) return false;
      const panels = Array.from(root.querySelectorAll('[role="tabpanel"]'));
      const visible = panels.find((panel) => panel.getClientRects().length > 0);
      return visible?.querySelector('[data-account-id]')?.getAttribute('data-account-id') === expected;
    }, { selector: `[data-shell="${index}"]`, expected: accountId }, { timeout: settleTimeout });
  } catch (error) {
    const actual = await currentVisibleAccount(page, index);
    throw new Error(`Expected the visible account to be ${JSON.stringify(accountId)} but saw ${JSON.stringify(actual)}`, { cause: error });
  }
}

async function currentVisibleAccount(page: Page, index = 1): Promise<string | null> {
  return shellRoot(page, index).locator('[role="tabpanel"]:visible [data-account-id]').first().getAttribute('data-account-id');
}

async function waitForVisibleTopic(page: Page, topic: string, index = 1): Promise<void> {
  try {
    await page.waitForFunction(({ selector, expected }) => {
      const root = document.querySelector(selector);
      if (!root) return false;
      const panels = Array.from(root.querySelectorAll('[role="tabpanel"]'));
      const visible = panels.find((panel) => panel.getClientRects().length > 0);
      return visible?.querySelector('[data-topic]')?.getAttribute('data-topic') === expected;
    }, { selector: `[data-shell="${index}"]`, expected: topic }, { timeout: settleTimeout });
  } catch (error) {
    const actual = await currentVisibleTopic(page, index);
    throw new Error(`Expected the visible topic to be ${JSON.stringify(topic)} but saw ${JSON.stringify(actual)}`, { cause: error });
  }
}

async function currentVisibleTopic(page: Page, index = 1): Promise<string | null> {
  return shellRoot(page, index).locator('[role="tabpanel"]:visible [data-topic]').first().getAttribute('data-topic');
}

async function waitForActivity(page: Page, accountId: string, index = 1): Promise<void> {
  const marker = `${accountId}-action`;
  await page.waitForFunction(({ selector, expected }) => {
    const root = document.querySelector(selector);
    if (!root) return false;
    const panels = Array.from(root.querySelectorAll('[role="tabpanel"]'));
    const visible = panels.find((panel) => panel.getClientRects().length > 0);
    return Boolean(visible && visible.textContent && visible.textContent.includes(expected));
  }, { selector: `[data-shell="${index}"]`, expected: marker }, { timeout: settleTimeout });
}

async function assertSingleVisiblePanel(page: Page, index = 1): Promise<void> {
  assert.equal(await shellRoot(page, index).locator('[role="tabpanel"]:visible').count(), 1, 'exactly one topic panel must be visible');
}

async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('first visit signs in with the keyboard, stores the session, and restores it on reload', async (t) => {
  const { page, mock, errors } = await openShellPage(t);
  const handle = '@alice@a.example';
  const password = 'first-visit-password';

  const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
  await signIn.waitFor({ state: 'visible', timeout: settleTimeout });
  await signIn.click();
  const dialog = page.getByRole('dialog', { name: 'Sign in' });
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await page.getByRole('listbox').count(), 0, 'sign-in must not be an inline account list');

  mock.onLogin = (body) => {
    assert.deepEqual(body, { handle, password });
    return { json: { status: 'signed-in', account: accountRecord(handle), clientToken: 'token-alice' } };
  };

  await dialog.getByLabel('Handle').focus();
  await page.keyboard.type(handle);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('input[type="password"]')), true, 'Tab must move from handle to password');
  await page.keyboard.type(password);
  await page.keyboard.press('Enter');

  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForAccount(page, handle);
  assert.equal(await shellRoot(page).getByRole('tab', { name: 'Connections', exact: true }).count(), 1);

  const logins = mock.requests.filter((request) => request.path === '/api/accounts/login');
  assert.equal(logins.length, 1);
  assert.deepEqual(JSON.parse(logins[0]!.body ?? 'null'), { handle, password });
  assert.equal(logins[0]!.authorization, undefined);
  assert.equal(logins[0]!.body?.includes('origin') ?? false, false);
  assert.equal(logins[0]!.body?.includes('home') ?? false, false);

  const stored = await readSessions(page);
  assert.deepEqual(stored.map((entry) => entry.accountId), [handle]);
  assert.equal(stored[0]!.clientToken, 'token-alice');
  assert.equal(JSON.stringify(stored).includes(password), false);
  assert.equal((await page.locator('body').innerText()).includes(password), false);

  await page.reload();
  await waitForFixture(page);
  await waitForAccount(page, handle);
  assert.equal(mock.requests.filter((request) => request.path === '/api/accounts/login').length, 1);
  assert.ok(mock.requests.some((request) => request.path === '/api/accounts' && request.authorization === 'Bearer token-alice'));
  assert.deepEqual(errors, []);
});

test('rejected and unavailable sign-in attempts clear the password and retain existing accounts', async (t) => {
  const existing = '@existing@a.example';
  const attempted = '@new@b.example';
  const password = 'rejected-password';
  const { page, mock, errors } = await openShellPage(t, { sessions: [session(existing, 'token-existing')] });

  await waitForAccount(page, existing);
  mock.onLogin = () => ({ status: 401, json: { status: 'rejected', reason: 'invalid handle or password' } });

  await page.getByRole('button', { name: 'Add account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByLabel('Handle').fill(attempted);
  await dialog.getByLabel('Password').fill(password);
  await dialog.getByRole('button', { name: /sign in/i }).click();

  const alert = page.getByRole('alert');
  await alert.waitFor({ state: 'visible', timeout: settleTimeout });
  assert.match(await alert.innerText(), /invalid handle or password/i);
  assert.equal(await dialog.getByLabel('Password').inputValue(), '');
  assert.equal((await page.locator('body').innerText()).includes(password), false);
  assert.deepEqual((await readSessions(page)).map((entry) => entry.accountId), [existing]);

  mock.onLogin = () => ({ abort: true });
  await dialog.getByLabel('Handle').fill(attempted);
  await dialog.getByLabel('Password').fill(password);
  await dialog.getByRole('button', { name: /sign in/i }).click();
  await page.waitForFunction((secret) => {
    const dialog = document.querySelector('[role="dialog"]');
    const password = dialog?.querySelector('input[type="password"]') as HTMLInputElement | null;
    const alert = (dialog?.querySelector('[role="alert"]') ?? document.querySelector('[role="alert"]')) as HTMLElement | null;
    return Boolean(alert && alert.textContent && password && password.value === '' && !alert.textContent.includes(secret));
  }, password, { timeout: settleTimeout });
  assert.equal((await page.locator('body').innerText()).includes(password), false);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await waitForAccount(page, existing);
  assert.deepEqual((await readSessions(page)).map((entry) => entry.accountId), [existing]);
  assert.deepEqual(errors, []);
});

test('adds another account without discarding the first and distinguishes full handles', async (t) => {
  const first = '@same@a.example';
  const second = '@same@b.example';
  const password = 'add-account-password';
  const { page, mock, errors } = await openShellPage(t, { sessions: [session(first, 'token-first')] });

  await waitForAccount(page, first);
  mock.onLogin = (body) => {
    assert.equal(body.handle, second);
    return { json: { status: 'signed-in', account: accountRecord(second), clientToken: 'token-second' } };
  };

  await page.getByRole('button', { name: 'Add account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByLabel('Handle').fill(second);
  await dialog.getByLabel('Password').fill(password);
  await dialog.getByRole('button', { name: /sign in/i }).click();

  await waitForAccount(page, first);
  await waitForAccount(page, second);
  assert.equal(await page.getByRole('dialog').count(), 0);

  const stored = await readSessions(page);
  assert.deepEqual(stored.map((entry) => entry.accountId).sort(), [first, second].sort());
  assert.ok(stored.some((entry) => entry.clientToken === 'token-first'));
  assert.ok(stored.some((entry) => entry.clientToken === 'token-second'));

  const login = mock.requests.find((request) => request.path === '/api/accounts/login');
  assert.ok(login);
  const body = JSON.parse(login.body ?? 'null') as Record<string, unknown>;
  assert.deepEqual(body, { handle: second, password });
  assert.equal('origin' in body, false);
  assert.equal('home' in body, false);

  await selectAccount(page, second);
  assert.equal(await currentVisibleAccount(page), second);
  assert.ok((await accountMenuButton(shellRoot(page)).innerText()).includes(second));
  await waitForAccount(page, first);
  await waitForAccount(page, second);
  assert.deepEqual(errors, []);
});

test('the account switcher exposes full handles and selects the exact account by keyboard', async (t) => {
  const first = '@same@a.example';
  const second = '@same@b.example';
  const { page, errors } = await openShellPage(t, { sessions: [session(first, 'token-a'), session(second, 'token-b')] });

  await waitForAccount(page, first);
  await waitForAccount(page, second);

  await waitForVisibleAccount(page, first);
  await selectAccount(page, second);
  assert.equal(await currentVisibleAccount(page), second);

  let menu = await openAccountMenu(page);
  assert.equal(await page.getByRole('listbox').count(), 0, 'the account switcher must be a menu, not a listbox');
  assert.equal(await menu.getByRole('menuitem').count(), 2);
  await accountMenuItem(menu, first).focus();
  await page.keyboard.press('Enter');
  await waitForVisibleAccount(page, first);
  assert.equal(await currentVisibleAccount(page), first);

  menu = await openAccountMenu(page);
  await accountMenuItem(menu, first).focus();
  await page.keyboard.press('ArrowDown');
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? '');
  assert.ok(focused.includes(second), 'ArrowDown must move focus to the next account');
  await page.keyboard.press('Enter');
  await waitForVisibleAccount(page, second);
  assert.equal(await currentVisibleAccount(page), second);
  assert.deepEqual(errors, []);
});

test('the add-account dialog traps focus and returns it to its trigger when dismissed', async (t) => {
  const existing = '@existing@a.example';
  const { page, errors } = await openShellPage(t, { sessions: [session(existing, 'token-existing')] });
  await waitForAccount(page, existing);

  const add = page.getByRole('button', { name: 'Add account' });
  await add.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByLabel('Handle').waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true, 'focus must move into the dialog');

  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.equal(await add.evaluate((element) => element === document.activeElement), true, 'focus must return to the add-account trigger');
  await waitForAccount(page, existing);
  await waitForVisibleAccount(page, existing);
  assert.deepEqual(errors, []);
});

test('topic tabs are keyboard accessible, render one panel, and preserve drafts across navigation', async (t) => {
  const account = '@tabs@a.example';
  const { page, errors } = await openShellPage(t, { sessions: [session(account, 'token-tabs')] });
  await waitForAccount(page, account);
  await waitForVisibleAccount(page, account);

  const shell = shellRoot(page);
  const tabs = shell.getByRole('tab');
  assert.deepEqual(await tabs.allInnerTexts(), [
    topicLabels.connections,
    topicLabels.explore,
    topicLabels.logistics,
    topicLabels.authoring,
    topicLabels.activity,
    topicLabels.administration
  ]);
  await assertSingleVisiblePanel(page);
  assert.equal(await currentVisibleTopic(page), 'connections');

  const connectionsTab = shell.getByRole('tab', { name: topicLabels.connections, exact: true });
  await connectionsTab.focus();
  await page.keyboard.press('ArrowRight');
  await waitForVisibleTopic(page, 'explore');
  assert.equal(await shell.getByRole('tab', { name: topicLabels.explore, exact: true }).getAttribute('aria-selected'), 'true');
  assert.ok((await page.evaluate(() => document.activeElement?.textContent ?? '')).includes(topicLabels.explore));
  await assertSingleVisiblePanel(page);

  await shell.getByRole('tab', { name: topicLabels.authoring, exact: true }).click();
  await waitForVisibleTopic(page, 'authoring');
  const draft = shell.getByLabel('Draft authoring');
  await draft.fill('preserved draft');
  await assertSingleVisiblePanel(page);

  await shell.getByRole('tab', { name: topicLabels.connections, exact: true }).click();
  await waitForVisibleTopic(page, 'connections');
  assert.equal(await draft.inputValue(), 'preserved draft');
  await assertSingleVisiblePanel(page);

  await shell.getByRole('tab', { name: topicLabels.authoring, exact: true }).click();
  await waitForVisibleTopic(page, 'authoring');
  assert.equal(await draft.inputValue(), 'preserved draft');
  await assertSingleVisiblePanel(page);
  assert.deepEqual(errors, []);
});

test('derives the visible topic from the pathname and pushes tab transitions into history', async (t) => {
  const { page, mock, errors } = await openShellPage(t);
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await page.waitForFunction(() => location.pathname === '/connections');
  assert.equal(new URL(page.url()).pathname, '/connections', 'the root must canonicalize to the Connections URI');

  await page.evaluate(() => { (window as unknown as { __routeMarker?: string }).__routeMarker = 'kept'; });
  const requestsBefore = mock.requests.length;
  const routes = [
    { topic: 'explore', label: topicLabels.explore, path: '/explore' },
    { topic: 'logistics', label: topicLabels.logistics, path: '/logistics' },
    { topic: 'authoring', label: topicLabels.authoring, path: '/authoring' },
    { topic: 'activity', label: topicLabels.activity, path: '/activity' },
    { topic: 'administration', label: topicLabels.administration, path: '/administration' }
  ] as const;

  for (const route of routes) {
    await shellRoot(page).getByRole('tab', { name: route.label, exact: true }).click();
    await waitForVisibleTopic(page, route.topic);
    assert.equal(new URL(page.url()).pathname, route.path, `${route.topic} must have its own URI`);
  }

  assert.equal(await page.evaluate(() => (window as unknown as { __routeMarker?: string }).__routeMarker), 'kept', 'topic transitions must not reload the document');
  assert.equal(mock.requests.length, requestsBefore, 'topic transitions must not load sources');

  await page.goBack();
  await waitForVisibleTopic(page, 'activity');
  assert.equal(new URL(page.url()).pathname, '/activity');
  await page.goForward();
  await waitForVisibleTopic(page, 'administration');
  assert.equal(new URL(page.url()).pathname, '/administration');
  assert.deepEqual(errors, []);
});

test('loads a topic from its URI on the first visit and after reload', async (t) => {
  const { page, errors } = await openShellPage(t, { path: '/activity' });
  await waitForVisibleTopic(page, 'activity');
  assert.equal(new URL(page.url()).pathname, '/activity');

  await page.reload();
  await waitForFixture(page);
  await waitForVisibleTopic(page, 'activity');
  assert.equal(new URL(page.url()).pathname, '/activity');
  assert.deepEqual(errors, []);
});

test('switching accounts clears private drafts and ignores delayed responses from the previous account', async (t) => {
  const first = '@delay@a.example';
  const second = '@delay@b.example';
  let releaseFirst: () => void = () => undefined;
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const { page, errors } = await openShellPage(t, {
    sessions: [session(first, 'token-delay-a'), session(second, 'token-delay-b')],
    configureMock: (mock) => {
      mock.onActivity = async (_request, accountId) => {
        if (accountId === first) await firstHeld;
      };
    }
  });

  await waitForAccount(page, first);
  await waitForVisibleAccount(page, first);
  await shellRoot(page).getByRole('tab', { name: topicLabels.authoring, exact: true }).click();
  await waitForVisibleTopic(page, 'authoring');
  const draft = shellRoot(page).getByLabel('Draft authoring');
  await draft.fill('first account private draft');

  await selectAccount(page, second);
  await waitForActivity(page, second);
  assert.equal(await draft.inputValue(), '', 'the first account draft must not remain under the second account');

  releaseFirst();
  await nextFrame(page);
  const panelText = await shellRoot(page).locator('[role="tabpanel"]:visible').innerText();
  assert.ok(panelText.includes(`${second}-action`));
  assert.equal(panelText.includes(`${first}-action`), false, 'a delayed response from the previous account must not overwrite the current account');

  await selectAccount(page, first);
  await waitForActivity(page, first);
  assert.equal(await draft.inputValue(), '', 'returning to an account must provide fresh private panel state');
  assert.deepEqual(errors, []);
});

test('an external session change clears a rejected selected account and retains other choices', async (t) => {
  const rejected = '@rejected@a.example';
  const retained = '@retained@b.example';
  const { page, errors } = await openShellPage(t, { sessions: [session(rejected, 'token-rejected'), session(retained, 'token-retained')] });

  await waitForAccount(page, rejected);
  await waitForAccount(page, retained);
  await waitForVisibleAccount(page, rejected);
  await shellRoot(page).getByRole('tab', { name: topicLabels.authoring, exact: true }).click();
  await waitForVisibleTopic(page, 'authoring');
  await shellRoot(page).getByLabel('Draft authoring').fill('rejected account private draft');

  await page.evaluate(({ key, event, accountId }) => {
    const raw = localStorage.getItem(key);
    const sessions = raw ? JSON.parse(raw) as Array<{ accountId: string }> : [];
    localStorage.setItem(key, JSON.stringify(sessions.filter((entry) => entry.accountId !== accountId)));
    window.dispatchEvent(new Event(event));
  }, { key: sessionKey, event: sessionChangeEvent, accountId: rejected });

  await waitForAccount(page, retained);
  const menu = await openAccountMenu(page);
  assert.equal(await accountMenuItem(menu, rejected).count(), 0);
  assert.equal(await accountMenuItem(menu, retained).count(), 1);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.notEqual(await currentVisibleAccount(page), rejected);
  assert.equal((await page.locator('body').innerText()).includes('rejected account private draft'), false);
  assert.deepEqual(errors, []);
});

test('selective logout removes only the selected local session even when the response still reports signed-in', async (t) => {
  const first = '@logout@a.example';
  const second = '@logout@b.example';
  const { page, mock, errors } = await openShellPage(t, { sessions: [session(first, 'token-logout-a'), session(second, 'token-logout-b')] });

  await waitForAccount(page, first);
  await waitForAccount(page, second);
  await selectAccount(page, first);

  mock.onLogout = (accountId) => {
    assert.equal(accountId, first);
    return { json: { account: accountRecord(first, 'signed-in') } };
  };

  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByRole('button', { name: 'Log out' }).waitFor({ state: 'hidden', timeout: settleTimeout });
  const menu = await openAccountMenu(page);
  assert.equal(await accountMenuItem(menu, first).count(), 0);
  assert.equal(await accountMenuItem(menu, second).count(), 1);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden', timeout: settleTimeout });
  assert.deepEqual((await readSessions(page)).map((entry) => entry.accountId), [second]);
  assert.equal(await currentVisibleAccount(page), '', 'logout must clear selection rather than switch to another account');

  const logouts = mock.requests.filter((request) => request.path === logoutPath(first));
  assert.equal(logouts.length, 1);
  assert.equal(logouts[0]!.method, 'POST');
  assert.equal(logouts[0]!.authorization, 'Bearer token-logout-a');
  assert.deepEqual(errors, []);
});

test('a failed logout keeps the selected session and reports the failure', async (t) => {
  const account = '@logout-fail@a.example';
  const { page, mock, errors } = await openShellPage(t, { sessions: [session(account, 'token-logout-fail')] });

  await waitForAccount(page, account);
  await selectAccount(page, account);

  mock.onLogout = () => ({ status: 503, json: { error: 'logout unavailable' } });
  await page.getByRole('button', { name: 'Log out' }).click();

  const alert = page.getByRole('alert');
  await alert.waitFor({ state: 'visible', timeout: settleTimeout });
  assert.match(await alert.innerText(), /logout unavailable|unavailable/i);
  await waitForAccount(page, account);
  assert.deepEqual((await readSessions(page)).map((entry) => entry.accountId), [account]);
  await waitForVisibleAccount(page, account);
  assert.deepEqual(errors, []);
});

test('mounted shells follow the browser-derived topic while keeping their own account controls', async (t) => {
  const account = '@isolated@a.example';
  const { page, errors } = await openShellPage(t, { sessions: [session(account, 'token-isolated')], shellCount: 2 });

  const firstShell = shellRoot(page, 1);
  const secondShell = shellRoot(page, 2);
  await waitForAccount(page, account, 1);
  await waitForAccount(page, account, 2);
  await waitForVisibleTopic(page, 'connections', 1);
  await waitForVisibleTopic(page, 'connections', 2);

  await firstShell.getByRole('tab', { name: topicLabels.explore, exact: true }).click();
  await waitForVisibleTopic(page, 'explore', 1);
  await waitForVisibleTopic(page, 'explore', 2);
  assert.equal(new URL(page.url()).pathname, '/explore');
  assert.equal(await firstShell.getByRole('tab', { name: topicLabels.explore, exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await secondShell.getByRole('tab', { name: topicLabels.explore, exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await firstShell.getByRole('button', { name: 'Account menu' }).count(), 1);
  assert.equal(await secondShell.getByRole('button', { name: 'Account menu' }).count(), 1);
  assert.deepEqual(errors, []);
});

test('a late logout failure cannot become an error for a different selected account', async (t) => {
  const first = '@late-logout@a.example';
  const second = '@late-logout@b.example';
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { page, mock, errors } = await openShellPage(t, { sessions: [session(first, 'late-a'), session(second, 'late-b')] });
  await waitForAccount(page, first);
  await waitForAccount(page, second);
  await waitForVisibleAccount(page, first);
  mock.onLogout = async () => {
    await held;
    return { status: 503, json: { error: 'old account logout failure' } };
  };
  await page.getByRole('button', { name: 'Log out' }).click();
  await mock.waitFor((request) => request.path === logoutPath(first));
  await selectAccount(page, second);
  const completed = page.waitForResponse((response) => new URL(response.url()).pathname === logoutPath(first));
  release();
  await (await completed).finished();
  await nextFrame(page);
  assert.equal(await page.getByRole('alert').count(), 0, 'old-account failure must not cross the selection boundary');
  assert.equal(await currentVisibleAccount(page), second);
  assert.deepEqual(errors, []);
});

for (const dismissal of ['Cancel', 'Escape'] as const) {
test(`a canceled add-account sign-in cannot change the selected account after ${dismissal} when its response arrives`, async (t) => {
  const first = '@cancel@a.example';
  const second = '@cancel@b.example';
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const { page, mock, errors } = await openShellPage(t, { sessions: [session(first, 'token-cancel-first')] });
  await waitForAccount(page, first);
  await waitForVisibleAccount(page, first);
  mock.onLogin = async () => {
    await held;
    return { json: { status: 'signed-in', account: accountRecord(second), clientToken: 'token-cancel-second' } };
  };
  await page.getByRole('button', { name: 'Add account' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Handle').fill(second);
  await dialog.getByLabel('Password').fill('cancel-password');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await mock.waitFor((request) => request.path === '/api/accounts/login');
  if (dismissal === 'Cancel') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  else await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  const completed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/accounts/login');
  release();
  await (await completed).finished();
  await waitForAccount(page, second);
  await nextFrame(page);
  assert.equal(await currentVisibleAccount(page), first, 'server session may be retained, but canceled sign-in must not select it');
  assert.deepEqual(errors, []);
});
}
