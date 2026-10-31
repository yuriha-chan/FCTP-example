import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request as PlaywrightRequest } from 'playwright';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtureOrigin = 'http://application.invalid/';
const sessionKey = 'fctp.client-sessions';
const settleTimeout = 5_000;
const observedAt = '2026-02-03T04:05:06.000Z';

const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>';

const fixtureSource = String.raw`
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { Application } from './apps/frontend/src/application.tsx';

createRoot(document.getElementById('root')).render(
  React.createElement(React.StrictMode, null, React.createElement(Application))
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
}

interface DirectoryResponse {
  servers: Array<{ server: string; origin: string; authorities: string[]; name?: string }>;
  authorities: Array<{ actorId: string; server: string; roles: string[]; name?: string; handle?: string }>;
}

interface ResourceInput {
  id: string;
  refresh: boolean;
  accountId: string | undefined;
  authorityId: string | undefined;
}

function accountRecord(id: string): Record<string, unknown> {
  return {
    id,
    handle: id,
    homeServer: 'home.example',
    login: { status: 'signed-in' }
  };
}

function directoryFor(origin: string): DirectoryResponse {
  const host = new URL(origin).host;
  const actorId = `${origin}/actors/registry`;
  return {
    servers: [{ server: host, origin, authorities: [actorId], name: 'Harbor Server' }],
    authorities: [{
      actorId,
      server: host,
      roles: ['registry'],
      name: 'Harbor Registry',
      handle: `@harbor.registry@${host}`
    }]
  };
}

function resourcePage(input: { actorId: string; accountId: string | undefined; description: string; name: string }): Record<string, unknown> {
  const value = { id: input.actorId, type: 'Actor', name: input.name, description: input.description };
  return {
    context: {
      resourceId: input.actorId,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId })
    },
    data: { resourceId: input.actorId, value },
    observations: {
      [`observation:${input.actorId}`]: { state: 'available', source: input.actorId, observedAt, value }
    },
    actions: []
  };
}

class ApplicationMock {
  readonly requests: MockRequest[] = [];
  directory: DirectoryResponse = { servers: [], authorities: [] };
  private readonly accounts = new Map<string, { id: string; handle: string }>();
  private readonly tokenAccounts = new Map<string, string>();
  private readonly waiters: Array<() => void> = [];

  onLogin: (body: Record<string, unknown>) => MockResponse = () => ({ status: 404, json: { error: 'unexpected-login' } });
  onDiscover: (body: Record<string, unknown>) => DirectoryResponse = () => this.directory;
  onResource: (input: ResourceInput) => Record<string, unknown> = (input) => resourcePage({
    actorId: input.id,
    accountId: input.accountId,
    name: 'Harbor Registry',
    description: 'Retained authority record'
  });

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
    this.notify();
    return record;
  }

  waitFor(predicate: (request: MockRequest) => boolean, timeout = settleTimeout): Promise<MockRequest> {
    const existing = this.requests.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<MockRequest>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Timed out waiting for an application request')); }, timeout);
      const check = (): void => {
        const match = this.requests.find(predicate);
        if (!match) {
          this.waiters.push(check);
          return;
        }
        clearTimeout(timer);
        resolve(match);
      };
      check();
    });
  }

  waitUntil(predicate: () => boolean, message: string, timeout = settleTimeout): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error(message)); }, timeout);
      const check = (): void => {
        if (!predicate()) {
          this.waiters.push(check);
          return;
        }
        clearTimeout(timer);
        resolve();
      };
      check();
    });
  }

  async handle(request: MockRequest): Promise<MockResponse> {
    if (request.method === 'POST' && request.path === '/api/accounts/login') {
      const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
      const response = this.onLogin(body);
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

    if (request.method === 'GET' && request.path === '/api/accounts') {
      const accountId = this.accountFor(request);
      if (accountId === undefined) return { status: 401, json: { error: 'rejected-session' } };
      return { json: { accounts: [accountRecord(accountId)] } };
    }

    if (request.path === '/api/servers') {
      if (request.method === 'GET') return { json: this.directory };
      if (request.method === 'POST') {
        const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
        this.directory = this.onDiscover(body);
        return { json: this.directory };
      }
    }

    const resourceMatch = /^\/api\/resources\/([^/]+)(\/refresh)?$/.exec(request.path);
    if (resourceMatch) {
      const id = decodeURIComponent(resourceMatch[1]!);
      const refresh = resourceMatch[2] !== undefined;
      const body = refresh ? JSON.parse(request.body ?? '{}') as Record<string, unknown> : undefined;
      const accountId = refresh
        ? (typeof body?.accountId === 'string' ? body.accountId : undefined)
        : (request.query.accountId ?? undefined);
      const authorityId = refresh
        ? (typeof body?.authorityId === 'string' ? body.authorityId : undefined)
        : (request.query.authorityId ?? undefined);
      if (this.accountFor(request) === undefined) return { status: 401, json: { error: 'rejected-session' } };
      return { json: this.onResource({ id, refresh, accountId, authorityId }) };
    }

    return { status: 404, json: { error: 'unexpected-request' } };
  }

  private notify(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  private accountFor(request: MockRequest): string | undefined {
    const token = request.authorization?.replace(/^Bearer /, '');
    return token === undefined ? undefined : this.tokenAccounts.get(token);
  }
}

let browser: Browser | undefined;
let bundle: string | undefined;
let stylesheet: string | undefined;

before(async () => {
  const result = await build({
    stdin: {
      contents: fixtureSource,
      resolveDir: projectRoot,
      sourcefile: 'frontend-application-fixture.js',
      loader: 'js'
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    outdir: join(tmpdir(), 'fctp-frontend-application-fixture'),
    loader: { '.css': 'local-css' },
    define: { 'process.env.NODE_ENV': '"development"' }
  });
  const script = result.outputFiles.find((file) => file.path.endsWith('.js'));
  const css = result.outputFiles.find((file) => file.path.endsWith('.css'));
  assert(script, 'esbuild produced no application fixture bundle');
  assert(css, 'esbuild produced no real stylesheet output');
  bundle = script.text;
  stylesheet = css.text;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

interface OpenOptions {
  sessions?: readonly StoredSession[];
  configureMock?: (mock: ApplicationMock) => void;
}

async function openApplicationPage(t: TestContext, options: OpenOptions = {}): Promise<{ page: Page; mock: ApplicationMock; errors: string[]; context: BrowserContext }> {
  const activeBrowser = browser;
  const activeBundle = bundle;
  const activeStylesheet = stylesheet;
  assert(activeBrowser, 'browser was not started');
  assert(activeBundle, 'application fixture bundle was not built');
  assert(activeStylesheet, 'application stylesheet was not built');

  const context = await activeBrowser.newContext();
  t.after(async () => { await context.close(); });
  if (options.sessions !== undefined) {
    await context.addInitScript((seed: { key: string; value: string }) => {
      localStorage.setItem(seed.key, seed.value);
    }, { key: sessionKey, value: JSON.stringify(options.sessions) });
  }

  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => { errors.push(error.message); });
  const mock = new ApplicationMock();
  options.configureMock?.(mock);
  if (options.sessions !== undefined) mock.seed(options.sessions);

  await page.route(`${fixtureOrigin}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/bundle.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: activeBundle });
      return;
    }
    if (url.pathname === '/bundle.css') {
      await route.fulfill({ status: 200, contentType: 'text/css', body: activeStylesheet });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const record = mock.record(request, url);
      const response = await mock.handle(record);
      await route.fulfill({
        status: response.status ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(response.json ?? {})
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });

  await page.goto(fixtureOrigin);
  return { page, mock, errors, context };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function connectionsRegion(page: Page): Locator {
  return page.getByRole('region', { name: 'Connections' });
}

function accountOption(page: Page, handle: string): Locator {
  return page.getByRole('option').filter({ hasText: handle });
}

async function selectAccount(page: Page, handle: string): Promise<void> {
  const target = accountOption(page, handle);
  await target.waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await target.count(), 1, `expected one account choice for ${handle}`);
  await target.click();
  await page.waitForFunction((text) => {
    const options = Array.from(document.querySelectorAll('[role="option"]'));
    const selected = options.find((candidate) => candidate.textContent?.includes(text));
    return selected?.getAttribute('aria-selected') === 'true';
  }, handle, { timeout: settleTimeout });
}

