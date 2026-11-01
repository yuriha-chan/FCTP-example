import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActionDescriptor, ActionRecord, PageResponse } from '@fctp/client-sdk';
import { createAccountService, type LoginInput } from './accounts.js';
import { createActionService, type ActionHandler, type ActionService } from './actions.js';
import { createAdministrationActionHandlers, createAdministrationService, AdministrationRequestError, type AdministrationService } from './administration.js';
import { createAuthoringPublicationHandler, createAuthoringService, AuthoringRequestError } from './authoring.js';
import { createDiscoveryService, type DiscoveryInput } from './discovery.js';
import { UpstreamError } from './errors.js';
import { createExploreService, ExploreRequestError } from './explore.js';
import { embedIdentities } from './identity-embedding.js';
import { createIdentityService, type IdentityService } from './identities.js';
import { createLogisticsService, createWorkflowActionHandlers, LogisticsRequestError } from './logistics.js';
import { createObservationService, type ObservationService } from './observations.js';
import { digestClientToken } from './sessions.js';
import { openClientState, type ClientApplicationState } from './store.js';

export interface AdministratorBinding {
  readonly accountId: string;
  readonly authorityActorIds: readonly string[];
  readonly credentialSource: string;
}

export interface ClientApplication {
  readonly state: ClientApplicationState;
  readonly seedServers: readonly string[];
  readonly fetch: typeof fetch;
  readonly observations: ObservationService;
  readonly identities: IdentityService;
  readonly actions: ActionService;
  readonly authoring: ReturnType<typeof createAuthoringService>;
  readonly administration: AdministrationService;
  resolveAdministratorCredential(accountId: string, targetActorId: string): Promise<string>;
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
  close(): Promise<void>;
}

export interface CreateClientApplicationOptions {
  storeFile: string;
  seedServers?: readonly string[];
  fetch?: typeof fetch;
  administratorBindings?: readonly AdministratorBinding[];
  administratorCredentials?: Readonly<Record<string, string>>;
  observationTimeoutMs?: number;
  actionTimeoutMs?: number;
  actionHandlers?: Readonly<Record<string, ActionHandler>>;
}

class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('Request body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function loginInput(body: Record<string, unknown>): LoginInput {
  const handle = typeof body.handle === 'string' ? body.handle.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!handle || !password) throw new ApiError(400, 'handle-and-password-required');
  if (Object.hasOwn(body, 'homeOrigin')) throw new ApiError(400, 'home-origin-not-supported');
  return { handle, password };
}

function discoveryInput(body: Record<string, unknown>): DiscoveryInput {
  const origin = body.origin;
  const handle = body.handle;
  if (origin !== undefined && typeof origin !== 'string') throw new ApiError(400, 'invalid-origin');
  if (handle !== undefined && typeof handle !== 'string') throw new ApiError(400, 'invalid-handle');
  return {
    ...(typeof origin === 'string' ? { origin } : {}),
    ...(typeof handle === 'string' ? { handle } : {})
  };
}

function accountIdFromLogoutPath(pathname: string): string | undefined {
  const match = /^\/api\/accounts\/([^/]+)\/logout$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
}

function activityActionPath(pathname: string): { actionId: string; refresh: boolean } | undefined {
  const refresh = /^\/api\/activity\/([^/]+)\/refresh$/.exec(pathname);
  if (refresh) {
    try {
      return { actionId: decodeURIComponent(refresh[1]!), refresh: true };
    } catch {
      throw new ApiError(404, 'action-not-found');
    }
  }
  const detail = /^\/api\/activity\/([^/]+)$/.exec(pathname);
  if (!detail) return undefined;
  try {
    return { actionId: decodeURIComponent(detail[1]!), refresh: false };
  } catch {
    throw new ApiError(404, 'action-not-found');
  }
}

function queryAccountId(url: URL): string | undefined {
  const values = url.searchParams.getAll('accountId').map((value) => value.trim()).filter((value) => value.length > 0);
  if (values.length === 0) return undefined;
  if (values.length > 1) throw new ApiError(400, 'conflicting-account-id');
  return values[0];
}

