import type { CargoManifest, Quantity } from '@fctp/protocol';

export interface SimulationConfig {
  commodities: {
    ore: string;
    nativeMetal: string;
    importedMetal: string;
    refinedProduct: string;
  };
  commodityMasses: Record<string, number>;
  depositAmount: number;
  miningCapacity: number;
  miningEnabled: boolean;
  manufacturingSlots: number;
  manufacturingTime: number;
  portCapacity: number;
  berthCapacity: number;
}

export interface VesselCargo {
  commodity: string;
  count: number;
  quantityKind?: 'Item' | 'Stack';
  id?: string;
  data?: Record<string, unknown>;
}

export interface VesselState {
  id: string;
  capacity: number;
  status: 'pending' | 'berthed' | 'departed';
  cargo: VesselCargo[];
}

export interface ProductionJob {
  id: number;
  kind: 'mine' | 'manufacture';
  output: string;
  count: number;
  remainingTicks: number;
  inputs: VesselCargo[];
}

export interface HandlingJob {
  id: number;
  vessel: string;
  operation: 'load' | 'unload';
  cargo: VesselCargo[];
  remainingTicks: number;
}

export interface CompletedEffect {
  type: 'production' | 'cargo-operation' | 'berthing';
  tick: number;
  vessel?: string;
  operation?: 'load' | 'unload';
  cargo?: CargoManifest;
  kind?: 'mine' | 'manufacture';
  output?: string;
  count?: number;
}

export interface SimulationState {
  config: SimulationConfig;
  tick: number;
  depositRemaining: number;
  rawStock: VesselCargo[];
  productStock: VesselCargo[];
  productionJobs: ProductionJob[];
  handlingJobs: HandlingJob[];
  vessels: VesselState[];
  audit: Array<{ tick: number; action: string; details: Record<string, unknown> }>;
  nextJobId: number;
}

const positiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;
const nonnegativeInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

function requireCount(count: number): void {
  if (!positiveInteger(count)) throw new Error('count must be a positive integer');
}

function sameCargo(left: VesselCargo, right: VesselCargo): boolean {
  return (left.quantityKind ?? 'Stack') === (right.quantityKind ?? 'Stack') && left.id === right.id
    && JSON.stringify(left.data ?? {}) === JSON.stringify(right.data ?? {});
}

function stockCount(stock: VesselCargo[], item: VesselCargo): number {
  return stock.filter((entry) => entry.commodity === item.commodity && sameCargo(entry, item))
    .reduce((sum, entry) => sum + entry.count, 0);
}

function addStock(stock: VesselCargo[], item: VesselCargo): void {
  const normalized = normalizeCargo([item])[0]!;
  const existing = stock.find((entry) => entry.commodity === normalized.commodity && sameCargo(entry, normalized));
  if (existing && normalized.quantityKind !== 'Item') existing.count += normalized.count;
  else stock.push(normalized);
}

function removeStock(stock: VesselCargo[], item: VesselCargo): void {
  let remaining = item.count;
  for (const entry of [...stock]) {
    if (entry.commodity !== item.commodity || !sameCargo(entry, item)) continue;
    const removed = Math.min(entry.count, remaining);
    entry.count -= removed;
    remaining -= removed;
    if (entry.count === 0) stock.splice(stock.indexOf(entry), 1);
    if (remaining === 0) return;
  }
  throw new Error(`insufficient stock: ${item.commodity}`);
}

function cargoCount(cargo: VesselCargo[]): number {
  return cargo.reduce((total, entry) => total + entry.count, 0);
}

function cargoMass(cargo: VesselCargo[], masses: Record<string, number>): number {
  return cargo.reduce((total, item) => total + item.count * masses[item.commodity]!, 0);
}

function manifest(cargo: VesselCargo[]): CargoManifest {
  return { entries: cargo.map((entry): Quantity => entry.quantityKind === 'Item'
    ? { id: entry.id!, variety: entry.commodity, data: structuredClone(entry.data ?? {}) }
    : { variety: entry.commodity, count: entry.count, data: structuredClone(entry.data ?? {}) }) };
}

function cargoFromManifest(cargo: CargoManifest): VesselCargo[] {
  return cargo.entries.map((entry) => 'id' in entry
    ? { commodity: entry.variety, count: 1, quantityKind: 'Item', id: entry.id as string, data: structuredClone(entry.data) }
    : { commodity: entry.variety, count: entry.count, quantityKind: 'Stack', data: structuredClone(entry.data) });
}