async function discover(page: Page, mock: ApplicationMock, origin: string): Promise<MockRequest> {
  const input = connectionsRegion(page).getByRole('textbox', { name: /server origin or account\/authority handle/i });
  await input.waitFor({ state: 'visible', timeout: settleTimeout });
  await input.fill(origin);
  await input.press('Enter');
  return mock.waitFor((request) => request.method === 'POST' && request.path === '/api/servers');
}

async function waitForReadAuthority(page: Page): Promise<Locator> {
  const buttons = connectionsRegion(page).getByRole('button', { name: /read authority/i });
  await buttons.first().waitFor({ state: 'visible', timeout: settleTimeout });
  return buttons;
}

function parsedBody(request: MockRequest): unknown {
  return request.body === null ? undefined : JSON.parse(request.body) as unknown;
}

test('signs in, persists the account, discovers an origin, reads and refreshes an authority, then leaves one visible panel', async (t) => {
  const handle = '@alice@a.example';
  const password = 'integration-password';
  const token = 'token-alice';
  const origin = 'http://alpha.test:4200';
  const directory = directoryFor(origin);
  const authority = directory.authorities[0]!;
  const resourcePath = `/api/resources/${encodeURIComponent(authority.actorId)}`;

  const { page, mock, errors } = await openApplicationPage(t, {
    configureMock: (candidate) => {
      candidate.onLogin = (body) => {
        const credentials = body as { handle?: unknown; password?: unknown };
        if (credentials.handle === handle && credentials.password === password) {
          return { json: { status: 'signed-in', account: accountRecord(handle), clientToken: token } };
        }
        return { status: 401, json: { status: 'rejected', reason: 'invalid handle or password' } };
      };
      candidate.onDiscover = () => directory;
      candidate.onResource = ({ id, accountId, refresh }) => resourcePage({
        actorId: id,
        accountId,
        name: 'Harbor Registry',
        description: refresh ? 'Explicitly refreshed authority snapshot' : 'Initial retained authority snapshot'
      });
    }
  });

  await page.getByLabel('Handle', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  await page.getByLabel('Password').waitFor({ state: 'visible', timeout: settleTimeout });
  await page.getByLabel('Handle', { exact: true }).fill(handle);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await accountOption(page, handle).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await accountOption(page, handle).count(), 1);

  const logins = mock.requests.filter((request) => request.path === '/api/accounts/login');
  assert.equal(logins.length, 1);
  assert.deepEqual(parsedBody(logins[0]!), { handle, password });
  assert.equal(logins[0]!.authorization, undefined);
  const loginBody = parsedBody(logins[0]!) as Record<string, unknown>;
  assert.equal('origin' in loginBody, false);
  assert.equal('home' in loginBody, false);

  const storedRaw = await page.evaluate((key) => localStorage.getItem(key), sessionKey);
  assert.ok(storedRaw, 'the client session must be persisted');
  const stored = JSON.parse(storedRaw) as StoredSession[];
  assert.deepEqual(stored.map((entry) => entry.accountId), [handle]);
  assert.equal(stored[0]!.clientToken, token);

  assert.equal(await page.evaluate(() => document.styleSheets.length > 0), true, 'the real stylesheet must be applied');

  const serverGetsBeforeReload = mock.requests.filter((request) => request.method === 'GET' && request.path === '/api/servers').length;
  await page.reload();
  await accountOption(page, handle).waitFor({ state: 'visible', timeout: settleTimeout });
  await mock.waitUntil(
    () => mock.requests.filter((request) => request.method === 'GET' && request.path === '/api/servers').length > serverGetsBeforeReload,
    'expected a retained directory read after restoring the session'
  );

  for (const request of mock.requests.filter((candidate) => candidate.path === '/api/servers')) {
    assert.equal(request.authorization, undefined, 'public directory requests must not attach a session credential');
  }

  const discovery = await discover(page, mock, origin);
  assert.deepEqual(parsedBody(discovery), { origin });
  assert.equal(discovery.authorization, undefined, 'explicit discovery must remain public');
  assert.equal(mock.requests.filter((request) => request.method === 'POST' && request.path === '/api/servers').length, 1);

  await connectionsRegion(page).getByRole('paragraph').filter({ hasText: authority.handle! }).waitFor({ state: 'visible', timeout: settleTimeout });

  const readButtons = await waitForReadAuthority(page);
  assert.equal(await readButtons.count(), 1, 'each known authority must have one contextual reader control');
  await readButtons.first().click();

  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByRole('heading', { name: 'Harbor Registry' }).waitFor({ state: 'visible', timeout: settleTimeout });

  const read = await mock.waitFor((request) => request.method === 'GET' && request.path === resourcePath);
  assert.equal(read.query.accountId, handle, 'the reader must use the exact selected account');
  assert.equal(read.authorization, `Bearer ${token}`, 'the reader must use the exact selected client session');

  await dialog.getByText(/Type:\s*Actor/i).waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByText(/Available/i).first().waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByRole('paragraph').filter({ hasText: observedAt }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal((await dialog.innerText()).includes(authority.actorId), false, 'exact authority IDs belong in the disclosure');

  const details = dialog.locator('details').filter({ hasText: 'Resource details' });
  await details.locator('summary').click();
  const technical = await details.textContent();
  assert.ok(technical?.includes(`Source ${authority.actorId}`), 'the disclosure must retain the exact source');
  assert.ok(technical?.includes('State available'));
  assert.ok(technical?.includes(`Observed ${observedAt}`));

  await sleep(200);
  assert.equal(
    mock.requests.filter((request) => request.method === 'POST' && request.path.startsWith('/api/resources/')).length,
    0,
    'opening the reader must not observe the world through POST'
  );

  await dialog.getByRole('button', { name: 'Refresh' }).click();
  const refresh = await mock.waitFor((request) => request.method === 'POST' && request.path === `${resourcePath}/refresh`);
  assert.equal(refresh.authorization, `Bearer ${token}`);
  const refreshBody = parsedBody(refresh) as Record<string, unknown>;
  assert.equal(refreshBody.accountId, handle);
  await dialog.getByText('Explicitly refreshed authority snapshot', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(
    mock.requests.filter((request) => request.method === 'POST' && request.path === `${resourcePath}/refresh`).length,
    1,
    'Refresh must be the only user-driven POST'
  );

  assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true, 'refresh must preserve focus inside the dialog');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });
  await page.waitForFunction(() => {
    const active = document.activeElement as HTMLElement | null;
    return Boolean(active && active.tagName === 'BUTTON' && /read authority/i.test(active.textContent ?? ''));
  }, undefined, { timeout: settleTimeout });
  assert.equal(await readButtons.first().evaluate((element) => element === document.activeElement), true, 'closing must return focus to the originating authority control');

  await page.getByRole('tab', { name: 'Explore', exact: true }).click();
  await page.waitForFunction(() => {
    const panels = Array.from(document.querySelectorAll('[role="tabpanel"]')) as HTMLElement[];
    const visible = panels.filter((panel) => panel.getClientRects().length > 0);
    return visible.length === 1 && (visible[0]?.textContent ?? '').includes('Explore');
  }, undefined, { timeout: settleTimeout });
  assert.equal(await page.locator('[role="tabpanel"]:visible').count(), 1, 'exactly one topic panel must be visible');

  const bodyText = await page.locator('body').innerText();
  assert.equal(bodyText.includes(password), false, 'the password must not appear in visible text');
  assert.equal(bodyText.includes(token), false, 'the client token must not appear in visible text');
  assert.deepEqual(errors, []);
});

