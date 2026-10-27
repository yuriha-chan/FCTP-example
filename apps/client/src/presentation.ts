type RecordValue = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);

const label = (uri: string): string => {
  const part = uri.split(/[/#]/).filter(Boolean).at(-1);
  if (!part) return uri;
  try { return decodeURIComponent(part); } catch (error) { if (error instanceof URIError) return part; throw error; }
};

const numeric = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const quantity = (value: unknown): string => {
  if (!isRecord(value)) return 'unknown quantity';
  const variety = typeof value.variety === 'string' ? value.variety : typeof value.commodity === 'string' ? value.commodity : 'unknown variety';
  const count = numeric(value.count);
  const item = typeof value.id === 'string' ? ` (item ${label(value.id)})` : '';
  const data = isRecord(value.data) && Object.keys(value.data).length > 0 ? ` [${Object.entries(value.data).map(([key, itemData]) => `${key}: ${typeof itemData === 'string' ? itemData : JSON.stringify(itemData)}`).join(', ')}]` : '';
  return `${count === undefined ? typeof value.id === 'string' ? '1' : 'some' : count} × ${label(variety)}${item}${data}`;
};

const itemList = (value: unknown, empty = 'empty'): string => {
  if (!Array.isArray(value) || value.length === 0) return empty;
  return value.map(quantity).join(', ');
};

const manifest = (value: unknown, empty = 'empty'): string => {
  if (!isRecord(value) || !Array.isArray(value.entries) || value.entries.length === 0) return empty;
  return itemList(value.entries);
};

const counts = (value: unknown): string => {
  if (!isRecord(value)) return 'none';
  const entries = Object.entries(value).filter(([, count]) => typeof count === 'number' && count > 0);
  return entries.length === 0 ? 'none' : entries.map(([variety, count]) => `${String(count)} × ${label(variety)}`).join(', ');
};

const stock = (value: unknown): string => {
  if (!Array.isArray(value) || value.length === 0) return 'none';
  const byIdentity = new Map<string, { entry: RecordValue; count: number }>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.commodity !== 'string') continue;
    const count = numeric(entry.count);
    if (count === undefined) continue;
    const key = JSON.stringify([entry.commodity, entry.id ?? null, entry.data ?? null]);
    const current = byIdentity.get(key);
    if (current) current.count += count;
    else byIdentity.set(key, { entry, count });
  }
  return byIdentity.size === 0 ? 'none' : [...byIdentity.values()].map(({ entry, count }) => quantity({ ...entry, count, variety: entry.commodity })).join(', ');
};

const visitCandidates = (source: RecordValue): RecordValue[] => {
  const visits = source.visits;
  const candidates: RecordValue[] = [];
  if (Array.isArray(visits)) {
    for (const visit of visits) if (isRecord(visit)) candidates.push(visit);
  } else if (isRecord(visits)) {
    for (const visit of Object.values(visits)) if (isRecord(visit)) candidates.push(visit);
  }
  if (isRecord(source.visit)) candidates.push(source.visit);
  return candidates;
};

const visitVessel = (visit: RecordValue): unknown => visit.vessel ?? visit.vesselId ?? (isRecord(visit.request) && isRecord(visit.request.vessel) ? visit.request.vessel.id : undefined);

const visitFor = (source: RecordValue, viewerVessel?: string): RecordValue | undefined => {
  const candidates = visitCandidates(source);
  if (viewerVessel) {
    const scoped = candidates.filter((visit) => visitVessel(visit) === viewerVessel);
    return [...scoped].reverse().find((visit) => visit.departed !== true && visit.exited !== true) ?? scoped.at(-1) ?? (isRecord(source.visit) && candidates.length === 1 ? source.visit : undefined);
  }
  return undefined;
};