function assertProductionCargo(cargo: VesselCargo): void {
  if (cargo.quantityKind === 'Item' || Object.keys(cargo.data ?? {}).length > 0) {
    throw new Error('production only supports homogeneous empty-data Stack ingredients');
  }
}

function committedPortSlots(state: SimulationState): number {
  return cargoCount(state.rawStock) + cargoCount(state.productStock)
    + state.handlingJobs.filter((job) => job.operation === 'unload').reduce((sum, job) => sum + cargoCount(job.cargo), 0)
    + state.productionJobs.reduce((sum, job) => sum + job.count, 0);
}

function assertCargo(cargo: VesselCargo[]): void {
  if (!cargo.length || cargo.some((entry) => !entry.commodity || !positiveInteger(entry.count))) {
    throw new Error('cargo must contain positive integer counts and commodity IDs');
  }
  if (cargo.some((entry) => entry.quantityKind === 'Item' && (entry.count !== 1 || !entry.id))) {
    throw new Error('Items must have an ID and count one');
  }
}

function normalizeCargo(cargo: VesselCargo[]): VesselCargo[] {
  return cargo.map((item) => ({ ...item, quantityKind: item.quantityKind ?? 'Stack', data: structuredClone(item.data ?? {}) }));
}

export function createSimulationState(config: SimulationConfig): SimulationState {
  const values = Object.values(config.commodities);
  if (values.some((id) => !id) || new Set(values).size !== values.length) {
    throw new Error('commodity IDs must be non-empty and distinct');
  }
  if (Object.values(config.commodityMasses).some((mass) => !Number.isFinite(mass) || mass <= 0)
    || values.some((id) => !Number.isFinite(config.commodityMasses[id]) || config.commodityMasses[id]! <= 0)) {
    throw new Error('every configured commodity must have a positive finite mass');
  }
  for (const value of [config.depositAmount, config.portCapacity, config.berthCapacity]) {
    if (!nonnegativeInteger(value)) throw new Error('deposit and port capacities must be nonnegative integers');
  }
  for (const value of [config.miningCapacity, config.manufacturingSlots, config.manufacturingTime]) {
    if (!positiveInteger(value)) throw new Error('facility capacities and production time must be positive integers');
  }
  return {
    config: structuredClone(config),
    tick: 0,
    depositRemaining: config.depositAmount,
    rawStock: [],
    productStock: [],
    productionJobs: [],
    handlingJobs: [],
    vessels: [],
    audit: [],
    nextJobId: 1,
  };
}

export function configureMining(state: SimulationState, enabled: boolean, capacity: number): void {
  if (!positiveInteger(capacity)) throw new Error('mining capacity must be a positive integer');
  state.config.miningEnabled = enabled;
  state.config.miningCapacity = capacity;
  state.audit.push({ tick: state.tick, action: 'configure-mining', details: { enabled, capacity } });
}

export function configureManufacturing(state: SimulationState, slots: number, time: number): void {
  if (!positiveInteger(slots) || !positiveInteger(time)) throw new Error('manufacturing slots and time must be positive integers');
  state.config.manufacturingSlots = slots;
  state.config.manufacturingTime = time;
  state.audit.push({ tick: state.tick, action: 'configure-manufacturing', details: { slots, time } });
}

export function configurePort(state: SimulationState, capacity: number, berths: number): void {
  if (!nonnegativeInteger(capacity) || !nonnegativeInteger(berths)) throw new Error('port capacities must be nonnegative integers');
  if (capacity < committedPortSlots(state)) throw new Error('port capacity is below occupied and reserved warehouse slots');
  state.config.portCapacity = capacity;
  state.config.berthCapacity = berths;
  state.audit.push({ tick: state.tick, action: 'configure-port', details: { capacity, berths } });
}

