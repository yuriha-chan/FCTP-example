import { binder, treeState, type Unsubscribe } from 'binduct';

export type TopicId = 'connections' | 'explore' | 'logistics' | 'authoring' | 'activity' | 'administration';

export interface ShellSnapshot {
  accountId: string | undefined;
  topic: TopicId;
}

export interface ShellState {
  read(): ShellSnapshot;
  subscribeAccountId(listener: (value: string | undefined) => void): Unsubscribe;
  subscribeTopic(listener: (value: TopicId) => void): Unsubscribe;
  update(patch: Partial<ShellSnapshot>): void;
}

export function createShellState(): ShellState {
  const state = treeState<ShellSnapshot>({ accountId: undefined, topic: 'connections' });
  return {
    read: () => ({ accountId: state.accountId, topic: state.topic }),
    subscribeAccountId: (listener) => binder(state).accountId((value) => listener(value)),
    subscribeTopic: (listener) => binder(state).topic((value) => listener(value)),
    update: (patch) => {
      if ('accountId' in patch) state.accountId = patch.accountId;
      if (patch.topic !== undefined) state.topic = patch.topic;
    }
  };
}
