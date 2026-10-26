import { randomUUID } from 'node:crypto';
import {
  validateModel,
  compareCargo,
  type CargoManifest,
  type DepartureEvent,
  type DepartureRequest,
  type EntryRejected,
  type EntryRequest,
  type ExitEvent,
  type URI,
} from '@fctp/protocol';
import type { HandlerContext, Host } from '@fctp/server-base';
import { resolveExitEvidence } from '@fctp/server-base';
import {
  advanceTick,
  admitVessel,
  configureManufacturing,
  configureMining,
  configurePort,
  createSimulationState,
  departVessel,
  scheduleHandling,
  startManufacturing,
  startMining,
  type SimulationConfig,
  type SimulationState,
  type VesselCargo,
} from './domain.js';

export type ManifestPolicy = 'request' | 'evidence' | 'reject-difference';

export interface SimulationTerritoryOptions {
  territoryActor?: string;
  port: URI;
  route: URI;
  config: SimulationConfig;
  acceptedRegistries: URI[];
  acceptedTerritories: URI[];
  manifestPolicy?: ManifestPolicy;
  requireExitEvidence?: boolean;
  fetcher?: typeof fetch;
  registryInbox?: (registry: URI) => Promise<URI>;
  epoch?: string;
  tickDurationMs?: number;
}

export interface SimulationVisit {
  request: EntryRequest;
  registry: URI;
  possessor: URI;
  vessel: URI;
  simulationVessel: string;
  port: URI;
  route: URI;
  evidence?: ExitEvent;
  evidenceVerification?: unknown;
  decision: { accepted: boolean; reason: string; manifestSource?: 'request' | 'evidence' };
  departureRequest?: DepartureRequest;
  departureEvent?: DepartureEvent;
  exited: boolean;
}

export interface SimulationTerritoryState {
  simulation: SimulationState;
  visits: Record<string, SimulationVisit>;
  handledIds: Record<string, string>;
  decisions: Array<{ request: string; accepted: boolean; reason: string; tick: number }>;
  evidence: Record<string, ExitEvent>;
}

export interface SimulationTerritory {
  state(): Promise<SimulationTerritoryState>;
  mine(count: number, duration?: number): Promise<number>;
  manufacture(input: 'native' | 'imported', count: number): Promise<number>;
  handle(requestId: URI, operation: 'load' | 'unload', cargo: VesselCargo[], duration: number): Promise<number>;
  tick(): Promise<SimulationTerritoryState>;
  configureMining(enabled: boolean, capacity: number): Promise<void>;
  configureManufacturing(slots: number, time: number): Promise<void>;
  configureFacilities(config: { mining?: { enabled: boolean; capacity: number }; manufacturing?: { slots: number; time: number }; port?: { capacity: number; berths: number } }): Promise<void>;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function simulationExpectedIssuer(sender: URI, object: unknown, knownRegistry?: URI): URI | undefined {
  if (!record(object)) return undefined;
  if (object.type === 'EntryRequest' && record(object.vessel) && object.vessel.registry === sender) return sender;
  if (object.type === 'DepartureRequest' && knownRegistry === sender) return sender;
  return undefined;
}

export function installSimulationTerritory(host: Host, options: SimulationTerritoryOptions): SimulationTerritory {
  const actorName = options.territoryActor ?? 'territory';
  const actorId = host.actor(actorName).id as URI;
  const territoryUrl = new URL(actorId);
  const base = territoryUrl.origin;
  const fetcher = options.fetcher ?? fetch;
  const epoch = options.epoch ?? '2000-01-01T00:00:00.000Z';
  const tickDurationMs = options.tickDurationMs ?? 60_000;
  if (!Number.isFinite(Date.parse(epoch)) || !Number.isSafeInteger(tickDurationMs) || tickDurationMs < 1) throw new TypeError('Invalid simulation epoch or tick duration');
  const manifestPolicy = options.manifestPolicy ?? 'reject-difference';
  const initial: SimulationTerritoryState = { simulation: createSimulationState(options.config), visits: {}, handledIds: {}, decisions: [], evidence: {} };
  let queue: Promise<void> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };

