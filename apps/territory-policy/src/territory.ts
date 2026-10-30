import { randomUUID } from 'node:crypto';
import { compareCargo, validateModel, type BerthingEvent, type CargoManifest, type CargoOperationEvent, type DepartureEvent, type DepartureRequest, type EntryRejected, type EntryRequest, type ExitEvent, type URI, type VoyageEvent } from '@fctp/protocol';
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
  routes?: Array<{ id: URI; from: string; to: string }>;
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
export interface PolicyEntryEvidence {
  verification: ExitEvidenceResult['verification'];
  binding: ExitEvidenceResult['binding'];
  difference: ReturnType<typeof compareCargo>;
  exit?: ExitEvent;
}
export interface PolicyEntryRequestRecord {
  request: EntryRequest;
  hash: string;
  sender: URI;
  activityId: string;
  receivedAt: string;
  verification: VerificationReport;
  inbox: URI;
  evidence?: PolicyEntryEvidence;
  status: 'pending' | 'accepted' | 'rejected';
  decision?: EntryDecision;
  event?: { id: URI; type: BerthingEvent['type'] | EntryRejected['type'] };
  decidedAt?: string;
}
export interface PolicyTerritoryLedger {
  state: TerritoryState;
  admission: { registryAcceptance: URI[]; territoryAcceptance: URI[]; mismatchPolicy: EvidenceMismatchPolicy; publicPorts: URI[]; reviewMode?: 'automatic' | 'manual' };
  visits: Record<URI, VesselVisit>;
  decisions: Record<URI, EntryDecision>;
  requests?: Record<URI, PolicyEntryRequestRecord>;
  movements?: VoyageEvent[];
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
  const initial: PolicyTerritoryLedger = { state: createState(options), admission: { registryAcceptance: options.registryAcceptance ?? [], territoryAcceptance: options.territoryAcceptance ?? [], mismatchPolicy: options.mismatchPolicy ?? 'reject', publicPorts: options.publicPorts ?? [], reviewMode: 'automatic' }, visits: {}, decisions: {}, requests: {}, movements: [], processed: [] };
  const routeEndpoints = new Map((options.routes ?? []).map((route) => [route.id, route]));
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
  const evaluateEntry = (ledger: PolicyTerritoryLedger, request: EntryRequest, verification: VerificationReport, resolved?: PolicyEntryEvidence): { decision: EntryDecision; event: BerthingEvent | EntryRejected } => {
    const policy = structuredClone(ledger.state.policy);
    const { admission } = ledger;
    const evidence = resolved?.exit;
    const declaredAllowed = admission.registryAcceptance.includes(request.vessel.registry) && (!evidence || admission.territoryAcceptance.includes(evidence.territory));
    let accepted = declaredAllowed && policy.decisions.entry !== 'deny';
    let reason: string | undefined = accepted ? undefined : 'entry-policy-rejected';
    if (resolved) {
      const validEvidence = positive(resolved.verification) && resolved.binding.bound;
      if (!validEvidence) {
        accepted = false;
        reason = 'exit-evidence-invalid-or-unbound';
      } else if (resolved.difference.leftOnly.length || resolved.difference.rightOnly.length) {
        if (admission.mismatchPolicy === 'reject') { accepted = false; reason = 'cargo-mismatch'; }
        if (admission.mismatchPolicy === 'evidence') accepted = admission.registryAcceptance.includes(request.vessel.registry) && admission.territoryAcceptance.includes(evidence?.territory ?? '') && policy.decisions.entry !== 'deny';
      }
    }
    if (admission.mismatchPolicy === 'evidence' && !resolved) { accepted = false; reason = 'exit-evidence-required'; }
    const decision: EntryDecision = { request: request.id, accepted, verification: structuredClone(verification), ...(reason ? { reason } : {}), policy: { ...policy, admission: structuredClone(admission) }, ...(resolved ? { evidence: { verification: resolved.verification, binding: resolved.binding, difference: resolved.difference } } : {}) };
    if (accepted) {
      const manifest = admission.mismatchPolicy === 'evidence' ? resolved!.exit!.cargo : request.cargo;
      const result = prepareVessel(ledger.state, request.vessel.id, request.vessel.capacity, manifest, request.vessel.registry);
      if (!result.success) { decision.accepted = false; decision.reason = result.error; }
      else {
        ledger.state = result.state;
        ledger.visits[request.vessel.id] = { vessel: request.vessel.id, possessor: request.vessel.possessor, registry: request.vessel.registry, entryRequest: request.id, port: request.destination.port, route: request.destination.route, departed: false, cargo: structuredClone(manifest) };
      }
    }
    ledger.decisions[request.id] = decision;
    const event: BerthingEvent | EntryRejected = decision.accepted
      ? { id: `${policyObjects}/berthing/${randomUUID()}`, type: 'BerthingEvent', vessel: request.vessel.id, territory, port: request.destination.port, request: request.id, effectiveAt: (options.now ?? (() => new Date().toISOString()))() }
      : { id: `${policyObjects}/entry-rejected/${randomUUID()}`, type: 'EntryRejected', request: request.id, territory, ...(decision.reason ? { reason: decision.reason } : {}) };
    return { decision, event };
  };
  host.server.on(territory, 'EntryRequest', (context, raw) => serial(async () => {
    if (!positive(context.verification)) return;
    const valid = validateModel<EntryRequest>(raw, 'EntryRequest');
    if (!valid.success) throw new TypeError('Invalid EntryRequest');
    const request = valid.data;
    if (context.senderActor !== request.vessel.registry) return;
    if (request.destination.territory !== territory || !options.portIds.includes(request.destination.port) || !options.routeIds.includes(request.destination.route)) return;
    const inbox = await host.server.resolveRecipientInbox(context.senderActor);
    const resolved = request.journey.exitEvidence ? await resolveExitEvidence(request.journey.exitEvidence, { vessel: request.vessel.id, registry: request.vessel.registry }, options.fetcher ? { fetcher: options.fetcher } : {}) : undefined;
    const evidence: PolicyEntryEvidence | undefined = resolved ? { verification: resolved.verification, binding: resolved.binding, difference: compareCargo(request.cargo, resolved.exit?.cargo ?? { entries: [] }), ...(resolved.exit ? { exit: structuredClone(resolved.exit) } : {}) } : undefined;
    const ledger = await get();
    const hash = JSON.stringify(request);
    const existing = ledger.requests?.[request.id];
    if (existing) {
      if (existing.hash !== hash) throw new TypeError('Conflicting reuse of EntryRequest ID');
      return;
    }
    if (ledger.processed.includes(context.activityId) || ledger.decisions[request.id]) return;
    if ((ledger.admission.reviewMode ?? 'automatic') === 'manual') {
      ledger.requests ??= {};
      ledger.requests[request.id] = {
        request: structuredClone(request), hash, sender: context.senderActor, activityId: context.activityId,
        receivedAt: (options.now ?? (() => new Date().toISOString()))(), verification: structuredClone(context.verification), inbox,
        ...(evidence ? { evidence } : {}), status: 'pending'
      };
      ledger.processed.push(context.activityId);
      await host.server.commit((domain) => { domain.policyTerritory = ledger; });
      return;
    }
    const { event } = evaluateEntry(ledger, request, context.verification, evidence);
    ledger.processed.push(context.activityId);
    host.server.registerResource(event.id, event);
    await host.server.commit((domain) => {
      const current = ledgerFrom(domain, initial);
      if (current.processed.includes(context.activityId) || current.decisions[request.id]) return;
      domain.policyTerritory = ledger;
    }, [{ actorId: territory, recipientActorId: context.senderActor, inbox, object: event, activityId: `${event.id}/activity` }]);
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
    if (!visit || visit.departed || visit.port !== request.port) return;
    let departureRoute = visit.route;
    if (request.route !== undefined && request.route !== visit.route) {
      const route = routeEndpoints.get(request.route);
      if (!route || !options.routeIds.includes(request.route) || route.from !== visit.port) return;
      departureRoute = request.route;
    }
    const now = (options.now ?? (() => new Date().toISOString()))();
    const departure: DepartureEvent = { id: `${policyObjects}/departure/${randomUUID()}`, type: 'DepartureEvent', vessel: visit.vessel, territory, port: visit.port, request: request.id, effectiveAt: now };
    const unsigned: Omit<ExitEvent, 'proof'> = { id: `${policyObjects}/exit/${randomUUID()}`, type: 'ExitEvent', vessel: visit.vessel, territory, route: departureRoute, entryRequest: visit.entryRequest, departureEvent: departure.id, cargo: structuredClone(ledger.state.vessels[visit.vessel]!.manifest), effectiveAt: now };
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
    traverse: (vessel: string, routeId: string, actor: string) => serial(async (): Promise<{ success: boolean; status?: number; error?: string; event?: VoyageEvent }> => {
      const ledger = await get();
      const visit = ledger.visits[vessel];
      if (!visit || visit.departed) return { success: false, status: 409, error: 'no-active-local-visit' };
      if (visit.possessor !== actor) return { success: false, status: 403, error: 'forbidden' };
      const route = routeEndpoints.get(routeId as URI);
      if (!route || !options.routeIds.includes(routeId as URI)) return { success: false, status: 404, error: 'unknown-route' };
      if (route.from !== visit.port) return { success: false, status: 409, error: 'route-does-not-start-at-current-port' };
      if (!options.portIds.includes(route.to as URI) || route.to === visit.port) return { success: false, status: 409, error: 'route-not-a-local-port-connection' };
      const event: VoyageEvent = {
        id: `${policyObjects}/voyage/${randomUUID()}`, type: 'VoyageEvent', vessel: visit.vessel, territory,
        kind: 'local-movement',
        details: { from: visit.port, to: route.to, route: route.id, entryRequest: visit.entryRequest },
        effectiveAt: (options.now ?? (() => new Date().toISOString()))()
      };
      host.server.registerResource(event.id, event);
      await host.server.commit((domain) => {
        const current = ledgerFrom(domain, initial);
        const active = current.visits[vessel];
        if (!active || active.departed || active.port !== visit.port) throw new Error('Local visit changed before movement');
        active.port = route.to as URI;
        active.route = route.id;
        current.movements ??= [];
        current.movements.push(structuredClone(event));
        domain.policyTerritory = current;
      });
      return { success: true, event };
    }),
    updatePolicy: (policy: Policy, administrator: string) => apply((state) => changePolicy(state, policy, administrator)),
    updateAdmissionPolicy: (admission: Partial<PolicyTerritoryLedger['admission']>) => serial(async () => {
      await host.server.commit((domain) => {
        const ledger = ledgerFrom(domain, initial);
        ledger.admission = { ...ledger.admission, ...structuredClone(admission) };
        domain.policyTerritory = ledger;
      });
    }),
    entryRequests: () => get().then((ledger) => Object.values(ledger.requests ?? {}).map((record) => ({
      requestId: record.request.id, request: record.request, sender: record.sender, receivedAt: record.receivedAt,
      status: record.status, ...(record.decision === undefined ? {} : { decision: record.decision }),
      ...(record.event === undefined ? {} : { event: record.event }), ...(record.decidedAt === undefined ? {} : { decidedAt: record.decidedAt })
    }))),
    decideEntryRequest: (requestId: URI, action: 'approve' | 'reject', reason?: string) => serial(async () => {
      const ledger = await get();
      const record = ledger.requests?.[requestId];
      if (!record) return undefined;
      if (record.status !== 'pending') return {
        requestId, accepted: record.decision?.accepted === true, ...(record.decision?.reason === undefined ? {} : { reason: record.decision.reason }),
        ...(record.decision === undefined ? {} : { decision: record.decision }), ...(record.event === undefined ? {} : { event: record.event }),
        ...(record.decidedAt === undefined ? {} : { decidedAt: record.decidedAt })
      };
      const now = (options.now ?? (() => new Date().toISOString()))();
      if (action === 'reject') {
        const decision: EntryDecision = {
          request: requestId, accepted: false, verification: structuredClone(record.verification),
          reason: reason ?? 'rejected-by-administrator',
          policy: { ...structuredClone(ledger.state.policy), admission: structuredClone(ledger.admission) }
        };
        const event: EntryRejected = { id: `${policyObjects}/entry-rejected/${randomUUID()}`, type: 'EntryRejected', request: requestId, territory, reason: decision.reason! };
        ledger.decisions[requestId] = decision;
        record.status = 'rejected';
        record.decision = decision;
        record.event = { id: event.id, type: event.type };
        record.decidedAt = now;
        host.server.registerResource(event.id, event);
        await host.server.commit((domain) => { domain.policyTerritory = ledger; }, [
          { actorId: territory, recipientActorId: record.sender, inbox: record.inbox, object: event, activityId: `${event.id}/activity` }
        ]);
        return { requestId, accepted: false, reason: decision.reason, decision, event: record.event, decidedAt: now };
      }
      const { decision, event } = evaluateEntry(ledger, record.request, record.verification, record.evidence);
      record.status = decision.accepted ? 'accepted' : 'rejected';
      record.decision = decision;
      record.event = { id: event.id, type: event.type };
      record.decidedAt = now;
      host.server.registerResource(event.id, event);
      await host.server.commit((domain) => { domain.policyTerritory = ledger; }, [
        { actorId: territory, recipientActorId: record.sender, inbox: record.inbox, object: event, activityId: `${event.id}/activity` }
      ]);
      return { requestId, accepted: decision.accepted, ...(decision.reason === undefined ? {} : { reason: decision.reason }), decision, event: record.event, decidedAt: now };
    }),
    expectedIssuer
  };

  async function expectedRegistry(vessel: URI): Promise<URI | undefined> { return (await get()).visits[vessel]?.registry; }
}

function createState(options: PolicyTerritoryOptions): TerritoryState {
  return { policy: structuredClone(options.initialPolicy), commodities: Object.fromEntries(options.commodities.map((commodity) => [commodity.variety.id, structuredClone(commodity)])), rawInventory: {}, productionReservations: {}, portInventory: {}, vessels: {}, audit: [] };
}
function ledgerFrom(domain: Record<string, unknown>, initial: PolicyTerritoryLedger): PolicyTerritoryLedger {
  const ledger = structuredClone((domain.policyTerritory as PolicyTerritoryLedger | undefined) ?? initial);
  ledger.movements ??= [];
  ledger.requests ??= {};
  return ledger;
}
function positive(report: { cryptographic: { verified: boolean }; attribution: { attributed: boolean }; expectedIssuer: { matches: boolean } }): boolean {
  return report.cryptographic.verified && report.attribution.attributed && report.expectedIssuer.matches;
}
