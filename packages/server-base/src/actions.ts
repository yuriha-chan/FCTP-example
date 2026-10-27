import type { URI } from '@fctp/protocol';

export interface LocalAction {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  request?: { method: 'GET' | 'POST'; href: string; body?: Record<string, unknown> };
  effect: string;
}

export interface LocalActionDiscovery {
  kind: 'registry' | 'policy' | 'simulation';
  actor: URI;
  player: URI;
  vessel: URI;
  observedAt: string;
  state: Record<string, unknown>;
  actions: LocalAction[];
  notes: string[];
}
