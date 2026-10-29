import { validateModel, type URI, type Vessel } from '@fctp/protocol';
import type { ActionEvidence } from '@fctp/client-sdk';

export interface RegistryStateView {
  authorityId: string;
  source: string;
  vesselId: string;
  payload: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Registry request failed: HTTP ${response.status}`);
  return response.json();
}

export function registryStateSource(registryId: string, vesselId: string): string {
  const url = new URL('/local/registry/state', registryId);
  url.searchParams.set('vessel', vesselId);
  return url.href;
}

export async function readVesselDocument(fetcher: typeof fetch, vesselId: string, signal: AbortSignal): Promise<Vessel> {
  const response = await fetcher(vesselId, {
    method: 'GET',
    headers: { Accept: 'application/ld+json, application/json' },
    cache: 'no-store',
    signal
  });
  if (!response.ok) throw new Error(`Vessel metadata unavailable: HTTP ${response.status}`);
  const checked = validateModel<Vessel>(await response.json(), 'Vessel');
  if (!checked.success || checked.data.id !== vesselId) throw new Error('Vessel metadata is invalid');
  return checked.data;
}

export async function readRegistryState(fetcher: typeof fetch, registryId: string, vesselId: string, nativeToken: string, signal: AbortSignal): Promise<RegistryStateView> {
  const source = registryStateSource(registryId, vesselId);
  const response = await fetcher(source, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${nativeToken}` },
    cache: 'no-store',
    signal
  });
  const payload = await responseJson(response);
  if (!isRecord(payload)) throw new Error('Registry state response is malformed');
  const actionsUrl = new URL('/local/registry/actions', registryId);
  actionsUrl.searchParams.set('vessel', vesselId);
  const discovery = await responseJson(await fetcher(actionsUrl.href, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${nativeToken}` },
    cache: 'no-store',
    signal
  }));
  if (!isRecord(discovery) || !isRecord(discovery.state)) throw new Error('Registry action discovery is malformed');
  return { authorityId: registryId, source, vesselId, payload: { ...payload, location: discovery.state.location, pendingRequests: discovery.state.pendingRequests } };
}

export function registrySummary(view: RegistryStateView): Record<string, unknown> {
  const payload = view.payload;
  const pendingRequests = Array.isArray(payload.pendingRequests) ? payload.pendingRequests : [];
  return {
    authorityId: view.authorityId,
    cargo: payload.cargo ?? null,
    adoption: payload.adoption === true,
    location: payload.location ?? null,
    pendingRequests,
    events: Array.isArray(payload.events) ? payload.events : [],
    requests: isRecord(payload.requests) ? payload.requests : {}
  };
}

export async function submitRegistryAction(
  fetcher: typeof fetch,
  input: { registryId: string; path: string; body: Record<string, unknown>; nativeToken: string; signal: AbortSignal }
): Promise<Record<string, unknown>> {
  const response = await fetcher(new URL(input.path, input.registryId).href, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${input.nativeToken}` },
    body: JSON.stringify(input.body),
    cache: 'no-store',
    signal: input.signal
  });
  if (!response.ok) throw new Error(`Registry action failed: HTTP ${response.status}`);
  const text = await response.text();
  if (!text) return {};
  const payload: unknown = JSON.parse(text);
  return isRecord(payload) ? payload : {};
}

export function reconcileRegistryRequest(
  view: RegistryStateView,
  requestId: string,
  observedAt: string
): { status: 'pending' | 'completed' | 'failed' | 'unverified'; evidence: ActionEvidence[]; error?: string } {
  const events = Array.isArray(view.payload.events) ? view.payload.events : [];
  for (const raw of events) {
    if (!isRecord(raw) || typeof raw.type !== 'string') continue;
    const matches = raw.request === requestId || raw.entryRequest === requestId;
    if (!matches) continue;
    if (raw.type === 'BerthingEvent' || raw.type === 'DepartureEvent' || raw.type === 'ExitEvent') {
      return { status: 'completed', evidence: [{ source: view.source, observedAt, changes: { event: raw } }] };
    }
    if (raw.type === 'EntryRejected') {
      return { status: 'failed', evidence: [{ source: view.source, observedAt, changes: { event: raw } }], error: typeof raw.reason === 'string' ? raw.reason : 'entry-rejected' };
    }
  }
  const requests = isRecord(view.payload.requests) ? view.payload.requests : {};
  if (!Object.hasOwn(requests, requestId)) return { status: 'unverified', evidence: [], error: 'Registry request is not retained' };
  return { status: 'pending', evidence: [] };
}

export function isOwnedVessel(vessel: { possessor: string }, actorId: string | undefined): boolean {
  return actorId !== undefined && vessel.possessor === actorId;
}

export function registryIdOf(vessel: Vessel): URI {
  return vessel.registry;
}
