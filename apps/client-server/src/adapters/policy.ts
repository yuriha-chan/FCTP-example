import type { ProductionOperation, ProductionOperationInput } from '@fctp/client-sdk';
import { encodeOperationId, validateOperationRequest } from './operations.js';

export interface LocalActionShape {
  id: string;
  label: string;
  available: boolean;
  reason?: string;
  request?: { method: string; href: string; body?: Record<string, unknown> };
  effect: string;
}

export interface PolicySnapshot {
  authorityId: string;
  kind: 'policy';
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export function policyKind(actionId: string): ProductionOperation['kind'] | undefined {
  if (actionId.startsWith('mine')) return 'mine';
  if (actionId.startsWith('manufacture')) return 'manufacture';
  if (actionId.startsWith('to-port') || actionId.startsWith('to-warehouse')) return 'transfer';
  if (actionId.startsWith('load')) return 'load';
  if (actionId.startsWith('unload')) return 'unload';
  return undefined;
}

export async function readPolicySnapshot(
  fetcher: typeof fetch,
  authorityId: string,
  vesselId: string,
  diplomaticToken: string,
  signal: AbortSignal
): Promise<PolicySnapshot> {
  const infoResponse = await fetcher(new URL('/local/info', authorityId).href, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal
  });
  if (!infoResponse.ok) throw new Error(`Policy info unavailable: HTTP ${infoResponse.status}`);
  const infoValue: unknown = await infoResponse.json();
  if (!isRecord(infoValue) || infoValue.kind !== 'policy') throw new Error('Authority is not a policy Territory');
  const endpoint = new URL('/local/actions', authorityId);
  endpoint.searchParams.set('vessel', vesselId);
  const source = endpoint.href;
  const response = await fetcher(source, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${diplomaticToken}` },
    cache: 'no-store',
    signal
  });
  if (!response.ok) throw new Error(`Policy actions unavailable: HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.actions)) throw new Error('Policy actions response is malformed');
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
    kind: 'policy',
    source,
    observedAt: typeof payload.observedAt === 'string' ? payload.observedAt : new Date().toISOString(),
    info: infoValue,
    actions,
    state: record(payload.state)
  };
}

function recipeChoices(info: Record<string, unknown>, actions: LocalActionShape[]): Array<{ value: string; label: string }> {
  const production = record(info.production);
  const recipes = Array.isArray(production.recipes) ? production.recipes.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string') return [];
    return [{ value: entry.id, label: typeof entry.output === 'string' ? `Recipe for ${entry.output}` : entry.id }];
  }) : [];
  const advertised = actions.filter((action) => action.id.startsWith('manufacture')).flatMap((action) => {
    const recipe = action.request?.body?.recipe;
    return typeof recipe === 'string' ? [{ value: recipe, label: recipe }] : [];
  });
  const choices = [...recipes, ...advertised];
  return choices.filter((choice, index) => choices.findIndex((candidate) => candidate.value === choice.value) === index);
}

function varietyChoices(info: Record<string, unknown>): Array<{ value: string; label: string }> {
  const ids = record(info.ids);
  const varieties = record(ids.varieties);
  return Object.entries(varieties).flatMap(([name, value]) => typeof value === 'string' ? [{ value, label: name }] : []);
}

function uniqueChoices(choices: Array<{ value: string; label: string }>): Array<{ value: string; label: string }> {
  return choices.filter((choice, index) => choices.findIndex((candidate) => candidate.value === choice.value) === index);
}

export function policyOperations(snapshot: PolicySnapshot): ProductionOperation[] {
  const operations: ProductionOperation[] = [];
  const recipes = recipeChoices(snapshot.info, snapshot.actions);
  const varieties = varietyChoices(snapshot.info);
  for (const action of snapshot.actions) {
    const kind = policyKind(action.id);
    if (!kind || !action.request) continue;
    const body = action.request.body ?? {};
    const inputs: ProductionOperationInput[] = [];
    const defaults: Record<string, string | number> = {};
    if (kind === 'mine') {
      inputs.push({ name: 'count', label: 'Quantity', type: 'count', required: true, default: 1, minimum: 1 });
      defaults.count = typeof body.count === 'number' ? body.count : 1;
    } else if (kind === 'manufacture') {
      inputs.push({ name: 'recipe', label: 'Recipe', type: 'choice', required: true, choices: recipes, ...(typeof body.recipe === 'string' ? { default: body.recipe } : {}) });
      inputs.push({ name: 'count', label: 'Quantity', type: 'count', required: true, default: 1, minimum: 1 });
      if (typeof body.recipe === 'string') defaults.recipe = body.recipe;
      defaults.count = typeof body.count === 'number' ? body.count : 1;
    } else if (kind === 'transfer') {
      const direction = typeof body.direction === 'string' ? body.direction : 'to-port';
      const varied = varieties.length > 0 ? varieties : (typeof body.variety === 'string' ? [{ value: body.variety, label: body.variety }] : []);
      const variety = typeof body.variety === 'string' ? body.variety : varied[0]?.value;
      const directions = uniqueChoices(snapshot.actions.filter((action) => policyKind(action.id) === 'transfer').flatMap((action) => {
        const advertised = action.request?.body?.direction;
        return typeof advertised === 'string' ? [{ value: advertised, label: advertised === 'to-port' ? 'To port' : 'To warehouse' }] : [];
      }));
      inputs.push({ name: 'direction', label: 'Direction', type: 'choice', required: true, default: direction, choices: directions.length > 0 ? directions : [{ value: direction, label: direction === 'to-port' ? 'To port' : 'To warehouse' }] });
      inputs.push({ name: 'variety', label: 'Variety', type: 'choice', required: true, ...(variety === undefined ? {} : { default: variety }), choices: varied });
      inputs.push({ name: 'count', label: 'Quantity', type: 'count', required: true, default: 1, minimum: 1 });
      defaults.direction = direction;
      if (variety !== undefined) defaults.variety = variety;
      defaults.count = typeof body.count === 'number' ? body.count : 1;
    } else {
      const varied = varieties.length > 0 ? varieties : (typeof body.variety === 'string' ? [{ value: body.variety, label: body.variety }] : []);
      const variety = typeof body.variety === 'string' ? body.variety : varied[0]?.value;
      inputs.push({ name: 'variety', label: 'Variety', type: 'choice', required: true, ...(variety === undefined ? {} : { default: variety }), choices: varied });
      inputs.push({ name: 'count', label: 'Quantity', type: 'count', required: true, default: 1, minimum: 1 });
      if (variety !== undefined) defaults.variety = variety;
      defaults.count = typeof body.count === 'number' ? body.count : 1;
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
      outputDestination: kind === 'load' ? 'Vessel cargo' : 'Shared Territory stock',
      source: snapshot.source,
      observedAt: snapshot.observedAt
    });
  }
  return operations;
}

