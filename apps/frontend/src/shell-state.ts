import { treeState, type StateProxy } from 'binduct';
import type { PublicAccountRecord } from '@fctp/client-sdk';

export type TopicId = 'connections' | 'explore' | 'logistics' | 'authoring' | 'activity' | 'administration';

export interface ShellSnapshot {
  accountId: string | undefined;
  topic: TopicId;
  accounts: readonly PublicAccountRecord[];
  listError: string | undefined;
  actionError: string | undefined;
  listLoading: boolean;
  signInOpen: boolean;
}

export function createShellState(): StateProxy<ShellSnapshot> {
  return treeState<ShellSnapshot>({
    accountId: undefined,
    topic: 'connections',
    accounts: [],
    listError: undefined,
    actionError: undefined,
    listLoading: false,
    signInOpen: false
  });
}