const visitSummary = (visit: RecordValue | undefined): string[] => {
  if (!visit) return ['Current local visit: none recorded in this scope.'];
  const request = isRecord(visit.request) ? visit.request : {};
  const lines: string[] = [];
  const status = visit.departed === true || visit.exited === true ? 'departed' : typeof visit.status === 'string' ? visit.status : visit.decided === true ? 'accepted' : 'recorded';
  lines.push(`Current local visit: ${status}.`);
  if (typeof visit.port === 'string') lines.push(`Port: ${label(visit.port)}.`);
  if (typeof visit.route === 'string') lines.push(`Route: ${label(visit.route)}.`);
  if (typeof visit.entryRequest === 'string') lines.push(`Entry request: ${visit.entryRequest}.`);
  else if (typeof request.id === 'string') lines.push(`Entry request: ${request.id}.`);
  if (isRecord(visit.cargo) || Array.isArray(visit.cargo)) lines.push(`Vessel cargo: ${Array.isArray(visit.cargo) ? itemList(visit.cargo) : manifest(visit.cargo)}.`);
  if (Array.isArray(visit.handling) && visit.handling.length > 0) lines.push(`Handling in progress: ${visit.handling.map((job) => isRecord(job) ? `${String(job.operation ?? 'handling')} ${Array.isArray(job.cargo) ? itemList(job.cargo) : manifest(job.cargo)} (${String(job.remainingTicks ?? '?')} ticks left)` : 'unknown job').join('; ')}.`);
  return lines;
};

const policySummary = (source: RecordValue, viewerVessel?: string): string[] => {
  const state = isRecord(source.state) ? source.state : source;
  const policy = isRecord(state.policy) ? state.policy : {};
  const lines: string[] = [];
  const permitted = policy.miningPermitted === true ? 'permitted' : 'not permitted';
  const quota = numeric(policy.miningQuota);
  const reserve = numeric(policy.oreReserve);
  lines.push(`Mining: ${permitted}${quota === undefined ? '' : `; quota ${quota}`}${reserve === undefined ? '' : `; ore reserve ${reserve}`}.`);
  if (Array.isArray(policy.recipes)) {
    for (const recipe of policy.recipes) {
      if (!isRecord(recipe)) continue;
      const ingredients = isRecord(recipe.ingredients) ? counts(recipe.ingredients) : 'no materials';
      const output = typeof recipe.output === 'string' ? label(recipe.output) : 'unknown output';
      const outputCount = numeric(recipe.outputCount) ?? 1;
      lines.push(`Recipe ${String(recipe.id ?? 'local')}: ${ingredients} → ${outputCount} × ${output}.`);
    }
  }
  lines.push(`Shared warehouse: ${counts(state.rawInventory)}.`);
  lines.push(`Shared port: ${counts(state.portInventory)}.`);
  const reserved = isRecord(state.productionReservations) ? counts(state.productionReservations) : 'none';
  if (reserved !== 'none') lines.push(`Reserved for production: ${reserved}.`);
  const visit = visitFor(source, viewerVessel) ?? visitFor(state, viewerVessel);
  if (visit) lines.push(...visitSummary(visit));
  else if (viewerVessel) lines.push(...visitSummary(undefined));
  else {
    const visits = visitCandidates(source).length > 0 ? visitCandidates(source) : visitCandidates(state);
    if (visits.length) {
      lines.push(`Local visits recorded: ${visits.length}.`);
      for (const entry of visits) lines.push(...visitSummary(entry));
    }
  }
  const admission = isRecord(source.admission) ? source.admission : isRecord(state.admission) ? state.admission : undefined;
  if (admission) {
    const mismatch = typeof admission.mismatchPolicy === 'string' ? admission.mismatchPolicy : 'not stated';
    const publicPorts = Array.isArray(admission.publicPorts) ? admission.publicPorts.map((port) => typeof port === 'string' ? label(port) : 'unknown').join(', ') : 'none';
    lines.push(`Admission: cargo mismatch ${mismatch}; public ports ${publicPorts}.`);
  }
  if (isRecord(source.decisions)) lines.push(`Recorded admission decisions: ${Object.keys(source.decisions).length}.`);
  return lines;
};

