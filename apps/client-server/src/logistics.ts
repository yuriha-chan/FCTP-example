import { deriveDiplomaticToken } from '@fctp/auth';
import type {
  AccountRecord,
  ActionRecord,
  LogisticsRegistryObservation,
  LogisticsTerritoryObservation,
  LogisticsVesselData,
  PageResponse,
  ProductionAuthorityRecord,
  ProductionData,
  ProductionJob,
  ProductionOperation,
  SourcedObservation
} from '@fctp/client-sdk';
import type { URI } from '@fctp/protocol';
import { withDeadline } from './deadline.js';
import type { ActionHandler, ActionService } from './actions.js';
import type { ObservationService } from './observations.js';
import type { ClientApplicationState } from './store.js';
import {
  isOwnedVessel,
  readRegistryState,
  readVesselDocument,
  reconcileRegistryRequest,
  registryStateSource,
  registrySummary,
  submitRegistryAction
} from './adapters/registry.js';
import {
  policyAuditAction,
  policyExecution,
  policyOperations,
  policyTerritorySummary,
  readPolicySnapshot,
  readPolicyState,
  type PolicySnapshot
} from './adapters/policy.js';
import {
  readSimulationSnapshot,
  readSimulationState,
  simulationExecution,
  simulationJobFromState,
  simulationOperations,
  simulationStateSource,
  simulationTerritorySummary,
  type SimulationJobContext,
  type SimulationSnapshot
} from './adapters/simulation.js';
import { decodeOperationId, encodeJobId } from './adapters/operations.js';

export class LogisticsRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export interface LogisticsService {
  vessel(accountId: string, vesselId: string): Promise<PageResponse<LogisticsVesselData>>;
  refreshVessel(accountId: string, vesselId: string): Promise<PageResponse<LogisticsVesselData>>;
  entry(input: { accountId: string; vesselId: string; territoryId: string; portId: string; routeId: string }): Promise<ActionRecord>;
  departure(input: { accountId: string; vesselId: string; territoryId: string; portId: string; routeId: string }): Promise<ActionRecord>;
  adoption(input: { accountId: string; vesselId: string; adoption: boolean }): Promise<ActionRecord>;
  production(accountId: string, vesselId: string): Promise<PageResponse<ProductionData>>;
  refreshProduction(accountId: string, vesselId: string): Promise<PageResponse<ProductionData>>;
  operation(operationId: string, accountId: string, vesselId: string): Promise<PageResponse<{ operation: ProductionOperation }>>;
  executeOperation(operationId: string, accountId: string, vesselId: string, inputs: Record<string, unknown>): Promise<ActionRecord>;
  job(jobId: string, accountId: string, vesselId: string): Promise<PageResponse<{ job: ProductionJob }>>;
  refreshJob(jobId: string, accountId: string, vesselId: string): Promise<PageResponse<{ job: ProductionJob }>>;
}

export interface LogisticsServiceOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const NUL = '\u0000';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function inputString(inputs: Record<string, unknown>, name: string): string | undefined {
  const value = inputs[name];
  return typeof value === 'string' && value ? value : undefined;
}

function requiredString(inputs: Record<string, unknown>, name: string): string {
  const value = inputString(inputs, name);
  if (!value) throw new LogisticsRequestError(400, `${name}-required`);
  return value;
}

function vesselMetadataKey(vesselId: string): string {
  return `logistics-vessel:${vesselId}`;
}

function logisticsKey(accountId: string, vesselId: string): string {
  return `logistics:${accountId}:${vesselId}`;
}

function productionKey(accountId: string, vesselId: string): string {
  return `production:${accountId}:${vesselId}`;
}

function jobKey(accountId: string, vesselId: string, jobId: string): string {
  return `production-job:${accountId}:${vesselId}:${encodeURIComponent(jobId)}`;
}

function observationValue<T>(observation: SourcedObservation<unknown> | undefined): T | undefined {
  if (!observation) return undefined;
  if (observation.state === 'available' || observation.state === 'stale' || observation.state === 'empty') return observation.value as T;
  return undefined;
}

interface VesselContext {
  vessel: {
    id: string;
    registry: string;
    possessor: string;
    capacity?: number;
    name?: string;
  };
}

interface TerritoryAuthority {
  actorId: string;
  name?: string;
}

