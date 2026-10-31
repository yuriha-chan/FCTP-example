import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { binder, type StateProxy, type Unsubscribe } from 'binduct';

export type StateSubscription<T> = (setValue: Dispatch<SetStateAction<T>>) => Unsubscribe;

export function useBoundState<T>(read: () => T, subscribe: StateSubscription<T>): T {
  const [value, setValue] = useState<T>(read);
  useEffect(() => subscribe(setValue), [subscribe]);
  return value;
}

type FieldSubscriptions<T> = { [K in keyof T]-?: (notify: () => void) => Unsubscribe };

export function useBoundFields<T extends object>(state: StateProxy<T>): Readonly<StateProxy<T>> {
  const read = useCallback(() => ({ ...state }), [state]);
  const subscribe = useCallback<StateSubscription<StateProxy<T>>>((setValue) => {
    const publish = (): void => setValue(read());
    // Fixed-shape, top-level fields only; array mutations need separate update bindings.
    const stops = (Object.keys(state) as (keyof T)[]).map((key) =>
      (binder(state) as FieldSubscriptions<T>)[key](publish)
    );
    return () => { for (const stop of stops) stop(); };
  }, [read, state]);
  return useBoundState(read, subscribe);
}