const facilitySummary = (config: RecordValue): string => {
  const mining = isRecord(config.mining) ? config.mining : {};
  const manufacturing = isRecord(config.manufacturing) ? config.manufacturing : {};
  const port = isRecord(config.port) ? config.port : {};
  const miningEnabled = (mining.enabled ?? config.miningEnabled) === true ? 'enabled' : 'disabled';
  const miningCapacity = numeric(mining.capacity ?? config.miningCapacity);
  const slots = numeric(manufacturing.slots ?? config.manufacturingSlots);
  const time = numeric(manufacturing.time ?? config.manufacturingTime);
  const portCapacity = numeric(port.capacity ?? config.portCapacity);
  const berths = numeric(port.berths ?? config.berthCapacity);
  return `Facilities: mining ${miningEnabled}${miningCapacity === undefined ? '' : ` (capacity ${miningCapacity})`}; manufacturing ${slots === undefined ? 'unknown slots' : `${slots} slots`}${time === undefined ? '' : ` of ${time} ticks`}; port ${portCapacity === undefined ? 'unknown capacity' : `capacity ${portCapacity}`}${berths === undefined ? '' : ` with ${berths} berth${berths === 1 ? '' : 's'}`}.`;
};

const simulationSummary = (source: RecordValue, viewerVessel?: string): string[] => {
  const simulation = isRecord(source.simulation) ? source.simulation : source;
  const shared = isRecord(simulation.sharedStock) ? simulation.sharedStock : undefined;
  const config = isRecord(simulation.config) ? simulation.config : isRecord(simulation.facilities) ? simulation.facilities : {};
  const tick = numeric(simulation.tick);
  const lines: string[] = [];
  if (tick !== undefined) lines.push(`Local tick: ${tick}.`);
  lines.push(facilitySummary({ ...config, ...(isRecord(config.facilities) ? config.facilities : {}) }));
  lines.push(`Shared raw stock: ${stock(simulation.rawStock ?? shared?.raw)}.`);
  lines.push(`Shared products: ${stock(simulation.productStock ?? shared?.products)}.`);
  const productionJobs = Array.isArray(simulation.productionJobs) ? simulation.productionJobs : Array.isArray(simulation.queuedProduction) ? simulation.queuedProduction : [];
  if (productionJobs.length > 0) {
    lines.push(`Production in progress: ${productionJobs.map((job) => isRecord(job) ? `${String(job.kind ?? 'work')} ${String(job.count ?? 1)} × ${typeof job.output === 'string' ? label(job.output) : 'output'} (${String(job.remainingTicks ?? '?')} ticks left)` : 'unknown job').join('; ')}.`);
  }
  if (Array.isArray(simulation.handlingJobs) && simulation.handlingJobs.length > 0) {
    const relevant = viewerVessel ? simulation.handlingJobs.filter((job) => isRecord(job) && (job.vessel === viewerVessel || String(job.vessel ?? '').startsWith(`${viewerVessel}#`))) : simulation.handlingJobs;
    if (relevant.length > 0) lines.push(`Cargo handling: ${relevant.map((job) => isRecord(job) ? `${String(job.operation ?? 'handling')} ${Array.isArray(job.cargo) ? itemList(job.cargo) : manifest(job.cargo)} (${String(job.remainingTicks ?? '?')} ticks left)` : 'unknown job').join('; ')}.`);
  }
  const persistedVisits = visitCandidates(source);
  const selectedVisit = viewerVessel
    ? (() => {
        const scoped = persistedVisits.filter((visit) => visitVessel(visit) === viewerVessel);
        return [...scoped].reverse().find((visit) => visit.exited !== true) ?? scoped.at(-1);
      })()
    : undefined;
  const visit = selectedVisit && typeof selectedVisit.simulationVessel === 'string'
    ? (() => {
        const vessel = Array.isArray(simulation.vessels) ? simulation.vessels.find((item) => isRecord(item) && item.id === selectedVisit.simulationVessel) : undefined;
        const handling = Array.isArray(simulation.handlingJobs) ? simulation.handlingJobs.filter((job) => isRecord(job) && job.vessel === selectedVisit.simulationVessel) : [];
        return { ...selectedVisit, ...(isRecord(vessel) ? { status: vessel.status, cargo: vessel.cargo } : {}), handling };
      })()
    : visitFor(source, viewerVessel) ?? visitFor(simulation, viewerVessel);
  if (visit) lines.push(...visitSummary(visit));
  else if (viewerVessel) lines.push(...visitSummary(undefined));
  else if (persistedVisits.length > 0 || isRecord(source.visits) || Array.isArray(source.visits)) {
    const visits = persistedVisits;
    lines.push(`Local visits recorded: ${visits.length}.`);
    for (const entry of visits) {
      const vessel = typeof entry.simulationVessel === 'string' && Array.isArray(simulation.vessels) ? simulation.vessels.find((item) => isRecord(item) && item.id === entry.simulationVessel) : undefined;
      const handling = typeof entry.simulationVessel === 'string' && Array.isArray(simulation.handlingJobs) ? simulation.handlingJobs.filter((job) => isRecord(job) && job.vessel === entry.simulationVessel) : [];
      lines.push(...visitSummary({ ...entry, ...(isRecord(vessel) ? { status: vessel.status, cargo: vessel.cargo } : {}), handling }));
    }
  }
  const recent = Array.isArray(simulation.audit) ? simulation.audit.at(-1) : undefined;
  if (isRecord(recent)) lines.push(`Latest local record: ${String(recent.action ?? 'activity')} at tick ${String(recent.tick ?? '?')}.`);
  return lines;
};

