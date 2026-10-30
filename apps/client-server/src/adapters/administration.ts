import type { AuthorityRole } from '@fctp/client-sdk';

export type AdministrationTargetKind = 'policy' | 'simulation' | 'registry' | 'home';

export interface AdministrationTarget {
  authorityId: string;
  server: string;
  roles: AuthorityRole[];
  name?: string;
}

export interface AdministrationTargetRead {
  source: string;
  value: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function administrationTargetKind(roles: readonly AuthorityRole[]): AdministrationTargetKind {
  if (roles.includes('home')) return 'home';
  if (roles.includes('registry')) return 'registry';
  return 'policy';
}

export function administrationControlPath(kind: AdministrationTargetKind, control: string): string | undefined {
  if (kind === 'policy') {
    if (control === 'policy') return '/local/admin/policy';
    if (control === 'admission') return '/local/admin/admission';
  }
  if (kind === 'simulation') {
    if (control === 'admission') return '/local/admin/admission';
    if (control === 'facilities') return '/local/admin/facilities';
    if (control === 'tick') return '/local/admin/tick';
  }
  if (kind === 'registry' && control === 'adoption') return '/local/registry/adoption';
  if (kind === 'home' && control === 'availability') return '/local/home/accounts/availability';
  return undefined;
}

async function readJson(fetcher: typeof fetch, source: string, token: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetcher(source, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    cache: 'no-store',
    signal
  });
  if (!response.ok) throw new Error(`Administration source unavailable: HTTP ${response.status}`);
  return response.json();
}

export async function readAdministrationTarget(
  fetcher: typeof fetch,
  target: AdministrationTarget,
  token: string,
  signal: AbortSignal
): Promise<AdministrationTargetRead> {
  const kind = administrationTargetKind(target.roles);
  if (kind === 'home') {
    const source = new URL('/local/home/accounts', target.authorityId).href;
    const payload = record(await readJson(fetcher, source, token, signal));
    return {
      source,
      value: { authorityId: target.authorityId, roles: target.roles, kind, accounts: Array.isArray(payload.accounts) ? payload.accounts : [] }
    };
  }
  if (kind === 'registry') {
    const source = new URL('/local/registry/fleet', target.authorityId).href;
    const payload = record(await readJson(fetcher, source, token, signal));
    return { source, value: { authorityId: target.authorityId, roles: target.roles, kind, fleet: payload } };
  }
  const stateSource = new URL('/local/state', target.authorityId).href;
  const requestsSource = new URL('/local/admin/entry-requests', target.authorityId).href;
  const [statePayload, requestsPayload] = await Promise.all([
    readJson(fetcher, stateSource, token, signal),
    readJson(fetcher, requestsSource, token, signal)
  ]);
  const state = record(statePayload);
  const simulation = isRecord(state.simulation);
  return {
    source: requestsSource,
    value: {
      authorityId: target.authorityId,
      roles: target.roles,
      kind: simulation ? 'simulation' : 'policy',
      state: simulation ? state : record(state.state),
      admission: state.admission ?? null,
      decisions: state.decisions ?? null,
      simulation: simulation ? state.simulation : null,
      requests: Array.isArray(record(requestsPayload).requests) ? record(requestsPayload).requests : []
    }
  };
}

export async function submitAdministrationPost(
  fetcher: typeof fetch,
  authorityId: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
  signal: AbortSignal
): Promise<{ source: string; value: unknown }> {
  const source = new URL(path, authorityId).href;
  const response = await fetcher(source, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal
  });
  if (!response.ok) throw new Error(`Administration action failed: HTTP ${response.status}`);
  const text = await response.text();
  return { source, value: text ? JSON.parse(text) as unknown : undefined };
}
