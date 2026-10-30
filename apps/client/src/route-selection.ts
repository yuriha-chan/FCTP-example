import type { RoutePlanRecord } from '@fctp/client-sdk';

export interface ExploreRouteSelection {
  accountId: string;
  plan: RoutePlanRecord;
}

let selection: ExploreRouteSelection | undefined;
const listeners = new Set<() => void>();

const notify = (): void => { for (const listener of listeners) listener(); };

export function setExploreRouteSelection(next: ExploreRouteSelection): void {
  selection = next;
  notify();
}

export function clearExploreRouteSelection(): void {
  if (selection === undefined) return;
  selection = undefined;
  notify();
}

export function getExploreRouteSelection(): ExploreRouteSelection | undefined {
  return selection;
}

export function onExploreRouteSelectionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
