import { validateModel, type CargoManifest, type Production, type Variety } from '@fctp/protocol';

export interface Commodity {
  variety: Variety;
  mass: number;
}

export interface Recipe {
  id: string;
  ingredients: Record<string, number>;
  output: string;
  outputCount: number;
}

export interface Policy {
  miningPermitted: boolean;
  miningQuota: number;
  oreReserve: number;
  manufacturePermits: string[];
  recipes: Recipe[];
  warehouseLimits: Record<string, number>;
  portLimits: Record<string, number>;
  decisions: Record<string, 'allow' | 'deny'>;
  varietyPortPolicy?: Record<string, 'allow' | 'deny'>;
  admission?: {
    registryAcceptance?: string[];
    territoryAcceptance?: string[];
    mismatchPolicy?: 'declared' | 'evidence' | 'reject';
    publicPorts?: string[];
  };
}

export interface VesselCargo { capacity: number; manifest: CargoManifest }
export interface AuditEntry { actor: string; action: string; outcome: 'accepted' | 'rejected'; details: Record<string, unknown> }
export interface TerritoryState {
  policy: Policy;
  commodities: Record<string, Commodity>;
  rawInventory: Record<string, number>;
  productionReservations: Record<string, number>;
  portInventory: Record<string, number>;
  vessels: Record<string, VesselCargo>;
  audit: AuditEntry[];
}

export type OperationResult = { success: true; state: TerritoryState } | { success: false; state: TerritoryState; error: string };

const validCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const clone = <T>(value: T): T => structuredClone(value);
const hasEmptyData = (data: Record<string, unknown>): boolean => Object.keys(data).length === 0;
const rejected = (state: TerritoryState, action: string, error: string, details: Record<string, unknown> = {}, actor = 'system'): OperationResult => ({
  success: false,
  state: { ...state, audit: [...state.audit, { actor, action, outcome: 'rejected', details: { ...details, error } }] },
  error
});
const accepted = (state: TerritoryState, action: string, details: Record<string, unknown>, actor = 'system'): OperationResult => ({
  success: true,
  state: { ...state, audit: [...state.audit, { actor, action, outcome: 'accepted', details }] }
});
const localCount = (state: TerritoryState, inventory: Record<string, number>, variety: string): number => inventory[variety] ?? 0;
const mass = (state: TerritoryState, manifest: CargoManifest): number => manifest.entries.reduce((sum, item) => {
  const commodity = state.commodities[item.variety];
  return sum + (commodity?.mass ?? Infinity) * ('id' in item ? 1 : item.count);
}, 0);
const countManifest = (manifest: CargoManifest, variety: string): number => manifest.entries.reduce((sum, item) =>
  sum + (item.variety === variety && !('id' in item) && hasEmptyData(item.data) ? item.count : 0), 0);
const addManifestCount = (manifest: CargoManifest, variety: string, count: number): CargoManifest => {
  const entries = clone(manifest.entries);
  const stack = entries.find((item) => item.variety === variety && !('id' in item) && hasEmptyData(item.data));
  if (stack && !('id' in stack)) stack.count += count;
  else entries.push({ variety, count, data: {} });
  return { ...manifest, entries };
};
const subtractManifestCount = (manifest: CargoManifest, variety: string, count: number): CargoManifest => {
  let remaining = count;
  const entries = manifest.entries.flatMap((item) => {
    if (item.variety !== variety || remaining === 0 || 'id' in item || !hasEmptyData(item.data)) return [clone(item)];
    const amount = item.count;
    const removed = Math.min(amount, remaining);
    remaining -= removed;
    return amount > removed ? [{ ...clone(item), count: amount - removed }] : [];
  });
  return { ...manifest, entries };
};

export function createTerritoryState(policy: Policy, commodities: Commodity[]): TerritoryState {
  return {
    policy: clone(policy),
    commodities: Object.fromEntries(commodities.map((commodity) => [commodity.variety.id, clone(commodity)])),
    rawInventory: {}, productionReservations: {}, portInventory: {}, vessels: {}, audit: []
  };
}

export function changePolicy(state: TerritoryState, policy: Policy, actor: string): OperationResult {
  if (!actor.trim() || !validCount(policy.miningQuota) || !validCount(policy.oreReserve) ||
      Object.values(policy.warehouseLimits).some((n) => !validCount(n)) || Object.values(policy.portLimits).some((n) => !validCount(n)) ||
      policy.recipes.some((recipe) => !validCount(recipe.outputCount) || Object.values(recipe.ingredients).some((n) => !validCount(n)))) {
    return rejected(state, 'policy-change', 'Invalid policy or actor');
  }
  return { success: true, state: { ...state, policy: clone(policy), audit: [...state.audit, { actor, action: 'policy-change', outcome: 'accepted', details: { policy: clone(policy) } }] } };
}