  const readState = async (): Promise<SimulationTerritoryState> => host.server.store.read((store) => structuredClone((store.domain.simulationTerritory as SimulationTerritoryState | undefined) ?? initial));
  const snapshot = async (): Promise<SimulationTerritoryState> => readState();
  const commit = async <T>(mutation: (state: SimulationTerritoryState) => T, outgoing: Parameters<typeof host.server.commit>[1] = []): Promise<T> =>
    host.server.commit((domain) => {
      const state = structuredClone((domain.simulationTerritory as SimulationTerritoryState | undefined) ?? initial);
      const result = mutation(state);
      domain.simulationTerritory = state;
      return result;
    }, outgoing);
  const stamp = (tick: number): string => new Date(Date.parse(epoch) + tick * tickDurationMs).toISOString();
  const uri = (kind: string): URI => `${base}/objects/simulation/${kind}/${randomUUID()}`;
  const inboxFor = async (registry: URI): Promise<URI> => {
    if (options.registryInbox) return options.registryInbox(registry);
    return host.server.resolveRecipientInbox(registry);
  };
  const outbound = async (registry: URI, object: Record<string, unknown>, activityId: URI) => ({
    actorId: actorId as URI, recipientActorId: registry, inbox: await inboxFor(registry), object, activityId,
  });

  const reject = async (request: EntryRequest, registry: URI, reason: string): Promise<void> => {
    const rejected: EntryRejected = { id: uri('entry-rejected'), type: 'EntryRejected', request: request.id, territory: actorId as URI, reason };
    const outgoing = await outbound(registry, rejected, `${rejected.id}/activity`);
    await commit((state) => {
      state.decisions.push({ request: request.id, accepted: false, reason, tick: state.simulation.tick });
      state.handledIds[request.id] = JSON.stringify(request);
    }, [outgoing]);
  };

  const onEntry = async (context: HandlerContext, raw: unknown): Promise<void> => serialized(async () => {
    const checked = validateModel<EntryRequest>(raw as Record<string, unknown>, 'EntryRequest');
    if (!checked.success) throw new TypeError(`Invalid EntryRequest: ${checked.issues.map((issue) => issue.message).join(', ')}`);
    const request = checked.data;
    const hash = JSON.stringify(request);
    const current = await snapshot();
    const previous = current.handledIds[request.id];
    if (previous) {
      if (previous !== hash) throw new TypeError('Conflicting reuse of EntryRequest ID');
      return;
    }
    if (context.senderActor !== request.vessel.registry || !context.verification.cryptographic.verified || !context.verification.attribution.attributed || !context.verification.expectedIssuer.matches) {
      return;
    }
    if (request.destination.territory !== actorId || !options.acceptedRegistries.includes(request.vessel.registry)) {
      await reject(request, request.vessel.registry, 'registry-or-destination-not-accepted');
      return;
    }
    if (request.destination.port !== options.port || request.destination.route !== options.route) {
      await reject(request, request.vessel.registry, 'port-or-route-not-accepted');
      return;
    }
    const evidenceUri = request.journey.exitEvidence;
    let evidence: ExitEvent | undefined;
    let evidenceVerification: unknown;
    if (evidenceUri) {
      const resolved = await resolveExitEvidence(evidenceUri, { vessel: request.vessel.id, registry: request.vessel.registry }, { fetcher });
      evidenceVerification = resolved.verification;
      evidence = resolved.exit;
      if (!resolved.exit || !resolved.verification.cryptographic.verified || !resolved.verification.attribution.attributed || !resolved.verification.expectedIssuer.matches || !resolved.binding.bound) {
        await reject(request, request.vessel.registry, 'exit-evidence-invalid-or-unbound');
        return;
      }
      if (!options.acceptedTerritories.includes(resolved.exit.territory)) {
        await reject(request, request.vessel.registry, 'prior-territory-not-accepted');
        return;
      }
    } else if (options.requireExitEvidence) {
      await reject(request, request.vessel.registry, 'exit-evidence-required');
      return;
    }
    const manifestSource = evidence && manifestPolicy === 'evidence' ? 'evidence' : 'request';
    const difference = evidence ? compareCargo(request.cargo, evidence.cargo) : undefined;
    if (manifestPolicy === 'reject-difference' && difference && (difference.leftOnly.length > 0 || difference.rightOnly.length > 0)) {
      await reject(request, request.vessel.registry, 'cargo-differs-from-exit-evidence');
      return;
    }
    const cargo = manifestSource === 'evidence' && evidence ? evidence.cargo : request.cargo;
    if (Object.values(current.visits).some((visit) => visit.decision.accepted && visit.vessel === request.vessel.id && !visit.exited)) {
      await reject(request, request.vessel.registry, 'vessel-already-visiting');
      return;
    }
    const simulation = structuredClone(current.simulation);
    const simulationVessel = `${request.vessel.id}#${encodeURIComponent(request.id)}`;
    try {
      admitVessel(simulation, simulationVessel, request.vessel.capacity, cargo);
    } catch (error) {
      if (!(error instanceof Error) || ![
        'invalid or duplicate vessel',
        'cargo commodity mass is not configured',
        'vessel capacity exceeded',
      ].includes(error.message)) throw error;
      await reject(request, request.vessel.registry, error.message);
      return;
    }
    const visit: SimulationVisit = {
      request: structuredClone(request), registry: request.vessel.registry, possessor: request.vessel.possessor,
      vessel: request.vessel.id, simulationVessel, port: request.destination.port, route: request.destination.route,
      ...(evidence ? { evidence: structuredClone(evidence), evidenceVerification } : {}),
      decision: { accepted: true, reason: 'locally-accepted', manifestSource }, exited: false,
    };
    await commit((state) => {
      state.simulation = simulation;
      state.visits[request.id] = visit;
      state.decisions.push({ request: request.id, accepted: true, reason: visit.decision.reason, tick: simulation.tick });
      state.handledIds[request.id] = hash;
      if (evidence) state.evidence[evidence.id] = structuredClone(evidence);
    });
  });

