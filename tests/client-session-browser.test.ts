import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page, type Request as PlaywrightRequest } from 'playwright';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
import { createClientApplication } from '../apps/client-server/src/app.js';
import { startClientServer } from '../apps/demo/src/client-server.js';

const adminSecret = 'client-session-browser-admin';
const sessionKey = 'fctp.client-sessions';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => document.documentElement?.getAttribute('data-client-busy') !== 'true');
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
  await page.waitForFunction(() => document.documentElement?.getAttribute('data-client-busy') !== 'true');
}

function captureResponses(page: Page, origin: string): { texts: string[]; flush: () => Promise<void> } {
  const texts: string[] = [];
  const reads: Promise<void>[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).origin !== origin) return;
    reads.push(response.text().then((text) => { texts.push(text); }, () => undefined));
  });
  return { texts, flush: async () => { await Promise.all(reads); } };
}

async function storedSessions(page: Page): Promise<{ raw: string | null; sessions: Array<Record<string, unknown>> }> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), sessionKey);
  if (raw === null) return { raw, sessions: [] };
  const parsed: unknown = JSON.parse(raw);
  assert.ok(Array.isArray(parsed));
  return { raw, sessions: parsed as Array<Record<string, unknown>> };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('browser client retains a client session across profile restart and logs out only the current session', { timeout: 300_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-session-browser-'));
  const originalProfile = join(directory, 'original-profile');
  const freshProfile = join(directory, 'fresh-profile');
  const [authorityPort, clientPort] = await Promise.all([freePort(), freePort()]);
  const authorityOrigin = `http://127.0.0.1:${authorityPort}`;
  const password = 'client-session-browser-password';
  const authority = await createAuthorityApp({
    origin: authorityOrigin,
    storeFile: join(directory, 'authority.json'),
    adminSecret,
    playerNames: ['player'],
    accountPasswords: { player: password }
  });
  await authority.authority.listen(authorityPort, '127.0.0.1');
  const application = await createClientApplication({ storeFile: join(directory, 'client.store.json') });
  const clientServer = await startClientServer({ port: clientPort, application });
  const handle = `@player@${new URL(authorityOrigin).host}`;
  const contexts: BrowserContext[] = [];
  t.after(async () => {
    await Promise.allSettled(contexts.map((context) => context.close()));
    await Promise.allSettled([clientServer.close(), application.close(), authority.authority.close()]);
    await rm(directory, { recursive: true, force: true });
  });

  let context = await chromium.launchPersistentContext(originalProfile, { headless: true });
  contexts.push(context);
  let page = context.pages()[0] ?? await context.newPage();
  const responses = captureResponses(page, clientServer.origin);
  await page.goto(clientServer.origin, { waitUntil: 'domcontentloaded' });
  await settle(page);
  assert.match(await page.locator('#accounts-list').innerText(), /No known accounts/i);

  await page.locator('#account-login-form input[name="handle"]').fill(handle);
  await page.locator('#account-login-form input[name="password"]').fill(password);
  await page.locator('#account-login-form button[type="submit"]').click();
  await page.waitForFunction((expected) => (document.getElementById('application-account-status')?.textContent ?? '').includes(`Signed in · ${expected}`), handle);
  await settle(page);
  assert.match(await page.locator('#accounts-list').innerText(), /Signed in/i);

  const account = await application.state.read((state) => Object.values(state.accounts).find((candidate) => candidate.handle === handle));
  assert.ok(account);
  assert.equal(account.login.status, 'signed-in');
  const nativeToken = account.login.status === 'signed-in' ? account.login.nativeToken : '';
  assert.ok(nativeToken);

  const stored = await storedSessions(page);
  assert.ok(stored.raw);
  assert.equal(stored.sessions.length, 1);
  const browserSession = stored.sessions[0]!;
  assert.equal(browserSession.accountId, account.id);
  assert.equal(browserSession.handle, handle);
  assert.equal(typeof browserSession.clientToken, 'string');
  const browserToken = browserSession.clientToken as string;
  assert.ok(browserToken);
  assert.equal(stored.raw.includes(nativeToken), false);
  assert.equal(JSON.stringify(stored.sessions).includes(nativeToken), false);

  await responses.flush();
  const loginHtml = await page.content();
  const loginText = await page.locator('body').innerText();
  assert.equal(loginHtml.includes(nativeToken), false);
  assert.equal(loginText.includes(nativeToken), false);
  assert.equal(loginText.includes(browserToken), false);
  assert.equal(responses.texts.some((text) => text.includes(nativeToken)), false);
  assert.equal(loginText.includes(password), false);

  await context.close();
  context = await chromium.launchPersistentContext(originalProfile, { headless: true });
  contexts.push(context);
  page = context.pages()[0] ?? await context.newPage();
  const reopenedResponses = captureResponses(page, clientServer.origin);
  await page.goto(clientServer.origin, { waitUntil: 'domcontentloaded' });
  await settle(page);
  await page.waitForFunction((expected) => {
    const list = document.getElementById('accounts-list')?.textContent ?? '';
    return list.includes(expected) && /Signed in/i.test(list);
  }, handle);
  assert.match(await page.locator('#accounts-list').innerText(), new RegExp(escapeRegExp(handle)));
  assert.match(await page.locator('#accounts-list').innerText(), /Signed in/i);
  assert.equal(await page.locator('#account-login-form input[name="password"]').inputValue(), '');
  const reopenedStored = await storedSessions(page);
  assert.equal(reopenedStored.raw, stored.raw);
  assert.equal(reopenedStored.raw?.includes(nativeToken) ?? false, false);

  await page.locator('#accounts-list article').filter({ hasText: handle }).getByRole('button', { name: 'Select account' }).click();
  await settle(page);
  assert.match(await page.locator('#application-account-status').innerText(), new RegExp(`Selected ${escapeRegExp(handle)}`));
  await page.locator('#activity-refresh').click();
  await page.waitForFunction(() => (document.getElementById('activity-status')?.textContent ?? '').includes('No retained actions for the selected account'));
  await settle(page);
  assert.equal((await page.locator('body').innerText()).includes(nativeToken), false);
  assert.equal((await page.locator('body').innerText()).includes(browserToken), false);

  const freshContext = await chromium.launchPersistentContext(freshProfile, { headless: true });
  contexts.push(freshContext);
  const freshPage = freshContext.pages()[0] ?? await freshContext.newPage();
  await freshPage.goto(clientServer.origin, { waitUntil: 'domcontentloaded' });
  await settle(freshPage);
  const freshList = await freshPage.locator('#accounts-list').innerText();
  assert.match(freshList, /No known accounts/i);
  assert.equal(freshList.includes(handle), false);
  assert.equal(await freshPage.evaluate(async () => { const response = await fetch('/api/accounts'); await response.text(); return response.status; }), 401);
  assert.equal(await freshPage.evaluate(async (accountId) => { const response = await fetch(`/api/activity?accountId=${encodeURIComponent(accountId)}`); await response.text(); return response.status; }, account.id), 401);

  const secondLogin = await fetch(new URL('/api/accounts/login', clientServer.origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle, password })
  });
  assert.equal(secondLogin.status, 200);
  const secondBody = await secondLogin.json() as { account: { id: string; handle: string }; clientToken: string; status: string };
  assert.equal(secondBody.status, 'signed-in');
  assert.equal(secondBody.account.id, account.id);
  assert.equal(secondBody.account.handle, handle);
  assert.ok(secondBody.clientToken);
  assert.notEqual(secondBody.clientToken, browserToken);
  assert.equal(JSON.stringify(secondBody).includes(nativeToken), false);
  assert.equal((await fetch(new URL('/api/accounts', clientServer.origin), { headers: { Authorization: `Bearer ${secondBody.clientToken}` } })).status, 200);

  await page.locator('#accounts-list article').filter({ hasText: handle }).getByRole('button', { name: 'Log out' }).click();
  await page.waitForFunction((expected) => (document.getElementById('application-account-status')?.textContent ?? '').includes(`Signed out · ${expected}`), handle);
  await settle(page);
  const afterLogout = await storedSessions(page);
  assert.equal(afterLogout.raw?.includes(browserToken) ?? false, false);
  assert.deepEqual(afterLogout.sessions, []);
  assert.doesNotMatch(await page.locator('#application-account-status').innerText(), /Selected/);
  const afterLogoutList = await page.locator('#accounts-list').innerText();
  assert.match(afterLogoutList, /No known accounts/i);
  assert.equal(afterLogoutList.includes(handle), false);

  const retained = await application.state.read((state) => Object.values(state.accounts).find((candidate) => candidate.handle === handle));
  assert.ok(retained);
  assert.equal(retained.login.status, 'signed-in');
  assert.equal((await fetch(new URL('/api/accounts', clientServer.origin))).status, 401);
  assert.equal(await page.evaluate(async () => { const response = await fetch('/api/accounts'); await response.text(); return response.status; }), 401);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await settle(page);
  assert.doesNotMatch(await page.locator('#application-account-status').innerText(), /Signed in|Selected/);
  const reloadedList = await page.locator('#accounts-list').innerText();
  assert.match(reloadedList, /No known accounts/i);
  assert.equal(reloadedList.includes(handle), false);
  const reloadedStored = await storedSessions(page);
  assert.deepEqual(reloadedStored.sessions, []);
  assert.equal(reloadedStored.raw?.includes(browserToken) ?? false, false);

  assert.equal((await fetch(new URL('/api/accounts', clientServer.origin), { headers: { Authorization: `Bearer ${secondBody.clientToken}` } })).status, 200);
  const cleanup = await fetch(new URL(`/api/accounts/${encodeURIComponent(account.id)}/logout`, clientServer.origin), {
    method: 'POST',
    headers: { Authorization: `Bearer ${secondBody.clientToken}` }
  });
  assert.equal(cleanup.status, 200);
  assert.equal((await fetch(new URL('/api/accounts', clientServer.origin), { headers: { Authorization: `Bearer ${secondBody.clientToken}` } })).status, 401);
  const signedOut = await application.state.read((state) => Object.values(state.accounts).find((candidate) => candidate.handle === handle));
  assert.ok(signedOut);
  assert.equal(signedOut.login.status, 'signed-out');

  await reopenedResponses.flush();
  const finalHtml = await page.content();
  const finalText = await page.locator('body').innerText();
  assert.equal(finalHtml.includes(nativeToken), false);
  assert.equal(finalText.includes(nativeToken), false);
  assert.equal(finalText.includes(browserToken), false);
  assert.equal(reopenedResponses.texts.some((text) => text.includes(nativeToken)), false);
  assert.equal(responses.texts.some((text) => text.includes(nativeToken)), false);
});

