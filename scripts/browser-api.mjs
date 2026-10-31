import { setTimeout, clearTimeout } from 'node:timers';
import { URL } from 'node:url';

const MAX_ERROR_LENGTH = 500;
const REQUEST_TIMEOUT_MS = 30_000;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bounded(value) {
  const message = typeof value === 'string' ? value : String(value);
  return message.slice(0, MAX_ERROR_LENGTH);
}

function redact(message, secrets) {
  let safe = message;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) safe = safe.replaceAll(secret, '[REDACTED]');
  }
  return safe;
}

function normalizeClientSession(value, account) {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || typeof value.accountId !== 'string' || !value.accountId || typeof value.handle !== 'string' || typeof value.clientToken !== 'string' || !value.clientToken) {
    throw new TypeError('Invalid client session');
  }
  if (value.handle !== account.handle) throw new TypeError('Client session handle does not match the configured account');
  return { accountId: value.accountId, handle: value.handle, clientToken: value.clientToken };
}

export function normalizeOrigin(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`Invalid ${label}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError(`Invalid ${label}`);
  }
  return url.origin;
}

export function applicationUrl(origin, path, { query = true } = {}) {
  if (typeof path !== 'string' || !path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new TypeError('Invalid application path');
  }
  let url;
  try { url = new URL(path, origin); } catch { throw new TypeError('Invalid application path'); }
  if (url.origin !== origin || url.username || url.password) throw new Error('Application path origin is not allowed');
  if (url.hash) throw new Error('Application path fragment is not allowed');
  if (!query && url.search) throw new Error('Application path query is not allowed');
  if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) throw new Error('Application path must target /api');
  if (url.pathname.startsWith('/world') || url.pathname.startsWith('/local')) throw new Error('World paths are not allowed');
  return url;
}

export function createApplicationTransport({ origin, account, fetch: injectedFetch, clientSession, onSessionChanged } = {}) {
  const transportOrigin = normalizeOrigin(origin, 'application origin');
  if (!isRecord(account) || typeof account.name !== 'string' || !account.name || typeof account.handle !== 'string' || !account.handle) {
    throw new TypeError('A configured account with a name and handle is required');
  }
  if (Object.hasOwn(account, 'homeOrigin')) throw new TypeError('Account homeOrigin is not supported; login origin is derived from the handle');
  const fetcher = injectedFetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw new TypeError('A fetch implementation is required');
  if (onSessionChanged !== undefined && typeof onSessionChanged !== 'function') throw new TypeError('A session callback must be a function');
  let currentSession = normalizeClientSession(clientSession, account);

  const notify = async (session) => {
    if (onSessionChanged === undefined) return;
    await onSessionChanged(session);
  };

  const invalidate = async (session) => {
    if (currentSession?.clientToken !== session.clientToken) return;
    currentSession = undefined;
    await notify(null);
  };

  const request = async (method, url, body, options = {}) => {
    const session = Object.hasOwn(options, 'session') ? options.session : currentSession;
    const clearOnUnauthorized = options.clearOnUnauthorized !== false;
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await fetcher(url, {
          method,
          headers: {
            Accept: 'application/json',
            ...(session === undefined ? {} : { Authorization: `Bearer ${session.clientToken}` }),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        throw new Error(bounded(name === 'AbortError' ? 'Application request timed out' : 'Application request unavailable'));
      }
      const text = await response.text();
      let value;
      try { value = text ? JSON.parse(text) : undefined; } catch { value = undefined; }
      if (!response.ok) {
        const reason = isRecord(value) && typeof (value.error ?? value.reason ?? value.status) === 'string'
          ? String(value.error ?? value.reason ?? value.status)
          : '';
        const safeReason = redact(reason, [body?.password, session?.clientToken]);
        if (response.status === 401 && session !== undefined && clearOnUnauthorized) await invalidate(session);
        throw new Error(bounded(`Application request failed: HTTP ${response.status}${safeReason ? ` ${safeReason}` : ''}`));
      }
      if (value === undefined && text) throw new Error('Application response was not JSON');
      return value;
    } finally {
      clearTimeout(timer);
    }
  };

  const resolveAccountId = async () => {
    if (currentSession === undefined) return undefined;
    const session = currentSession;
    const page = await request('GET', new URL('/api/accounts', transportOrigin), undefined, { session });
    const accounts = isRecord(page) && Array.isArray(page.accounts) ? page.accounts : [];
    const match = accounts.find((candidate) => isRecord(candidate) && candidate.id === session.accountId);
    if (!match || match.handle !== account.handle) {
      await invalidate(session);
      throw new Error('Application account binding does not match the client session');
    }
    return session.accountId;
  };

  return {
    async login(password) {
      if (typeof password !== 'string' || !password) throw new TypeError('A password is required');
      const body = {
        handle: account.handle,
        password
      };
      const result = await request('POST', new URL('/api/accounts/login', transportOrigin), body, { session: undefined });
      if (!isRecord(result) || result.status !== 'signed-in') {
        throw new Error('Application login failed');
      }
      if (!isRecord(result.account) || typeof result.account.id !== 'string' || !result.account.id || result.account.handle !== account.handle) {
        throw new Error('Application login returned an unexpected account');
      }
      if (typeof result.clientToken !== 'string' || !result.clientToken) {
        throw new Error('Application login did not return a client session');
      }
      const session = { accountId: result.account.id, handle: result.account.handle, clientToken: result.clientToken };
      currentSession = session;
      await notify(session);
      return result;
    },
    async logout() {
      const session = currentSession;
      if (session === undefined) throw new Error('A signed-in account is required to log out');
      const url = new URL(`/api/accounts/${encodeURIComponent(session.accountId)}/logout`, transportOrigin);
      const result = await request('POST', url, undefined, { session, clearOnUnauthorized: false });
      if (currentSession?.clientToken === session.clientToken) {
        currentSession = undefined;
        await notify(null);
      }
      return result;
    },
    async page(path) {
      const url = applicationUrl(transportOrigin, path, { query: true });
      const requestedAccountId = url.searchParams.get('accountId');
      const accountId = await resolveAccountId();
      if (accountId === undefined) {
        if (requestedAccountId) throw new Error('A signed-in account is required for account-scoped reads');
        url.searchParams.delete('accountId');
      } else {
        url.searchParams.set('accountId', accountId);
      }
      return request('GET', url, undefined, { session: currentSession });
    },
    async action(descriptor, inputs = {}) {
      if (!isRecord(descriptor)) throw new TypeError('Invalid action descriptor');
      if (descriptor.enabled === false) throw new Error('Action descriptor is disabled');
      if (Array.isArray(descriptor.blockers) && descriptor.blockers.length > 0) throw new Error('Action descriptor has blockers');
      if (descriptor.method !== 'POST') throw new Error('Action descriptor method must be POST');
      const url = applicationUrl(transportOrigin, descriptor.endpoint, { query: false });
      if (url.pathname === '/api/accounts/login') throw new Error('Use configured account login');
      if (!isRecord(inputs)) throw new TypeError('Action inputs must be an object');
      const logout = /^\/api\/accounts\/([^/]+)\/logout$/.exec(url.pathname);
      if (logout) {
        const targetId = decodeURIComponent(logout[1]);
        const session = currentSession;
        if (session === undefined || targetId !== session.accountId) throw new Error('Account substitution is not allowed');
        const result = await request('POST', url, inputs, { session, clearOnUnauthorized: false });
        if (currentSession?.clientToken === session.clientToken) {
          currentSession = undefined;
          await notify(null);
        }
        return result;
      }
      const accountId = await resolveAccountId();
      if (Object.hasOwn(inputs, 'accountId')) {
        if (accountId === undefined || inputs.accountId !== accountId) throw new Error('Account substitution is not allowed');
      }
      return request('POST', url, { ...inputs, ...(accountId === undefined ? {} : { accountId }) }, { session: currentSession });
    },
    async result(actionId) {
      if (typeof actionId !== 'string' || !actionId) throw new TypeError('An action id is required');
      const url = applicationUrl(transportOrigin, `/api/activity/${encodeURIComponent(actionId)}`, { query: true });
      const accountId = await resolveAccountId();
      if (accountId === undefined) throw new Error('A signed-in account is required to read an action result');
      url.searchParams.set('accountId', accountId);
      return request('GET', url, undefined, { session: currentSession });
    }
  };
}