  const onDeparture = async (context: HandlerContext, raw: unknown): Promise<void> => serialized(async () => {
    const checked = validateModel<DepartureRequest>(raw as Record<string, unknown>, 'DepartureRequest');
    if (!checked.success) throw new TypeError(`Invalid DepartureRequest: ${checked.issues.map((issue) => issue.message).join(', ')}`);
    const request = checked.data;
    const hash = JSON.stringify(request);
    const current = await snapshot();
    const previous = current.handledIds[request.id];
    if (previous) {
      if (previous !== hash) throw new TypeError('Conflicting reuse of DepartureRequest ID');
      return;
    }
    const visit = Object.values(current.visits).find((item) => item.vessel === request.vessel && item.registry === context.senderActor && !item.exited);
    if (!visit || request.territory !== actorId || request.port !== visit.port || !context.verification.cryptographic.verified || !context.verification.attribution.attributed || !context.verification.expectedIssuer.matches) {
      throw new Error('DepartureRequest failed local vessel, port, territory, or verification checks');
    }
    if (request.route && request.route !== visit.route) throw new Error('DepartureRequest route does not match the admitted route');
    const next = structuredClone(current);
    const vessel = next.simulation.vessels.find((item) => item.id === visit.simulationVessel);
    if (!vessel || vessel.status !== 'berthed') throw new Error('Departure requires a berthed vessel');
    visit.departureRequest = structuredClone(request);
    next.visits[visit.request.id] = visit;
    next.handledIds[request.id] = hash;
    await commit((state) => Object.assign(state, next));
  });

  host.server.on(actorId, 'EntryRequest', onEntry);
  host.server.on(actorId, 'DepartureRequest', onDeparture);