export function formatRegistryState(state: RecordValue, vessel?: string): string {
  const lines: string[] = [];
  if (vessel) lines.push(`Vessel: ${vessel}.`);
  lines.push(`Registry cargo: ${manifest(state.cargo)}.`);
  if (isRecord(state.vessel)) {
    const vessel = state.vessel;
    const details = [typeof vessel.name === 'string' ? vessel.name : undefined, typeof vessel.id === 'string' ? vessel.id : undefined, typeof vessel.possessor === 'string' ? `possessor ${vessel.possessor}` : undefined].filter(Boolean);
    if (details.length) lines.push(`Vessel record: ${details.join('; ')}.`);
  }
  lines.push(`Territory notifications: ${state.adoption === true ? 'adopted' : 'not adopted'}.`);
  const location = isRecord(state.location) ? state.location : undefined;
  if (location) {
    const status = typeof location.status === 'string' ? location.status.replaceAll('-', ' ') : 'recorded';
    const place = typeof location.port === 'string' ? ` at ${label(location.port)}` : '';
    const territory = typeof location.territory === 'string' ? ` in ${label(location.territory)}` : '';
    lines.push(`Recorded location: ${status}${place}${territory}.`);
    if (typeof location.entryRequest === 'string') lines.push(`Current entry request: ${location.entryRequest}.`);
  }
  const pending = Array.isArray(state.pendingRequests) ? state.pendingRequests.length : isRecord(state.requests) ? Object.keys(state.requests).length : 0;
  lines.push(`Pending Registry requests: ${pending}.`);
  if (typeof state.latestExitEvidence === 'string') lines.push(`Latest exit evidence: ${state.latestExitEvidence}.`);
  const events = Array.isArray(state.events) ? state.events.length : 0;
  if (events > 0) lines.push(`Recorded Territory events: ${events}.`);
  return lines.join('\n');
}

export function formatDiscovery(result: { kind: string; state: RecordValue; notes?: string[]; observedAt?: string; vessel?: string }): string {
  const lines: string[] = [];
  if (result.observedAt) lines.push(`Observed at ${result.observedAt}.`);
  if (result.kind === 'registry') {
    lines.push(formatRegistryState(result.state, result.vessel));
  } else if (result.kind === 'policy') {
    lines.push(...policySummary(result.state, result.vessel));
  } else {
    lines.push(...simulationSummary(result.state, result.vessel));
  }
  if (result.notes && result.notes.length > 0) {
    lines.push('');
    for (const note of result.notes) lines.push(note);
  }
  return lines.join('\n');
}

export function formatPolicyState(result: RecordValue, viewerVessel?: string): string {
  return policySummary(result, viewerVessel).join('\n');
}

export function formatSimulationState(result: RecordValue, viewerVessel?: string): string {
  return simulationSummary(result, viewerVessel).join('\n');
}