function bodyAccountId(body: Record<string, unknown>): string | undefined {
  const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
  return accountId || undefined;
}

function accountScope(url: URL, body: Record<string, unknown> | undefined, required: boolean): string | undefined {
  const query = queryAccountId(url);
  const fromBody = body === undefined ? undefined : bodyAccountId(body);
  if (query !== undefined && fromBody !== undefined && query !== fromBody) throw new ApiError(400, 'conflicting-account-id');
  const accountId = query ?? fromBody;
  if (accountId === undefined && required) throw new ApiError(400, 'account-id-required');
  return accountId;
}

function optionalQuery(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim() ?? '';
  return value ? value : undefined;
}

function optionalBody(body: Record<string, unknown>, name: string): string | undefined {
  const value = typeof body[name] === 'string' ? body[name].trim() : '';
  return value ? value : undefined;
}

function explorePlacePath(pathname: string): { placeId: string; refresh: boolean } | undefined {
  const refresh = /^\/api\/explore\/places\/([^/]+)\/refresh$/.exec(pathname);
  if (refresh) {
    try {
      return { placeId: decodeURIComponent(refresh[1]!), refresh: true };
    } catch {
      throw new ApiError(404, 'place-not-found');
    }
  }
  const detail = /^\/api\/explore\/places\/([^/]+)$/.exec(pathname);
  if (!detail) return undefined;
  try {
    return { placeId: decodeURIComponent(detail[1]!), refresh: false };
  } catch {
    throw new ApiError(404, 'place-not-found');
  }
}

function exploreRoutePath(pathname: string): string | undefined {
  const match = /^\/api\/explore\/routes\/([^/]+)$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    throw new ApiError(404, 'route-not-found');
  }
}

function resourcePath(pathname: string): { resourceId: string; refresh: boolean } | undefined {
  const refresh = /^\/api\/resources\/([^/]+)\/refresh$/.exec(pathname);
  if (refresh) {
    try {
      return { resourceId: decodeURIComponent(refresh[1]!), refresh: true };
    } catch {
      throw new ApiError(404, 'resource-not-found');
    }
  }
  const read = /^\/api\/resources\/([^/]+)$/.exec(pathname);
  if (!read) return undefined;
  try {
    return { resourceId: decodeURIComponent(read[1]!), refresh: false };
  } catch {
    throw new ApiError(404, 'resource-not-found');
  }
}

function draftPath(pathname: string): { draftId: string; publish: boolean } | undefined {
  const publish = /^\/api\/drafts\/([^/]+)\/publish$/.exec(pathname);
  if (publish) {
    try {
      return { draftId: decodeURIComponent(publish[1]!), publish: true };
    } catch {
      throw new ApiError(404, 'draft-not-found');
    }
  }
  const detail = /^\/api\/drafts\/([^/]+)$/.exec(pathname);
  if (!detail) return undefined;
  try {
    return { draftId: decodeURIComponent(detail[1]!), publish: false };
  } catch {
    throw new ApiError(404, 'draft-not-found');
  }
}

function bodyKind(body: Record<string, unknown>): 'asset' | 'variety' {
  const kind = body.kind;
  if (kind !== 'asset' && kind !== 'variety') throw new ApiError(400, 'invalid-draft-kind');
  return kind;
}

function logisticsVesselPath(pathname: string): { vesselId: string; action?: 'refresh' | 'entry' | 'departure' | 'adoption' | 'traverse' } | undefined {
  const match = /^\/api\/logistics\/vessels\/([^/]+)(?:\/(refresh|entry|departure|adoption|traverse))?$/.exec(pathname);
  if (!match) return undefined;
  try {
    const vesselId = decodeURIComponent(match[1]!);
    const action = match[2] as 'refresh' | 'entry' | 'departure' | 'adoption' | 'traverse' | undefined;
    return { vesselId, ...(action === undefined ? {} : { action }) };
  } catch {
    throw new ApiError(404, 'vessel-not-found');
  }
}