  return {
    state: snapshot,
    mine: (count, duration) => serialized(async () => {
      const current = await snapshot(); const simulation = structuredClone(current.simulation);
      const id = startMining(simulation, count, duration);
      await commit((state) => { state.simulation = simulation; }); return id;
    }),
    manufacture: (input, count) => serialized(async () => {
      const current = await snapshot(); const simulation = structuredClone(current.simulation);
      const id = startManufacturing(simulation, input, count);
      await commit((state) => { state.simulation = simulation; }); return id;
    }),
    handle: (requestId, operation, cargo, duration) => serialized(async () => {
      const current = await snapshot(); const visit = current.visits[requestId];
      if (!visit?.decision.accepted || visit.exited) throw new Error('Unknown or inactive EntryRequest');
      const simulation = structuredClone(current.simulation);
      const id = scheduleHandling(simulation, visit.simulationVessel, operation, cargo, duration);
      await commit((state) => { state.simulation = simulation; }); return id;
    }),
    configureMining: (enabled, capacity) => serialized(async () => {
      const current = await snapshot(); const simulation = structuredClone(current.simulation); configureMining(simulation, enabled, capacity);
      await commit((state) => { state.simulation = simulation; });
    }),
    configureManufacturing: (slots, time) => serialized(async () => {
      const current = await snapshot(); const simulation = structuredClone(current.simulation); configureManufacturing(simulation, slots, time);
      await commit((state) => { state.simulation = simulation; });
    }),
    configureFacilities: (facilities) => serialized(async () => {
      const current = await snapshot(); const simulation = structuredClone(current.simulation);
      if (facilities.mining) configureMining(simulation, facilities.mining.enabled, facilities.mining.capacity);
      if (facilities.manufacturing) configureManufacturing(simulation, facilities.manufacturing.slots, facilities.manufacturing.time);
      if (facilities.port) configurePort(simulation, facilities.port.capacity, facilities.port.berths);
      await commit((state) => { state.simulation = simulation; });
    }),
    tick: () => serialized(async () => {
      const current = await snapshot(); const state = structuredClone(current); const completed = advanceTick(state.simulation);
      const outgoing: Array<Awaited<ReturnType<typeof outbound>>> = [];
      for (const effect of completed) {
        if (effect.type === 'berthing' && effect.vessel) {
          const visit = Object.values(state.visits).find((item) => item.simulationVessel === effect.vessel && !item.exited);
          if (!visit) throw new Error(`Missing admitted visit for vessel ${effect.vessel}`);
          const event = { id: uri('berthing'), type: 'BerthingEvent', vessel: visit.vessel, territory: actorId, port: visit.port, request: visit.request.id, effectiveAt: stamp(effect.tick) };
          outgoing.push(await outbound(visit.registry, event, `${event.id}/activity`));
        }
        if (effect.type === 'cargo-operation' && effect.vessel && effect.operation && effect.cargo) {
          const visit = Object.values(state.visits).find((item) => item.simulationVessel === effect.vessel && !item.exited);
          if (!visit) throw new Error(`Missing admitted visit for vessel ${effect.vessel}`);
          const event = { id: uri('cargo-operation'), type: 'CargoOperationEvent', vessel: visit.vessel, territory: actorId, port: visit.port, operation: effect.operation, cargo: effect.cargo, effectiveAt: stamp(effect.tick) };
          outgoing.push(await outbound(visit.registry, event, `${event.id}/activity`));
        }
      }
      for (const visit of Object.values(state.visits)) {
        if (!visit.departureRequest || visit.exited) continue;
        const vessel = state.simulation.vessels.find((item) => item.id === visit.simulationVessel);
        if (!vessel || vessel.status !== 'berthed' || state.simulation.handlingJobs.some((job) => job.vessel === visit.simulationVessel)) continue;
        departVessel(state.simulation, visit.simulationVessel);
        const departure: DepartureEvent = { id: uri('departure'), type: 'DepartureEvent', vessel: visit.vessel, territory: actorId, port: visit.port, request: visit.departureRequest.id, effectiveAt: stamp(state.simulation.tick) };
        const exitDraft: Omit<ExitEvent, 'proof'> = { id: uri('exit'), type: 'ExitEvent', vessel: visit.vessel, territory: actorId, route: visit.departureRequest.route ?? visit.route, entryRequest: visit.request.id, departureEvent: departure.id, cargo: cargoFromVessel(vessel.cargo), effectiveAt: stamp(state.simulation.tick) };
        const exit = await host.signObject(actorName, exitDraft as unknown as Record<string, unknown>) as ExitEvent;
        visit.departureEvent = departure; visit.exited = true;
        outgoing.push(await outbound(visit.registry, departure as unknown as Record<string, unknown>, `${departure.id}/activity`));
        outgoing.push(await outbound(visit.registry, exit as unknown as Record<string, unknown>, `${exit.id}/activity`));
      }
      await commit((persisted) => Object.assign(persisted, state), outgoing);
      return state;
    }),
  };
}

function cargoFromVessel(cargo: VesselCargo[]): CargoManifest {
  return { entries: cargo.map((item) => item.quantityKind === 'Item'
    ? { id: item.id!, variety: item.commodity, data: structuredClone(item.data ?? {}) }
    : { variety: item.commodity, count: item.count, data: structuredClone(item.data ?? {}) }) };
}
