import type { AuthorityRecord, PublicAccountRecord, ServerRecord } from '@fctp/client-sdk';
import { discoverServer, loginAccount, logoutAccount, readAccounts, readServers } from './application-api.js';

function element<T extends HTMLElement>(id: string): T | undefined {
  const found = document.getElementById(id);
  return found instanceof HTMLElement ? found as T : undefined;
}

function field(form: HTMLFormElement, name: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined {
  const found = form.elements.namedItem(name);
  return found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement || found instanceof HTMLSelectElement ? found : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function statusLabel(account: PublicAccountRecord): string {
  if (account.login.status === 'signed-in') return 'Signed in';
  if (account.login.status === 'signed-out') return 'Signed out';
  return `Authentication rejected${account.login.reason ? `: ${account.login.reason}` : ''}`;
}

function technicalDetails(label: string, text: string): HTMLDetailsElement {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = label;
  const content = document.createElement('p');
  content.textContent = text;
  details.append(summary, content);
  return details;
}

function renderAccounts(container: HTMLElement, accounts: readonly PublicAccountRecord[], selectedId: string | undefined, select: (accountId: string) => void, logout: (accountId: string) => void): void {
  container.replaceChildren();
  if (accounts.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No known accounts.';
    container.append(empty);
    return;
  }
  for (const account of accounts) {
    const article = document.createElement('article');
    const identity = document.createElement('p');
    identity.textContent = `${account.handle} · ${statusLabel(account)}${account.id === selectedId ? ' · Selected' : ''}`;
    article.append(identity);
    const actions = document.createElement('p');
    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.textContent = 'Select account';
    selectButton.addEventListener('click', () => select(account.id));
    const logoutButton = document.createElement('button');
    logoutButton.type = 'button';
    logoutButton.textContent = 'Log out';
    logoutButton.addEventListener('click', () => logout(account.id));
    actions.append(selectButton, logoutButton);
    article.append(actions);
    const details = technicalDetails(`${account.handle} identity details`, `Actor ${text(account.actorId)} · Home ${text(account.homeAuthority)} · Server ${account.homeServer}`);
    article.append(details);
    container.append(article);
  }
}

function renderServers(container: HTMLElement, servers: readonly ServerRecord[], authorities: readonly AuthorityRecord[]): void {
  container.replaceChildren();
  if (servers.length === 0 && authorities.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No discovered servers.';
    container.append(empty);
    return;
  }
  for (const server of servers) {
    const heading = document.createElement('h3');
    heading.textContent = `Server ${server.server}`;
    container.append(heading);
    const address = technicalDetails(`${server.server} connection details`, server.origin);
    container.append(address);
    for (const actorId of server.authorities) {
      const authority = authorities.find((candidate) => candidate.actorId === actorId);
      if (!authority) continue;
      const details = document.createElement('p');
      details.textContent = `${authority.name ?? authority.handle ?? 'Authority'} · ${authority.roles.join(', ')}`;
      container.append(details, technicalDetails(`${authority.roles.join(', ')} authority details`, authority.actorId));
    }
  }
  for (const authority of authorities) {
    if (servers.some((server) => server.authorities.includes(authority.actorId))) continue;
    const details = document.createElement('p');
    details.textContent = `${authority.name ?? authority.handle ?? 'Authority'} · ${authority.roles.join(', ')}`;
    container.append(details, technicalDetails(`${authority.roles.join(', ')} authority details`, authority.actorId));
  }
}

export interface ApplicationControlsOptions {
  onAccountSelected?: (account: PublicAccountRecord | undefined) => void;
}

export function setupApplicationControls(options: ApplicationControlsOptions = {}): void {
  const loginForm = element<HTMLFormElement>('account-login-form');
  const discoveryForm = element<HTMLFormElement>('server-discovery-form');
  const accountsList = element<HTMLElement>('accounts-list');
  const serversList = element<HTMLElement>('servers-list');
  const accountStatus = element<HTMLElement>('application-account-status');
  const connectionStatus = element<HTMLElement>('application-connection-status');
  if (!loginForm || !discoveryForm || !accountsList || !serversList || !accountStatus || !connectionStatus) return;

  let accounts: PublicAccountRecord[] = [];
  let selectedAccountId: string | undefined;
  let servers: ServerRecord[] = [];
  let authorities: AuthorityRecord[] = [];
  let accountRevision = 0;

  const notifyAccountSelected = (): void => {
    options.onAccountSelected?.(accounts.find((account) => account.id === selectedAccountId));
  };

  const renderAccountList = (): void => {
    renderAccounts(accountsList, accounts, selectedAccountId, (accountId) => {
      selectedAccountId = accountId;
      const selected = accounts.find((account) => account.id === accountId);
      accountStatus.textContent = selected ? `Selected ${selected.handle} · ${statusLabel(selected)}` : 'No account selected.';
      notifyAccountSelected();
      renderAccountList();
    }, (accountId) => { void performLogout(accountId); });
  };

  const refreshAccounts = async (): Promise<void> => {
    const revision = accountRevision;
    const hadAccounts = accounts.length > 0;
    try {
      const result = (await readAccounts()).accounts;
      if (revision !== accountRevision) return;
      accounts = result;
      const selected = accounts.find((account) => account.id === selectedAccountId);
      if (!selected) selectedAccountId = undefined;
      accountStatus.textContent = selected
        ? `${statusLabel(selected)} · ${selected.handle}`
        : accounts.length === 0 && hadAccounts ? 'Signed out.' : 'No account selected.';
      notifyAccountSelected();
    } catch {
      if (revision !== accountRevision) return;
      accountStatus.textContent = 'Application account API unavailable.';
    }
    renderAccountList();
  };

  const performLogout = async (accountId: string): Promise<void> => {
    accountRevision += 1;
    document.documentElement.dataset.clientBusy = 'true';
    try {
      const result = await logoutAccount(accountId);
      accounts = accounts.filter((account) => account.id !== result.account.id);
      if (selectedAccountId === result.account.id) selectedAccountId = undefined;
      accountStatus.textContent = `Signed out · ${result.account.handle}`;
      notifyAccountSelected();
    } catch (error) {
      accountStatus.textContent = `Log out failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    renderAccountList();
    document.documentElement.dataset.clientBusy = 'false';
  };

  const refreshServers = async (): Promise<void> => {
    try {
      const result = await readServers();
      servers = result.servers;
      authorities = result.authorities;
      connectionStatus.textContent = servers.length === 0 ? 'No discovered servers.' : `Known servers: ${servers.length}.`;
    } catch {
      connectionStatus.textContent = 'Application discovery API unavailable.';
    }
    renderServers(serversList, servers, authorities);
  };

  loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const handle = field(loginForm, 'handle');
    const password = field(loginForm, 'password');
    const homeOrigin = field(loginForm, 'homeOrigin');
    if (!handle || !password) return;
    const value = password.value;
    accountRevision += 1;
    document.documentElement.dataset.clientBusy = 'true';
    void (async () => {
      try {
        const result = await loginAccount({
          handle: handle.value.trim(),
          password: value,
          ...(homeOrigin?.value.trim() ? { homeOrigin: homeOrigin.value.trim() } : {})
        });
        password.value = '';
        if (result.account) {
          selectedAccountId = result.account.id;
          accounts = [...accounts.filter((account) => account.id !== result.account!.id), result.account];
        }
        accountStatus.textContent = result.account ? `${statusLabel(result.account)} · ${result.account.handle}` : `Sign in ${result.status}`;
        notifyAccountSelected();
      } catch (error) {
        password.value = '';
        accountStatus.textContent = `Sign in failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      renderAccountList();
      document.documentElement.dataset.clientBusy = 'false';
    })();
  });

  discoveryForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const origin = field(discoveryForm, 'origin');
    const handle = field(discoveryForm, 'handle');
    const originValue = origin?.value.trim() ?? '';
    const handleValue = handle?.value.trim() ?? '';
    void (async () => {
      if (Boolean(originValue) === Boolean(handleValue)) {
        connectionStatus.textContent = 'Provide exactly one server origin or authority handle.';
        return;
      }
      document.documentElement.dataset.clientBusy = 'true';
      try {
        const result = await discoverServer({
          ...(originValue ? { origin: originValue } : {}),
          ...(handleValue ? { handle: handleValue } : {})
        });
        servers = result.servers;
        authorities = result.authorities;
        connectionStatus.textContent = `Discovered ${servers.length} server(s) and ${authorities.length} authority record(s).`;
        if (origin) origin.value = '';
        if (handle) handle.value = '';
      } catch (error) {
        connectionStatus.textContent = `Server discovery failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      renderServers(serversList, servers, authorities);
      document.documentElement.dataset.clientBusy = 'false';
    })();
  });

  globalThis.addEventListener('fctp-client-sessions-changed', () => { void refreshAccounts(); });
  void refreshAccounts();
  void refreshServers();
}
