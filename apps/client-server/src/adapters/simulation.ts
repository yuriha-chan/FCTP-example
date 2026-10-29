import type { ActionEvidence, ProductionJob, ProductionOperation, ProductionOperationInput } from '@fctp/client-sdk';
import { encodeOperationId, localJobId, validateOperationRequest } from './operations.js';
import type { LocalActionShape } from './policy.js';

export interface SimulationSnapshot {
  authorityId: string;
  kind: 'simulation';
  source: string;
  observedAt: string;
  info: Record<string, unknown>;
  actions: LocalActionShape[];
  state: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function simulationKind(actionId: string): ProductionOperation['kind'] | undefined {
  if (actionId === 'mine' || actionId.startsWith('mine:')) return 'mine';
  if (actionId.startsWith('manufacture')) return 'manufacture';
  if (actionId === 'load' || actionId.startsWith('load:')) return 'load';
  if (actionId === 'unload' || actionId.startsWith('unload:')) return 'unload';
  return undefined;
}

export async function readSimulationSnapshot(
  fetcher: typeof fetch,
  authorityId: string,
  vesselId: string,
  diplomaticToken: string,
  signal: AbortSignal
): Promise<SimulationSnapshot> {
  const infoResponse = await fetcher(new URL('/local/info', authorityId).href, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal
  });
  if (!infoResponse.ok) throw new Error(`Simulation info unavailable: HTTP ${infoResponse.status}`);
  const infoValue: unknown = await infoResponse.json();
  if (!isRecord(infoValue) || infoValue.kind !== 'simulation') throw new Error('Authority is not a simulation Territory');
  const endpoint = new URL('/local/actions', authorityId);
  endpoint.searchParams.set('vessel', vesselId);
  const source = endpoint.href;
  const response = await fetcher(source, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${diplomaticToken}` },
    cache: 'no-store',
    signal
  });
  if (!response.ok) throw new Error(`Simulation actions unavailable: HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.actions)) throw new Error('Simulation actions response is malformed');
  const actions = payload.actions.flatMap((entry): LocalActionShape[] => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.label !== 'string') return [];
    const request = isRecord(entry.request) && typeof entry.request.href === 'string'
      ? { method: typeof entry.request.method === 'string' ? entry.request.method : 'POST', href: entry.request.href, ...(isRecord(entry.request.body) ? { body: entry.request.body } : {}) }
      : undefined;
    return [{
      id: entry.id,
      label: entry.label,
      available: entry.available === true,
      ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
      ...(request === undefined ? {} : { request }),
      effect: typeof entry.effect === 'string' ? entry.effect : ''
    }];
  });
  return {
    authorityId,
    kind: 'simulation',
    source,
    observedAt: typeof payload.observedAt === 'string' ? payload.observedAt : new Date().toISOString(),
    info: infoValue,
    actions,
    state: record(payload.state)
  };
}

function cargoEntry(action: LocalActionShape): Record<string, unknown> | undefined {
  const cargo = action.request?.body?.cargo;
  if (!isRecord(cargo) || !Array.isArray(cargo.entries)) return undefined;
  return cargo.entries.flatMap((entry) => isRecord(entry) ? [entry] : [])[0];
}

function recipeChoices(info: Record<string, unknown>, actions: LocalActionShape[]): Array<{ value: string; label: string }> {
  const choices = actions.filter((action) => action.id.startsWith('manufacture')).flatMap((action) => {
    const recipe = action.request?.body?.recipe;
    if (typeof recipe !== 'string') return [];
    return [{ value: recipe, label: recipe }];
  });
  const production = record(info.production);
  if (choices.length === 0) for (const key of Object.keys(production)) choices.push({ value: key, label: key });
  return choices.filter((choice, index) => choices.findIndex((candidate) => candidate.value === choice.value) === index);
}

