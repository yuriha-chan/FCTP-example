import { createFctpClient, toPublicAccount, type AccountRecord, type LoginState, type PublicAccountRecord } from '@fctp/client-sdk';
import { boundedFetcher } from './errors.js';
import { createClientToken, digestClientToken } from './sessions.js';
import type { ClientApplicationState } from './store.js';

export interface LoginInput {
  handle: string;
  password: string;
}

export type LoginOutcome =
  | { status: 'signed-in'; account: PublicAccountRecord; clientToken: string }
  | { status: 'rejected' | 'unavailable'; reason?: string };

export interface AccountService {
  list(): Promise<PublicAccountRecord[]>;
  get(accountId: string): Promise<PublicAccountRecord | undefined>;
  login(input: LoginInput): Promise<LoginOutcome>;
  logout(accountId: string, clientTokenDigest: string): Promise<PublicAccountRecord | undefined>;
}

export function createAccountService(state: ClientApplicationState, fetcher: typeof fetch): AccountService {
  const sdk = createFctpClient({ fetcher: boundedFetcher(fetcher) });
  return {
    async list() {
      const accounts = await state.read((current) => Object.values(current.accounts));
      return accounts.map(toPublicAccount);
    },
    async get(accountId) {
      const account = await state.read((current) => current.accounts[accountId]);
      return account ? toPublicAccount(account) : undefined;
    },
    async login(input) {
      if (typeof input.handle !== 'string' || !input.handle.trim() || typeof input.password !== 'string' || !input.password) {
        throw new TypeError('A handle and password are required');
      }
      const resolution = await sdk.resolveAccount(input.handle);
      const result = await sdk.login({ handle: input.handle, password: input.password }, resolution.homeOrigin);
      if (result.status !== 'signed-in') {
        return result.reason ? { status: result.status, reason: result.reason } : { status: result.status };
      }
      const id = result.handle;
      const login: LoginState = {
        status: 'signed-in',
        homeServer: resolution.homeServer,
        nativeToken: result.nativeToken,
        ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt })
      };
      const account: AccountRecord = {
        id,
        handle: result.handle,
        homeServer: resolution.homeServer,
        actorId: resolution.actorId,
        homeAuthority: resolution.homeAuthority,
        login
      };
      const clientToken = createClientToken();
      const digest = digestClientToken(clientToken);
      await state.transaction((current) => {
        current.accounts[id] = account;
        current.clientSessions[digest] = { accountId: id, issuedAt: new Date().toISOString() };
      });
      return { status: 'signed-in', account: toPublicAccount(account), clientToken };
    },
    async logout(accountId, clientTokenDigest) {
      return state.transaction((current) => {
        delete current.clientSessions[clientTokenDigest];
        const account = current.accounts[accountId];
        if (!account) return undefined;
        const remaining = Object.values(current.clientSessions).some((session) => session.accountId === accountId);
        if (!remaining) account.login = { status: 'signed-out' };
        return toPublicAccount(account);
      });
    }
  };
}
