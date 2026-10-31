import type { ActionRecord, AdministrationData, AuthoringDraft, AuthoringKind, AuthorityRecord, ExplorePlaceDetailData, ExplorePlacesData, LibraryData, LogisticsVesselData, PageResponse, ProductionData, ProductionJob, ProductionOperation, PublicAccountRecord, ResourceReaderData, RoutePlanRecord, ServerRecord } from '@fctp/client-sdk';

export interface AccountListResponse {
  accounts: PublicAccountRecord[];
}

export interface AccountLoginResponse {
  account?: PublicAccountRecord;
  status: string;
  reason?: string;
  clientToken?: string;
}

export interface AccountLogoutResponse {
  account: PublicAccountRecord;
}

export interface ServerListResponse {
  servers: ServerRecord[];
  authorities: AuthorityRecord[];
}

export interface ClientSession {
  accountId: string;
  handle: string;
  clientToken: string;
}

const CLIENT_SESSIONS_KEY = 'fctp.client-sessions';
const CLIENT_SESSIONS_EVENT = 'fctp-client-sessions-changed';

class ApplicationRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function isClientSession(value: unknown): value is ClientSession {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.accountId === 'string' && Boolean(record.accountId)
    && typeof record.handle === 'string' && Boolean(record.handle)
    && typeof record.clientToken === 'string' && Boolean(record.clientToken);
}

function readSessions(): ClientSession[] {
  const raw = globalThis.localStorage.getItem(CLIENT_SESSIONS_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  return Array.isArray(parsed) ? parsed.filter(isClientSession) : [];
}

function writeSessions(sessions: readonly ClientSession[]): void {
  globalThis.localStorage.setItem(CLIENT_SESSIONS_KEY, JSON.stringify(sessions));
}

function sessionFor(accountId: string): ClientSession | undefined {
  return readSessions().find((session) => session.accountId === accountId);
}

function saveSession(session: ClientSession): void {
  writeSessions([...readSessions().filter((candidate) => candidate.accountId !== session.accountId), session]);
}

function removeSession(accountId: string, clientToken: string): void {
  writeSessions(readSessions().filter((session) => !(session.accountId === accountId && session.clientToken === clientToken)));
}

function notifySessionExpired(): void {
  globalThis.dispatchEvent(new Event(CLIENT_SESSIONS_EVENT));
}

function decodedPathAccountId(pathname: string): string | undefined {
  const match = /^\/api\/accounts\/([^/]+)\/logout$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
}

function bodyAccountId(init?: RequestInit): string | undefined {
  if (typeof init?.body !== 'string') return undefined;
  let body: unknown;
  try {
    body = JSON.parse(init.body) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const accountId = (body as Record<string, unknown>).accountId;
  return typeof accountId === 'string' && accountId ? accountId : undefined;
}

function requestAccountId(path: string, init?: RequestInit): string | undefined {
  const url = new URL(path, 'http://client.invalid');
  const queryAccountId = url.searchParams.get('accountId');
  if (queryAccountId) return queryAccountId;
  return bodyAccountId(init) ?? decodedPathAccountId(url.pathname);
}

function errorMessage(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
    if (typeof record.reason === 'string') return record.reason;
  }
  return `Application request failed: HTTP ${status}`;
}

function redact(message: string, secrets: readonly (string | undefined)[]): string {
  let redacted = message;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  return redacted;
}

interface RequestOptions {
  session?: ClientSession;
  accountId?: string;
  clearOnUnauthorized?: boolean;
  secrets?: readonly (string | undefined)[];
}

async function request<T>(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<T> {
  const accountId = options.accountId ?? requestAccountId(path, init);
  const session = options.session ?? (accountId === undefined ? undefined : sessionFor(accountId));
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(session === undefined ? {} : { Authorization: `Bearer ${session.clientToken}` }),
      ...(init?.headers ?? {})
    }
  });
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) as unknown : undefined;
  if (!response.ok) {
    if (response.status === 401 && session !== undefined && options.clearOnUnauthorized !== false) {
      removeSession(session.accountId, session.clientToken);
      notifySessionExpired();
    }
    throw new ApplicationRequestError(redact(errorMessage(body, response.status), [session?.clientToken, ...(options.secrets ?? [])]), response.status);
  }
  return body as T;
}

export async function readAccounts(): Promise<AccountListResponse> {
  const sessions = readSessions();
  const accounts: PublicAccountRecord[] = [];
  for (const session of sessions) {
    try {
      const page = await request<AccountListResponse>('/api/accounts', undefined, { session });
      const account = page.accounts.find((candidate) => candidate.id === session.accountId && candidate.handle === session.handle);
      if (account) accounts.push(account);
      else removeSession(session.accountId, session.clientToken);
    } catch (error) {
      if (error instanceof ApplicationRequestError && error.status === 401) continue;
      throw error;
    }
  }
  return { accounts };
}

export async function loginAccount(input: { handle: string; password: string }): Promise<AccountLoginResponse> {
  const result = await request<AccountLoginResponse>('/api/accounts/login', {
    method: 'POST',
    body: JSON.stringify({ handle: input.handle, password: input.password })
  }, { secrets: [input.password] });
  if (result.status === 'signed-in') {
    if (!result.account || !result.account.id || !result.clientToken) throw new Error('Application login did not return a client session');
    saveSession({ accountId: result.account.id, handle: result.account.handle, clientToken: result.clientToken });
  }
  return result;
}

export async function logoutAccount(accountId: string): Promise<AccountLogoutResponse> {
  const session = sessionFor(accountId);
  const result = await request<AccountLogoutResponse>(`/api/accounts/${encodeURIComponent(accountId)}/logout`, { method: 'POST' }, {
    ...(session === undefined ? { accountId } : { session }),
    clearOnUnauthorized: false
  });
  if (session !== undefined) removeSession(accountId, session.clientToken);
  return result;
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