export function formatActor(actor: RecordValue): string {
  const lines: string[] = [];
  if (typeof actor.id === 'string') lines.push(`Actor: ${actor.id}.`);
  if (typeof actor.name === 'string') lines.push(`Name: ${actor.name}.`);
  if (typeof actor.type === 'string') lines.push(`Type: ${actor.type}.`);
  if (typeof actor.role === 'string') lines.push(`Role: ${actor.role}.`);
  if (typeof actor.inbox === 'string') lines.push(`Inbox: ${actor.inbox}.`);
  if (typeof actor.outbox === 'string') lines.push(`Outbox: ${actor.outbox}.`);
  const resources = isRecord(actor.resources) ? actor.resources : undefined;
  if (resources) {
    const parts: string[] = [];
    for (const key of ['ports', 'routes'] as const) if (typeof resources[key] === 'string') parts.push(`${key} ${resources[key]}`);
    if (Array.isArray(resources.areas)) parts.push(`${resources.areas.length} area${resources.areas.length === 1 ? '' : 's'}`);
    if (parts.length > 0) lines.push(`Territory resources: ${parts.join('; ')}.`);
  }
  if (Array.isArray(actor.capabilities) && actor.capabilities.length > 0) lines.push(`Capabilities: ${actor.capabilities.join(', ')}.`);
  return lines.join('\n');
}

export function formatVerification(result: RecordValue): string {
  const lines: string[] = [];
  const exit = isRecord(result.exit) ? result.exit : undefined;
  if (exit && typeof exit.id === 'string') lines.push(`Exit record: ${exit.id}.`);
  if (exit && isRecord(exit.cargo)) lines.push(`Cargo when leaving: ${manifest(exit.cargo)}.`);
  const verification = isRecord(result.verification) ? result.verification : result;
  const crypto = isRecord(verification.cryptographic) ? verification.cryptographic : {};
  const attribution = isRecord(verification.attribution) ? verification.attribution : {};
  const issuer = isRecord(verification.expectedIssuer) ? verification.expectedIssuer : {};
  const cryptoStatus = result.proofCryptography === 'verified' ? 'verified' : result.proofCryptography === 'failed' ? 'failed' : crypto.verified === true ? 'verified' : crypto.verified === false ? 'failed' : 'unknown';
  const attributionStatus = typeof result.keyAttribution === 'string' ? result.keyAttribution.startsWith('attributed') ? `recognized${typeof attribution.publisher === 'string' ? ` as ${attribution.publisher}` : ''}` : result.keyAttribution.startsWith('not attributed: unknown') ? 'unknown' : 'not recognized' : attribution.attributed === true ? `recognized${typeof attribution.publisher === 'string' ? ` as ${attribution.publisher}` : ''}` : attribution.attributed === false ? 'not recognized' : 'unknown';
  lines.push(`Signature: ${cryptoStatus}.`);
  lines.push(`Signer: ${attributionStatus}.`);
  const expectedIssuer = result.expectedIssuer;
  const issuerStatus = expectedIssuer === 'verified' || issuer.matches === true ? 'matches' : expectedIssuer === 'failed' || issuer.matches === false ? 'does not match' : 'not established';
  lines.push(`Expected issuer: ${issuerStatus}.`);
  const binding = isRecord(result.binding) ? result.binding : {};
  lines.push(`Entry request binding: ${binding.bound === true ? 'bound' : 'not bound'}${typeof binding.reason === 'string' ? ` (${binding.reason})` : ''}.`);
  if (isRecord(result.registryDeclaredCargo)) lines.push(`Registry declared cargo: ${manifest(result.registryDeclaredCargo)}.`);
  if (isRecord(result.exitEventCargo)) lines.push(`Exit event cargo: ${manifest(result.exitEventCargo)}.`);
  if (isRecord(result.descriptiveDifference)) {
    const left = Array.isArray(result.descriptiveDifference.leftOnly) ? result.descriptiveDifference.leftOnly.length : 0;
    const right = Array.isArray(result.descriptiveDifference.rightOnly) ? result.descriptiveDifference.rightOnly.length : 0;
    lines.push(`Cargo comparison: ${left === 0 && right === 0 ? 'the descriptions agree' : 'the descriptions differ'}.`);
    if (left > 0) lines.push(`Only the Registry describes: ${itemList(result.descriptiveDifference.leftOnly)}.`);
    if (right > 0) lines.push(`Only the exit describes: ${itemList(result.descriptiveDifference.rightOnly)}.`);
  }
  if (typeof result.error === 'string') lines.push(`Problem: ${result.error}.`);
  return lines.join('\n');
}