export function mineOre(state: TerritoryState, oreVariety: string, count: number, actor = 'system'): OperationResult {
  if (!state.policy.miningPermitted) return rejected(state, 'mine', 'Mining is not permitted', { oreVariety, count }, actor);
  if (!validCount(count) || count === 0 || count > state.policy.miningQuota || count > state.policy.oreReserve) return rejected(state, 'mine', 'Mining quota or reserve exceeded', { oreVariety, count }, actor);
  const nextCount = localCount(state, state.rawInventory, oreVariety) + count;
  if (!state.commodities[oreVariety]?.variety.production?.some((production) => production.type === 'mine') || nextCount > (state.policy.warehouseLimits[oreVariety] ?? Infinity)) return rejected(state, 'mine', 'Commodity has no configured mining production or warehouse limit exceeded', { oreVariety, count }, actor);
  const next = { ...state, rawInventory: { ...state.rawInventory, [oreVariety]: nextCount }, policy: { ...state.policy, oreReserve: state.policy.oreReserve - count, miningQuota: state.policy.miningQuota - count } };
  return accepted(next, 'mine', { oreVariety, count }, actor);
}

export function manufacture(state: TerritoryState, recipeId: string, count: number, actor = 'system'): OperationResult {
  const recipe = state.policy.recipes.find((entry) => entry.id === recipeId);
  if (!recipe || !state.policy.manufacturePermits.includes(recipeId)) return rejected(state, 'manufacture', 'Manufacturing is not permitted', { recipeId, count }, actor);
  if (!validCount(count) || count === 0) return rejected(state, 'manufacture', 'Invalid production count', { recipeId, count }, actor);
  const required = Object.entries(recipe.ingredients).map(([variety, amount]) => [variety, amount * count] as const);
  const outputCount = recipe.outputCount * count;
  if (!validCount(outputCount) || required.some(([, amount]) => !validCount(amount))) return rejected(state, 'manufacture', 'Production quantity exceeds safe limits', { recipeId, count }, actor);
  if (required.some(([variety, amount]) => !state.commodities[variety] || localCount(state, state.rawInventory, variety) < amount)) return rejected(state, 'manufacture', 'Insufficient ingredients', { recipeId, count }, actor);
  if (!state.commodities[recipe.output] || localCount(state, state.rawInventory, recipe.output) + outputCount > (state.policy.warehouseLimits[recipe.output] ?? Infinity)) return rejected(state, 'manufacture', 'Unknown output or warehouse limit exceeded', { recipeId, count }, actor);
  const rawInventory = { ...state.rawInventory };
  for (const [variety, amount] of required) rawInventory[variety] = rawInventory[variety]! - amount;
  rawInventory[recipe.output] = (rawInventory[recipe.output] ?? 0) + outputCount;
  return accepted({ ...state, rawInventory }, 'manufacture', { recipeId, count, outputCount }, actor);
}

export function transferWarehouseToPort(state: TerritoryState, variety: string, count: number, actor = 'system'): OperationResult {
  if (!validCount(count) || count === 0 || localCount(state, state.rawInventory, variety) < count) return rejected(state, 'warehouse-to-port', 'Insufficient warehouse stock or invalid count', { variety, count }, actor);
  if (localCount(state, state.portInventory, variety) + count > (state.policy.portLimits[variety] ?? Infinity)) return rejected(state, 'warehouse-to-port', 'Port stock limit exceeded', { variety, count }, actor);
  const rawInventory = { ...state.rawInventory, [variety]: state.rawInventory[variety]! - count };
  const portInventory = { ...state.portInventory, [variety]: localCount(state, state.portInventory, variety) + count };
  return accepted({ ...state, rawInventory, portInventory }, 'warehouse-to-port', { variety, count }, actor);
}

export function transferPortToWarehouse(state: TerritoryState, variety: string, count: number, actor = 'system'): OperationResult {
  if (!validCount(count) || count === 0 || localCount(state, state.portInventory, variety) < count) return rejected(state, 'port-to-warehouse', 'Insufficient port stock or invalid count', { variety, count }, actor);
  if (localCount(state, state.rawInventory, variety) + count > (state.policy.warehouseLimits[variety] ?? Infinity)) return rejected(state, 'port-to-warehouse', 'Warehouse limit exceeded', { variety, count }, actor);
  return accepted({ ...state, portInventory: { ...state.portInventory, [variety]: state.portInventory[variety]! - count }, rawInventory: { ...state.rawInventory, [variety]: localCount(state, state.rawInventory, variety) + count } }, 'port-to-warehouse', { variety, count }, actor);
}

