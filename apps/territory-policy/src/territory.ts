import { randomUUID } from 'node:crypto';
import { compareCargo, validateModel, type BerthingEvent, type CargoManifest, type CargoOperationEvent, type DepartureEvent, type DepartureRequest, type EntryRejected, type EntryRequest, type ExitEvent, type URI } from '@fctp/protocol';
import { resolveExitEvidence, type ExitEvidenceResult } from '@fctp/server-base';
import type { Host, VerificationReport } from '@fctp/server-base';
import {
  changePolicy, exitVessel, loadCargo, manufacture, mineOre, prepareVessel, transferPortToWarehouse, transferWarehouseToPort, unloadCargo,
  type Commodity, type OperationResult, type Policy, type TerritoryState
} from './domain.js';

export type EvidenceMismatchPolicy = 'declared' | 'evidence' | 'reject';
export interface PolicyTerritoryOptions {
  name: string;
  portIds: URI[];
  routeIds: URI[];
  commodities: Commodity[];
  initialPolicy: Policy;
  registryAcceptance?: URI[];
  territoryAcceptance?: URI[];
  mismatchPolicy?: EvidenceMismatchPolicy;
  publicPorts?: URI[];
  fetcher?: typeof fetch;
  now?: () => string;
}
export interface VesselVisit {
  vessel: URI;
  possessor: URI;
  registry: URI;
  entryRequest: URI;
  port: URI;
  route: URI;
  departureRequest?: URI;
  departed: boolean;
  cargo: CargoManifest;
}
export interface EntryDecision {
  request: URI;
  accepted: boolean;
  verification: VerificationReport;
  reason?: string;
  policy: Policy;
  evidence?: { verification: ExitEvidenceResult['verification']; binding: ExitEvidenceResult['binding']; difference: ReturnType<typeof compareCargo> };
}
export interface PolicyTerritoryLedger {
  state: TerritoryState;
  admission: { registryAcceptance: URI[]; territoryAcceptance: URI[]; mismatchPolicy: EvidenceMismatchPolicy; publicPorts: URI[] };
  visits: Record<URI, VesselVisit>;
  decisions: Record<URI, EntryDecision>;
  processed: string[];
}

export function expectedIssuer(object: unknown, visits: Record<URI, VesselVisit>): URI | undefined {
  if (!object || typeof object !== 'object') return undefined;
  const value = object as Record<string, unknown>;
  if (value.type === 'EntryRequest' && value.vessel && typeof value.vessel === 'object') {
    const vessel = value.vessel as Record<string, unknown>;
    return typeof vessel.registry === 'string' ? vessel.registry : undefined;
  }
  if (value.type === 'DepartureRequest' && typeof value.vessel === 'string') {
    const visit = visits[value.vessel];
    return visit && !visit.departed ? visit.registry : undefined;
  }
  return undefined;
}