test('keeps same-name accounts isolated while reopening the same retained authority reader', async (t) => {
  const first = '@same@a.example';
  const second = '@same@b.example';
  const tokenFirst = 'token-alpha';
  const tokenSecond = 'token-beta';
  const origin = 'http://alpha.test:4200';
  const directory = directoryFor(origin);
  const authority = directory.authorities[0]!;
  const resourcePath = `/api/resources/${encodeURIComponent(authority.actorId)}`;

  const { page, mock, errors } = await openApplicationPage(t, {
    sessions: [
      { accountId: first, handle: first, clientToken: tokenFirst },
      { accountId: second, handle: second, clientToken: tokenSecond }
    ],
    configureMock: (candidate) => {
      candidate.onDiscover = () => directory;
      candidate.onResource = ({ id, accountId }) => resourcePage({
        actorId: id,
        accountId,
        name: 'Harbor Registry',
        description: accountId === first ? 'Alpha private registry record' : 'Beta private registry record'
      });
    }
  });

  await accountOption(page, first).waitFor({ state: 'visible', timeout: settleTimeout });
  await accountOption(page, second).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal(await accountOption(page, first).count(), 1);
  assert.equal(await accountOption(page, second).count(), 1);

  await selectAccount(page, first);
  const discovery = await discover(page, mock, origin);
  assert.deepEqual(parsedBody(discovery), { origin });
  assert.equal(discovery.authorization, undefined);

  await connectionsRegion(page).getByRole('paragraph').filter({ hasText: authority.handle! }).waitFor({ state: 'visible', timeout: settleTimeout });
  const firstButtons = await waitForReadAuthority(page);
  assert.equal(await firstButtons.count(), 1);
  await firstButtons.first().click();

  let dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByText('Alpha private registry record', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });

  const firstRead = await mock.waitFor((request) => request.method === 'GET' && request.path === resourcePath && request.query.accountId === first);
  assert.equal(firstRead.authorization, `Bearer ${tokenFirst}`);

  await dialog.getByRole('button', { name: 'Close' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });

  const serverGetsBeforeSwitch = mock.requests.filter((request) => request.method === 'GET' && request.path === '/api/servers').length;
  await selectAccount(page, second);
  await mock.waitUntil(
    () => mock.requests.filter((request) => request.method === 'GET' && request.path === '/api/servers').length > serverGetsBeforeSwitch,
    'expected the connections panel to reload for the exact selected account'
  );
  assert.equal((await page.locator('body').innerText()).includes('Alpha private registry record'), false, 'private reader content must not cross the account switch');

  const secondButtons = await waitForReadAuthority(page);
  assert.equal(await secondButtons.count(), 1);
  await secondButtons.first().click();

  dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: settleTimeout });
  await dialog.getByText('Beta private registry record', { exact: true }).waitFor({ state: 'visible', timeout: settleTimeout });
  assert.equal((await dialog.innerText()).includes('Alpha private registry record'), false);

  const secondRead = await mock.waitFor((request) => request.method === 'GET' && request.path === resourcePath && request.query.accountId === second);
  assert.equal(secondRead.authorization, `Bearer ${tokenSecond}`, 'reopening must use the newly selected account session');
  assert.equal(secondRead.query.accountId, second);

  assert.equal(await page.getByRole('tab').count(), 6, 'the same shell must remain coherent across the account switch');
  assert.equal(await accountOption(page, first).count(), 1);
  assert.equal(await accountOption(page, second).count(), 1);
  assert.equal(await page.locator('[role="tabpanel"]:visible').count(), 1);

  await dialog.getByRole('button', { name: 'Close' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: settleTimeout });

  const bodyText = await page.locator('body').innerText();
  assert.equal(bodyText.includes(tokenFirst), false);
  assert.equal(bodyText.includes(tokenSecond), false);
  assert.equal(bodyText.includes('Alpha private registry record'), false);
  assert.equal(bodyText.includes('Beta private registry record'), false);
  assert.deepEqual(errors, []);
});