export function prepareVessel(state: TerritoryState, vesselId: string, capacity: number, cargo: CargoManifest = { entries: [] }, actor = 'system'): OperationResult {
  const validation = validateModel<CargoManifest>(cargo, 'CargoManifest');
  const itemIds = validation.success ? validation.data.entries.flatMap((item) => 'id' in item ? [item.id] : []) : [];
  if (!vesselId || !Number.isFinite(capacity) || capacity < 0 || vesselId in state.vessels || !validation.success || new Set(itemIds).size !== itemIds.length || !Number.isFinite(mass(state, cargo)) || mass(state, cargo) > capacity) return rejected(state, 'prepare-vessel', 'Invalid vessel or cargo capacity', { vesselId, capacity }, actor);
  return accepted({ ...state, vessels: { ...state.vessels, [vesselId]: { capacity, manifest: clone(cargo) } } }, 'prepare-vessel', { vesselId }, actor);
}

export function removeVessel(state: TerritoryState, vesselId: string): OperationResult {
  if (!state.vessels[vesselId]) return rejected(state, 'remove-vessel', 'Unknown vessel', { vesselId });
  if (state.vessels[vesselId].manifest.entries.length > 0) return rejected(state, 'remove-vessel', 'Cannot remove a vessel carrying cargo', { vesselId });
  const vessels = { ...state.vessels };
  delete vessels[vesselId];
  return accepted({ ...state, vessels }, 'remove-vessel', { vesselId });
}

export function exitVessel(state: TerritoryState, vesselId: string, actor = 'system'): OperationResult {
  if (!state.vessels[vesselId]) return rejected(state, 'exit-vessel', 'Unknown vessel', { vesselId }, actor);
  const vessels = { ...state.vessels };
  delete vessels[vesselId];
  return accepted({ ...state, vessels }, 'exit-vessel', { vesselId }, actor);
}

export function loadCargo(state: TerritoryState, vesselId: string, variety: string, count: number, actor = 'system'): OperationResult {
  if (state.policy.varietyPortPolicy?.[variety] === 'deny') return rejected(state, 'load', 'Variety is denied by local port policy', { vesselId, variety, count }, actor);
  const vessel = state.vessels[vesselId];
  const commodity = state.commodities[variety];
  if (!vessel || !commodity || !validCount(count) || count === 0 || localCount(state, state.portInventory, variety) < count) return rejected(state, 'load', 'Unknown vessel/commodity or insufficient port stock', { vesselId, variety, count }, actor);
  const manifest = addManifestCount(vessel.manifest, variety, count);
  if (mass(state, manifest) > vessel.capacity) return rejected(state, 'load', 'Vessel capacity exceeded', { vesselId, variety, count }, actor);
  return accepted({ ...state, portInventory: { ...state.portInventory, [variety]: state.portInventory[variety]! - count }, vessels: { ...state.vessels, [vesselId]: { ...vessel, manifest } } }, 'load', { vesselId, variety, count }, actor);
}

export function unloadCargo(state: TerritoryState, vesselId: string, variety: string, count: number, actor = 'system'): OperationResult {
  if (state.policy.varietyPortPolicy?.[variety] === 'deny') return rejected(state, 'unload', 'Variety is denied by local port policy', { vesselId, variety, count }, actor);
  const vessel = state.vessels[vesselId];
  if (!vessel || !validCount(count) || count === 0 || countManifest(vessel.manifest, variety) < count) return rejected(state, 'unload', 'Unknown vessel or insufficient cargo', { vesselId, variety, count }, actor);
  if (localCount(state, state.portInventory, variety) + count > (state.policy.portLimits[variety] ?? Infinity)) return rejected(state, 'unload', 'Port stock limit exceeded', { vesselId, variety, count }, actor);
  const manifest = subtractManifestCount(vessel.manifest, variety, count);
  return accepted({ ...state, portInventory: { ...state.portInventory, [variety]: localCount(state, state.portInventory, variety) + count }, vessels: { ...state.vessels, [vesselId]: { ...vessel, manifest } } }, 'unload', { vesselId, variety, count }, actor);
}

export const territoryAProduction: { ore: Variety; metal: Variety; recipes: Recipe[]; production: Production[] } = {
  ore: { id: 'https://fctp.example/variety/ore', name: 'Ore', holder: 'https://fctp.example/territory/a', mass: 2, version: '1', production: [{ type: 'mine', duration: 0, yield: [{ probability: 1, count: 1, data: {} }] }] },
  metal: { id: 'https://fctp.example/variety/metal', name: 'Metal', holder: 'https://fctp.example/territory/a', mass: 1, version: '1' },
  recipes: [{ id: 'ore-to-metal', ingredients: { 'https://fctp.example/variety/ore': 2 }, output: 'https://fctp.example/variety/metal', outputCount: 1 }],
  production: [
    { type: 'mine', duration: 0, yield: [{ probability: 1, count: 1, data: {} }] },
    { type: 'manufacture', duration: 0, ingredients: [{ variety: 'https://fctp.example/variety/ore', count: 2, data: {} }], yield: [{ probability: 1, count: 1, data: {} }] }
  ]
};