async function territoryInfo(fetcher: typeof fetch, authorityId: string, signal: AbortSignal): Promise<{ kind: 'policy' | 'simulation'; info: Record<string, unknown> }> {
  const response = await fetcher(new URL('/local/info', authorityId).href, {
    method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', signal
  });
  if (!response.ok) throw new Error(`Territory info unavailable: HTTP ${response.status}`);
  const info: unknown = await response.json();
  if (!isRecord(info) || (info.kind !== 'policy' && info.kind !== 'simulation')) throw new Error('Authority does not advertise supported production operations');
  return { kind: info.kind, info };
}

async function territorySnapshot(fetcher: typeof fetch, authorityId: string, vesselId: string, token: string, signal: AbortSignal): Promise<PolicySnapshot | SimulationSnapshot> {
  const { kind } = await territoryInfo(fetcher, authorityId, signal);
  return kind === 'policy'
    ? readPolicySnapshot(fetcher, authorityId, vesselId, token, signal)
    : readSimulationSnapshot(fetcher, authorityId, vesselId, token, signal);
}

export function createLogisticsService(
  state: ClientApplicationState,
  fetcher: typeof fetch,
  observations: ObservationService,
  actions: ActionService,
  options: LogisticsServiceOptions = {}
): LogisticsService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const call = <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => withDeadline(timeoutMs, operation);

  const signedInAccount = async (accountId: string): Promise<AccountRecord> => {
    const account = await state.read((current) => current.accounts[accountId]);
    if (!account) throw new LogisticsRequestError(404, 'account-not-found');
    if (account.login.status !== 'signed-in') throw new LogisticsRequestError(403, 'account-not-signed-in');
    return account;
  };

  const readVesselObservation = async (vesselId: string): Promise<SourcedObservation<unknown> | undefined> => {
    const found = await observations.read(vesselMetadataKey(vesselId));
    return found[0];
  };

  const ensureVessel = async (account: AccountRecord, vesselId: string, load: boolean): Promise<VesselContext | undefined> => {
    let observation = await readVesselObservation(vesselId);
    if (load) {
      observation = await observations.refresh({
        key: vesselMetadataKey(vesselId),
        source: vesselId,
        load: (signal) => call(() => readVesselDocument(fetcher, vesselId, signal))
      });
    }
    const vessel = observationValue<{ id: string; registry: string; possessor: string; capacity?: number; name?: string }>(observation);
    if (vessel) {
      if (!isOwnedVessel(vessel, account.actorId)) throw new LogisticsRequestError(403, 'vessel-not-owned');
      if (account.login.status === 'signed-in' && new URL(vessel.registry).host !== account.login.homeServer) {
        throw new LogisticsRequestError(403, 'Registry native authentication requires the issuing Home server');
      }
      return { vessel };
    }
    if (load) throw new LogisticsRequestError(502, 'vessel-metadata-unavailable');
    return undefined;
  };

  const territoryAuthorities = async (): Promise<TerritoryAuthority[]> => state.read((current) => Object.values(current.authorities)
    .filter((authority) => authority.roles.includes('territory'))
    .map((authority) => ({ actorId: authority.actorId, ...(authority.name === undefined ? {} : { name: authority.name }) })));

  const validateDestination = async (territoryId: string, portId: string, routeId: string): Promise<void> => {
    const { info } = await call((signal) => territoryInfo(fetcher, territoryId, signal));
    const ids = record(info.ids);
    const ports = Array.isArray(ids.ports) ? ids.ports.filter((value): value is string => typeof value === 'string') : [];
    const routes = Array.isArray(ids.routes) ? ids.routes.filter((value): value is string => typeof value === 'string') : [];
    if (!ports.includes(portId)) throw new LogisticsRequestError(400, 'port-not-advertised');
    if (!routes.includes(routeId)) throw new LogisticsRequestError(400, 'route-not-advertised');
  };

  const logisticsPage = async (account: AccountRecord, vesselId: string): Promise<PageResponse<LogisticsVesselData>> => {
    const key = logisticsKey(account.id, vesselId);
    const entries = await state.read((current) => Object.entries(current.observations)
      .filter(([storedKey]) => storedKey === key || storedKey.startsWith(`${key}${NUL}`))
      .map(([, observation]) => observation));
    const vesselObservation = await readVesselObservation(vesselId);
    const vessel = observationValue<{ id: string; registry: string; possessor: string; capacity?: number; name?: string }>(vesselObservation);
    let registry: LogisticsRegistryObservation = {
      authorityId: vessel?.registry ?? vesselId,
      source: vessel ? registryStateSource(vessel.registry, vesselId) : vesselId,
      state: 'not-retrieved'
    };
    const territories: LogisticsTerritoryObservation[] = [];
    for (const observation of entries) {
      const value = observationValue<Record<string, unknown>>(observation);
      if (!value) continue;
      if (value.recordType === 'registry') {
        registry = {
          authorityId: typeof value.authorityId === 'string' ? value.authorityId : registry.authorityId,
          source: observation.source,
          state: observation.state,
          ...('observedAt' in observation && observation.observedAt !== undefined ? { observedAt: observation.observedAt } : {}),
          ...('error' in observation && observation.error !== undefined ? { error: observation.error } : {}),
          ...(value.cargo === undefined ? {} : { cargo: value.cargo }),
          ...(value.adoption === undefined ? {} : { adoption: value.adoption === true }),
          ...(value.location === undefined ? {} : { location: value.location }),
          ...(value.pendingRequests === undefined ? {} : { pendingRequests: Array.isArray(value.pendingRequests) ? value.pendingRequests : [] })
        };
      }
      if (value.recordType === 'territory') {
        territories.push({
          authorityId: typeof value.authorityId === 'string' ? value.authorityId : observation.source,
          kind: value.kind === 'simulation' ? 'simulation' : 'policy',
          source: observation.source,
          state: observation.state,
          ...('observedAt' in observation && observation.observedAt !== undefined ? { observedAt: observation.observedAt } : {}),
          ...('error' in observation && observation.error !== undefined ? { error: observation.error } : {}),
          ...(value.visit === undefined ? {} : { visit: value.visit }),
          ...(value.cargo === undefined ? {} : { cargo: value.cargo }),
          ...(value.sharedStock === undefined ? {} : { sharedStock: value.sharedStock })
        });
      }
    }
    const data: LogisticsVesselData = {
      accountId: account.id,
      vesselId,
      ...(vessel === undefined ? {} : { vessel }),
      registry,
      territories
    };
    const observed = Object.fromEntries(entries.map((observation) => [observation.source, observation]));
    return {
      context: { accountId: account.id, vesselId },
      data,
      observations: observed,
      actions: []
    };
  };

  const readProduction = async (account: AccountRecord, vesselId: string): Promise<PageResponse<ProductionData>> => {
    const key = productionKey(account.id, vesselId);
    const authorities = await territoryAuthorities();
    const entries = await state.read((current) => Object.entries(current.observations)
      .filter(([storedKey]) => storedKey === key || storedKey.startsWith(`${key}${NUL}`))
      .map(([, observation]) => observation));
    const operations: ProductionOperation[] = [];
    const authorityRecords: ProductionAuthorityRecord[] = [];
    for (const authority of authorities) {
      const source = new URL('/local/actions', authority.actorId).href;
      const observation = entries.find((candidate) => candidate.source === source);
      const value = observationValue<Record<string, unknown>>(observation);
      const kind = value?.kind === 'simulation' ? 'simulation' : value?.kind === 'policy' ? 'policy' : undefined;
      if (kind) {
        authorityRecords.push({
          authorityId: authority.actorId,
          kind,
          source,
          state: observation?.state ?? 'not-retrieved',
          ...(authority.name === undefined ? {} : { name: authority.name }),
          ...(observation && 'error' in observation && observation.error !== undefined ? { error: observation.error } : {}),
          ...(observation && 'observedAt' in observation && observation.observedAt !== undefined ? { observedAt: observation.observedAt } : {})
        });
      }
      const listed = Array.isArray(value?.operations) ? value.operations : [];
      for (const operation of listed) if (isRecord(operation)) operations.push(operation as unknown as ProductionOperation);
    }
    const jobEntries = await state.read((current) => Object.entries(current.observations)
      .filter(([storedKey]) => storedKey.startsWith(`production-job:${account.id}:${vesselId}:`))
      .map(([, observation]) => observation));
    const jobs = jobEntries.flatMap((observation) => {
      const job = observationValue<ProductionJob>(observation);
      return job === undefined ? [] : [job];
    });
    const data: ProductionData = { accountId: account.id, vesselId, operations, authorities: authorityRecords, jobs };
    return {
      context: { accountId: account.id, vesselId },
      data,
      observations: Object.fromEntries(entries.map((observation) => [observation.source, observation])),
      actions: []
    };
  };

  const requireOperation = async (operationId: string, accountId: string, vesselId: string): Promise<ProductionOperation> => {
    const page = await readProduction(await signedInAccount(accountId), vesselId);
    const operation = page.data.operations.find((candidate) => candidate.operationId === operationId);
    if (!operation) throw new LogisticsRequestError(404, 'operation-not-found');
    return operation;
  };

  const readJobObservation = async (accountId: string, vesselId: string, jobId: string): Promise<SourcedObservation<unknown> | undefined> => {
    const found = await observations.read(jobKey(accountId, vesselId, jobId));
    return found[0];
  };

  const jobPage = async (jobId: string, accountId: string, vesselId: string): Promise<PageResponse<{ job: ProductionJob }>> => {
    const observation = await readJobObservation(accountId, vesselId, jobId);
    const job = observationValue<ProductionJob>(observation);
    if (!job) throw new LogisticsRequestError(404, 'job-not-found');
    return {
      context: { accountId, vesselId },
      data: { job },
      observations: observation ? { [observation.source]: observation } : {},
      actions: [{
        id: `refresh:${jobId}`,
        label: 'Refresh selected job',
        endpoint: `/api/production/jobs/${encodeURIComponent(jobId)}/refresh`,
        method: 'POST',
        targetId: job.authorityId,
        inputs: [{ name: 'accountId', required: true }, { name: 'vesselId', required: true }],
        blockers: [],
        expectedResult: 'Observed job progress or completion evidence'
      }]
    };
  };

  const refreshJobObservation = async (jobId: string, accountId: string, vesselId: string): Promise<ProductionJob> => {
    const account = await signedInAccount(accountId);
    const observation = await readJobObservation(accountId, vesselId, jobId);
    const retained = observationValue<ProductionJob>(observation);
    if (!retained) throw new LogisticsRequestError(404, 'job-not-found');
    const source = retained.source || simulationStateSource(retained.authorityId);
    const token = await deriveDiplomaticToken(account.login.status === 'signed-in' ? account.login.nativeToken : '', retained.authorityId as URI);
    const refreshed = await observations.refresh<ProductionJob>({
      key: jobKey(accountId, vesselId, jobId),
      source,
      load: (signal) => call(async () => {
        const view = await readSimulationState(fetcher, retained.authorityId, token, signal);
        const context: SimulationJobContext = {
          authorityId: retained.authorityId,
          accountId,
          vesselId,
          operation: retained.operation,
          source: view.source,
          observedAt: new Date().toISOString()
        };
        return simulationJobFromState(view.payload, jobId, context);
      })
    });
    const job = observationValue<ProductionJob>(refreshed);
    if (!job) throw new LogisticsRequestError(502, 'job-refresh-failed');
    const pendingActions = (await actions.list(accountId)).filter((action) =>
      action.submission.status === 'accepted'
      && action.outcome.status === 'pending'
      && action.resultReferences.some((reference) => reference.kind === 'job' && reference.id === jobId)
    );
    for (const action of pendingActions) await actions.reconcile(action.id, accountId);
    return job;
  };

  const reconcilePendingRegistryActions = async (accountId: string): Promise<void> => {
    const pending = (await actions.list(accountId)).filter((action) =>
      action.submission.status === 'accepted'
      && action.outcome.status === 'pending'
      && ['entry', 'departure', 'adoption'].includes(action.intent.kind)
    );
    for (const action of pending) await actions.reconcile(action.id, accountId);
  };

  const pendingProductionActions = async (accountId: string): Promise<ActionRecord[]> => (await actions.list(accountId)).filter((action) =>
    action.submission.status === 'accepted'
    && action.outcome.status === 'pending'
    && ['mine', 'manufacture', 'transfer', 'load', 'unload'].includes(action.intent.kind)
  );

  return {
    async vessel(accountId, vesselId) {
      const account = await signedInAccount(accountId);
      await ensureVessel(account, vesselId, false);
      return logisticsPage(account, vesselId);
    },
    async refreshVessel(accountId, vesselId) {
      const account = await signedInAccount(accountId);
      await ensureVessel(account, vesselId, true);
      const vessel = observationValue<{ registry: string }>(await readVesselObservation(vesselId));
      if (!vessel) throw new LogisticsRequestError(502, 'vessel-metadata-unavailable');
      const token = account.login.status === 'signed-in' ? account.login.nativeToken : '';
      await observations.refresh({
        key: logisticsKey(accountId, vesselId),
        source: registryStateSource(vessel.registry, vesselId),
        load: (signal) => call(async () => {
          const view = await readRegistryState(fetcher, vessel.registry, vesselId, token, signal);
          return { recordType: 'registry', ...registrySummary(view), observedAt: new Date().toISOString() };
        })
      });
      for (const authority of await territoryAuthorities()) {
        const diplomatic = await deriveDiplomaticToken(token, authority.actorId as URI);
        const source = new URL('/local/actions', authority.actorId).href;
        await observations.refresh({
          key: logisticsKey(accountId, vesselId),
          source,
          load: (signal) => call(async () => {
            const snapshot = await territorySnapshot(fetcher, authority.actorId, vesselId, diplomatic, signal);
            const summary = snapshot.kind === 'policy' ? policyTerritorySummary(snapshot) : simulationTerritorySummary(snapshot);
            return { recordType: 'territory', ...summary, observedAt: new Date().toISOString() };
          })
        });
      }
      await reconcilePendingRegistryActions(accountId);
      return logisticsPage(account, vesselId);
    },
    async entry(input) {
      const account = await signedInAccount(input.accountId);
      const context = await ensureVessel(account, input.vesselId, true);
      if (!context) throw new LogisticsRequestError(502, 'vessel-metadata-unavailable');
      await validateDestination(input.territoryId, input.portId, input.routeId);
      return actions.submit({
        accountId: account.id,
        targetId: input.territoryId,
        intent: {
          kind: 'entry',
          inputs: {
            registryId: context.vessel.registry,
            vesselId: input.vesselId,
            territoryId: input.territoryId,
            portId: input.portId,
            routeId: input.routeId
          }
        }
      });
    },
    async departure(input) {
      const account = await signedInAccount(input.accountId);
      const context = await ensureVessel(account, input.vesselId, true);
      if (!context) throw new LogisticsRequestError(502, 'vessel-metadata-unavailable');
      await validateDestination(input.territoryId, input.portId, input.routeId);
      return actions.submit({
        accountId: account.id,
        targetId: input.territoryId,
        intent: {
          kind: 'departure',
          inputs: {
            registryId: context.vessel.registry,
            vesselId: input.vesselId,
            territoryId: input.territoryId,
            portId: input.portId,
            routeId: input.routeId
          }
        }
      });
    },
    async adoption(input) {
      const account = await signedInAccount(input.accountId);
      const context = await ensureVessel(account, input.vesselId, true);
      if (!context) throw new LogisticsRequestError(502, 'vessel-metadata-unavailable');
      return actions.submit({
        accountId: account.id,
        targetId: context.vessel.registry,
        intent: { kind: 'adoption', inputs: { registryId: context.vessel.registry, vesselId: input.vesselId, adoption: input.adoption } }
      });
    },
    async production(accountId, vesselId) {
      const account = await signedInAccount(accountId);
      await ensureVessel(account, vesselId, false);
      return readProduction(account, vesselId);
    },
    async refreshProduction(accountId, vesselId) {
      const account = await signedInAccount(accountId);
      await ensureVessel(account, vesselId, true);
      const token = account.login.status === 'signed-in' ? account.login.nativeToken : '';
      for (const authority of await territoryAuthorities()) {
        const diplomatic = await deriveDiplomaticToken(token, authority.actorId as URI);
        const source = new URL('/local/actions', authority.actorId).href;
        await observations.refresh({
          key: productionKey(accountId, vesselId),
          source,
          load: (signal) => call(async () => {
            const snapshot = await territorySnapshot(fetcher, authority.actorId, vesselId, diplomatic, signal);
            const operations = snapshot.kind === 'policy' ? policyOperations(snapshot) : simulationOperations(snapshot);
            return {
              recordType: 'territory-production',
              authorityId: authority.actorId,
              kind: snapshot.kind,
              operations,
              observedAt: new Date().toISOString()
            };
          })
        });
      }
      for (const action of await pendingProductionActions(accountId)) {
        if (action.outcome.status === 'pending') await actions.reconcile(action.id, accountId);
      }
      return readProduction(account, vesselId);
    },
    async operation(operationId, accountId, vesselId) {
      const operation = await requireOperation(operationId, accountId, vesselId);
      const page = await readProduction(await signedInAccount(accountId), vesselId);
      return {
        context: page.context,
        data: { operation },
        observations: page.observations,
        actions: [{
          id: `execute:${operationId}`,
          label: `Execute ${operation.label}`,
          endpoint: `/api/production/operations/${encodeURIComponent(operationId)}/execute`,
          method: 'POST',
          targetId: operation.authorityId,
          inputs: operation.inputs.map((field) => ({ name: field.name, required: field.required })),
          blockers: operation.blockers,
          expectedResult: operation.kind === 'mine' || operation.kind === 'manufacture' ? 'Production result or job reference' : 'Cargo handling result or job reference'
        }]
      };
    },
    async executeOperation(operationId, accountId, vesselId, rawInputs) {
      const account = await signedInAccount(accountId);
      const operation = await requireOperation(operationId, accountId, vesselId);
      const decoded = decodeOperationId(operationId);
      if (!decoded) throw new LogisticsRequestError(404, 'operation-not-found');
      const token = account.login.status === 'signed-in' ? account.login.nativeToken : '';
      const diplomatic = await deriveDiplomaticToken(token, operation.authorityId as URI);
      const fresh = await call((signal) => territorySnapshot(fetcher, operation.authorityId, vesselId, diplomatic, signal));
      const freshOperations = fresh.kind === 'policy' ? policyOperations(fresh) : simulationOperations(fresh);
      const current = freshOperations.find((candidate) => candidate.operationId === operationId);
      if (!current) throw new LogisticsRequestError(409, 'operation-no-longer-advertised');
      const sanitized: Record<string, unknown> = {};
      for (const field of current.inputs) {
        const supplied = rawInputs[field.name];
        if (field.type === 'count') {
          const value = supplied === undefined ? field.default : supplied;
          const count = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : undefined;
          if (count === undefined || !Number.isSafeInteger(count) || count < (field.minimum ?? 1)) {
            if (field.required) throw new LogisticsRequestError(400, `${field.name}-invalid`);
            continue;
          }
          sanitized[field.name] = count;
        } else {
          const value = supplied === undefined ? field.default : supplied;
          const choices = field.choices?.map((choice) => choice.value) ?? [];
          if (typeof value !== 'string' || (choices.length > 0 && !choices.includes(value))) {
            if (field.required) throw new LogisticsRequestError(400, `${field.name}-invalid`);
            continue;
          }
          sanitized[field.name] = value;
        }
      }
      const authorityKind = fresh.kind;
      const record = await actions.submit({
        accountId,
        targetId: operation.authorityId,
        intent: {
          kind: operation.kind,
          inputs: {
            ...sanitized,
            operationId,
            actionId: decoded.actionId,
            authorityId: operation.authorityId,
            vesselId,
            authorityKind,
            available: current.kind === 'transfer' || current.kind === 'load' || current.kind === 'unload' ? true : current.available,
            ...(current.blockers[0] === undefined ? {} : { blocker: current.blockers[0] })
          }
        }
      });
      return actions.reconcile(record.id, accountId);
    },
    async job(jobId, accountId, vesselId) {
      await signedInAccount(accountId);
      return jobPage(jobId, accountId, vesselId);
    },
    async refreshJob(jobId, accountId, vesselId) {
      await signedInAccount(accountId);
      const job = await refreshJobObservation(jobId, accountId, vesselId);
      return jobPage(job.jobId, accountId, vesselId);
    }
  };
}

