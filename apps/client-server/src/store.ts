import { JsonSnapshotStore } from '@fctp/server-base';
import { emptyClientState, type ClientState } from './model.js';

export interface ClientApplicationState {
  read<T>(reader: (state: Readonly<ClientState>) => T): Promise<T>;
  transaction<T>(operation: (state: ClientState) => T | Promise<T>): Promise<T>;
}

export async function openClientState(storeFile: string): Promise<ClientApplicationState> {
  const store = new JsonSnapshotStore(storeFile);
  await store.open();
  const client = await store.read((snapshot) => snapshot.domain.client as ClientState | undefined);
  if (client === undefined || client.clientSessions === undefined || client.identities === undefined) {
    await store.transaction((draft) => {
      draft.domain.client ??= emptyClientState();
      (draft.domain.client as ClientState).clientSessions ??= {};
      (draft.domain.client as ClientState).identities ??= {};
    });
  }
  return {
    read: (reader) => store.read((snapshot) => reader(snapshot.domain.client as ClientState)),
    transaction: (operation) => store.transaction((draft) => operation(draft.domain.client as ClientState))
  };
}