export function formatResource(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return 'No entries.';
    return value.map((entry) => isRecord(entry) ? formatResource(entry) : String(entry)).join('\n\n');
  }
  if (!isRecord(value)) return 'No readable details.';
  const lines: string[] = [];
  const fleetEntries = isRecord(value.vessels) ? Object.entries(value.vessels) : Object.entries(value).filter(([, entry]) => isRecord(entry) && isRecord(entry.vessel));
  const fleet = fleetEntries.filter(([, entry]) => isRecord(entry) && isRecord(entry.vessel));
  if (fleet.length > 0) {
    lines.push(`Fleet: ${fleet.length} vessel${fleet.length === 1 ? '' : 's'}.`);
    for (const [id, entry] of fleet) {
      if (!isRecord(entry)) continue;
      const vessel = isRecord(entry.vessel) ? entry.vessel : {};
      lines.push(`\n${typeof vessel.name === 'string' ? vessel.name : id}\n${formatRegistryState(entry, id)}`);
    }
  }
  if (typeof value.type === 'string') lines.push(`Type: ${value.type}.`);
  if (typeof value.id === 'string') lines.push(`Identifier: ${value.id}.`);
  if (typeof value.name === 'string') lines.push(`Name: ${value.name}.`);
  if (typeof value.role === 'string') lines.push(`Role: ${value.role}.`);
  if (typeof value.holder === 'string') lines.push(`Holder: ${value.holder}.`);
  if (Array.isArray(value.creator)) lines.push(`Creators: ${value.creator.filter((item) => typeof item === 'string').join(', ') || 'none'}.`);
  if (typeof value.mass === 'number') lines.push(`Mass: ${value.mass}.`);
  if (typeof value.version === 'string') lines.push(`Version: ${value.version}.`);
  if (isRecord(value.cargo)) lines.push(`Cargo: ${manifest(value.cargo)}.`);
  if (Array.isArray(value.media)) lines.push(`Media: ${value.media.length} item${value.media.length === 1 ? '' : 's'}.`);
  if (Array.isArray(value.production)) {
    lines.push(`Production (${value.production.length} entr${value.production.length === 1 ? 'y' : 'ies'}; descriptive only):`);
    for (const entry of value.production) if (isRecord(entry)) lines.push(`- ${formatProduction(entry)}`);
  }
  for (const key of ['orderedItems', 'items'] as const) {
    if (!Array.isArray(value[key])) continue;
    lines.push(`Collection entries: ${value[key].length}.`);
    for (const item of value[key]) {
      if (typeof item === 'string') lines.push(`- ${item}`);
      else if (isRecord(item)) lines.push(`- ${String(item.name ?? item.type ?? 'Entry')}${typeof item.id === 'string' ? `: ${item.id}` : ''}`);
    }
  }
  if (typeof value.variety === 'string') lines.push(`Variety: ${label(value.variety)}.`);
  if (typeof value.count === 'number') lines.push(`Count: ${value.count}.`);
  if (isRecord(value.location)) {
    const status = typeof value.location.status === 'string' ? value.location.status.replaceAll('-', ' ') : 'recorded';
    lines.push(`Location: ${status}.`);
  }
  if (isRecord(value.vessel) && typeof value.vessel.id === 'string') lines.push(`Vessel: ${value.vessel.id}.`);
  if (isRecord(value.simulation)) lines.push(...simulationSummary(value));
  if (isRecord(value.state)) lines.push(...policySummary(value));
  if (typeof value.error === 'string') lines.push(`Problem: ${value.error}.`);
  if (lines.length === 0) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') lines.push(`${key}: ${String(item)}.`);
      else if (Array.isArray(item)) lines.push(`${key}: ${item.length} entr${item.length === 1 ? 'y' : 'ies'}.`);
      else if (isRecord(item)) lines.push(`${key}: recorded.`);
    }
  }
  return lines.length === 0 ? 'No readable details.' : lines.join('\n');
}