export function createWorkflowActionHandlers(
  state: ClientApplicationState,
  fetcher: typeof fetch,
  observations: ObservationService,
  options: LogisticsServiceOptions = {}
): Record<string, ActionHandler> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const call = <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => withDeadline(timeoutMs, operation);

  const accountFor = async (accountId: string): Promise<AccountRecord & { login: { status: 'signed-in'; nativeToken: string } }> => {
    const account = await state.read((current) => current.accounts[accountId]);
    if (!account || account.login.status !== 'signed-in') throw new Error('A signed-in account is required');
    return account as AccountRecord & { login: { status: 'signed-in'; nativeToken: string } };
  };

  const registryStateFor = async (accountId: string, registryId: string, vesselId: string, signal: AbortSignal) => {
    const account = await accountFor(accountId);
    return readRegistryState(fetcher, registryId, vesselId, account.login.nativeToken, signal);
  };

  const entryOrDeparture = (kind: 'entry' | 'departure'): ActionHandler => ({
    async prepare(input) {
      if (!inputString(input.intent.inputs, 'registryId') || !inputString(input.intent.inputs, 'vesselId')) return { accepted: false, reason: 'Registry and vessel scope are required' };
      return { accepted: true };
    },
    async submit(input) {
      const registryId = requiredString(input.intent.inputs, 'registryId');
      const vesselId = requiredString(input.intent.inputs, 'vesselId');
      const territoryId = requiredString(input.intent.inputs, 'territoryId');
      const portId = requiredString(input.intent.inputs, 'portId');
      const account = await accountFor(input.accountId);
      const path = kind === 'entry' ? '/local/registry/entry' : '/local/registry/departure';
      const routeId = inputString(input.intent.inputs, 'routeId');
      const result = await submitRegistryAction(fetcher, {
        registryId,
        path,
        nativeToken: account.login.nativeToken,
        signal: input.signal,
        body: {
          vessel: vesselId,
          territory: territoryId,
          port: portId,
          ...(kind === 'entry' || routeId !== undefined ? { route: routeId } : {})
        }
      });
      const requestId = typeof result.id === 'string' ? result.id : undefined;
      if (!requestId) throw new Error('Registry did not return a request reference');
      return { result: requestId, references: [{ kind: 'request', id: requestId }] };
    },
    async reconcile(input) {
      const registryId = inputString(input.intent.inputs, 'registryId');
      const vesselId = inputString(input.intent.inputs, 'vesselId');
      const reference = input.references.find((candidate) => candidate.kind === 'request');
      if (!registryId || !vesselId || !reference) return { status: 'unverified', error: 'Registry scope or request reference is missing' };
      const view = await registryStateFor(input.accountId, registryId, vesselId, input.signal);
      return reconcileRegistryRequest(view, reference.id, new Date().toISOString());
    }
  });

  const adoption: ActionHandler = {
    async submit(input) {
      const registryId = requiredString(input.intent.inputs, 'registryId');
      const vesselId = requiredString(input.intent.inputs, 'vesselId');
      const adoption = input.intent.inputs.adoption;
      if (typeof adoption !== 'boolean') throw new Error('Adoption must be boolean');
      const account = await accountFor(input.accountId);
      await submitRegistryAction(fetcher, {
        registryId,
        path: '/local/registry/adoption',
        nativeToken: account.login.nativeToken,
        signal: input.signal,
        body: { vessel: vesselId, adoption }
      });
      return { result: `adoption-${adoption}` };
    },
    async reconcile(input) {
      const registryId = inputString(input.intent.inputs, 'registryId');
      const vesselId = inputString(input.intent.inputs, 'vesselId');
      const adoption = input.intent.inputs.adoption;
      if (!registryId || !vesselId || typeof adoption !== 'boolean') return { status: 'unverified', error: 'Registry scope is missing' };
      const view = await registryStateFor(input.accountId, registryId, vesselId, input.signal);
      const actual = view.payload.adoption === true;
      if (actual === adoption) return { status: 'completed', evidence: [{ source: view.source, observedAt: new Date().toISOString(), changes: { adoption: actual } }] };
      return { status: 'pending', evidence: [] };
    }
  };

  const production = (kind: ProductionOperation['kind']): ActionHandler => ({
    async prepare(input) {
      if (input.intent.inputs.available === false) return { accepted: false, reason: typeof input.intent.inputs.blocker === 'string' ? input.intent.inputs.blocker : 'Operation is blocked by the selected authority' };
      return { accepted: true };
    },
    async submit(input) {
      const authorityId = requiredString(input.intent.inputs, 'authorityId');
      const actionId = requiredString(input.intent.inputs, 'actionId');
      const vesselId = requiredString(input.intent.inputs, 'vesselId');
      const authorityKind = requiredString(input.intent.inputs, 'authorityKind');
      const account = await accountFor(input.accountId);
      const token = await deriveDiplomaticToken(account.login.nativeToken, authorityId as URI);
      const snapshot = await call((signal) => territorySnapshot(fetcher, authorityId, vesselId, token, signal));
       const execution = authorityKind === 'policy'
        ? policyExecution(snapshot as PolicySnapshot, actionId, kind, input.intent.inputs)
         : simulationExecution(snapshot as SimulationSnapshot, actionId, kind, input.intent.inputs);
      const before = authorityKind === 'policy'
        ? await readPolicyState(fetcher, authorityId, token, input.signal)
        : undefined;
      const evidenceBaseline = before === undefined ? undefined : [{
        source: before.source,
        observedAt: new Date().toISOString(),
        changes: { auditLength: Array.isArray(before.state.audit) ? before.state.audit.length : 0 }
      }];
      const response = await fetcher(execution.operation.request!.href, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(execution.body),
        cache: 'no-store',
        signal: input.signal
      });
      if (!response.ok) throw new Error(`Production submission failed: HTTP ${response.status}`);
      const text = await response.text();
      const payload: unknown = text ? JSON.parse(text) : {};
      if (!isRecord(payload)) throw new Error('Production response is malformed');
      if (authorityKind === 'policy') {
        if (payload.success === false) throw new Error(typeof payload.error === 'string' ? payload.error : 'Production submission was rejected');
        return { result: typeof payload.error === 'string' ? payload.error : 'production-accepted', ...(evidenceBaseline === undefined ? {} : { evidenceBaseline }) };
      }
      const localId = typeof payload.job === 'number' || typeof payload.job === 'string' ? String(payload.job) : undefined;
      if (!localId || !/^\d+$/.test(localId)) throw new Error('Simulation did not return a job reference');
      const jobId = encodeJobId(authorityId, localId);
      const observedAt = new Date().toISOString();
      const source = simulationStateSource(authorityId);
      const pending: ProductionJob = {
        jobId,
        authorityId,
        accountId: input.accountId,
        vesselId,
        operation: kind,
        status: 'pending',
        source,
        observedAt,
        progress: { ...(typeof input.intent.inputs.count === 'number' ? { count: input.intent.inputs.count } : {}) }
      };
      await observations.refresh<ProductionJob>({ key: jobKey(input.accountId, vesselId, jobId), source, load: async () => pending });
      return { result: `job ${jobId}`, references: [{ kind: 'job', id: jobId }] };
    },
    async reconcile(input) {
      const authorityKind = inputString(input.intent.inputs, 'authorityKind');
      if (authorityKind === 'policy') {
        if (input.action.submission.status !== 'accepted') return { status: 'unverified', error: 'Policy submission was not confirmed' };
        const authorityId = requiredString(input.intent.inputs, 'authorityId');
        const actionId = requiredString(input.intent.inputs, 'actionId');
        const vesselId = requiredString(input.intent.inputs, 'vesselId');
        const account = await accountFor(input.accountId);
        const token = await deriveDiplomaticToken(account.login.nativeToken, authorityId as URI);
        const snapshot = await call((signal) => territorySnapshot(fetcher, authorityId, vesselId, token, signal));
        const execution = policyExecution(snapshot as PolicySnapshot, actionId, kind, input.intent.inputs);
        const view = await call((signal) => readPolicyState(fetcher, authorityId, token, signal));
        const audit = Array.isArray(view.state.audit) ? view.state.audit.filter(isRecord) : [];
        const auditLength = input.action.submission.evidenceBaseline?.find((evidence) => evidence.source === view.source)?.changes?.auditLength;
        if (typeof auditLength !== 'number' || !Number.isSafeInteger(auditLength) || auditLength < 0) return { status: 'unverified', error: 'Pre-submission Policy observation is unavailable' };
        const expected = policyAuditAction(kind, execution.body);
        const match = audit.slice(auditLength).reverse().find((entry) => {
          if (entry.action !== expected || entry.outcome !== 'accepted') return false;
          if (entry.actor !== account.actorId) return false;
          const details = record(entry.details);
          if (typeof execution.body.count === 'number' && details.count !== execution.body.count) return false;
          if (kind === 'mine' && typeof execution.body.variety === 'string' && details.oreVariety !== execution.body.variety) return false;
          if (kind === 'manufacture' && typeof execution.body.recipe === 'string' && details.recipeId !== execution.body.recipe) return false;
          if ((kind === 'transfer' || kind === 'load' || kind === 'unload') && typeof execution.body.variety === 'string' && details.variety !== execution.body.variety) return false;
          return true;
        });
        if (match) return { status: 'completed', evidence: [{ source: view.source, observedAt: new Date().toISOString(), changes: { audit: match } }] };
        return { status: 'pending', evidence: [] };
      }
      const reference = input.references.find((candidate) => candidate.kind === 'job');
      const authorityId = requiredString(input.intent.inputs, 'authorityId');
      const vesselId = requiredString(input.intent.inputs, 'vesselId');
      if (!reference) return { status: 'unverified', error: 'A job reference is required' };
      const account = await accountFor(input.accountId);
      const token = await deriveDiplomaticToken(account.login.nativeToken, authorityId as URI);
      const view = await call((signal) => readSimulationState(fetcher, authorityId, token, signal));
      const context: SimulationJobContext = {
        authorityId,
        accountId: input.accountId,
        vesselId,
        operation: kind,
        source: view.source,
        observedAt: new Date().toISOString()
      };
      const job = simulationJobFromState(view.payload, reference.id, context);
      await observations.refresh<ProductionJob>({ key: jobKey(input.accountId, vesselId, reference.id), source: view.source, load: async () => job });
      if (job.status === 'completed') return { status: 'completed', evidence: job.evidence ?? [] };
      if (job.status === 'pending' || job.status === 'progress' || job.status === 'queued') return { status: 'pending', evidence: [] };
      return { status: 'unverified', error: job.error ?? 'Job completion evidence is unavailable' };
    }
  });

  return {
    entry: entryOrDeparture('entry'),
    departure: entryOrDeparture('departure'),
    adoption,
    mine: production('mine'),
    manufacture: production('manufacture'),
    transfer: production('transfer'),
    load: production('load'),
    unload: production('unload')
  };
}
