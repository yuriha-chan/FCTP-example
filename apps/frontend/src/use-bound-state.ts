import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { Unsubscribe } from 'binduct';

export type StateSubscription<T> = (setValue: Dispatch<SetStateAction<T>>) => Unsubscribe;

export function useBoundState<T>(read: () => T, subscribe: StateSubscription<T>): T {
  const [value, setValue] = useState<T>(read);
  useEffect(() => subscribe(setValue), [subscribe]);
  return value;
}