const formatProduction = (entry: RecordValue): string => {
  const details: string[] = [];
  if (typeof entry.type === 'string') details.push(entry.type);
  if (entry.ingredients !== undefined) details.push(`ingredients ${Array.isArray(entry.ingredients) ? itemList(entry.ingredients, 'none') : isRecord(entry.ingredients) ? counts(entry.ingredients) : String(entry.ingredients)}`);
  if (entry.tool !== undefined) details.push(`tool ${typeof entry.tool === 'string' ? label(entry.tool) : JSON.stringify(entry.tool)}`);
  if (entry.duration !== undefined) details.push(`duration ${String(entry.duration)}`);
  if (entry.location !== undefined) details.push(`location ${Array.isArray(entry.location) ? entry.location.map(formatProductionLocation) : formatProductionLocation(entry.location)}`);
  if (entry.yield !== undefined) details.push(`yield ${Array.isArray(entry.yield) ? entry.yield.map((item) => isRecord(item) ? `${String(item.probability ?? '?')} chance of ${String(item.count ?? '?')}${isRecord(item.data) && Object.keys(item.data).length ? ` with ${JSON.stringify(item.data)}` : ''}` : String(item)).join(', ') : JSON.stringify(entry.yield)}`);
  const known = new Set(['type', 'ingredients', 'tool', 'duration', 'location', 'yield']);
  const extensions = Object.entries(entry).filter(([key]) => !known.has(key)).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  if (extensions.length) details.push(`details ${extensions.join('; ')}`);
  return details.join('; ') || 'details unavailable';
};

const formatProductionLocation = (location: unknown): string => {
  if (typeof location === 'string') return label(location);
  if (!isRecord(location)) return String(location);
  const metadata = [location.id, location.name, location.territory].filter((value): value is string => typeof value === 'string');
  return metadata.length > 0 ? metadata.join(' / ') : JSON.stringify(location);
};

export function formatResult(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (isRecord(value) && value.requestAccepted === true) return 'Request accepted by the local service. Refresh the relevant state to see the recorded result.';
  if (isRecord(value) && typeof value.reason === 'string') return `Not completed: ${value.reason}.`;
  if (isRecord(value) && typeof value.error === 'string') return `Not completed: ${value.error}.`;
  return formatResource(value);
}

export function formatActionReason(reason: string): string {
  const messages: Record<string, string> = {
    'no-persisted-local-visit': 'A current local berth is required before cargo can move.',
    'no-active-local-berth': 'This vessel has no current local berth.',
    'vessel-already-has-active-local-visit': 'This vessel already has a berth here.',
    'blocked-by-local-domain-rules': 'The local Territory rules do not allow this action right now.',
    'not-enough-ingredients': 'There are not enough shared ingredients.',
    'not-enough-stock': 'There is not enough shared stock.',
    'insufficient stock': 'There is not enough shared stock.'
  };
  if (messages[reason]) return messages[reason];
  if (/^insufficient stock:/.test(reason)) return `There is not enough ${label(reason.slice('insufficient stock:'.length))}.`;
  if (/^insufficient unreserved product stock:/.test(reason)) return 'No unreserved product stock is available to load.';
  if (/^insufficient unreserved vessel cargo:/.test(reason)) return 'This vessel has no unreserved cargo to unload.';
  return reason.replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

export function formatAuthoringEntry(kind: string, entry: RecordValue): string {
  const lines: string[] = [];
  const name = typeof entry.name === 'string' ? `“${entry.name}”` : 'Untitled';
  lines.push(`${kind}: ${name}`);
  if (typeof entry.id === 'string') lines.push(`Identifier: ${entry.id}`);
  if (typeof entry.mass === 'number') lines.push(`Mass: ${entry.mass}`);
  if (typeof entry.version === 'string') lines.push(`Version: ${entry.version}`);
  if (typeof entry.asset === 'string') lines.push(`Asset: ${entry.asset}`);
  if (typeof entry.variety === 'string') lines.push(`Variety: ${entry.variety}`);
  if (typeof entry.asset === 'string' && typeof entry.grantee === 'string') lines.push(`Grantee: ${entry.grantee}`);
  if (Array.isArray(entry.media)) lines.push(`Text media: ${entry.media.length}`);
  if (Array.isArray(entry.production)) lines.push(`Production entries: ${entry.production.length}`);
  return lines.join('\n');
}