export function simulationOperations(snapshot: SimulationSnapshot): ProductionOperation[] {
  const operations: ProductionOperation[] = [];
  const recipes = recipeChoices(snapshot.info, snapshot.actions);
  for (const action of snapshot.actions) {
    const kind = simulationKind(action.id);
    if (!kind || !action.request) continue;
    const body = action.request.body ?? {};
    const inputs: ProductionOperationInput[] = [];
    const defaults: Record<string, string | number> = {};
    if (kind === 'mine') {
      inputs.push({ name: 'count', label: 'Quantity', type: 'count', required: true, default: typeof body.count === 'number' ? body.count : 1, minimum: 1 });
      inputs.push({ name: 'duration', label: 'Duration', type: 'count', required: true, default: typeof body.duration === 'number' ? body.duration : 1, minimum: 1 });
      defaults.count = typeof body.count === 'number' ? body.count : 1;
      defaults.duration = typeof body.duration === 'number' ? body.duration : 1;
    } else if (kind === 'manufacture') {
      inputs.push({ name: 'recipe', label: 'Recipe', type: 'choice', required: true, ...(typeof body.recipe === 'string' ? { default: body.recipe } : {}), choices: recipes });
      inputs.push({ name: 'count', label: 'Quantity', type: 'count', required: true, default: 1, minimum: 1 });
      if (typeof body.recipe === 'string') defaults.recipe = body.recipe;
      defaults.count = typeof body.count === 'number' ? body.count : 1;
    } else {
      const entry = cargoEntry(action);
      const variety = typeof entry?.variety === 'string' ? entry.variety : undefined;
      if (variety !== undefined) {
        inputs.push({ name: 'variety', label: 'Variety', type: 'choice', required: true, default: variety, choices: [{ value: variety, label: variety }] });
        defaults.variety = variety;
      }
      inputs.push({ name: 'count', label: 'Quantity', type: 'count', required: true, default: typeof entry?.count === 'number' ? entry.count : 1, minimum: 1 });
      inputs.push({ name: 'duration', label: 'Duration', type: 'count', required: true, default: typeof body.duration === 'number' ? body.duration : 1, minimum: 1 });
      defaults.count = typeof entry?.count === 'number' ? entry.count : 1;
      defaults.duration = typeof body.duration === 'number' ? body.duration : 1;
    }
    operations.push({
      operationId: encodeOperationId(snapshot.authorityId, action.id),
      authorityId: snapshot.authorityId,
      kind,
      label: action.label,
      effect: action.effect,
      inputs,
      defaults,
      blockers: action.available ? [] : [action.reason ?? 'Blocked by local Territory rules'],
      available: action.available,
      outputDestination: kind === 'load' ? 'Vessel cargo' : kind === 'unload' ? 'Shared local stock' : 'Queued local production',
      source: snapshot.source,
      observedAt: snapshot.observedAt
    });
  }
  return operations;
}

export interface SimulationExecution {
  body: Record<string, unknown>;
  operation: LocalActionShape;
}

export function simulationExecution(snapshot: SimulationSnapshot, actionId: string, kind: ProductionOperation['kind'], inputs: Record<string, unknown>): SimulationExecution {
  const action = snapshot.actions.find((candidate) => candidate.id === actionId);
  if (!action?.request) throw new Error('Operation is no longer advertised');
  validateOperationRequest(snapshot.authorityId, kind, action.request);
  const base = action.request.body ?? {};
  const duration = inputs.duration === undefined ? (typeof base.duration === 'number' ? base.duration : 1) : inputs.duration;
  if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 1) throw new Error('duration must be a positive integer');
  const count = inputs.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) throw new Error('count must be a positive integer');
  if (kind === 'mine') return { body: { count, duration }, operation: action };
  if (kind === 'manufacture') {
    const recipe = inputs.recipe;
    const choices = recipeChoices(snapshot.info, snapshot.actions).map((choice) => choice.value);
    if (typeof recipe !== 'string' || !choices.includes(recipe)) throw new Error('recipe is not supported by this authority');
    return { body: { recipe, count }, operation: action };
  }
  const entry = cargoEntry(action);
  if (!entry || typeof entry.variety !== 'string') throw new Error('Operation has no advertised cargo item');
  if (inputs.variety !== undefined && inputs.variety !== entry.variety) throw new Error('variety is not supported by this operation');
  const requested = typeof entry.id === 'string' ? { ...entry, count: 1 } : { ...entry, count };
  const body: Record<string, unknown> = {
    entryRequest: base.entryRequest,
    cargo: { entries: [requested] },
    duration
  };
  return { body, operation: action };
}