export interface PolicyExecution {
  body: Record<string, unknown>;
  operation: LocalActionShape;
}

export function policyExecution(snapshot: PolicySnapshot, actionId: string, kind: ProductionOperation['kind'], inputs: Record<string, unknown>): PolicyExecution {
  const action = snapshot.actions.find((candidate) => candidate.id === actionId);
  if (!action?.request) throw new Error('Operation is no longer advertised');
  validateOperationRequest(snapshot.authorityId, kind, action.request);
  const body = { ...(action.request.body ?? {}) };
  const count = inputs.count;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) throw new Error('count must be a positive integer');
  body.count = count;
  if (kind === 'manufacture') {
    const recipe = inputs.recipe;
    const choices = recipeChoices(snapshot.info, snapshot.actions).map((choice) => choice.value);
    if (typeof recipe !== 'string' || !choices.includes(recipe)) throw new Error('recipe is not supported by this authority');
    body.recipe = recipe;
  }
  if (kind === 'transfer') {
    const direction = inputs.direction;
    const directions = uniqueChoices(snapshot.actions.filter((candidate) => policyKind(candidate.id) === 'transfer').flatMap((candidate) => {
      const advertised = candidate.request?.body?.direction;
      return typeof advertised === 'string' ? [{ value: advertised, label: advertised }] : [];
    })).map((choice) => choice.value);
    if (typeof direction !== 'string' || (directions.length > 0 && !directions.includes(direction))) throw new Error('direction is not supported by this authority');
    const variety = inputs.variety;
    const varieties = varietyChoices(snapshot.info).map((choice) => choice.value);
    if (typeof variety !== 'string' || (varieties.length > 0 && !varieties.includes(variety))) throw new Error('variety is not supported by this authority');
    body.direction = direction;
    body.variety = variety;
  }
  if (kind === 'load' || kind === 'unload') {
    const variety = inputs.variety;
    const varieties = varietyChoices(snapshot.info).map((choice) => choice.value);
    if (typeof variety !== 'string' || (varieties.length > 0 && !varieties.includes(variety))) throw new Error('variety is not supported by this authority');
    body.variety = variety;
  }
  return { body, operation: action };
}

export function policyExecutionSource(snapshot: PolicySnapshot, action: LocalActionShape): string {
  return action.request?.href ?? snapshot.source;
}

export function policyStateSource(authorityId: string): string {
  return new URL('/local/state', authorityId).href;
}

export function policyAuditAction(kind: ProductionOperation['kind'], body: Record<string, unknown>): string {
  if (kind === 'mine') return 'mine';
  if (kind === 'manufacture') return 'manufacture';
  if (kind === 'transfer') return body.direction === 'to-port' ? 'warehouse-to-port' : 'port-to-warehouse';
  return kind;
}

export function policyTerritorySummary(snapshot: PolicySnapshot): Record<string, unknown> {
  const state = snapshot.state;
  return {
    authorityId: snapshot.authorityId,
    kind: 'policy',
    rawInventory: record(state.rawInventory),
    portInventory: record(state.portInventory),
    sharedStock: { warehouse: record(state.rawInventory), port: record(state.portInventory) },
    visit: Array.isArray(state.visits) ? state.visits[0] ?? null : null,
    cargo: state.cargo ?? null
  };
}

export function policyVarietyIds(info: Record<string, unknown>): string[] {
  return stringArray(record(record(info.ids).varieties) ? Object.values(record(record(info.ids).varieties)) : []);
}

export interface PolicyStateView {
  authorityId: string;
  source: string;
  payload: Record<string, unknown>;
  state: Record<string, unknown>;
}

export async function readPolicyState(fetcher: typeof fetch, authorityId: string, diplomaticToken: string, signal: AbortSignal): Promise<PolicyStateView> {
  const source = policyStateSource(authorityId);
  const response = await fetcher(source, {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${diplomaticToken}` },
    cache: 'no-store',
    signal
  });
  if (!response.ok) throw new Error(`Policy state unavailable: HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error('Policy state response is malformed');
  return { authorityId, source, payload, state: record(payload.state) };
}