const sessionApiOrigin = 'http://session-api.invalid/';
const sessionApiHtml = '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="/bundle.js"></script></body></html>';

const sessionApiFixtureSource = String.raw`
import {
  loginAccount,
  logoutAccount,
  readAccounts,
  readActivity,
  readExplorePlaces,
  refreshAction,
  refreshExplorePlaces,
  subscribeSessionChanges
} from './apps/frontend/src/application-api.ts';

const operations = {
  readAccounts: () => readAccounts(),
  loginAccount: (input) => loginAccount(input),
  logoutAccount: (accountId) => logoutAccount(accountId),
  readActivity: (accountId) => readActivity(accountId),
  refreshAction: (accountId, actionId) => refreshAction(accountId, actionId),
  readExplorePlaces: (accountId) => readExplorePlaces(accountId),
  refreshExplorePlaces: (input) => refreshExplorePlaces(input)
};

const listeners = {};
const counts = {};
const payloads = {};
const disposers = {};

function credentialPayload(args) {
  const texts = [];
  for (const value of args) {
    if (value instanceof StorageEvent && value.newValue) texts.push(value.newValue);
    else if (typeof CustomEvent !== 'undefined' && value instanceof CustomEvent) {
      try { texts.push(JSON.stringify(value.detail ?? null)); } catch (error) { texts.push(String(value.detail)); }
    } else if (value && typeof value === 'object') {
      try { texts.push(JSON.stringify(value)); } catch (error) { texts.push(String(value)); }
    }
  }
  return texts.filter((text) => /clientToken|password/i.test(text)).join('\n');
}

function listenerFor(token) {
  if (!listeners[token]) {
    listeners[token] = (...args) => {
      counts[token] = (counts[token] ?? 0) + 1;
      const leaked = credentialPayload(args);
      if (leaked) (payloads[token] ??= []).push(leaked);
    };
  }
  return listeners[token];
}

window.__sessionFixture = {
  async call(name, args) {
    try {
      return { ok: true, value: await operations[name](...args) };
    } catch (error) {
      return {
        ok: false,
        error: {
          name: error && error.name ? String(error.name) : '',
          message: error && error.message ? String(error.message) : String(error),
          status: error && typeof error.status === 'number' ? error.status : null
        }
      };
    }
  },
  subscribe(token) {
    counts[token] ??= 0;
    payloads[token] ??= [];
    const dispose = subscribeSessionChanges(listenerFor(token));
    (disposers[token] ??= []).push(dispose);
    return disposers[token].length;
  },
  dispose(token, index, times = 1) {
    const dispose = disposers[token] && disposers[token][index];
    if (!dispose) return false;
    for (let attempt = 0; attempt < times; attempt += 1) dispose();
    return true;
  },
  snapshot(token) {
    return { count: counts[token] ?? 0, payloads: payloads[token] ?? [] };
  }
};
`;