function productionOperationPath(pathname: string): { operationId: string; execute: boolean } | undefined {
  const execute = /^\/api\/production\/operations\/([^/]+)\/execute$/.exec(pathname);
  if (execute) {
    try {
      return { operationId: decodeURIComponent(execute[1]!), execute: true };
    } catch {
      throw new ApiError(404, 'operation-not-found');
    }
  }
  const detail = /^\/api\/production\/operations\/([^/]+)$/.exec(pathname);
  if (!detail) return undefined;
  try {
    return { operationId: decodeURIComponent(detail[1]!), execute: false };
  } catch {
    throw new ApiError(404, 'operation-not-found');
  }
}

function productionJobPath(pathname: string): { jobId: string; refresh: boolean } | undefined {
  const refresh = /^\/api\/production\/jobs\/([^/]+)\/refresh$/.exec(pathname);
  if (refresh) {
    try {
      return { jobId: decodeURIComponent(refresh[1]!), refresh: true };
    } catch {
      throw new ApiError(404, 'job-not-found');
    }
  }
  const detail = /^\/api\/production\/jobs\/([^/]+)$/.exec(pathname);
  if (!detail) return undefined;
  try {
    return { jobId: decodeURIComponent(detail[1]!), refresh: false };
  } catch {
    throw new ApiError(404, 'job-not-found');
  }
}

function administrationDecisionPath(pathname: string): { requestId: string; decision: 'approve' | 'reject' } | undefined {
  const match = /^\/api\/administration\/entry-requests\/([^/]+)\/(approve|reject)$/.exec(pathname);
  if (!match) return undefined;
  try {
    return { requestId: decodeURIComponent(match[1]!), decision: match[2] as 'approve' | 'reject' };
  } catch {
    throw new ApiError(404, 'request-not-found');
  }
}

function queryVesselId(url: URL): string {
  const vesselId = url.searchParams.get('vesselId')?.trim() ?? '';
  if (!vesselId) throw new ApiError(400, 'vessel-id-required');
  return vesselId;
}

function bodyVesselId(body: Record<string, unknown>): string {
  const vesselId = typeof body.vesselId === 'string' ? body.vesselId.trim() : '';
  if (!vesselId) throw new ApiError(400, 'vessel-id-required');
  return vesselId;
}

interface AuthenticatedClient {
  accountId: string;
  digest: string;
}

async function authorize(
  state: ClientApplicationState,
  request: IncomingMessage,
  expectedAccountId: string | undefined,
  required: boolean
): Promise<AuthenticatedClient | undefined> {
  const header = request.headers.authorization;
  if (header === undefined || header.trim() === '') {
    if (required || expectedAccountId !== undefined) throw new ApiError(401, 'authentication-required');
    return undefined;
  }
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  if (!match) throw new ApiError(401, 'invalid-client-token');
  const digest = digestClientToken(match[1]!);
  const authenticated = await state.read((current) => {
    const session = current.clientSessions[digest];
    if (!session) return undefined;
    const account = current.accounts[session.accountId];
    if (!account || account.login.status !== 'signed-in') return undefined;
    return { accountId: session.accountId, digest };
  });
  if (!authenticated) throw new ApiError(401, 'invalid-client-token');
  if (expectedAccountId !== undefined && authenticated.accountId !== expectedAccountId) {
    throw new ApiError(403, 'account-scope-forbidden');
  }
  return authenticated;
}

async function requireClient(
  state: ClientApplicationState,
  request: IncomingMessage,
  expectedAccountId: string | undefined
): Promise<AuthenticatedClient> {
  const authenticated = await authorize(state, request, expectedAccountId, true);
  if (!authenticated) throw new ApiError(401, 'authentication-required');
  return authenticated;
}

async function requireAccount(state: ClientApplicationState, accountId: string): Promise<void> {
  const account = await state.read((current) => current.accounts[accountId]);
  if (!account) throw new ApiError(404, 'account-not-found');
}

