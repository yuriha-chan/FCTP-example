import type { ActionRecord, AdministrationData, AuthoringDraft, AuthoringKind, AuthorityRecord, ExplorePlaceDetailData, ExplorePlacesData, LibraryData, LogisticsVesselData, PageResponse, ProductionData, ProductionJob, ProductionOperation, PublicAccountRecord, ResourceReaderData, RoutePlanRecord, ServerRecord } from '@fctp/client-sdk';

export interface AccountListResponse {
  accounts: PublicAccountRecord[];
}

export interface AccountLoginResponse {
  account?: PublicAccountRecord;
  status: string;
  reason?: string;
}

export interface AccountLogoutResponse {
  account: PublicAccountRecord;
}

export interface ServerListResponse {
  servers: ServerRecord[];
  authorities: AuthorityRecord[];
}

function errorMessage(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
    if (typeof record.reason === 'string') return record.reason;
  }
  return `Application request failed: HTTP ${status}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers ?? {})
    }
  });
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) as unknown : undefined;
  if (!response.ok) throw new Error(errorMessage(body, response.status));
  return body as T;
}

export function readAccounts(): Promise<AccountListResponse> {
  return request('/api/accounts');
}

export function loginAccount(input: { handle: string; password: string; homeOrigin?: string }): Promise<AccountLoginResponse> {
  return request('/api/accounts/login', {
    method: 'POST',
    body: JSON.stringify({ handle: input.handle, password: input.password, ...(input.homeOrigin ? { homeOrigin: input.homeOrigin } : {}) })
  });
}

export function logoutAccount(accountId: string): Promise<AccountLogoutResponse> {
  return request(`/api/accounts/${encodeURIComponent(accountId)}/logout`, { method: 'POST' });
}

export function readServers(): Promise<ServerListResponse> {
  return request('/api/servers');
}

export function discoverServer(input: { origin?: string; handle?: string }): Promise<ServerListResponse> {
  return request('/api/servers', {
    method: 'POST',
    body: JSON.stringify({ ...(input.origin ? { origin: input.origin } : {}), ...(input.handle ? { handle: input.handle } : {}) })
  });
}

export type ActivityListResponse = PageResponse<{ actions: ActionRecord[] }>;
export type ActivityDetailResponse = PageResponse<{ action: ActionRecord }>;

export function readActivity(accountId: string): Promise<ActivityListResponse> {
  return request(`/api/activity?accountId=${encodeURIComponent(accountId)}`);
}

export function readAction(accountId: string, actionId: string): Promise<ActivityDetailResponse> {
  return request(`/api/activity/${encodeURIComponent(actionId)}?accountId=${encodeURIComponent(accountId)}`);
}

export function refreshAction(accountId: string, actionId: string): Promise<ActivityDetailResponse> {
  return request(`/api/activity/${encodeURIComponent(actionId)}/refresh`, {
    method: 'POST',
    body: JSON.stringify({ accountId })
  });
}

export type ExplorePlacesResponse = PageResponse<ExplorePlacesData>;
export type ExplorePlaceDetailResponse = PageResponse<ExplorePlaceDetailData>;
export type RoutePlanResponse = PageResponse<{ plan: RoutePlanRecord }>;
export type ResourceReaderResponse = PageResponse<ResourceReaderData>;

function optionalQuery(accountId?: string, vesselId?: string): string {
  const params = new URLSearchParams();
  if (accountId) params.set('accountId', accountId);
  if (vesselId) params.set('vesselId', vesselId);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function readExplorePlaces(accountId?: string, vesselId?: string): Promise<ExplorePlacesResponse> {
  return request(`/api/explore/places${optionalQuery(accountId, vesselId)}`);
}

export function refreshExplorePlaces(input: { accountId?: string; vesselId?: string }): Promise<ExplorePlacesResponse> {
  return request('/api/explore/refresh', {
    method: 'POST',
    body: JSON.stringify({ ...(input.accountId ? { accountId: input.accountId } : {}), ...(input.vesselId ? { vesselId: input.vesselId } : {}) })
  });
}

export function readExplorePlace(placeId: string, accountId?: string, vesselId?: string): Promise<ExplorePlaceDetailResponse> {
  return request(`/api/explore/places/${encodeURIComponent(placeId)}${optionalQuery(accountId, vesselId)}`);
}

export function refreshExplorePlace(placeId: string, input: { accountId?: string; vesselId?: string }): Promise<ExplorePlaceDetailResponse> {
  return request(`/api/explore/places/${encodeURIComponent(placeId)}/refresh`, {
    method: 'POST',
    body: JSON.stringify({ ...(input.accountId ? { accountId: input.accountId } : {}), ...(input.vesselId ? { vesselId: input.vesselId } : {}) })
  });
}

export function createRoutePlan(input: { accountId: string; from: string; to: string }): Promise<RoutePlanResponse> {
  return request('/api/explore/routes', { method: 'POST', body: JSON.stringify(input) });
}

export function readRoutePlan(routeId: string, accountId: string): Promise<RoutePlanResponse> {
  return request(`/api/explore/routes/${encodeURIComponent(routeId)}?accountId=${encodeURIComponent(accountId)}`);
}

export function readResourceReader(resourceId: string, input: { accountId?: string; authorityId?: string } = {}): Promise<ResourceReaderResponse> {
  const params = new URLSearchParams();
  if (input.accountId) params.set('accountId', input.accountId);
  if (input.authorityId) params.set('authorityId', input.authorityId);
  const query = params.toString();
  return request(`/api/resources/${encodeURIComponent(resourceId)}${query ? `?${query}` : ''}`);
}

export function refreshResourceReader(resourceId: string, input: { accountId?: string; authorityId?: string } = {}): Promise<ResourceReaderResponse> {
  return request(`/api/resources/${encodeURIComponent(resourceId)}/refresh`, {
    method: 'POST',
    body: JSON.stringify({ ...(input.accountId ? { accountId: input.accountId } : {}), ...(input.authorityId ? { authorityId: input.authorityId } : {}) })
  });
}


export type LibraryResponse = PageResponse<LibraryData>;
export interface DraftResponse { draft: AuthoringDraft }
export interface DraftPublicationResponse { action: ActionRecord; draft: AuthoringDraft }

export function readLibrary(accountId: string): Promise<LibraryResponse> {
  return request(`/api/library?accountId=${encodeURIComponent(accountId)}`);
}

export function refreshLibrary(accountId: string): Promise<LibraryResponse> {
  return request('/api/library/refresh', { method: 'POST', body: JSON.stringify({ accountId }) });
}

export function createDraft(input: { accountId: string; kind: AuthoringKind; fields: Record<string, unknown> }): Promise<DraftResponse> {
  return request('/api/drafts', { method: 'POST', body: JSON.stringify(input) });
}

export function readDraft(draftId: string, accountId: string): Promise<DraftResponse> {
  return request(`/api/drafts/${encodeURIComponent(draftId)}?accountId=${encodeURIComponent(accountId)}`);
}

export function saveDraft(draftId: string, input: { accountId: string; fields: Record<string, unknown> }): Promise<DraftResponse> {
  return request(`/api/drafts/${encodeURIComponent(draftId)}`, { method: 'POST', body: JSON.stringify(input) });
}

export function publishDraft(draftId: string, accountId: string): Promise<DraftPublicationResponse> {
  return request(`/api/drafts/${encodeURIComponent(draftId)}/publish`, { method: 'POST', body: JSON.stringify({ accountId }) });
}


export type LogisticsVesselResponse = PageResponse<LogisticsVesselData>;
export type ProductionResponse = PageResponse<ProductionData>;
export type ProductionOperationResponse = PageResponse<{ operation: ProductionOperation }>;
export type ProductionJobResponse = PageResponse<{ job: ProductionJob }>;
export interface ActionResponse { action: ActionRecord }

export function readLogisticsVessel(accountId: string, vesselId: string): Promise<LogisticsVesselResponse> {
  return request(`/api/logistics/vessels/${encodeURIComponent(vesselId)}?accountId=${encodeURIComponent(accountId)}`);
}

export function refreshLogisticsVessel(accountId: string, vesselId: string): Promise<LogisticsVesselResponse> {
  return request(`/api/logistics/vessels/${encodeURIComponent(vesselId)}/refresh`, {
    method: 'POST',
    body: JSON.stringify({ accountId })
  });
}

export function submitLogisticsTraverse(input: { accountId: string; vesselId: string; routePlanId: string }): Promise<ActionResponse> {
  return request(`/api/logistics/vessels/${encodeURIComponent(input.vesselId)}/traverse`, {
    method: 'POST',
    body: JSON.stringify({ accountId: input.accountId, routePlanId: input.routePlanId })
  });
}

export function submitLogisticsEntry(input: { accountId: string; vesselId: string; territoryId: string; portId: string; routeId: string }): Promise<ActionResponse> {
  return request(`/api/logistics/vessels/${encodeURIComponent(input.vesselId)}/entry`, {
    method: 'POST',
    body: JSON.stringify({ accountId: input.accountId, territoryId: input.territoryId, portId: input.portId, routeId: input.routeId })
  });
}

export function submitLogisticsDeparture(input: { accountId: string; vesselId: string; territoryId: string; portId: string; routeId: string }): Promise<ActionResponse> {
  return request(`/api/logistics/vessels/${encodeURIComponent(input.vesselId)}/departure`, {
    method: 'POST',
    body: JSON.stringify({ accountId: input.accountId, territoryId: input.territoryId, portId: input.portId, routeId: input.routeId })
  });
}

export function submitLogisticsAdoption(input: { accountId: string; vesselId: string; adoption: boolean }): Promise<ActionResponse> {
  return request(`/api/logistics/vessels/${encodeURIComponent(input.vesselId)}/adoption`, {
    method: 'POST',
    body: JSON.stringify({ accountId: input.accountId, adoption: input.adoption })
  });
}

export function readProduction(accountId: string, vesselId: string): Promise<ProductionResponse> {
  return request(`/api/production${optionalQuery(accountId, vesselId)}`);
}

export function refreshProduction(accountId: string, vesselId: string): Promise<ProductionResponse> {
  return request('/api/production/refresh', { method: 'POST', body: JSON.stringify({ accountId, vesselId }) });
}

export function readProductionOperation(operationId: string, accountId: string, vesselId: string): Promise<ProductionOperationResponse> {
  return request(`/api/production/operations/${encodeURIComponent(operationId)}${optionalQuery(accountId, vesselId)}`);
}

export function executeProductionOperation(input: { operationId: string; accountId: string; vesselId: string; inputs: Record<string, unknown> }): Promise<ActionResponse> {
  return request(`/api/production/operations/${encodeURIComponent(input.operationId)}/execute`, {
    method: 'POST',
    body: JSON.stringify({ accountId: input.accountId, vesselId: input.vesselId, inputs: input.inputs })
  });
}

export function readProductionJob(jobId: string, accountId: string, vesselId: string): Promise<ProductionJobResponse> {
  return request(`/api/production/jobs/${encodeURIComponent(jobId)}${optionalQuery(accountId, vesselId)}`);
}

export function refreshProductionJob(jobId: string, accountId: string, vesselId: string): Promise<ProductionJobResponse> {
  return request(`/api/production/jobs/${encodeURIComponent(jobId)}/refresh`, {
    method: 'POST',
    body: JSON.stringify({ accountId, vesselId })
  });
}


export type AdministrationResponse = PageResponse<AdministrationData>;

export function readAdministration(accountId: string): Promise<AdministrationResponse> {
  return request(`/api/administration?accountId=${encodeURIComponent(accountId)}`);
}

export function refreshAdministration(accountId: string, authorityId: string): Promise<AdministrationResponse> {
  return request('/api/administration/refresh', { method: 'POST', body: JSON.stringify({ accountId, authorityId }) });
}

export function applyAdministrationControl(accountId: string, authorityId: string, control: string, inputs: Record<string, unknown>): Promise<ActionResponse> {
  return request('/api/administration/controls', { method: 'POST', body: JSON.stringify({ accountId, authorityId, control, inputs }) });
}

export function decideAdministrationEntry(accountId: string, authorityId: string, requestId: string, decision: 'approve' | 'reject', reason?: string): Promise<ActionResponse> {
  return request(`/api/administration/entry-requests/${encodeURIComponent(requestId)}/${decision}`, {
    method: 'POST',
    body: JSON.stringify({ accountId, authorityId, ...(reason === undefined ? {} : { reason }) })
  });
}
