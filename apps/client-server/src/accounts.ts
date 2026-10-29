import { createFctpClient, toPublicAccount, type AccountRecord, type LoginState, type PublicAccountRecord } from '@fctp/client-sdk';
import { boundedFetcher } from './errors.js';
import type { ClientApplicationState } from './store.js';

export interface LoginInput {
  handle: string;
  password: string;
  homeOrigin?: string;
}

export type LoginOutcome =
  | { status: 'signed-in'; account: PublicAccountRecord }
  | { status: 'rejected' | 'unavailable'; reason?: string };

export interface AccountService {
  list(): Promise<PublicAccountRecord[]>;
  login(input: LoginInput): Promise<LoginOutcome>;
  logout(accountId: string): Promise<PublicAccountRecord | undefined>;
}

export function createAccountService(state: ClientApplicationState, fetcher: typeof fetch): AccountService {
  const sdk = createFctpClient({ fetcher: boundedFetcher(fetcher) });
  return {
    async list() {
      const accounts = await state.read((current) => Object.values(current.accounts));
      return accounts.map(toPublicAccount);
    },
    async login(input) {
      if (typeof input.handle !== 'string' || !input.handle.trim() || typeof input.password !== 'string' || !input.password) {
        throw new TypeError('A handle and password are required');
      }
      const resolution = await sdk.resolveAccount(input.handle, input.homeOrigin ? { homeOrigin: input.homeOrigin } : {});
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
      await state.transaction((current) => {
        current.accounts[id] = account;
      });
      return { status: 'signed-in', account: toPublicAccount(account) };
    },
    async logout(accountId) {
      return state.transaction((current) => {
        const account = current.accounts[accountId];
        if (!account) return undefined;
        account.login = { status: 'signed-out' };
        return toPublicAccount(account);
      });
    }
  };
}