async function activityPage<T extends { actions: ActionRecord[] } | { action: ActionRecord }>(
  state: ClientApplicationState,
  context: { accountId: string; targetId?: string },
  data: T,
  actions: ActionDescriptor[]
): Promise<PageResponse<T>> {
  const records = 'action' in data ? [data.action] : data.actions;
  const sources = new Set(records.flatMap((record) => record.outcome.evidence.map((evidence) => evidence.source)));
  const observations = await state.read((current) => Object.fromEntries(Object.entries(current.observations).filter(([, observation]) => sources.has(observation.source))));
  return {
    context: { accountId: context.accountId, ...(context.targetId === undefined ? {} : { targetId: context.targetId }) },
    data,
    observations,
    actions
  };
}

export async function createClientApplication(options: CreateClientApplicationOptions): Promise<ClientApplication> {
  const state = await openClientState(options.storeFile);
  const fetcher = options.fetch ?? fetch;
  const accounts = createAccountService(state, fetcher);
  const discovery = createDiscoveryService(state, fetcher);
  const observations = createObservationService(state, {
    ...(options.observationTimeoutMs === undefined ? {} : { timeoutMs: options.observationTimeoutMs })
  });
  const identities = createIdentityService(state, fetcher, {
    ...(options.observationTimeoutMs === undefined ? {} : { timeoutMs: options.observationTimeoutMs })
  });
  const bindings = [...(options.administratorBindings ?? [])];
  const credentials = { ...(options.administratorCredentials ?? {}) };
  const resolveAdministratorCredential = async (accountId: string, targetActorId: string): Promise<string> => {
    const account = await state.read((current) => current.accounts[accountId]);
    if (!account || account.login.status !== 'signed-in') throw new Error('Account is not signed in');
    const binding = bindings.find((candidate) => candidate.accountId === accountId && candidate.authorityActorIds.includes(targetActorId));
    if (!binding) throw new Error('No administrator binding matches the account and target');
    if (!Object.hasOwn(credentials, binding.credentialSource)) throw new Error('Administrator credential source is not configured');
    const credential = credentials[binding.credentialSource];
    if (typeof credential !== 'string' || !credential) throw new Error('Administrator credential source is not configured');
    return credential;
  };
  const builtInHandlers = createWorkflowActionHandlers(state, fetcher, observations, {
    ...(options.actionTimeoutMs === undefined ? {} : { timeoutMs: options.actionTimeoutMs })
  });
  const administrationHandlers = createAdministrationActionHandlers(state, fetcher, {
    bindings, resolveCredential: resolveAdministratorCredential,
    ...(options.actionTimeoutMs === undefined ? {} : { timeoutMs: options.actionTimeoutMs })
  });
  const actions = createActionService(state, {
    handlers: {
      ...builtInHandlers,
    'authoring-publication': createAuthoringPublicationHandler(state, fetcher, observations),
      ...administrationHandlers,
      ...(options.actionHandlers ?? {})
    },
    ...(options.actionTimeoutMs === undefined ? {} : { timeoutMs: options.actionTimeoutMs })
  });
  const authoring = createAuthoringService(state, fetcher, observations, actions);
  const explore = createExploreService(state, fetcher, observations, {
    ...(options.observationTimeoutMs === undefined ? {} : { timeoutMs: options.observationTimeoutMs })
  });
  const seedServers = [...(options.seedServers ?? [])];
  const logistics = createLogisticsService(state, fetcher, observations, actions, {
    ...(options.observationTimeoutMs === undefined ? {} : { timeoutMs: options.observationTimeoutMs })
  });
  const administration = createAdministrationService(state, fetcher, observations, actions, {
    bindings, resolveCredential: resolveAdministratorCredential,
    ...(options.observationTimeoutMs === undefined ? {} : { timeoutMs: options.observationTimeoutMs })
  });

  return {
    state,
    seedServers,
    fetch: fetcher,
    observations,
    identities,
    actions,
    authoring,
    administration,
    resolveAdministratorCredential,
    async handle(request, response) {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      if (!isApiPath(pathname)) return false;
      const resolveIdentities = request.method !== 'GET' && request.method !== 'HEAD'
        && !pathname.endsWith('/login') && !pathname.includes('/logout');
      const send = async (status: number, body: unknown): Promise<void> => {
        writeJson(response, status, await embedIdentities(body, identities, { resolve: resolveIdentities }));
      };
      try {
        if (request.method === 'GET' && pathname === '/api/health') {
          await send(200, { status: 'ok' });
          return true;
        }
        if (request.method === 'GET' && pathname === '/api/accounts') {
          const authenticated = await requireClient(state, request, undefined);
          const account = await accounts.get(authenticated.accountId);
          await send(200, { accounts: account ? [account] : [] });
          return true;
        }
        if (request.method === 'POST' && pathname === '/api/accounts/login') {
          const input = loginInput(await readJsonBody(request));
          const outcome = await accounts.login(input);
          writeJson(response, outcome.status === 'signed-in' ? 200 : 401, outcome);
          return true;
        }
        const logoutAccountId = accountIdFromLogoutPath(pathname);
        if (request.method === 'POST' && logoutAccountId !== undefined) {
          const authenticated = await requireClient(state, request, logoutAccountId);
          const account = await accounts.logout(logoutAccountId, authenticated.digest);
          if (!account) throw new ApiError(404, 'account-not-found');
          await send(200, { account });
          return true;
        }
        if (request.method === 'GET' && pathname === '/api/servers') {
          await authorize(state, request, undefined, false);
          await send(200, await discovery.list());
          return true;
        }
        if (request.method === 'POST' && pathname === '/api/servers') {
          await authorize(state, request, undefined, false);
          await send(200, await discovery.discover(discoveryInput(await readJsonBody(request))));
          return true;
        }
        if (request.method === 'GET' && pathname === '/api/library') {
          const accountId = accountScope(url, undefined, true)!;
          await requireClient(state, request, accountId);
          await send(200, await authoring.library(accountId));
          return true;
        }
        if (request.method === 'POST' && pathname === '/api/library/refresh') {
          const body = await readJsonBody(request);
          const accountId = accountScope(url, body, true)!;
          await requireClient(state, request, accountId);
          await send(200, await authoring.refreshLibrary(accountId));
          return true;
        }
        if (request.method === 'POST' && pathname === '/api/drafts') {
          const body = await readJsonBody(request);
          const accountId = accountScope(url, body, true)!;
          await requireClient(state, request, accountId);
          await send(201, await authoring.createDraft({ accountId, kind: bodyKind(body), fields: body.fields }));
          return true;
        }
        const draft = draftPath(pathname);
        if (draft) {
          if (draft.publish && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = accountScope(url, body, true)!;
            await requireClient(state, request, accountId);
            await send(200, await authoring.publishDraft(draft.draftId, accountId));
            return true;
          }
          if (!draft.publish && request.method === 'GET') {
            const accountId = accountScope(url, undefined, true)!;
            await requireClient(state, request, accountId);
            await send(200, await authoring.getDraft(draft.draftId, accountId));
            return true;
          }
          if (!draft.publish && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = accountScope(url, body, true)!;
            await requireClient(state, request, accountId);
            await send(200, await authoring.saveDraft(draft.draftId, { accountId, fields: body.fields }));
            return true;
          }
        }
        if (request.method === 'GET' && pathname === '/api/explore/places') {
          const accountId = accountScope(url, undefined, false);
          await authorize(state, request, accountId, false);
          await send(200, await explore.listPlaces(accountId, optionalQuery(url, 'vesselId')));
          return true;
        }
        if (request.method === 'POST' && pathname === '/api/explore/refresh') {
          const body = await readJsonBody(request);
          const accountId = accountScope(url, body, false);
          await authorize(state, request, accountId, false);
          await send(200, await explore.refresh({
            ...(accountId === undefined ? {} : { accountId }),
            ...(optionalBody(body, 'vesselId') === undefined ? {} : { vesselId: optionalBody(body, 'vesselId')! })
          }));
          return true;
        }
        const placePath = explorePlacePath(pathname);
        if (placePath) {
          if (placePath.refresh && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = accountScope(url, body, false);
            await authorize(state, request, accountId, false);
            await send(200, await explore.refreshPlace(placePath.placeId, {
              ...(accountId === undefined ? {} : { accountId }),
              ...(optionalBody(body, 'vesselId') === undefined ? {} : { vesselId: optionalBody(body, 'vesselId')! })
            }));
            return true;
          }
          if (!placePath.refresh && request.method === 'GET') {
            const accountId = accountScope(url, undefined, false);
            await authorize(state, request, accountId, false);
            await send(200, await explore.placeDetail(placePath.placeId, accountId, optionalQuery(url, 'vesselId')));
            return true;
          }
        }
        if (request.method === 'POST' && pathname === '/api/explore/routes') {
          const body = await readJsonBody(request);
          const accountId = accountScope(url, body, true)!;
          await requireClient(state, request, accountId);
          const from = optionalBody(body, 'from');
          const to = optionalBody(body, 'to');
          if (from === undefined || to === undefined) throw new ApiError(400, 'route-endpoints-required');
          await send(200, await explore.createRoute({ accountId, from, to }));
          return true;
        }
        const routeId = exploreRoutePath(pathname);
        if (routeId !== undefined && request.method === 'GET') {
          const accountId = accountScope(url, undefined, false);
          await authorize(state, request, accountId, false);
          await send(200, await explore.routeDetail(routeId, accountId));
          return true;
        }
        const resource = resourcePath(pathname);
        if (resource) {
          if (resource.refresh && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = accountScope(url, body, false);
            await authorize(state, request, accountId, false);
            await send(200, await explore.refreshResource(resource.resourceId, {
              ...(accountId === undefined ? {} : { accountId }),
              ...(optionalBody(body, 'authorityId') === undefined ? {} : { authorityId: optionalBody(body, 'authorityId')! })
            }));
            return true;
          }
          if (!resource.refresh && request.method === 'GET') {
            const accountId = accountScope(url, undefined, false);
            await authorize(state, request, accountId, false);
            await send(200, await explore.readResource(resource.resourceId, {
              ...(accountId === undefined ? {} : { accountId }),
              ...(optionalQuery(url, 'authorityId') === undefined ? {} : { authorityId: optionalQuery(url, 'authorityId')! })
            }));
            return true;
          }
        }
        if (request.method === 'GET' && pathname === '/api/logistics/vessels') {
          const accountId = accountScope(url, undefined, true)!;
          await requireClient(state, request, accountId);
          await send(200, await logistics.vesselCandidates(accountId));
          return true;
        }
        if (request.method === 'POST' && pathname === '/api/logistics/vessels/refresh') {
          const body = await readJsonBody(request);
          const accountId = accountScope(url, body, true)!;
          await requireClient(state, request, accountId);
          await send(200, await logistics.refreshVesselCandidates(accountId));
          return true;
        }
        const logisticsVessel = logisticsVesselPath(pathname);
        if (logisticsVessel) {
          const action = logisticsVessel.action;
          if (action === undefined && request.method === 'GET') {
            const accountId = accountScope(url, undefined, true)!;
            await requireClient(state, request, accountId);
            await requireAccount(state, accountId);
            await send(200, await logistics.vessel(accountId, logisticsVessel.vesselId));
            return true;
          }
          if (action === 'refresh' && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = accountScope(url, body, true)!;
            await requireClient(state, request, accountId);
            await requireAccount(state, accountId);
            await send(200, await logistics.refreshVessel(accountId, logisticsVessel.vesselId));
            return true;
          }
          if ((action === 'entry' || action === 'departure') && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = accountScope(url, body, true)!;
            await requireClient(state, request, accountId);
            await requireAccount(state, accountId);
            const territoryId = optionalBody(body, 'territoryId');
            const portId = optionalBody(body, 'portId');
            const routeId = optionalBody(body, 'routeId');
            if (territoryId === undefined || portId === undefined || routeId === undefined) throw new ApiError(400, 'destination-required');
            const input = { accountId, vesselId: logisticsVessel.vesselId, territoryId, portId, routeId };
            const record = action === 'entry' ? await logistics.entry(input) : await logistics.departure(input);
            await send(200, { action: record });
            return true;
          }
          if (action === 'adoption' && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = accountScope(url, body, true)!;
            await requireClient(state, request, accountId);
            await requireAccount(state, accountId);
            if (typeof body.adoption !== 'boolean') throw new ApiError(400, 'adoption-required');
            await send(200, { action: await logistics.adoption({ accountId, vesselId: logisticsVessel.vesselId, adoption: body.adoption }) });
            return true;
          }
          if (action === 'traverse' && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = accountScope(url, body, true)!;
            await requireClient(state, request, accountId);
            await requireAccount(state, accountId);
            const routePlanId = optionalBody(body, 'routePlanId');
            if (routePlanId === undefined) throw new ApiError(400, 'route-plan-id-required');
            await send(200, { action: await logistics.traverse({ accountId, vesselId: logisticsVessel.vesselId, routePlanId }) });
            return true;
          }
        }
        if (request.method === 'GET' && pathname === '/api/production') {
          const accountId = accountScope(url, undefined, true)!;
          await requireClient(state, request, accountId);
          await requireAccount(state, accountId);
          await send(200, await logistics.production(accountId, queryVesselId(url)));
          return true;
        }
        if (request.method === 'POST' && pathname === '/api/production/refresh') {
          const body = await readJsonBody(request);
          const accountId = accountScope(url, body, true)!;
          await requireClient(state, request, accountId);
          await requireAccount(state, accountId);
          await send(200, await logistics.refreshProduction(accountId, bodyVesselId(body)));
          return true;
        }
        const productionOperation = productionOperationPath(pathname);
        if (productionOperation) {
          if (productionOperation.execute && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = accountScope(url, body, true)!;
            await requireClient(state, request, accountId);
            await requireAccount(state, accountId);
            const inputs = typeof body.inputs === 'object' && body.inputs !== null && !Array.isArray(body.inputs) ? body.inputs as Record<string, unknown> : {};
            const record = await logistics.executeOperation(productionOperation.operationId, accountId, bodyVesselId(body), inputs);
            await send(200, { action: record });
            return true;
          }
          if (!productionOperation.execute && request.method === 'GET') {
            const accountId = accountScope(url, undefined, true)!;
            await requireClient(state, request, accountId);
            await requireAccount(state, accountId);
            await send(200, await logistics.operation(productionOperation.operationId, accountId, queryVesselId(url)));
            return true;
          }
        }
        const productionJob = productionJobPath(pathname);
        if (productionJob) {
          if (productionJob.refresh && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = accountScope(url, body, true)!;
            await requireClient(state, request, accountId);
            await requireAccount(state, accountId);
            await send(200, await logistics.refreshJob(productionJob.jobId, accountId, bodyVesselId(body)));
            return true;
          }
          if (!productionJob.refresh && request.method === 'GET') {
            const accountId = accountScope(url, undefined, true)!;
            await requireClient(state, request, accountId);
            await requireAccount(state, accountId);
            await send(200, await logistics.job(productionJob.jobId, accountId, queryVesselId(url)));
            return true;
          }
        }
        if (request.method === 'GET' && pathname === '/api/administration') {
          const accountId = accountScope(url, undefined, true)!;
          await requireClient(state, request, accountId);
          await send(200, await administration.page(accountId));
          return true;
        }
        if (request.method === 'POST' && pathname === '/api/administration/refresh') {
          const body = await readJsonBody(request);
          const accountId = accountScope(url, body, true)!;
          await requireClient(state, request, accountId);
          const authorityId = optionalBody(body, 'authorityId');
          if (authorityId === undefined) throw new ApiError(400, 'authority-id-required');
          await send(200, await administration.refresh({ accountId, authorityId }));
          return true;
        }
        if (request.method === 'POST' && pathname === '/api/administration/controls') {
          const body = await readJsonBody(request);
          const accountId = accountScope(url, body, true)!;
          await requireClient(state, request, accountId);
          const authorityId = optionalBody(body, 'authorityId');
          const control = optionalBody(body, 'control');
          if (authorityId === undefined) throw new ApiError(400, 'authority-id-required');
          if (control === undefined) throw new ApiError(400, 'control-required');
          const inputs = typeof body.inputs === 'object' && body.inputs !== null && !Array.isArray(body.inputs) ? body.inputs as Record<string, unknown> : {};
          await send(200, await administration.control({ accountId, authorityId, control, inputs }));
          return true;
        }
        const administrationDecision = administrationDecisionPath(pathname);
        if (administrationDecision && request.method === 'POST') {
          const body = await readJsonBody(request);
          const accountId = accountScope(url, body, true)!;
          await requireClient(state, request, accountId);
          const authorityId = optionalBody(body, 'authorityId');
          if (authorityId === undefined) throw new ApiError(400, 'authority-id-required');
          const reason = optionalBody(body, 'reason');
          await send(200, await administration.decide({
            accountId, authorityId, requestId: administrationDecision.requestId,
            decision: administrationDecision.decision, ...(reason === undefined ? {} : { reason })
          }));
          return true;
        }
        if (request.method === 'GET' && pathname === '/api/activity') {
          const accountId = accountScope(url, undefined, true)!;
          await requireClient(state, request, accountId);
          await requireAccount(state, accountId);
          await send(200, await activityPage(state, { accountId }, { actions: await actions.list(accountId) }, []));
          return true;
        }
        const activityPath = activityActionPath(pathname);
        if (activityPath) {
          if (activityPath.refresh && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = accountScope(url, body, true)!;
            await requireClient(state, request, accountId);
            await requireAccount(state, accountId);
            const existing = await actions.get(activityPath.actionId, accountId);
            if (!existing) throw new ApiError(404, 'action-not-found');
            const record = await actions.reconcile(activityPath.actionId, accountId);
            await send(200, await activityPage(state, { accountId, targetId: record.targetId }, { action: record }, [{
              id: `refresh:${record.id}`,
              label: `Refresh ${record.intent.kind} action`,
              endpoint: `/api/activity/${encodeURIComponent(record.id)}/refresh`,
              method: 'POST',
              targetId: record.targetId,
              inputs: [{ name: 'accountId', required: true }],
              blockers: [],
              expectedResult: 'reconciled action result'
            }]));
            return true;
          }
          if (!activityPath.refresh && request.method === 'GET') {
            const accountId = accountScope(url, undefined, true)!;
            await requireClient(state, request, accountId);
            await requireAccount(state, accountId);
            const record = await actions.get(activityPath.actionId, accountId);
            if (!record) throw new ApiError(404, 'action-not-found');
            await send(200, await activityPage(state, { accountId, targetId: record.targetId }, { action: record }, [{
              id: `refresh:${record.id}`,
              label: `Refresh ${record.intent.kind} action`,
              endpoint: `/api/activity/${encodeURIComponent(record.id)}/refresh`,
              method: 'POST',
              targetId: record.targetId,
              inputs: [{ name: 'accountId', required: true }],
              blockers: [],
              expectedResult: 'reconciled action result'
            }]));
            return true;
          }
        }
        writeJson(response, 404, { error: 'not-found' });
        return true;
      } catch (error) {
        if (error instanceof ApiError) {
          writeJson(response, error.status, { error: error.code });
          return true;
        }
        if (error instanceof ExploreRequestError || error instanceof LogisticsRequestError || error instanceof AdministrationRequestError) {
          writeJson(response, error.status, { error: error.code });
          return true;
        }
        if (error instanceof AuthoringRequestError) {
          writeJson(response, error.status, { error: error.code });
          return true;
        }
        if (error instanceof UpstreamError) {
          writeJson(response, 502, { error: 'upstream-failure' });
          return true;
        }
        if (error instanceof SyntaxError || error instanceof TypeError) {
          writeJson(response, 400, { error: 'invalid-request' });
          return true;
        }
        writeJson(response, 502, { error: 'request-failed' });
        return true;
      }
    },
    close: () => Promise.resolve()
  };
}