interface SessionCallSuccess {
  ok: true;
  value: unknown;
}

interface SessionCallFailure {
  ok: false;
  error: { name: string; message: string; status: number | null };
}

type SessionCallResult = SessionCallSuccess | SessionCallFailure;

interface SessionFixtureWindow {
  call(name: string, args: unknown[]): Promise<SessionCallResult>;
  subscribe(token: string): number;
  dispose(token: string, index: number, times?: number): boolean;
  snapshot(token: string): { count: number; payloads: string[] };
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

type MockHandler = (request: MockRequest) => MockResponse | Promise<MockResponse>;

class MockApplication {
  requests: MockRequest[] = [];
  handler: MockHandler = () => ({ status: 200, json: {} });
  private waiters: Array<() => void> = [];

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
}

let sessionBrowser: Browser | undefined;
let sessionBundle: string | undefined;

before(async () => {
  const result = await build({
    stdin: {
      contents: sessionApiFixtureSource,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      sourcefile: 'frontend-session-api-fixture.js',
      loader: 'js'
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022'
  });
  const output = result.outputFiles[0];
  assert(output, 'esbuild produced no session-api fixture bundle');
  sessionBundle = output.text;
  sessionBrowser = await chromium.launch({ headless: true });
});

after(async () => {
  await sessionBrowser?.close();
});

function sessionValue<T>(result: SessionCallResult): T {
  if (!result.ok) throw new Error(`Expected the session API call to succeed but it failed: ${result.error.message}`);
  return result.value as T;
}

function sessionFailure(result: SessionCallResult): { name: string; message: string; status: number | null } {
  if (result.ok) throw new Error('Expected the session API call to fail but it succeeded');
  return result.error;
}

function accountRecord(id: string): Record<string, unknown> {
  return { id, handle: id, login: { status: 'signed-in' } };
}

function logoutPath(accountId: string): string {
  return `/api/accounts/${encodeURIComponent(accountId)}/logout`;
}

async function newSessionContext(t: TestContext): Promise<BrowserContext> {
  assert(sessionBrowser, 'session-api browser was not started');
  const context = await sessionBrowser.newContext();
  t.after(async () => { await context.close(); });
  return context;
}

async function openSessionPage(context: BrowserContext): Promise<{ page: Page; errors: string[]; mock: MockApplication }> {
  const bundle = sessionBundle;
  assert(bundle, 'session-api fixture bundle was not built');
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });
  const mock = new MockApplication();
  await page.route(`${sessionApiOrigin}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/bundle.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: bundle });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const record = mock.record(request, url);
      const response = await mock.handler(record);
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
    await route.fulfill({ status: 200, contentType: 'text/html', body: sessionApiHtml });
  });
  await page.goto(sessionApiOrigin);
  await page.waitForFunction(() => Boolean((window as unknown as { __sessionFixture?: unknown }).__sessionFixture));
  return { page, errors, mock };
}

async function callSession(page: Page, name: string, ...args: unknown[]): Promise<SessionCallResult> {
  return page.evaluate(
    ({ name, args }) => (window as unknown as { __sessionFixture: SessionFixtureWindow }).__sessionFixture.call(name, args),
    { name, args }
  );
}

async function subscribeSession(page: Page, token: string): Promise<number> {
  return page.evaluate((token) => (window as unknown as { __sessionFixture: SessionFixtureWindow }).__sessionFixture.subscribe(token), token);
}

async function disposeSession(page: Page, token: string, index: number, times = 1): Promise<boolean> {
  return page.evaluate(
    ({ token, index, times }) => (window as unknown as { __sessionFixture: SessionFixtureWindow }).__sessionFixture.dispose(token, index, times),
    { token, index, times }
  );
}

async function sessionSnapshot(page: Page, token: string): Promise<{ count: number; payloads: string[] }> {
  return page.evaluate((token) => (window as unknown as { __sessionFixture: SessionFixtureWindow }).__sessionFixture.snapshot(token), token);
}

async function waitForSessionCount(page: Page, token: string, count: number): Promise<void> {
  try {
    await page.waitForFunction(
      ({ token, count }) => (window as unknown as { __sessionFixture: SessionFixtureWindow }).__sessionFixture.snapshot(token).count >= count,
      { token, count },
      { timeout: 2_000 }
    );
  } catch (error) {
    const actual = await sessionSnapshot(page, token);
    throw new Error(`Expected ${count} session change notification(s) for ${token} but saw ${actual.count}`, { cause: error });
  }
  assert.equal((await sessionSnapshot(page, token)).count, count);
}

async function drainTasks(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => { setTimeout(resolve, 0); }));
}

async function storeSessionEntries(page: Page, sessions: Array<{ accountId: string; handle: string; clientToken: string }>): Promise<void> {
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: sessionKey, value: JSON.stringify(sessions) });
}

async function sessionEntries(page: Page): Promise<Array<Record<string, unknown>>> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), sessionKey);
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  assert.ok(Array.isArray(parsed));
  return parsed as Array<Record<string, unknown>>;
}

test('frontend session API notifies local login and logout without initial or credential payloads', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  const accountId = '@alice@a.example';
  const account = accountRecord(accountId);
  mock.handler = (request) => {
    if (request.method === 'POST' && request.path === '/api/accounts/login') {
      return { json: { status: 'signed-in', account, clientToken: 'token-local' } };
    }
    if (request.method === 'POST' && request.path === logoutPath(accountId)) {
      return { json: { account } };
    }
    return { status: 404, json: { error: 'unexpected' } };
  };

  await subscribeSession(page, 'watch');
  assert.deepEqual(await sessionSnapshot(page, 'watch'), { count: 0, payloads: [] });

  sessionValue(await callSession(page, 'loginAccount', { handle: accountId, password: 'local-password' }));
  assert.deepEqual(await sessionSnapshot(page, 'watch'), { count: 1, payloads: [] });

  sessionValue(await callSession(page, 'logoutAccount', accountId));
  assert.deepEqual(await sessionSnapshot(page, 'watch'), { count: 2, payloads: [] });
  assert.deepEqual(await sessionEntries(page), []);
  assert.deepEqual(errors, []);
});

test('frontend session API registers the same callback twice and disposes only that subscription', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  const first = '@pair@one.example';
  const second = '@pair@two.example';
  const tokens: Record<string, string> = { [first]: 'token-pair-1', [second]: 'token-pair-2' };
  mock.handler = (request) => {
    if (request.method === 'POST' && request.path === '/api/accounts/login') {
      const body = JSON.parse(request.body ?? '{}') as { handle: string };
      return { json: { status: 'signed-in', account: accountRecord(body.handle), clientToken: tokens[body.handle] ?? '' } };
    }
    return { status: 404, json: { error: 'unexpected' } };
  };

  assert.equal(await subscribeSession(page, 'pair'), 1);
  assert.equal(await subscribeSession(page, 'pair'), 2);
  assert.deepEqual(await sessionSnapshot(page, 'pair'), { count: 0, payloads: [] });

  sessionValue(await callSession(page, 'loginAccount', { handle: first, password: 'pair-password' }));
  assert.deepEqual(await sessionSnapshot(page, 'pair'), { count: 2, payloads: [] });

  assert.equal(await disposeSession(page, 'pair', 0, 2), true);
  sessionValue(await callSession(page, 'loginAccount', { handle: second, password: 'pair-password' }));
  assert.deepEqual(await sessionSnapshot(page, 'pair'), { count: 3, payloads: [] });

  assert.equal(await disposeSession(page, 'pair', 1, 2), true);
  assert.equal(await disposeSession(page, 'pair', 1, 1), true);
  sessionValue(await callSession(page, 'loginAccount', { handle: first, password: 'pair-password' }));
  assert.deepEqual(await sessionSnapshot(page, 'pair'), { count: 3, payloads: [] });
  assert.deepEqual(errors, []);
});

test('frontend session API follows cross-tab session storage changes and ignores unrelated storage', async (t) => {
  const context = await newSessionContext(t);
  const first = await openSessionPage(context);
  const second = await openSessionPage(context);
  await subscribeSession(first.page, 'cross');
  assert.deepEqual(await sessionSnapshot(first.page, 'cross'), { count: 0, payloads: [] });

  const stored = JSON.stringify([{ accountId: '@cross@a.example', handle: '@cross@a.example', clientToken: 'token-cross' }]);
  await second.page.evaluate(() => localStorage.setItem('unrelated-key', 'ignored'));
  await drainTasks(first.page);
  assert.equal((await sessionSnapshot(first.page, 'cross')).count, 0);

  await second.page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: sessionKey, value: stored });
  await waitForSessionCount(first.page, 'cross', 1);

  await second.page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: sessionKey, value: '[]' });
  await waitForSessionCount(first.page, 'cross', 2);

  await second.page.evaluate(() => localStorage.clear());
  await waitForSessionCount(first.page, 'cross', 3);

  await first.page.evaluate(({ key }) => {
    window.dispatchEvent(new StorageEvent('storage', { key, storageArea: sessionStorage }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated-key', storageArea: localStorage }));
  }, { key: sessionKey });
  await drainTasks(first.page);
  assert.equal((await sessionSnapshot(first.page, 'cross')).count, 3);

  assert.deepEqual(first.errors, []);
  assert.deepEqual(second.errors, []);
});

test('frontend session API sends only handle and password, persists sessions, and keeps them on login failure', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  const existingId = '@existing@a.example';
  const existing = { accountId: existingId, handle: existingId, clientToken: 'token-existing' };
  await storeSessionEntries(page, [existing]);

  const password = 'login-secret-value';
  const newId = '@new@b.example';
  mock.handler = (request) => {
    if (request.method === 'POST' && request.path === '/api/accounts/login') {
      return { json: { status: 'signed-in', account: accountRecord(newId), clientToken: 'token-new' } };
    }
    return { status: 404, json: { error: 'unexpected' } };
  };

  sessionValue(await callSession(page, 'loginAccount', { handle: newId, password }));
  const loginRequest = mock.requests[0]!;
  assert.equal(loginRequest.method, 'POST');
  assert.equal(loginRequest.path, '/api/accounts/login');
  assert.deepEqual(JSON.parse(loginRequest.body ?? 'null'), { handle: newId, password });
  assert.equal(loginRequest.authorization, undefined);
  assert.equal(loginRequest.body?.includes('home') ?? false, false);

  let stored = await sessionEntries(page);
  assert.equal(stored.length, 2);
  assert.ok(stored.some((entry) => entry.accountId === newId && entry.clientToken === 'token-new'));
  assert.ok(stored.some((entry) => entry.accountId === existingId && entry.clientToken === 'token-existing'));

  mock.handler = (request) => {
    if (request.method === 'POST' && request.path === '/api/accounts/login') {
      return { status: 401, json: { status: 'rejected', reason: `invalid ${password}` } };
    }
    return { status: 404, json: { error: 'unexpected' } };
  };
  const rejected = sessionFailure(await callSession(page, 'loginAccount', { handle: '@wrong@a.example', password }));
  assert.match(rejected.message, /invalid/i);
  assert.equal(rejected.message.includes(password), false);
  stored = await sessionEntries(page);
  assert.equal(stored.length, 2);

  mock.handler = () => ({ abort: true });
  const unavailable = sessionFailure(await callSession(page, 'loginAccount', { handle: newId, password }));
  assert.equal(unavailable.message.includes(password), false);
  assert.equal(unavailable.message.includes('token-new'), false);
  assert.equal((await sessionEntries(page)).length, 2);

  assert.equal((await page.evaluate((key) => localStorage.getItem(key), sessionKey))?.includes(password) ?? false, false);
  assert.deepEqual(errors, []);
});

test('frontend session API scopes account requests and omits authorization from public requests', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  const accountA = '@scope@a.example';
  const accountB = '@scope@b.example';
  await storeSessionEntries(page, [
    { accountId: accountA, handle: accountA, clientToken: 'token-a' },
    { accountId: accountB, handle: accountB, clientToken: 'token-b' }
  ]);
  mock.handler = (request) => {
    if (request.path === '/api/activity') return { json: { actions: [] } };
    if (request.path === '/api/activity/action-1/refresh') return { json: { action: { id: 'action-1' } } };
    if (request.path === '/api/explore/places') return { json: { places: [] } };
    if (request.path === '/api/explore/refresh') return { json: { places: [] } };
    return { status: 404, json: { error: 'unexpected' } };
  };

  sessionValue(await callSession(page, 'readActivity', accountA));
  sessionValue(await callSession(page, 'readActivity', accountB));
  sessionValue(await callSession(page, 'refreshAction', accountA, 'action-1'));
  sessionValue(await callSession(page, 'readExplorePlaces'));
  sessionValue(await callSession(page, 'readExplorePlaces', accountA));
  sessionValue(await callSession(page, 'refreshExplorePlaces', { accountId: accountA }));
  sessionValue(await callSession(page, 'refreshExplorePlaces', {}));

  const [activityA, activityB, refresh, publicPlaces, scopedPlaces, refreshScoped, refreshPublic] = mock.requests;
  assert.ok(activityA && activityB && refresh && publicPlaces && scopedPlaces && refreshScoped && refreshPublic);
  assert.equal(activityA.method, 'GET');
  assert.equal(activityA.path, '/api/activity');
  assert.equal(activityA.query.accountId, accountA);
  assert.equal(activityA.authorization, 'Bearer token-a');
  assert.equal(activityB.query.accountId, accountB);
  assert.equal(activityB.authorization, 'Bearer token-b');
  assert.equal(refresh.method, 'POST');
  assert.equal(refresh.path, '/api/activity/action-1/refresh');
  assert.equal(refresh.authorization, 'Bearer token-a');
  assert.deepEqual(JSON.parse(refresh.body ?? 'null'), { accountId: accountA });
  assert.equal(publicPlaces.path, '/api/explore/places');
  assert.equal(publicPlaces.search, '');
  assert.equal(publicPlaces.authorization, undefined);
  assert.equal(scopedPlaces.query.accountId, accountA);
  assert.equal(scopedPlaces.authorization, 'Bearer token-a');
  assert.equal(refreshScoped.method, 'POST');
  assert.equal(refreshScoped.authorization, 'Bearer token-a');
  assert.deepEqual(JSON.parse(refreshScoped.body ?? 'null'), { accountId: accountA });
  assert.equal(refreshPublic.authorization, undefined);
  assert.deepEqual(JSON.parse(refreshPublic.body ?? 'null'), {});
  assert.deepEqual(errors, []);
});

test('frontend session API reads each saved session separately and keeps distinct host identities', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  const accountA = '@same@a.example';
  const accountB = '@same@b.example';
  await storeSessionEntries(page, [
    { accountId: accountA, handle: accountA, clientToken: 'token-host-a' },
    { accountId: accountB, handle: accountB, clientToken: 'token-host-b' }
  ]);
  mock.handler = (request) => {
    if (request.path !== '/api/accounts') return { status: 404, json: { error: 'unexpected' } };
    if (request.authorization === 'Bearer token-host-a') return { json: { accounts: [accountRecord(accountA)] } };
    if (request.authorization === 'Bearer token-host-b') return { json: { accounts: [accountRecord(accountB)] } };
    return { status: 401, json: { error: 'unexpected-token' } };
  };

  const result = sessionValue<{ accounts: Array<{ id: string; handle: string }> }>(await callSession(page, 'readAccounts'));
  assert.deepEqual(result.accounts.map((account) => account.id), [accountA, accountB]);
  assert.equal(mock.requests.length, 2);
  assert.equal(mock.requests[0]!.method, 'GET');
  assert.equal(mock.requests[0]!.path, '/api/accounts');
  assert.equal(mock.requests[0]!.authorization, 'Bearer token-host-a');
  assert.equal(mock.requests[1]!.authorization, 'Bearer token-host-b');
  assert.deepEqual(errors, []);
});

test('frontend session API returns no accounts without IO and does not swallow account lookup failures', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  mock.handler = () => { throw new Error('readAccounts must not contact the application without sessions'); };
  const empty = sessionValue<{ accounts: unknown[] }>(await callSession(page, 'readAccounts'));
  assert.deepEqual(empty.accounts, []);
  assert.equal(mock.requests.length, 0);

  const accountA = '@lookup@a.example';
  const accountB = '@lookup@b.example';
  await storeSessionEntries(page, [
    { accountId: accountA, handle: accountA, clientToken: 'token-lookup-a' },
    { accountId: accountB, handle: accountB, clientToken: 'token-lookup-b' }
  ]);
  mock.handler = (request) => {
    if (request.authorization === 'Bearer token-lookup-a') return { status: 401, json: { error: 'rejected-session' } };
    if (request.authorization === 'Bearer token-lookup-b') return { json: { accounts: [accountRecord(accountB)] } };
    return { status: 500, json: { error: 'unexpected-token' } };
  };
  const filtered = sessionValue<{ accounts: Array<{ id: string }> }>(await callSession(page, 'readAccounts'));
  assert.deepEqual(filtered.accounts.map((account) => account.id), [accountB]);
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.accountId), [accountB]);

  await storeSessionEntries(page, [
    { accountId: accountA, handle: accountA, clientToken: 'token-lookup-c' },
    { accountId: accountB, handle: accountB, clientToken: 'token-lookup-d' }
  ]);
  mock.handler = (request) => {
    if (request.authorization === 'Bearer token-lookup-c') return { status: 500, json: { error: 'upstream-failure' } };
    return { json: { accounts: [accountRecord(accountB)] } };
  };
  const failure = sessionFailure(await callSession(page, 'readAccounts'));
  assert.match(failure.message, /upstream-failure/);
  assert.equal(failure.status, 500);
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.accountId), [accountA, accountB]);
  assert.deepEqual(errors, []);
});

test('frontend session API suppresses account identities whose session changed while readAccounts awaited', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  const accountId = '@stale@a.example';

  await storeSessionEntries(page, [{ accountId, handle: accountId, clientToken: 'token-stale-1' }]);
  let releaseReplacement!: () => void;
  const replacementHeld = new Promise<void>((resolve) => { releaseReplacement = resolve; });
  mock.handler = async (request) => {
    if (request.path === '/api/accounts' && request.authorization === 'Bearer token-stale-1') {
      await replacementHeld;
      return { json: { accounts: [accountRecord(accountId)] } };
    }
    if (request.path === '/api/accounts/login') {
      return { json: { status: 'signed-in', account: accountRecord(accountId), clientToken: 'token-stale-2' } };
    }
    return { status: 404, json: { error: 'unexpected' } };
  };
  const replacementRead = callSession(page, 'readAccounts');
  await mock.waitFor((request) => request.path === '/api/accounts' && request.authorization === 'Bearer token-stale-1');
  sessionValue(await callSession(page, 'loginAccount', { handle: accountId, password: 'stale-password' }));
  releaseReplacement();
  const replaced = sessionValue<{ accounts: unknown[] }>(await replacementRead);
  assert.deepEqual(replaced.accounts, []);
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.clientToken), ['token-stale-2']);

  await storeSessionEntries(page, [{ accountId, handle: accountId, clientToken: 'token-stale-3' }]);
  let releaseRemoval!: () => void;
  const removalHeld = new Promise<void>((resolve) => { releaseRemoval = resolve; });
  mock.handler = async (request) => {
    if (request.path === '/api/accounts' && request.authorization === 'Bearer token-stale-3') {
      await removalHeld;
      return { json: { accounts: [accountRecord(accountId)] } };
    }
    return { status: 404, json: { error: 'unexpected' } };
  };
  const removalRead = callSession(page, 'readAccounts');
  await mock.waitFor((request) => request.path === '/api/accounts' && request.authorization === 'Bearer token-stale-3');
  await page.evaluate((key) => localStorage.removeItem(key), sessionKey);
  releaseRemoval();
  const removed = sessionValue<{ accounts: unknown[] }>(await removalRead);
  assert.deepEqual(removed.accounts, []);
  assert.deepEqual(errors, []);
});

test('frontend session API invalidates only the token used by a rejected authenticated request', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  const accountA = '@reject@a.example';
  const accountB = '@reject@b.example';
  await storeSessionEntries(page, [
    { accountId: accountA, handle: accountA, clientToken: 'token-reject-a' },
    { accountId: accountB, handle: accountB, clientToken: 'token-reject-b' }
  ]);
  mock.handler = (request) => {
    if (request.path === '/api/activity' && request.authorization === 'Bearer token-reject-a') return { status: 401, json: { error: 'expired-session' } };
    if (request.path === '/api/activity' && request.authorization === 'Bearer token-reject-b') return { json: { actions: [] } };
    return { status: 500, json: { error: 'unexpected-token' } };
  };
  await subscribeSession(page, 'reject');
  const rejected = sessionFailure(await callSession(page, 'readActivity', accountA));
  assert.equal(rejected.status, 401);
  assert.match(rejected.message, /expired-session/);
  assert.equal(rejected.message.includes('token-reject-a'), false);
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.accountId), [accountB]);
  assert.deepEqual(await sessionSnapshot(page, 'reject'), { count: 1, payloads: [] });

  sessionValue(await callSession(page, 'readActivity', accountB));
  assert.equal(mock.requests[mock.requests.length - 1]!.authorization, 'Bearer token-reject-b');
  assert.deepEqual(errors, []);
});

test('frontend session API keeps a newer login and stays quiet for a late 401', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  const accountId = '@late@a.example';
  await storeSessionEntries(page, [{ accountId, handle: accountId, clientToken: 'token-late-1' }]);
  let releaseUnauthorized!: () => void;
  const unauthorizedHeld = new Promise<void>((resolve) => { releaseUnauthorized = resolve; });
  mock.handler = async (request) => {
    if (request.path === '/api/activity' && request.authorization === 'Bearer token-late-1') {
      await unauthorizedHeld;
      return { status: 401, json: { error: 'late-expiry' } };
    }
    if (request.path === '/api/accounts/login') {
      return { json: { status: 'signed-in', account: accountRecord(accountId), clientToken: 'token-late-2' } };
    }
    return { status: 404, json: { error: 'unexpected' } };
  };
  await subscribeSession(page, 'late');
  const lateRead = callSession(page, 'readActivity', accountId);
  await mock.waitFor((request) => request.path === '/api/activity' && request.authorization === 'Bearer token-late-1');
  sessionValue(await callSession(page, 'loginAccount', { handle: accountId, password: 'late-password' }));
  assert.deepEqual(await sessionSnapshot(page, 'late'), { count: 1, payloads: [] });

  releaseUnauthorized();
  const lateFailure = sessionFailure(await lateRead);
  assert.equal(lateFailure.status, 401);
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.clientToken), ['token-late-2']);
  assert.deepEqual(await sessionSnapshot(page, 'late'), { count: 1, payloads: [] });
  assert.deepEqual(errors, []);
});

test('frontend session API does not remove a replacement token when an older logout completes late', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  const accountId = '@logout-late@a.example';
  await storeSessionEntries(page, [{ accountId, handle: accountId, clientToken: 'token-logout-1' }]);
  let releaseLogout!: () => void;
  const logoutHeld = new Promise<void>((resolve) => { releaseLogout = resolve; });
  mock.handler = async (request) => {
    if (request.path === logoutPath(accountId) && request.authorization === 'Bearer token-logout-1') {
      await logoutHeld;
      return { json: { account: accountRecord(accountId) } };
    }
    if (request.path === '/api/accounts/login') {
      return { json: { status: 'signed-in', account: accountRecord(accountId), clientToken: 'token-logout-2' } };
    }
    return { status: 404, json: { error: 'unexpected' } };
  };
  const lateLogout = callSession(page, 'logoutAccount', accountId);
  await mock.waitFor((request) => request.path === logoutPath(accountId) && request.authorization === 'Bearer token-logout-1');
  sessionValue(await callSession(page, 'loginAccount', { handle: accountId, password: 'logout-password' }));
  releaseLogout();
  sessionValue(await lateLogout);
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.clientToken), ['token-logout-2']);
  assert.deepEqual(errors, []);
});

test('frontend session API removes only the logged-out session and retains it on failed logout', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  const accountA = '@logout@a.example';
  const accountB = '@logout@b.example';
  await storeSessionEntries(page, [
    { accountId: accountA, handle: accountA, clientToken: 'token-logout-a' },
    { accountId: accountB, handle: accountB, clientToken: 'token-logout-b' }
  ]);

  mock.handler = () => ({ abort: true });
  sessionFailure(await callSession(page, 'logoutAccount', accountA));
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.accountId), [accountA, accountB]);

  mock.handler = (request) => {
    if (request.path === logoutPath(accountA)) return { status: 503, json: { error: 'logout-unavailable' } };
    return { status: 404, json: { error: 'unexpected' } };
  };
  const unavailable = sessionFailure(await callSession(page, 'logoutAccount', accountA));
  assert.equal(unavailable.status, 503);
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.accountId), [accountA, accountB]);

  mock.handler = (request) => {
    if (request.path === logoutPath(accountA)) return { json: { account: accountRecord(accountA) } };
    return { status: 404, json: { error: 'unexpected' } };
  };
  sessionValue(await callSession(page, 'logoutAccount', accountA));
  const logoutRequest = mock.requests[mock.requests.length - 1]!;
  assert.equal(logoutRequest.method, 'POST');
  assert.equal(logoutRequest.path, logoutPath(accountA));
  assert.equal(logoutRequest.authorization, 'Bearer token-logout-a');
  assert.equal(logoutRequest.body, null);
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.accountId), [accountB]);
  assert.deepEqual(errors, []);
});

test('frontend session API keeps credentials on forbidden, server, and transport failures', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  const accountId = '@status@a.example';
  await storeSessionEntries(page, [{ accountId, handle: accountId, clientToken: 'token-status-1' }]);
  mock.handler = (request) => {
    if (request.path === '/api/accounts/login') return { json: { status: 'signed-in', account: accountRecord(accountId), clientToken: 'token-status-2' } };
    if (request.path === '/api/activity') return { status: 403, json: { error: 'forbidden' } };
    return { status: 404, json: { error: 'unexpected' } };
  };
  await subscribeSession(page, 'status');
  sessionValue(await callSession(page, 'loginAccount', { handle: accountId, password: 'status-password' }));
  assert.deepEqual(await sessionSnapshot(page, 'status'), { count: 1, payloads: [] });

  const forbidden = sessionFailure(await callSession(page, 'readActivity', accountId));
  assert.equal(forbidden.status, 403);
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.clientToken), ['token-status-2']);

  mock.handler = (request) => {
    if (request.path === '/api/activity') return { status: 500, json: { error: 'server-failure' } };
    return { status: 404, json: { error: 'unexpected' } };
  };
  const server = sessionFailure(await callSession(page, 'readActivity', accountId));
  assert.equal(server.status, 500);
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.clientToken), ['token-status-2']);

  mock.handler = () => ({ abort: true });
  sessionFailure(await callSession(page, 'readActivity', accountId));
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.clientToken), ['token-status-2']);
  assert.deepEqual(await sessionSnapshot(page, 'status'), { count: 1, payloads: [] });
  assert.deepEqual(errors, []);
});

test('frontend session API clears a rejected logout session without clearing other accounts', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  const accountA = '@logout-rejected@a.example';
  const accountB = '@logout-rejected@b.example';
  await storeSessionEntries(page, [
    { accountId: accountA, handle: accountA, clientToken: 'token-logout-rejected-a' },
    { accountId: accountB, handle: accountB, clientToken: 'token-logout-rejected-b' }
  ]);
  mock.handler = () => ({ status: 401, json: { error: 'rejected-session' } });
  await subscribeSession(page, 'logout-rejected');
  assert.equal(sessionFailure(await callSession(page, 'logoutAccount', accountA)).status, 401);
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.accountId), [accountB]);
  assert.deepEqual(await sessionSnapshot(page, 'logout-rejected'), { count: 1, payloads: [] });
  assert.deepEqual(errors, []);
});

test('frontend session API applies rejected-session handling to a non-JSON 401 body', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  const accountA = '@nonjson@a.example';
  const accountB = '@nonjson@b.example';
  await storeSessionEntries(page, [
    { accountId: accountA, handle: accountA, clientToken: 'token-nonjson-a' },
    { accountId: accountB, handle: accountB, clientToken: 'token-nonjson-b' }
  ]);
  mock.handler = (request) => {
    if (request.path === '/api/activity') {
      return { status: 401, text: `rejected ${request.authorization ?? ''}`, contentType: 'text/plain' };
    }
    return { status: 404, json: { error: 'unexpected' } };
  };
  const rejected = sessionFailure(await callSession(page, 'readActivity', accountA));
  assert.equal(rejected.status, 401);
  assert.equal(rejected.message.includes('token-nonjson-a'), false);
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.accountId), [accountB]);
  assert.deepEqual(errors, []);
});

test('frontend session API does not expose passwords or session tokens from malformed or failed responses', async (t) => {
  const context = await newSessionContext(t);
  const { page, errors, mock } = await openSessionPage(context);
  const accountId = '@secret@a.example';
  const password = 'pw12345';
  const token = 'tok12345';
  await storeSessionEntries(page, [{ accountId, handle: accountId, clientToken: token }]);

  mock.handler = (request) => {
    if (request.path === '/api/accounts/login') return { status: 200, text: `${password} is not json` };
    if (request.path === '/api/activity') return { status: 200, text: `${token} is not json` };
    return { status: 404, json: { error: 'unexpected' } };
  };
  const malformedLogin = sessionFailure(await callSession(page, 'loginAccount', { handle: accountId, password }));
  assert.equal(malformedLogin.message.includes(password), false);
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.clientToken), [token]);

  const malformedRead = sessionFailure(await callSession(page, 'readActivity', accountId));
  assert.equal(malformedRead.message.includes(token), false);
  assert.deepEqual((await sessionEntries(page)).map((entry) => entry.clientToken), [token]);

  mock.handler = (request) => {
    if (request.path === '/api/activity') return { status: 401, json: { error: `rejected ${token}` } };
    return { status: 404, json: { error: 'unexpected' } };
  };
  const rejected = sessionFailure(await callSession(page, 'readActivity', accountId));
  assert.equal(rejected.message.includes(token), false);
  assert.equal(rejected.status, 401);
  assert.deepEqual(await sessionEntries(page), []);
  assert.deepEqual(errors, []);
});
