import { treeState, type StateProxy } from 'binduct';
import type { PublicAccountRecord } from '@fctp/client-sdk';

export interface ShellSnapshot {
  accountId: string | undefined;
  accounts: readonly PublicAccountRecord[];
  listError: string | undefined;
  actionError: string | undefined;
  listLoading: boolean;
  signInOpen: boolean;
}

export function createShellState(): StateProxy<ShellSnapshot> {
  return treeState<ShellSnapshot>({
    accountId: undefined,
    accounts: [],
    listError: undefined,
    actionError: undefined,
    listLoading: false,
    signInOpen: false
  });
}
