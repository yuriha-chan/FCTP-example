import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ActionDescriptor, ActionRecord, PageResponse } from '@fctp/client-sdk';
import { createAccountService, type LoginInput } from './accounts.js';
import { createActionService, type ActionHandler, type ActionService } from './actions.js';
import { createDiscoveryService, type DiscoveryInput } from './discovery.js';
import { UpstreamError } from './errors.js';
import { createExploreService, ExploreRequestError } from './explore.js';
import { createLogisticsService, createWorkflowActionHandlers, LogisticsRequestError } from './logistics.js';
import { createObservationService, type ObservationService } from './observations.js';
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
  readonly actions: ActionService;
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
  const homeOrigin = body.homeOrigin;
  if (homeOrigin !== undefined && typeof homeOrigin !== 'string') throw new ApiError(400, 'invalid-home-origin');
  return { handle, password, ...(typeof homeOrigin === 'string' && homeOrigin ? { homeOrigin } : {}) };
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

function queryAccountId(url: URL): string {
  const accountId = url.searchParams.get('accountId')?.trim() ?? '';
  if (!accountId) throw new ApiError(400, 'account-id-required');
  return accountId;
}

function bodyAccountId(body: Record<string, unknown>): string {
  const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : '';
  if (!accountId) throw new ApiError(400, 'account-id-required');
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

function logisticsVesselPath(pathname: string): { vesselId: string; action?: 'refresh' | 'entry' | 'departure' | 'adoption' } | undefined {
  const match = /^\/api\/logistics\/vessels\/([^/]+)(?:\/(refresh|entry|departure|adoption))?$/.exec(pathname);
  if (!match) return undefined;
  try {
    const vesselId = decodeURIComponent(match[1]!);
    const action = match[2] as 'refresh' | 'entry' | 'departure' | 'adoption' | undefined;
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
  const builtInHandlers = createWorkflowActionHandlers(state, fetcher, observations, {
    ...(options.actionTimeoutMs === undefined ? {} : { timeoutMs: options.actionTimeoutMs })
  });
  const actions = createActionService(state, {
    handlers: { ...builtInHandlers, ...(options.actionHandlers ?? {}) },
    ...(options.actionTimeoutMs === undefined ? {} : { timeoutMs: options.actionTimeoutMs })
  });
  const explore = createExploreService(state, fetcher, observations, {
    ...(options.observationTimeoutMs === undefined ? {} : { timeoutMs: options.observationTimeoutMs })
  });
  const logistics = createLogisticsService(state, fetcher, observations, actions, {
    ...(options.observationTimeoutMs === undefined ? {} : { timeoutMs: options.observationTimeoutMs })
  });
  const bindings = [...(options.administratorBindings ?? [])];
  const credentials = { ...(options.administratorCredentials ?? {}) };

  return {
    state,
    seedServers: [...(options.seedServers ?? [])],
    fetch: fetcher,
    observations,
    actions,
    async resolveAdministratorCredential(accountId, targetActorId) {
      const account = await state.read((current) => current.accounts[accountId]);
      if (!account || account.login.status !== 'signed-in') throw new Error('Account is not signed in');
      const binding = bindings.find((candidate) => candidate.accountId === accountId && candidate.authorityActorIds.includes(targetActorId));
      if (!binding) throw new Error('No administrator binding matches the account and target');
      if (!Object.hasOwn(credentials, binding.credentialSource)) throw new Error('Administrator credential source is not configured');
      const credential = credentials[binding.credentialSource];
      if (typeof credential !== 'string' || !credential) throw new Error('Administrator credential source is not configured');
      return credential;
    },
    async handle(request, response) {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      if (!isApiPath(pathname)) return false;
      try {
        if (request.method === 'GET' && pathname === '/api/health') {
          writeJson(response, 200, { status: 'ok' });
          return true;
        }
        if (request.method === 'GET' && pathname === '/api/accounts') {
          writeJson(response, 200, { accounts: await accounts.list() });
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
          const account = await accounts.logout(logoutAccountId);
          if (!account) throw new ApiError(404, 'account-not-found');
          writeJson(response, 200, { account });
          return true;
        }
        if (request.method === 'GET' && pathname === '/api/servers') {
          writeJson(response, 200, await discovery.list());
          return true;
        }
        if (request.method === 'POST' && pathname === '/api/servers') {
          writeJson(response, 200, await discovery.discover(discoveryInput(await readJsonBody(request))));
          return true;
        }
        if (request.method === 'GET' && pathname === '/api/explore/places') {
          writeJson(response, 200, await explore.listPlaces(optionalQuery(url, 'accountId'), optionalQuery(url, 'vesselId')));
          return true;
        }
        if (request.method === 'POST' && pathname === '/api/explore/refresh') {
          const body = await readJsonBody(request);
          writeJson(response, 200, await explore.refresh({
            ...(optionalBody(body, 'accountId') === undefined ? {} : { accountId: optionalBody(body, 'accountId')! }),
            ...(optionalBody(body, 'vesselId') === undefined ? {} : { vesselId: optionalBody(body, 'vesselId')! })
          }));
          return true;
        }
        const placePath = explorePlacePath(pathname);
        if (placePath) {
          if (placePath.refresh && request.method === 'POST') {
            const body = await readJsonBody(request);
            writeJson(response, 200, await explore.refreshPlace(placePath.placeId, {
              ...(optionalBody(body, 'accountId') === undefined ? {} : { accountId: optionalBody(body, 'accountId')! }),
              ...(optionalBody(body, 'vesselId') === undefined ? {} : { vesselId: optionalBody(body, 'vesselId')! })
            }));
            return true;
          }
          if (!placePath.refresh && request.method === 'GET') {
            writeJson(response, 200, await explore.placeDetail(placePath.placeId, optionalQuery(url, 'accountId'), optionalQuery(url, 'vesselId')));
            return true;
          }
        }
        if (request.method === 'POST' && pathname === '/api/explore/routes') {
          const body = await readJsonBody(request);
          const accountId = bodyAccountId(body);
          const from = optionalBody(body, 'from');
          const to = optionalBody(body, 'to');
          if (from === undefined || to === undefined) throw new ApiError(400, 'route-endpoints-required');
          writeJson(response, 200, await explore.createRoute({ accountId, from, to }));
          return true;
        }
        const routeId = exploreRoutePath(pathname);
        if (routeId !== undefined && request.method === 'GET') {
          writeJson(response, 200, await explore.routeDetail(routeId, optionalQuery(url, 'accountId')));
          return true;
        }
        const resource = resourcePath(pathname);
        if (resource) {
          if (resource.refresh && request.method === 'POST') {
            const body = await readJsonBody(request);
            writeJson(response, 200, await explore.refreshResource(resource.resourceId, {
              ...(optionalBody(body, 'accountId') === undefined ? {} : { accountId: optionalBody(body, 'accountId')! }),
              ...(optionalBody(body, 'authorityId') === undefined ? {} : { authorityId: optionalBody(body, 'authorityId')! })
            }));
            return true;
          }
          if (!resource.refresh && request.method === 'GET') {
            writeJson(response, 200, await explore.readResource(resource.resourceId, {
              ...(optionalQuery(url, 'accountId') === undefined ? {} : { accountId: optionalQuery(url, 'accountId')! }),
              ...(optionalQuery(url, 'authorityId') === undefined ? {} : { authorityId: optionalQuery(url, 'authorityId')! })
            }));
            return true;
          }
        }
        const logisticsVessel = logisticsVesselPath(pathname);
        if (logisticsVessel) {
          const action = logisticsVessel.action;
          if (action === undefined && request.method === 'GET') {
            const accountId = queryAccountId(url);
            await requireAccount(state, accountId);
            writeJson(response, 200, await logistics.vessel(accountId, logisticsVessel.vesselId));
            return true;
          }
          if (action === 'refresh' && request.method === 'POST') {
            const accountId = bodyAccountId(await readJsonBody(request));
            await requireAccount(state, accountId);
            writeJson(response, 200, await logistics.refreshVessel(accountId, logisticsVessel.vesselId));
            return true;
          }
          if ((action === 'entry' || action === 'departure') && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = bodyAccountId(body);
            await requireAccount(state, accountId);
            const territoryId = optionalBody(body, 'territoryId');
            const portId = optionalBody(body, 'portId');
            const routeId = optionalBody(body, 'routeId');
            if (territoryId === undefined || portId === undefined || routeId === undefined) throw new ApiError(400, 'destination-required');
            const input = { accountId, vesselId: logisticsVessel.vesselId, territoryId, portId, routeId };
            const record = action === 'entry' ? await logistics.entry(input) : await logistics.departure(input);
            writeJson(response, 200, { action: record });
            return true;
          }
          if (action === 'adoption' && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = bodyAccountId(body);
            await requireAccount(state, accountId);
            if (typeof body.adoption !== 'boolean') throw new ApiError(400, 'adoption-required');
            writeJson(response, 200, { action: await logistics.adoption({ accountId, vesselId: logisticsVessel.vesselId, adoption: body.adoption }) });
            return true;
          }
        }
        if (request.method === 'GET' && pathname === '/api/production') {
          const accountId = queryAccountId(url);
          await requireAccount(state, accountId);
          writeJson(response, 200, await logistics.production(accountId, queryVesselId(url)));
          return true;
        }
        if (request.method === 'POST' && pathname === '/api/production/refresh') {
          const body = await readJsonBody(request);
          const accountId = bodyAccountId(body);
          await requireAccount(state, accountId);
          writeJson(response, 200, await logistics.refreshProduction(accountId, bodyVesselId(body)));
          return true;
        }
        const productionOperation = productionOperationPath(pathname);
        if (productionOperation) {
          if (productionOperation.execute && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = bodyAccountId(body);
            await requireAccount(state, accountId);
            const inputs = typeof body.inputs === 'object' && body.inputs !== null && !Array.isArray(body.inputs) ? body.inputs as Record<string, unknown> : {};
            const record = await logistics.executeOperation(productionOperation.operationId, accountId, bodyVesselId(body), inputs);
            writeJson(response, 200, { action: record });
            return true;
          }
          if (!productionOperation.execute && request.method === 'GET') {
            const accountId = queryAccountId(url);
            await requireAccount(state, accountId);
            writeJson(response, 200, await logistics.operation(productionOperation.operationId, accountId, queryVesselId(url)));
            return true;
          }
        }
        const productionJob = productionJobPath(pathname);
        if (productionJob) {
          if (productionJob.refresh && request.method === 'POST') {
            const body = await readJsonBody(request);
            const accountId = bodyAccountId(body);
            await requireAccount(state, accountId);
            writeJson(response, 200, await logistics.refreshJob(productionJob.jobId, accountId, bodyVesselId(body)));
            return true;
          }
          if (!productionJob.refresh && request.method === 'GET') {
            const accountId = queryAccountId(url);
            await requireAccount(state, accountId);
            writeJson(response, 200, await logistics.job(productionJob.jobId, accountId, queryVesselId(url)));
            return true;
          }
        }
        if (request.method === 'GET' && pathname === '/api/activity') {
          const accountId = queryAccountId(url);
          await requireAccount(state, accountId);
          writeJson(response, 200, await activityPage(state, { accountId }, { actions: await actions.list(accountId) }, []));
          return true;
        }
        const activityPath = activityActionPath(pathname);
        if (activityPath) {
          if (activityPath.refresh && request.method === 'POST') {
            const accountId = bodyAccountId(await readJsonBody(request));
            await requireAccount(state, accountId);
            const existing = await actions.get(activityPath.actionId, accountId);
            if (!existing) throw new ApiError(404, 'action-not-found');
            const record = await actions.reconcile(activityPath.actionId, accountId);
            writeJson(response, 200, await activityPage(state, { accountId, targetId: record.targetId }, { action: record }, [{
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
            const accountId = queryAccountId(url);
            await requireAccount(state, accountId);
            const record = await actions.get(activityPath.actionId, accountId);
            if (!record) throw new ApiError(404, 'action-not-found');
            writeJson(response, 200, await activityPage(state, { accountId, targetId: record.targetId }, { action: record }, [{
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
        if (error instanceof ExploreRequestError || error instanceof LogisticsRequestError) {
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