export function simulationStateSource(authorityId: string): string {
  return new URL('/local/state', authorityId).href;
}

export function simulationTerritorySummary(snapshot: SimulationSnapshot): Record<string, unknown> {
  const state = snapshot.state;
  return {
    authorityId: snapshot.authorityId,
    kind: 'simulation',
    visit: state.visit ?? null,
    cargo: record(state.visit).cargo ?? null,
    sharedStock: state.sharedStock ?? { raw: [], products: [] },
    queuedProduction: Array.isArray(state.queuedProduction) ? state.queuedProduction : [],
    facilities: state.facilities ?? null
  };
}

export interface SimulationJobContext {
  authorityId: string;
  accountId: string;
  vesselId: string;
  operation: ProductionOperation['kind'];
  source: string;
  observedAt: string;
}

export function simulationJobFromState(
  payload: Record<string, unknown>,
  jobId: string,
  context: SimulationJobContext
): ProductionJob {
  const simulation = record(payload.simulation);
  const production = Array.isArray(simulation.productionJobs) ? simulation.productionJobs.filter(isRecord) : [];
  const handling = Array.isArray(simulation.handlingJobs) ? simulation.handlingJobs.filter(isRecord) : [];
  const numeric = Number(localJobId(jobId, context.authorityId));
  const productionJob = production.find((job) => job.id === numeric);
  const handlingJob = handling.find((job) => job.id === numeric);
  const pending = productionJob ?? handlingJob;
  if (pending) {
    return {
      jobId,
      authorityId: context.authorityId,
      accountId: context.accountId,
      vesselId: context.vesselId,
      operation: context.operation,
      status: 'pending',
      source: context.source,
      observedAt: context.observedAt,
      progress: {
        ...(typeof pending.remainingTicks === 'number' ? { remainingTicks: pending.remainingTicks } : {}),
        ...(typeof simulation.tick === 'number' ? { tick: simulation.tick } : {}),
        ...(typeof pending.count === 'number' ? { count: pending.count } : {})
      }
    };
  }
  const audit = Array.isArray(simulation.audit) ? simulation.audit.filter(isRecord) : [];
  const completed = [...audit].reverse().find((entry) => {
    const details = record(entry.details);
    return details.id === numeric && (entry.action === 'complete-production' || entry.action === 'complete-load' || entry.action === 'complete-unload');
  });
  if (completed) {
    const details = record(completed.details);
    const evidence: ActionEvidence[] = [{ source: context.source, observedAt: context.observedAt, changes: { audit: completed } }];
    return {
      jobId,
      authorityId: context.authorityId,
      accountId: context.accountId,
      vesselId: context.vesselId,
      operation: context.operation,
      status: 'completed',
      source: context.source,
      observedAt: context.observedAt,
      ...(typeof details.output === 'string' ? { output: details.output } : {}),
      ...(details.cargo === undefined ? {} : { cargo: details.cargo }),
      ...(typeof details.count === 'number' ? { progress: { count: details.count, ...(typeof simulation.tick === 'number' ? { tick: simulation.tick } : {}) } } : { progress: typeof simulation.tick === 'number' ? { tick: simulation.tick } : {} }),
      evidence
    };
  }
  return {
    jobId,
    authorityId: context.authorityId,
    accountId: context.accountId,
    vesselId: context.vesselId,
    operation: context.operation,
    status: 'unverified',
    source: context.source,
    observedAt: context.observedAt,
    error: 'Job is absent without correlated completion evidence'
  };
}

export interface SimulationStateView {
  authorityId: string;
  source: string;
  payload: Record<string, unknown>;
}

export async function readSimulationState(fetcher: typeof fetch, authorityId: string, diplomaticToken: string, signal: AbortSignal): Promise<SimulationStateView> {
  const source = simulationStateSource(authorityId);
  const response = await fetcher(source, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${diplomaticToken}` },
    cache: 'no-store',
    signal
  });
  if (!response.ok) throw new Error(`Simulation state unavailable: HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error('Simulation state response is malformed');
  return { authorityId, source, payload };
}