export function installPolicyTerritory(host: Host, options: PolicyTerritoryOptions) {
  if (!options.name || !host.actors[options.name]) throw new TypeError(`Unknown Territory Actor: ${options.name}`);
  if (!options.portIds.length || !options.routeIds.length) throw new TypeError('At least one owned port and route are required');
  const actor = host.actor(options.name);
  const territory = actor.id as URI;
  const tail: { promise: Promise<void> } = { promise: Promise.resolve() };
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.promise.then(operation);
    tail.promise = result.then(() => undefined, () => undefined);
    return result;
  };
  const initial: PolicyTerritoryLedger = { state: createState(options), admission: { registryAcceptance: options.registryAcceptance ?? [], territoryAcceptance: options.territoryAcceptance ?? [], mismatchPolicy: options.mismatchPolicy ?? 'reject', publicPorts: options.publicPorts ?? [] }, visits: {}, decisions: {}, processed: [] };
  const policyObjects = `${new URL(territory).origin}/objects/policy`;
  host.server.registerResource(`${policyObjects}/public-ports`, { id: `${policyObjects}/public-ports`, type: 'PublicPorts', territory, publicPorts: initial.admission.publicPorts });
  const get = async (): Promise<PolicyTerritoryLedger> => host.server.store.read((store) => structuredClone((store.domain.policyTerritory as PolicyTerritoryLedger | undefined) ?? initial));
  const apply = (action: (state: TerritoryState) => OperationResult): Promise<OperationResult> => serial(async () => {
    let result!: OperationResult;
    await host.server.commit((domain) => {
      const ledger = ledgerFrom(domain, initial);
      result = action(ledger.state);
      ledger.state = result.state;
      domain.policyTerritory = ledger;
    });
    return result;
  });
  const cargoOperation = (operation: 'load' | 'unload', vessel: URI, variety: string, count: number, actor?: string): Promise<OperationResult> => serial(async () => {
    const ledger = await get();
    const visit = ledger.visits[vessel];
    if (!visit || visit.departed) return { success: false, state: ledger.state, error: 'Vessel has no active visit' };
    const action = operation === 'load' ? loadCargo : unloadCargo;
    const result = action(ledger.state, vessel, variety, count, actor);
    if (!result.success) {
      await host.server.commit((domain) => { const current = ledgerFrom(domain, initial); current.state = result.state; domain.policyTerritory = current; });
      return result;
    }
    const event: CargoOperationEvent = { id: `${policyObjects}/cargo-operation/${randomUUID()}`, type: 'CargoOperationEvent', vessel, territory, port: visit.port, operation, cargo: { entries: [{ variety, count, data: {} }] }, effectiveAt: (options.now ?? (() => new Date().toISOString()))() };
    const inbox = await host.server.resolveRecipientInbox(visit.registry);
    await host.server.commit((domain) => {
      const current = ledgerFrom(domain, initial);
      if (!current.visits[vessel] || current.visits[vessel]!.departed) throw new Error('Vessel visit is no longer active');
      current.state = result.state;
      current.visits[vessel]!.cargo = structuredClone(result.state.vessels[vessel]!.manifest);
      domain.policyTerritory = current;
    }, [{ actorId: territory, recipientActorId: visit.registry, inbox, object: event, activityId: `${event.id}/activity` }]);
    return result;
  });
  host.server.on(territory, 'EntryRequest', (context, raw) => serial(async () => {
    if (!positive(context.verification)) return;
    const valid = validateModel<EntryRequest>(raw, 'EntryRequest');
    if (!valid.success) throw new TypeError('Invalid EntryRequest');
    const request = valid.data;
    if (context.senderActor !== request.vessel.registry) return;
    if (request.destination.territory !== territory || !options.portIds.includes(request.destination.port) || !options.routeIds.includes(request.destination.route)) return;
    const inbox = await host.server.resolveRecipientInbox(context.senderActor);
    const evidence = request.journey.exitEvidence ? await resolveExitEvidence(request.journey.exitEvidence, { vessel: request.vessel.id, registry: request.vessel.registry }, options.fetcher ? { fetcher: options.fetcher } : {}) : undefined;
    const ledger = await get();
    if (ledger.processed.includes(context.activityId) || ledger.decisions[request.id]) return;
    const policy = structuredClone(ledger.state.policy);
    const { admission } = ledger;
    const declaredAllowed = admission.registryAcceptance.includes(request.vessel.registry) && (!evidence || admission.territoryAcceptance.includes(evidence.exit?.territory ?? ''));
    let accepted = declaredAllowed && policy.decisions.entry !== 'deny';
    let reason: string | undefined = accepted ? undefined : 'entry-policy-rejected';
    let difference: ReturnType<typeof compareCargo> | undefined;
    if (evidence) {
      difference = compareCargo(request.cargo, evidence.exit?.cargo ?? { entries: [] });
      const validEvidence = positive(evidence.verification) && evidence.binding.bound;
      if (!validEvidence) {
        accepted = false;
        reason = 'exit-evidence-invalid-or-unbound';
      } else if (difference.leftOnly.length || difference.rightOnly.length) {
        if (admission.mismatchPolicy === 'reject') { accepted = false; reason = 'cargo-mismatch'; }
        if (admission.mismatchPolicy === 'evidence') accepted = admission.registryAcceptance.includes(request.vessel.registry) && admission.territoryAcceptance.includes(evidence.exit?.territory ?? '') && policy.decisions.entry !== 'deny';
      }
    }
    if (admission.mismatchPolicy === 'evidence' && !evidence) { accepted = false; reason = 'exit-evidence-required'; }
    const decision: EntryDecision = { request: request.id, accepted, verification: structuredClone(context.verification), ...(reason ? { reason } : {}), policy: { ...policy, admission: structuredClone(admission) }, ...(evidence ? { evidence: { verification: evidence.verification, binding: evidence.binding, difference: difference! } } : {}) };
    if (accepted) {
      const manifest = admission.mismatchPolicy === 'evidence' ? evidence!.exit!.cargo : request.cargo;
      const result = prepareVessel(ledger.state, request.vessel.id, request.vessel.capacity, manifest, context.senderActor);
      if (!result.success) { decision.accepted = false; decision.reason = result.error; }
      else {
        ledger.state = result.state;
        ledger.visits[request.vessel.id] = { vessel: request.vessel.id, possessor: request.vessel.possessor, registry: request.vessel.registry, entryRequest: request.id, port: request.destination.port, route: request.destination.route, departed: false, cargo: structuredClone(manifest) };
      }
    }
    ledger.decisions[request.id] = decision;
    ledger.processed.push(context.activityId);
    const resultEvent: BerthingEvent | EntryRejected = decision.accepted
      ? { id: `${policyObjects}/berthing/${randomUUID()}`, type: 'BerthingEvent', vessel: request.vessel.id, territory, port: request.destination.port, request: request.id, effectiveAt: (options.now ?? (() => new Date().toISOString()))() }
      : { id: `${policyObjects}/entry-rejected/${randomUUID()}`, type: 'EntryRejected', request: request.id, territory, ...(decision.reason ? { reason: decision.reason } : {}) };
    host.server.registerResource(resultEvent.id, resultEvent);
    await host.server.commit((domain) => {
      const current = ledgerFrom(domain, initial);
      if (current.processed.includes(context.activityId) || current.decisions[request.id]) return;
      domain.policyTerritory = ledger;
    }, [{ actorId: territory, recipientActorId: context.senderActor, inbox, object: resultEvent, activityId: `${resultEvent.id}/activity` }]);
  }));
  host.server.on(territory, 'DepartureRequest', (context, raw) => serial(async () => {
    if (!positive(context.verification)) return;
    const valid = validateModel<DepartureRequest>(raw, 'DepartureRequest');
    if (!valid.success) throw new TypeError('Invalid DepartureRequest');
    const request = valid.data;
    if (context.senderActor !== await expectedRegistry(request.vessel) || request.territory !== territory || !options.portIds.includes(request.port)) return;
    const inbox = await host.server.resolveRecipientInbox(context.senderActor);
    const ledger = await get();
    const visit = ledger.visits[request.vessel];
    if (!visit || visit.departed || visit.port !== request.port || (request.route && request.route !== visit.route)) return;
    const now = (options.now ?? (() => new Date().toISOString()))();
    const departure: DepartureEvent = { id: `${policyObjects}/departure/${randomUUID()}`, type: 'DepartureEvent', vessel: visit.vessel, territory, port: visit.port, request: request.id, effectiveAt: now };
    const unsigned: Omit<ExitEvent, 'proof'> = { id: `${policyObjects}/exit/${randomUUID()}`, type: 'ExitEvent', vessel: visit.vessel, territory, route: visit.route, entryRequest: visit.entryRequest, departureEvent: departure.id, cargo: structuredClone(ledger.state.vessels[visit.vessel]!.manifest), effectiveAt: now };
    const signed = await host.signObject(options.name, unsigned as unknown as Record<string, unknown>) as unknown as ExitEvent;
    host.server.registerResource(departure.id, departure);
    host.server.registerResource(signed.id, signed);
    await host.server.commit((domain) => {
      const current = ledgerFrom(domain, initial);
      const active = current.visits[request.vessel];
      if (!active || active.departed || current.processed.includes(context.activityId)) return;
      active.departed = true;
      active.cargo = structuredClone(signed.cargo);
      const exited = exitVessel(current.state, request.vessel, context.senderActor);
      if (!exited.success) throw new Error(exited.error);
      current.state = exited.state;
      current.processed.push(context.activityId);
      domain.policyTerritory = current;
    }, [
      { actorId: territory, recipientActorId: context.senderActor, inbox, object: departure, activityId: `${departure.id}/activity` },
      { actorId: territory, recipientActorId: context.senderActor, inbox, object: signed, activityId: `${signed.id}/activity` }
    ]);
  }));
  return {
    get state() { return get().then((ledger) => ledger.state); },
    get ledger() { return get(); },
    mine: (variety: string, count: number, actor?: string) => apply((state) => mineOre(state, variety, count, actor)),
    manufacture: (recipe: string, count: number, actor?: string) => apply((state) => manufacture(state, recipe, count, actor)),
    transferWarehouseToPort: (variety: string, count: number, actor?: string) => apply((state) => transferWarehouseToPort(state, variety, count, actor)),
    transferPortToWarehouse: (variety: string, count: number, actor?: string) => apply((state) => transferPortToWarehouse(state, variety, count, actor)),
    load: (vessel: URI, variety: string, count: number, actor?: string) => cargoOperation('load', vessel, variety, count, actor),
    unload: (vessel: URI, variety: string, count: number, actor?: string) => cargoOperation('unload', vessel, variety, count, actor),
    updatePolicy: (policy: Policy, administrator: string) => apply((state) => changePolicy(state, policy, administrator)),
    updateAdmissionPolicy: (admission: Partial<PolicyTerritoryLedger['admission']>) => serial(async () => {
      await host.server.commit((domain) => {
        const ledger = ledgerFrom(domain, initial);
        ledger.admission = { ...ledger.admission, ...structuredClone(admission) };
        domain.policyTerritory = ledger;
      });
    }),
    expectedIssuer
  };

  async function expectedRegistry(vessel: URI): Promise<URI | undefined> { return (await get()).visits[vessel]?.registry; }
}

function createState(options: PolicyTerritoryOptions): TerritoryState {
  return { policy: structuredClone(options.initialPolicy), commodities: Object.fromEntries(options.commodities.map((commodity) => [commodity.variety.id, structuredClone(commodity)])), rawInventory: {}, productionReservations: {}, portInventory: {}, vessels: {}, audit: [] };
}
function ledgerFrom(domain: Record<string, unknown>, initial: PolicyTerritoryLedger): PolicyTerritoryLedger {
  return structuredClone((domain.policyTerritory as PolicyTerritoryLedger | undefined) ?? initial);
}
function positive(report: { cryptographic: { verified: boolean }; attribution: { attributed: boolean }; expectedIssuer: { matches: boolean } }): boolean {
  return report.cryptographic.verified && report.attribution.attributed && report.expectedIssuer.matches;
}