export function startMining(state: SimulationState, count: number, duration = 1): number {
  requireCount(count);
  if (!positiveInteger(duration)) throw new Error('duration must be a positive integer');
  if (!state.config.miningEnabled) throw new Error('mining facility is disabled');
  const inFlight = state.productionJobs.filter((job) => job.kind === 'mine').reduce((sum, job) => sum + job.count, 0);
  if (count + inFlight > state.config.miningCapacity) throw new Error('mining capacity exceeded');
  if (count > state.depositRemaining) throw new Error('deposit capacity exceeded');
  if (committedPortSlots(state) + count > state.config.portCapacity) throw new Error('port capacity exceeded');
  state.depositRemaining -= count;
  const id = state.nextJobId++;
  state.productionJobs.push({ id, kind: 'mine', output: state.config.commodities.ore, count, remainingTicks: duration, inputs: [] });
  state.audit.push({ tick: state.tick, action: 'start-mining', details: { id, count, duration } });
  return id;
}

export function startManufacturing(state: SimulationState, input: 'native' | 'imported', count: number): number {
  requireCount(count);
  if (state.productionJobs.filter((job) => job.kind === 'manufacture').length >= state.config.manufacturingSlots) {
    throw new Error('manufacturing slots are full');
  }
  const inputCommodity = input === 'native' ? state.config.commodities.ore : state.config.commodities.importedMetal;
  const output = input === 'native' ? state.config.commodities.nativeMetal : state.config.commodities.refinedProduct;
  const ingredient: VesselCargo = { commodity: inputCommodity, count, quantityKind: 'Stack', data: {} };
  const matching = state.rawStock.filter((item) => item.commodity === inputCommodity);
  if (matching.some((item) => item.quantityKind === 'Item' || Object.keys(item.data ?? {}).length > 0)) assertProductionCargo(matching.find((item) => item.quantityKind === 'Item' || Object.keys(item.data ?? {}).length > 0)!);
  if (stockCount(state.rawStock, ingredient) < count) throw new Error(`insufficient stock: ${inputCommodity}`);
  removeStock(state.rawStock, ingredient);
  const id = state.nextJobId++;
  state.productionJobs.push({
    id,
    kind: 'manufacture',
    output,
    count,
    remainingTicks: state.config.manufacturingTime,
    inputs: [{ commodity: inputCommodity, count }],
  });
  state.audit.push({ tick: state.tick, action: 'start-manufacturing', details: { id, input, count } });
  return id;
}

export function admitVessel(state: SimulationState, id: string, capacity: number, cargo: CargoManifest = { entries: [] }): void {
  if (!id || !positiveInteger(capacity) || state.vessels.some((vessel) => vessel.id === id)) throw new Error('invalid or duplicate vessel');
  const initialCargo = cargoFromManifest(cargo);
  if (initialCargo.length) assertCargo(initialCargo);
  if (initialCargo.some((item) => !state.config.commodityMasses[item.commodity])) throw new Error('cargo commodity mass is not configured');
  if (cargoMass(initialCargo, state.config.commodityMasses) > capacity) throw new Error('vessel capacity exceeded');
  state.vessels.push({ id, capacity, status: 'pending', cargo: initialCargo });
  state.audit.push({ tick: state.tick, action: 'admit-vessel', details: { id } });
}

export function scheduleHandling(
  state: SimulationState,
  vesselId: string,
  operation: 'load' | 'unload',
  cargo: VesselCargo[],
  duration: number,
): number {
  assertCargo(cargo);
  cargo = normalizeCargo(cargo);
  if (cargo.some((item) => !state.config.commodityMasses[item.commodity])) throw new Error('cargo commodity mass is not configured');
  if (!positiveInteger(duration)) throw new Error('duration must be a positive integer');
  const vessel = state.vessels.find((candidate) => candidate.id === vesselId);
  if (!vessel || vessel.status !== 'berthed') throw new Error('vessel is not berthed');
  if (operation === 'load') {
    for (const item of cargo) {
      const reserved = state.handlingJobs.filter((job) => job.operation === 'load').flatMap((job) => job.cargo)
        .filter((entry) => entry.commodity === item.commodity && sameCargo(entry, item)).reduce((sum, entry) => sum + entry.count, 0);
      const requested = cargo.filter((entry) => entry.commodity === item.commodity && sameCargo(entry, item))
        .reduce((sum, entry) => sum + entry.count, 0);
      if (stockCount(state.rawStock, item) + stockCount(state.productStock, item) - reserved < requested) {
        throw new Error(`insufficient unreserved product stock: ${item.commodity}`);
      }
    }
    if (cargoMass(vessel.cargo, state.config.commodityMasses)
      + state.handlingJobs.filter((job) => job.vessel === vesselId && job.operation === 'load').reduce((sum, job) => sum + cargoMass(job.cargo, state.config.commodityMasses), 0)
      + cargoMass(cargo, state.config.commodityMasses) > vessel.capacity) throw new Error('vessel capacity exceeded');
  } else {
    const alreadyReserved = state.handlingJobs.filter((job) => job.vessel === vesselId && job.operation === 'unload').flatMap((job) => job.cargo);
    if (committedPortSlots(state) + cargoCount(cargo) > state.config.portCapacity) throw new Error('port capacity exceeded');
    for (const item of cargo) {
      const available = stockCount(vessel.cargo, item) - alreadyReserved
        .filter((entry) => entry.commodity === item.commodity && sameCargo(entry, item)).reduce((sum, entry) => sum + entry.count, 0);
      const requested = cargo.filter((entry) => entry.commodity === item.commodity && sameCargo(entry, item))
        .reduce((sum, entry) => sum + entry.count, 0);
      if (available < requested) throw new Error(`insufficient unreserved vessel cargo: ${item.commodity}`);
    }
  }
  const id = state.nextJobId++;
  state.handlingJobs.push({ id, vessel: vesselId, operation, cargo: structuredClone(cargo), remainingTicks: duration });
  state.audit.push({ tick: state.tick, action: `schedule-${operation}`, details: { id, vessel: vesselId, cargo } });
  return id;
}

