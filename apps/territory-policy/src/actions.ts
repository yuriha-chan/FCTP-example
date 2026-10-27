import type { URI } from '@fctp/protocol';
import { validateModel, type Vessel } from '@fctp/protocol';
import type { LocalAction, LocalActionDiscovery } from '@fctp/server-base';
import { loadCargo, manufacture, mineOre, transferPortToWarehouse, transferWarehouseToPort, unloadCargo, type TerritoryState } from './domain.js';
import type { PolicyAppIds } from './app.js';
import type { installPolicyTerritory } from './territory.js';

type Territory = ReturnType<typeof installPolicyTerritory>;

export async function discoverPolicyActions(input: {
  actor: URI; player: URI; vessel: URI; ids: PolicyAppIds; origin: string; fetcher: typeof fetch; territory: Territory;
}): Promise<LocalActionDiscovery> {
  const ledger = await input.territory.ledger;
  const visit = ledger.visits[input.vessel];
  let vessel: Vessel | undefined;
  if (visit) {
    if (visit.possessor !== input.player) throw new ActionDiscoveryError(403, 'forbidden');
    vessel = { id: input.vessel, type: 'Vessel', registry: visit.registry, possessor: visit.possessor, capacity: ledger.state.vessels[input.vessel]?.capacity ?? 0 };
  } else {
    const response = await input.fetcher(input.vessel);
    if (!response.ok) throw new ActionDiscoveryError(response.status === 404 ? 404 : 400, 'vessel-retrieval-failed');
    const result = validateModel<Vessel>(await response.json(), 'Vessel');
    if (!result.success || result.data.id !== input.vessel) throw new ActionDiscoveryError(400, 'invalid-vessel');
    vessel = result.data;
    if (vessel.possessor !== input.player) throw new ActionDiscoveryError(403, 'forbidden');
    if (!ledger.admission.registryAcceptance.includes(vessel.registry)) throw new ActionDiscoveryError(403, 'registry-not-accepted');
  }

  const state = ledger.state;
  const snapshot = {
    policy: structuredClone(state.policy), rawInventory: { ...state.rawInventory }, portInventory: { ...state.portInventory },
    productionReservations: { ...state.productionReservations }, visits: visit ? [{ vessel: input.vessel, port: visit.port, route: visit.route, departed: visit.departed }] : [],
    cargo: visit ? structuredClone(visit.cargo) : { entries: [] }
  };
  const actions: LocalAction[] = [];
  const preview = (id: string, label: string, request: NonNullable<LocalAction['request']>, effect: string, run: (copy: TerritoryState) => { success: boolean; error?: string }, vesselScoped = false): void => {
    const cloned = structuredClone(state);
    const result = run(cloned);
    const blockedByVisit = vesselScoped && !visit;
    const reason = blockedByVisit ? 'no-persisted-local-visit' : !result.success ? result.error ?? 'blocked-by-local-domain-rules' : undefined;
    actions.push({ id, label, available: !reason, ...(reason ? { reason } : {}), request, effect });
  };
  const post = (path: string, body: Record<string, unknown>) => ({ method: 'POST' as const, href: `${input.origin}/local/${path}`, body });
  preview('mine-ore', 'Mine one ore', post('mine', { variety: input.ids.varieties.ore, count: 1 }), 'Consumes one unit of shared reserve/quota and adds shared warehouse stock.', (copy) => mineOre(copy, input.ids.varieties.ore, 1));
  preview('manufacture-metal', 'Manufacture one metal', post('manufacture', { recipe: 'ore-to-metal', count: 1 }), 'Consumes shared warehouse ingredients and adds shared warehouse output.', (copy) => manufacture(copy, 'ore-to-metal', 1));
  for (const [variety, label] of [[input.ids.varieties.ore, 'ore'], [input.ids.varieties.metal, 'metal']] as const) {
    preview(`to-port-${label}`, `Transfer one ${label} to port`, post('transfer', { direction: 'to-port', variety, count: 1 }), 'Transfers one shared local unit from warehouse to port.', (copy) => transferWarehouseToPort(copy, variety, 1));
    preview(`to-warehouse-${label}`, `Transfer one ${label} to warehouse`, post('transfer', { direction: 'to-warehouse', variety, count: 1 }), 'Transfers one shared local unit from port to warehouse.', (copy) => transferPortToWarehouse(copy, variety, 1));
    preview(`load-${label}`, `Load one ${label}`, post('load', { vessel: input.vessel, variety, count: 1 }), 'Moves one shared port unit into this vessel, subject to its actual capacity.', (copy) => loadCargo(copy, input.vessel, variety, 1), true);
    preview(`unload-${label}`, `Unload one ${label}`, post('unload', { vessel: input.vessel, variety, count: 1 }), 'Moves one supported empty-data Stack unit from this vessel into shared port stock.', (copy) => unloadCargo(copy, input.vessel, variety, 1), true);
  }
  const activeVisit = !!visit && !visit.departed;
  for (const [port, route] of [[input.ids.ports[0]!, input.ids.routes[0]!], [input.ids.ports[1]!, input.ids.routes[1]!]]) {
    actions.push({ id: `request-entry-${port === input.ids.ports[0] ? 'east' : 'west'}`, label: `Request local entry at ${port === input.ids.ports[0] ? 'East Haven' : 'West Haven'}`, available: !activeVisit, ...(!activeVisit ? {} : { reason: 'vessel-already-has-active-local-visit' }), request: { method: 'POST', href: new URL('/local/registry/entry', vessel.registry).href, body: { vessel: input.vessel, territory: input.actor, port, route } }, effect: 'Asks the Registry to create an entry request using its declared cargo and journey; local acceptance is separately decided at execution.' });
  }
  if (visit && !visit.departed) actions.push({ id: 'depart-current-visit', label: 'Request departure from current berth', available: true, request: { method: 'POST', href: new URL('/local/registry/departure', visit.registry).href, body: { vessel: input.vessel, territory: input.actor, port: visit.port, route: visit.route } }, effect: 'Requests Registry processing for this persisted current berth and route; Registry native authentication is required.' });
  else actions.push({ id: 'depart-current-visit', label: 'Request departure from current berth', available: false, reason: 'no-active-local-berth', effect: 'A current local berth is required.' });
  return { kind: 'policy', actor: input.actor, player: input.player, vessel: input.vessel, observedAt: new Date().toISOString(), state: snapshot, actions, notes: ['Shared stock and policy values describe local Territory resources, not personal balances.', 'Only this vessel’s persisted local visit and cargo are shown; no other vessel, audit history, or global location is disclosed.', 'Entry requests are local examples, not evidence of departure elsewhere or a promise of global eligibility. Action availability is advisory and execution revalidates.'] };
}

export class ActionDiscoveryError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
