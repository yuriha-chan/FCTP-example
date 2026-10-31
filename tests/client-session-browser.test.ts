import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium, type BrowserContext, type Page } from 'playwright';
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