export function departVessel(state: SimulationState, vesselId: string): void {
  const vessel = state.vessels.find((candidate) => candidate.id === vesselId);
  if (!vessel || vessel.status !== 'berthed') throw new Error('vessel is not berthed');
  if (state.handlingJobs.some((job) => job.vessel === vesselId)) throw new Error('vessel has pending cargo handling');
  vessel.status = 'departed';
  state.audit.push({ tick: state.tick, action: 'depart-vessel', details: { vessel: vesselId } });
}

export function advanceTick(state: SimulationState): CompletedEffect[] {
  state.tick += 1;
  const effects: CompletedEffect[] = [];
  const capacity = state.config.berthCapacity;
  for (const vessel of state.vessels) {
    if (vessel.status === 'pending' && state.vessels.filter((candidate) => candidate.status === 'berthed').length < capacity) {
      vessel.status = 'berthed';
      effects.push({ type: 'berthing', tick: state.tick, vessel: vessel.id });
    }
  }
  for (const job of state.productionJobs) job.remainingTicks -= 1;
  const completedProduction = state.productionJobs.filter((job) => job.remainingTicks === 0);
  state.productionJobs = state.productionJobs.filter((job) => job.remainingTicks > 0);
  for (const job of completedProduction) {
    const output = { commodity: job.output, count: job.count, quantityKind: 'Stack' as const, data: {} };
    if (job.kind === 'mine') addStock(state.rawStock, output);
    else addStock(state.productStock, output);
    effects.push({ type: 'production', tick: state.tick, kind: job.kind, output: job.output, count: job.count });
    state.audit.push({ tick: state.tick, action: 'complete-production', details: { id: job.id, output: job.output, count: job.count } });
  }
  for (const job of state.handlingJobs) job.remainingTicks -= 1;
  const completedHandling = state.handlingJobs.filter((job) => job.remainingTicks === 0);
  state.handlingJobs = state.handlingJobs.filter((job) => job.remainingTicks > 0);
  for (const job of completedHandling) {
    const vessel = state.vessels.find((candidate) => candidate.id === job.vessel);
    if (!vessel) throw new Error(`missing vessel: ${job.vessel}`);
    for (const item of job.cargo) {
      if (job.operation === 'load') {
        const rawAvailable = stockCount(state.rawStock, item);
        const fromRaw = Math.min(item.count, rawAvailable);
        if (fromRaw > 0) removeStock(state.rawStock, { ...item, count: fromRaw });
        if (fromRaw < item.count) removeStock(state.productStock, { ...item, count: item.count - fromRaw });
        addStock(vessel.cargo, item);
      } else {
        removeStock(vessel.cargo, item);
        addStock(state.rawStock, item);
      }
    }
    effects.push({ type: 'cargo-operation', tick: state.tick, vessel: vessel.id, operation: job.operation, cargo: manifest(job.cargo) });
    state.audit.push({ tick: state.tick, action: `complete-${job.operation}`, details: { id: job.id, vessel: vessel.id, cargo: job.cargo } });
  }
  return effects;
}
