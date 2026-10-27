import type { LocalAction, LocalActionDiscovery } from '@fctp/server-base';
import type { URI, Vessel } from '@fctp/protocol';
import { scheduleHandling, startManufacturing, startMining, type SimulationState } from './domain.js';

const knownPreviewErrors = new Set([
  'count must be a positive integer', 'duration must be a positive integer', 'mining facility is disabled',
  'mining capacity exceeded', 'deposit capacity exceeded', 'port capacity exceeded', 'manufacturing slots are full',
  'vessel is not berthed', 'cargo must contain positive integer counts and commodity IDs',
  'Items must have an ID and count one', 'cargo commodity mass is not configured', 'vessel capacity exceeded',
  'production only supports homogeneous empty-data Stack ingredients', 'vessel has pending cargo handling',
]);

function knownPreviewError(message: string): boolean {
  return knownPreviewErrors.has(message) || /^(?:insufficient stock|insufficient unreserved product stock|insufficient unreserved vessel cargo): /.test(message);
}

interface SimulationVisit {
  request: { id: URI; vessel: Vessel };
  possessor: URI;
  simulationVessel: string;
  port: URI;
  route: URI;
  exited: boolean;
}

export function discoverSimulationActions(input: {
  simulation: SimulationState;
  actor: URI;
  player: URI;
  vesselId: URI;
  vessel: Vessel;
  origin: string;
  visit?: SimulationVisit;
}): LocalActionDiscovery {
  const { simulation, actor, player, vesselId, vessel, origin, visit } = input;
  const simVessel = visit && simulation.vessels.find((item) => item.id === visit.simulationVessel);
  const cargo = structuredClone(simVessel?.cargo ?? []);
  const request = (path: string, body: Record<string, unknown>): NonNullable<LocalAction['request']> => ({ method: 'POST', href: `${origin}${path}`, body });
  const preview = (id: string, label: string, href: string, body: Record<string, unknown>, effect: string, operation: (clone: SimulationState) => void): LocalAction => previewSimulationAction(simulation, id, label, request(href, body), effect, operation);
  const actions: LocalAction[] = [
    preview('mine', 'Mine one ore', '/local/mine', { count: 1, duration: 1 }, 'Queues one ore for a later tick.', (clone) => { startMining(clone, 1, 1); }),
    preview('manufacture-native', 'Manufacture one native metal', '/local/manufacture', { recipe: 'native', count: 1 }, 'Consumes one ore and queues one native metal.', (clone) => { startManufacturing(clone, 'native', 1); }),
    preview('manufacture-imported', 'Manufacture one refined metal', '/local/manufacture', { recipe: 'imported', count: 1 }, 'Consumes one imported metal and queues one refined metal.', (clone) => { startManufacturing(clone, 'imported', 1); }),
  ];
  const active = visit && !visit.exited;
  if (active && simVessel) {
    const entryRequest = visit.request.id;
    const stocks = [...simulation.rawStock, ...simulation.productStock];
    const distinct = (items: typeof stocks): typeof stocks => items.filter((item, index) => item.count > 0 && items.findIndex((other) => other.commodity === item.commodity && (other.quantityKind ?? 'Stack') === (item.quantityKind ?? 'Stack') && other.id === item.id && JSON.stringify(other.data ?? {}) === JSON.stringify(item.data ?? {})) === index);
    const candidates = distinct(stocks);
    const loadCandidates = candidates.length ? candidates : [undefined];
    for (const item of loadCandidates) {
      const id = item ? `load:${encodeURIComponent(item.commodity)}:${encodeURIComponent(item.id ?? JSON.stringify(item.data ?? {}))}` : 'load';
      const cargoEntry = item && item.quantityKind === 'Item' ? { variety: item.commodity, id: item.id!, data: item.data ?? {} } : { variety: item?.commodity ?? simulation.config.commodities.ore, count: 1, data: item?.data ?? {} };
      const body = { entryRequest, cargo: { entries: [cargoEntry] }, duration: 1 };
      const action = preview(id, item ? `Load one ${item.commodity}` : 'Load one available unit', '/local/load', body, 'Reserves shared local stock and schedules handling.', (clone) => {
        if (!item) throw new Error('insufficient unreserved product stock: no stock available');
        scheduleHandling(clone, simVessel.id, 'load', [{ ...item, count: 1 }], 1);
      });
      actions.push(action);
    }
    const carried = distinct(simVessel.cargo);
    for (const item of carried.length ? carried : [undefined]) {
      const id = item ? `unload:${encodeURIComponent(item.commodity)}:${encodeURIComponent(item.id ?? JSON.stringify(item.data ?? {}))}` : 'unload';
      const cargoEntry = item && item.quantityKind === 'Item' ? { variety: item.commodity, id: item.id!, data: item.data ?? {} } : { variety: item?.commodity ?? simulation.config.commodities.ore, count: 1, data: item?.data ?? {} };
      const body = { entryRequest, cargo: { entries: [cargoEntry] }, duration: 1 };
      actions.push(preview(id, item ? `Unload one ${item.commodity}` : 'Unload one carried unit', '/local/unload', body, 'Reserves one carried unit and warehouse capacity for scheduled handling.', (clone) => {
        if (!item) throw new Error('insufficient unreserved vessel cargo: no cargo available');
        scheduleHandling(clone, simVessel.id, 'unload', [{ ...item, count: 1 }], 1);
      }));
    }
  }
  const registryBase = new URL('/local/registry/', vessel.registry).origin;
  const entryBody = { vessel: vesselId, territory: actor, port: visit?.port ?? `${origin}/objects/ports/main`, route: visit?.route ?? `${origin}/objects/routes/approach` };
  actions.push({ id: 'entry', label: 'Request entry at this Territory', available: !active, ...(!active ? {} : { reason: 'Vessel already has an active local visit.' }), request: { method: 'POST', href: `${registryBase}/local/registry/entry`, body: entryBody }, effect: 'Submits a local entry possibility; Registry and Territory acceptance are still required.' });
  const pendingHandling = Boolean(active && simulation.handlingJobs.some((job) => job.vessel === visit.simulationVessel));
  const departed = Boolean(visit?.exited || simVessel?.status === 'departed');
  const awaitingBerth = Boolean(active && simVessel?.status === 'pending');
  const departureBody = { vessel: vesselId, territory: actor, port: visit?.port ?? `${origin}/objects/ports/main`, route: visit?.route ?? `${origin}/objects/routes/approach` };
  const departureReason = departed ? 'Visit has exited or departed.' : pendingHandling ? 'Cargo handling is pending.' : awaitingBerth ? 'Vessel is waiting for a berth.' : !active ? 'No active local visit.' : undefined;
  actions.push({ id: 'departure', label: 'Request Registry departure', available: Boolean(active && simVessel?.status === 'berthed' && !pendingHandling), ...(departureReason ? { reason: departureReason } : {}), request: { method: 'POST', href: `${registryBase}/local/registry/departure`, body: departureBody }, effect: 'Asks the Registry to initiate departure from the current local berth.' });
  const activeHandling = active ? simulation.handlingJobs.filter((job) => job.vessel === visit.simulationVessel) : [];
  return {
    kind: 'simulation', actor, player, vessel: vesselId, observedAt: new Date().toISOString(),
    state: { tick: simulation.tick, sharedStock: { raw: structuredClone(simulation.rawStock), products: structuredClone(simulation.productStock) }, facilities: { mining: { enabled: simulation.config.miningEnabled, capacity: simulation.config.miningCapacity }, manufacturing: { slots: simulation.config.manufacturingSlots, time: simulation.config.manufacturingTime }, port: { capacity: simulation.config.portCapacity, berths: simulation.config.berthCapacity } }, visit: active ? { entryRequest: visit.request.id, status: simVessel?.status, cargo, handling: activeHandling } : null, queuedProduction: simulation.productionJobs.map(({ kind, output, count, remainingTicks }) => ({ kind, output, count, remainingTicks })) },
    actions, notes: ['Shared stock and facility availability are local observations, not personal balances or reservations.', 'Production and handling complete only as ticks advance; Players cannot advance ticks.', 'Pending berthing, handling, or an exited visit can block cargo or departure actions.'],
  };
}

export function previewSimulationAction(
  simulation: SimulationState,
  id: string,
  label: string,
  request: NonNullable<LocalAction['request']>,
  effect: string,
  operation: (clone: SimulationState) => void,
): LocalAction {
  try {
    operation(structuredClone(simulation));
    return { id, label, available: true, request, effect };
  } catch (error) {
    if (!(error instanceof Error) || !knownPreviewError(error.message)) throw error;
    return { id, label, available: false, reason: error.message, request, effect };
  }
}
