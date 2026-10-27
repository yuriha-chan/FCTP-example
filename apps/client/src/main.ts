import type { CargoManifest, FCTPActor, URI } from '@fctp/protocol';
import { configuredOrigin, mapText, getAuthenticated, isRecord, loadConfig, localRequest as rawLocalRequest, portListings, readTextPublicThenAuthenticated, resolveInput, resolveReference, sdk, territoryResources, verifyExit, type BrowserLocalActionDiscovery } from './client.js';
import { setupAuthoring } from './authoring.js';
import { formatActionReason, formatActor, formatDiscovery, formatPolicyState, formatRegistryState, formatResult, formatSimulationState, formatVerification } from './presentation.js';

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing interface element: ${id}`);
  return element as T;
};
const form = (id: string): HTMLFormElement => byId<HTMLFormElement>(id);
const field = (formId: string, name: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
  const element = form(formId).elements.namedItem(name);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) throw new Error(`Missing form field: ${name}`);
  return element;
};
const value = (formId: string, name: string): string => field(formId, name).value.trim();
const show = (id: string, content: unknown): void => { byId(id).textContent = formatResult(content); };
const numberField = (formId: string, name: string): number => {
  const raw = value(formId, name);
  if (!raw) throw new TypeError(`${name} is required`);
  const result = Number(raw);
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError(`${name} must be a nonnegative integer`);
  return result;
};

document.documentElement.dataset.clientBusy = 'true';
const config = await loadConfig();
const localRequest = <T>(origin: string, path: string, options: Parameters<typeof rawLocalRequest<T>>[2] = {}): Promise<T> => {
  configuredOrigin(new URL(path, origin).href, config);
  return rawLocalRequest<T>(origin, path, options);
};
const actorIds = config.actors ?? {};
const territoryIds: Record<'policy' | 'simulation', string> = {
  policy: actorIds.policy ?? `${config.origins.policy}/actors/territory`,
  simulation: actorIds.simulation ?? `${config.origins.simulation}/actors/territory`
};
let nativeToken = '';
let registrySnapshot: Record<string, unknown> = {};
let policyInfo: Record<string, unknown> = {};
let simulationInfo: Record<string, unknown> = {};
type SessionRole = 'player' | 'policy-admin' | 'simulation-admin' | 'authority-admin';
let session: { role: SessionRole; player: string; vessel: string; credential: string } | undefined;
let busy = false;
let policySnapshot: Record<string, unknown> = {};
let admissionSnapshot: Record<string, unknown> = {};
let simulationConfigSnapshot: Record<string, unknown> = {};
let policyAdminReady = false;
let simulationAdminReady = false;
let policyCargoAvailable = false;
let simulationCargoAvailable = false;
let simulationCurrentEntryRequest = '';

function updateControlAvailability(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-action="policy-update"], [data-action="admission-update"]').forEach((button) => { button.disabled = busy || !policyAdminReady || session?.role !== 'policy-admin'; });
  document.querySelectorAll<HTMLButtonElement>('[data-action="facilities-update"], [data-action="simulation-tick"]').forEach((button) => { button.disabled = busy || !simulationAdminReady || session?.role !== 'simulation-admin'; });
  document.querySelectorAll<HTMLButtonElement>('[data-cargo-control]').forEach((button) => {
    const available = button.dataset.action?.startsWith('policy-') ? policyCargoAvailable : simulationCargoAvailable;
    button.disabled = busy || !available || session?.role !== 'player';
  });
}

function resetAdminState(): void {
  policyAdminReady = false;
  simulationAdminReady = false;
  policyCargoAvailable = false;
  simulationCargoAvailable = false;
  simulationCurrentEntryRequest = '';
  policySnapshot = {};
  admissionSnapshot = {};
  simulationConfigSnapshot = {};
  for (const name of ['miningQuota', 'oreReserve', 'policyAdvanced', 'admissionAdvanced']) field('policy-admin-form', name).value = '';
  for (const name of ['miningCapacity', 'manufacturingSlots', 'manufacturingTime', 'portCapacity', 'berthCapacity']) field('simulation-admin-form', name).value = '';
  for (const name of ['miningPermitted', 'manufacturePermitted', 'orePortPolicy', 'metalPortPolicy', 'mismatchPolicy']) field('policy-admin-form', name).value = '';
  field('simulation-admin-form', 'miningEnabled').value = '';
  field('policy-admin-form', 'policyMode').value = 'common';
  field('policy-admin-form', 'admissionMode').value = 'common';
  field('simulation-operation-form', 'entryRequest').value = '';
  field('simulation-operation-form', 'cargo').value = '';
  field('policy-operation-form', 'vessel').value = '';
  field('policy-operation-form', 'cargoVariety').value = '';
  syncAdminModes();
  (field('policy-admin-form', 'publicEast') as HTMLInputElement).checked = false;
  (field('policy-admin-form', 'publicWest') as HTMLInputElement).checked = false;
  updateControlAvailability();
}

function syncAdminModes(): void {
  const policyAdvanced = value('policy-admin-form', 'policyMode') === 'advanced';
  byId('policy-common-controls').hidden = policyAdvanced;
  byId('policy-advanced').hidden = !policyAdvanced;
  const admissionAdvanced = value('policy-admin-form', 'admissionMode') === 'advanced';
  byId('admission-common-controls').hidden = admissionAdvanced;
  byId('admission-advanced').hidden = !admissionAdvanced;
}

const credentialFor = (role: SessionRole): string => {
  if (!session || session.role !== role || !session.credential) throw new Error(`Apply a ${role} session first`);
  return session.credential;
};
const authorityAdmin = (): string => credentialFor('authority-admin');
const policyAdmin = (): string => credentialFor('policy-admin');
const simulationAdmin = (): string => credentialFor('simulation-admin');
const playerToken = (): string => {
  const token = session?.role === 'player' ? session.credential : value('authority-form', 'nativeToken') || nativeToken;
  if (!token) throw new Error('Issue or enter the native token first');
  return token;
};
const localPlayerToken = async (territory: string): Promise<string> => {
  const { deriveDiplomaticToken } = await import('@fctp/auth');
  return deriveDiplomaticToken(playerToken(), territory as URI);
};

async function task<T>(output: string, action: () => Promise<T>, refresh?: () => Promise<void>): Promise<void> {
  const status = byId('operation-status');
  if (busy) { status.textContent = 'Another operation is pending.'; status.dataset.state = 'busy'; return; }
  busy = true;
  status.textContent = 'Pending…'; status.dataset.state = 'busy';
  const controls = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('button, input, select, textarea')];
  const disabled = new Map(controls.map((control) => [control, control.disabled]));
  controls.forEach((control) => { control.disabled = true; });
  document.documentElement.dataset.clientBusy = 'true';
  try {
    const result = await action();
    if (result !== undefined) show(output, result);
    if (refresh) await refresh();
    status.textContent = 'Completed.'; status.dataset.state = 'idle';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    show(output, message); status.textContent = `Error: ${message}`; status.dataset.state = 'error';
  } finally {
    busy = false;
    controls.forEach((control) => { control.disabled = disabled.get(control) ?? false; });
    document.querySelectorAll<HTMLButtonElement>('button[data-discovered-action]').forEach((button) => { button.disabled = button.dataset.unavailable === 'true'; });
    document.querySelectorAll<HTMLButtonElement>('button[data-resource-action]').forEach((button) => { button.disabled = false; });
    updateControlAvailability();
    document.documentElement.dataset.clientBusy = 'false';
  }
}

const authoring = setupAuthoring({
  authorityOrigin: config.origins.authority,
  getSession: () => session ? { role: session.role, player: session.player, credential: session.credential } : undefined,
  request: localRequest,
  task: (output, action, refresh) => { void task(output, action, refresh); },
  getPublicResource: (uri) => sdk.get(uri as URI, { cache: false })
});

const actionOutputs: Record<string, string> = {
  'discover-registry': 'registry-discovery', 'discover-policy': 'policy-discovery', 'discover-simulation': 'simulation-discovery',
  'issue-token': 'registry-state', 'rotate-token': 'registry-state', 'digest-request': 'registry-state', 'revoke-token': 'registry-state', 'refresh-fleet': 'registry-fleet',
  'registry-entry': 'registry-state', 'registry-departure': 'registry-state', 'registry-adoption': 'registry-state', 'refresh-authority': 'registry-state',
  'policy-update': 'policy-result', 'admission-update': 'policy-result', 'policy-mine': 'policy-result', 'policy-manufacture': 'policy-result', 'policy-transfer': 'policy-result', 'policy-load': 'policy-result', 'policy-unload': 'policy-result', 'refresh-policy': 'policy-state',
  'facilities-update': 'simulation-result', 'simulation-tick': 'simulation-result', 'simulation-mine': 'simulation-result', 'simulation-manufacture': 'simulation-result', 'simulation-load': 'simulation-result', 'simulation-unload': 'simulation-result', 'refresh-simulation': 'simulation-state'
};

function addAction(action: string, handler: () => Promise<void>): void {
  const output = actionOutputs[action];
  if (!output) throw new Error(`Missing action output mapping: ${action}`);
  document.querySelectorAll<HTMLButtonElement>(`[data-action="${action}"]`).forEach((button) => {
    button.addEventListener('click', () => { void task(output, handler); });
  });
}

async function refreshAuthority(): Promise<void> {
  if (!session) throw new Error('Apply a session first');
  if (session.role !== 'player' && session.role !== 'authority-admin') throw new Error('Registry is unavailable to this role');
  if (!session.vessel) throw new Error('Select a vessel in the session form');
  const query = new URLSearchParams({ vessel: session.vessel });
  registrySnapshot = await localRequest<Record<string, unknown>>(config.origins.authority, `/local/registry/state?${query}`, { token: session.role === 'player' ? playerToken() : authorityAdmin() });
  const cargo = registrySnapshot.cargo as CargoManifest | undefined;
  const output = byId('registry-state');
  const vessel = isRecord(registrySnapshot.vessel) ? registrySnapshot.vessel.id : undefined;
  output.textContent = formatRegistryState({ ...registrySnapshot, declaredCargo: cargo }, typeof vessel === 'string' ? vessel : undefined);
  const exitUris = Array.isArray(registrySnapshot.exitEvidence) ? registrySnapshot.exitEvidence.filter((uri): uri is string => typeof uri === 'string') : [];
  for (const uri of exitUris) {
    const button = document.createElement('button');
     button.type = 'button'; button.textContent = `Verify ${uri}`; button.disabled = busy; button.dataset.resourceAction = 'true';
    button.addEventListener('click', () => { field('exit-form', 'exitUri').value = uri; void verifySelectedExit(); });
    output.append(document.createElement('br'), button);
  }
}

async function refreshFleet(): Promise<void> {
  if (!session || session.role !== 'authority-admin') throw new Error('Apply an authority administrator session first');
  const fleet = await localRequest<Record<string, unknown>>(config.origins.authority, '/local/registry/fleet', { token: authorityAdmin() });
  show('registry-fleet', fleet);
}

function populatePolicyAdmin(policy: Record<string, unknown>, admission: Record<string, unknown>): void {
  policySnapshot = structuredClone(policy);
  admissionSnapshot = structuredClone(admission);
  const form = 'policy-admin-form';
  (field(form, 'miningPermitted') as HTMLSelectElement).value = String(policy.miningPermitted === true);
  field(form, 'miningQuota').value = String(policy.miningQuota ?? 0);
  field(form, 'oreReserve').value = String(policy.oreReserve ?? 0);
  field(form, 'policyAdvanced').value = JSON.stringify(policy, null, 2);
  field(form, 'admissionAdvanced').value = JSON.stringify(admission, null, 2);
  const permits = Array.isArray(policy.manufacturePermits) ? policy.manufacturePermits : [];
  (field(form, 'manufacturePermitted') as HTMLSelectElement).value = String(permits.includes('ore-to-metal'));
  const varietyPolicy = isRecord(policy.varietyPortPolicy) ? policy.varietyPortPolicy : {};
  const ids = isRecord(policyInfo.ids) ? policyInfo.ids : {};
  const varieties = isRecord(ids.varieties) ? ids.varieties : {};
  const ore = typeof varieties.ore === 'string' ? varieties.ore : '';
  const metal = typeof varieties.metal === 'string' ? varieties.metal : '';
  (field(form, 'orePortPolicy') as HTMLSelectElement).value = varietyPolicy[ore] === 'deny' ? 'deny' : 'allow';
  (field(form, 'metalPortPolicy') as HTMLSelectElement).value = varietyPolicy[metal] === 'deny' ? 'deny' : 'allow';
  (field(form, 'mismatchPolicy') as HTMLSelectElement).value = String(admission.mismatchPolicy ?? 'reject');
  const publicPorts = Array.isArray(admission.publicPorts) ? admission.publicPorts : [];
  const ports = Array.isArray(ids.ports) ? ids.ports : [];
  (field(form, 'publicEast') as HTMLInputElement).checked = typeof ports[0] === 'string' && publicPorts.includes(ports[0]);
  (field(form, 'publicWest') as HTMLInputElement).checked = typeof ports[1] === 'string' && publicPorts.includes(ports[1]);
}

function policyBody(): Record<string, unknown> {
  const form = 'policy-admin-form';
  if (!policyAdminReady || session?.role !== 'policy-admin') throw new Error('Refresh Territory A settings in this administrator session before updating policy');
  if (value(form, 'policyMode') === 'advanced') return parseAdminObject(value(form, 'policyAdvanced'), 'policy');
  const body = structuredClone(policySnapshot);
  body.miningPermitted = value(form, 'miningPermitted') === 'true';
  body.miningQuota = numberField(form, 'miningQuota');
  body.oreReserve = numberField(form, 'oreReserve');
  const recipes = Array.isArray(body.recipes) ? body.recipes : [];
  const permitted = Array.isArray(body.manufacturePermits) ? body.manufacturePermits.filter((entry) => typeof entry === 'string') : [];
  body.manufacturePermits = value(form, 'manufacturePermitted') === 'true'
    ? [...new Set([...permitted, 'ore-to-metal'].filter((entry) => recipes.some((recipe) => isRecord(recipe) && recipe.id === entry)))]
    : permitted.filter((entry) => entry !== 'ore-to-metal');
  const ids = isRecord(policyInfo.ids) ? policyInfo.ids : {};
  const varieties = isRecord(ids.varieties) ? ids.varieties : {};
  const policies = isRecord(body.varietyPortPolicy) ? structuredClone(body.varietyPortPolicy) : {};
  for (const [key, name] of [['ore', 'orePortPolicy'], ['metal', 'metalPortPolicy']] as const) {
    const uri = varieties[key];
    if (typeof uri !== 'string') continue;
    policies[uri] = value(form, name);
  }
  body.varietyPortPolicy = policies;
  return body;
}

function admissionBody(): Record<string, unknown> {
  const form = 'policy-admin-form';
  if (!policyAdminReady || session?.role !== 'policy-admin') throw new Error('Refresh Territory A settings in this administrator session before updating admission');
  if (value(form, 'admissionMode') === 'advanced') return parseAdminObject(value(form, 'admissionAdvanced'), 'admission');
  const body: Record<string, unknown> = { ...structuredClone(admissionSnapshot), mismatchPolicy: value(form, 'mismatchPolicy') };
  const ids = isRecord(policyInfo.ids) ? policyInfo.ids : {};
  const ports = Array.isArray(ids.ports) ? ids.ports.filter((port): port is string => typeof port === 'string') : [];
  const prior = Array.isArray(body.publicPorts) ? body.publicPorts.filter((port): port is string => typeof port === 'string') : [];
  const displayed = ports.slice(0, 2);
  const publicPorts = prior.filter((port) => !displayed.includes(port));
  if ((field(form, 'publicEast') as HTMLInputElement).checked && ports[0]) publicPorts.push(ports[0]);
  if ((field(form, 'publicWest') as HTMLInputElement).checked && ports[1]) publicPorts.push(ports[1]);
  return { ...body, publicPorts };
}

function parseAdminObject(raw: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new TypeError(`${label} must be a JSON object`);
  return parsed;
}

async function refreshPolicy(): Promise<void> {
  if (!session) throw new Error('Apply a session first');
  const currentSession = session;
  if (currentSession.role === 'policy-admin') policyAdminReady = false;
  if (currentSession.role === 'player') policyCargoAvailable = false;
  updateControlAvailability();
  const token = session.role === 'player' ? await localPlayerToken(territoryIds.policy) : policyAdmin();
  const result = await localRequest<Record<string, unknown>>(config.origins.policy, '/local/state', { token });
  const state = isRecord(result.state) ? result.state : result;
  const policy = isRecord(state.policy) ? state.policy : {};
  const admission = isRecord(result.admission) ? result.admission : {};
  if (currentSession.role === 'policy-admin') {
    populatePolicyAdmin(policy, admission);
    policyAdminReady = true;
  }
  if (currentSession.role === 'player' && session === currentSession) {
    field('policy-operation-form', 'vessel').value = currentSession.vessel;
    const ids = isRecord(policyInfo.ids) ? policyInfo.ids : {};
    const varieties = isRecord(ids.varieties) ? ids.varieties : {};
    if (typeof varieties.metal === 'string') field('policy-operation-form', 'cargoVariety').value ||= varieties.metal;
    const visits = isRecord(result.visits) ? result.visits : {};
    const visit = visits[currentSession.vessel];
    const vessels = isRecord(state.vessels) ? state.vessels : {};
    policyCargoAvailable = isRecord(visit) && visit.vessel === currentSession.vessel && visit.possessor === currentSession.player && visit.departed !== true && isRecord(vessels[currentSession.vessel]);
  }
  show('policy-state', formatPolicyState(result, currentSession.vessel));
  updateControlAvailability();
}

function populateSimulationAdmin(config: Record<string, unknown>): void {
  simulationConfigSnapshot = structuredClone(config);
  const form = 'simulation-admin-form';
  (field(form, 'miningEnabled') as HTMLSelectElement).value = String(config.miningEnabled === true);
  field(form, 'miningCapacity').value = String(config.miningCapacity ?? 1);
  field(form, 'manufacturingSlots').value = String(config.manufacturingSlots ?? 1);
  field(form, 'manufacturingTime').value = String(config.manufacturingTime ?? 1);
  field(form, 'portCapacity').value = String(config.portCapacity ?? 0);
  field(form, 'berthCapacity').value = String(config.berthCapacity ?? 0);
}

function facilitiesBody(): Record<string, unknown> {
  if (!simulationAdminReady || session?.role !== 'simulation-admin') throw new Error('Refresh Territory B settings in this administrator session before updating facilities');
  if (!Object.keys(simulationConfigSnapshot).length) throw new Error('Territory B facility snapshot is unavailable');
  const form = 'simulation-admin-form';
  return {
    mining: { enabled: value(form, 'miningEnabled') === 'true', capacity: numberField(form, 'miningCapacity') },
    manufacturing: { slots: numberField(form, 'manufacturingSlots'), time: numberField(form, 'manufacturingTime') },
    port: { capacity: numberField(form, 'portCapacity'), berths: numberField(form, 'berthCapacity') }
  };
}

async function refreshSimulation(): Promise<void> {
  if (!session) throw new Error('Apply a session first');
  const currentSession = session;
  if (currentSession.role === 'simulation-admin') simulationAdminReady = false;
  if (currentSession.role === 'player') {
    simulationCargoAvailable = false;
    simulationCurrentEntryRequest = '';
    field('simulation-operation-form', 'entryRequest').value = '';
  }
  updateControlAvailability();
  const token = currentSession.role === 'player' ? await localPlayerToken(territoryIds.simulation) : simulationAdmin();
  const result = await localRequest<Record<string, unknown>>(config.origins.simulation, '/local/state', { token });
  const simulation = isRecord(result.simulation) ? result.simulation : {};
  const currentConfig = isRecord(simulation.config) ? simulation.config : {};
  if (currentSession.role === 'simulation-admin') {
    populateSimulationAdmin(currentConfig);
    simulationAdminReady = true;
  }
  if (currentSession.role === 'player' && session === currentSession) {
    if (!value('simulation-operation-form', 'cargo')) {
      const ids = isRecord(simulationInfo.ids) ? simulationInfo.ids : {};
      const varieties = isRecord(ids.varieties) ? ids.varieties : {};
      if (typeof varieties.importedMetal === 'string') field('simulation-operation-form', 'cargo').value = JSON.stringify({ entries: [{ variety: varieties.importedMetal, count: 1, data: {} }] }, null, 2);
    }
    const visits = isRecord(result.visits) ? Object.values(result.visits) : [];
    const visit = visits.find((candidate) => {
      if (!isRecord(candidate) || candidate.exited === true || candidate.possessor !== currentSession.player) return false;
      const request = isRecord(candidate.request) ? candidate.request : {};
      const requestVessel = isRecord(request.vessel) ? request.vessel : {};
      return requestVessel.id === currentSession.vessel && isRecord(candidate.decision) && candidate.decision.accepted === true;
    });
    const simState = isRecord(result.simulation) ? result.simulation : {};
    const vessels = Array.isArray(simState.vessels) ? simState.vessels : [];
    const berthed = isRecord(visit) && vessels.some((vessel) => isRecord(vessel) && vessel.id === visit.simulationVessel && vessel.status === 'berthed');
    if (berthed && isRecord(visit) && isRecord(visit.request) && typeof visit.request.id === 'string') {
      simulationCurrentEntryRequest = visit.request.id;
      field('simulation-operation-form', 'entryRequest').value = simulationCurrentEntryRequest;
      simulationCargoAvailable = true;
    }
  }
  show('simulation-state', formatSimulationState(result, currentSession.vessel));
  updateControlAvailability();
}

async function verifySelectedExit(): Promise<void> {
  await task('exit-result', async () => {
    const vessel = isRecord(registrySnapshot.vessel) ? registrySnapshot.vessel : {};
    const result = await verifyExit(value('exit-form', 'exitUri'), String(vessel.id ?? ''), String(vessel.registry ?? ''), isRecord(registrySnapshot.requests) ? registrySnapshot.requests : {});
    const exit = isRecord(result.exit) ? result.exit : {};
    const declared = registrySnapshot.cargo;
    const exitCargo = exit.cargo;
    const comparison = isRecord(declared) && isRecord(exitCargo) ? sdk.compareManifests(declared as CargoManifest, exitCargo as CargoManifest) : undefined;
    const sideBySide = { ...result, registryDeclaredCargo: declared, exitEventCargo: exitCargo, descriptiveDifference: comparison };
    return formatVerification(sideBySide);
  });
}

async function discoverActor(): Promise<void> {
  await task('actor-result', async () => {
    const resolution = await resolveInput(value('actor-form', 'actor'));
    await renderActorResources(resolution.actor as FCTPActor & Record<string, unknown>);
    return `${formatActor(resolution.actor as Record<string, unknown>)}\nResolved through ${resolution.source}.`;
  });
}

async function discoverTerritory(uri: string): Promise<void> {
  await task('actor-result', async () => {
    const resolution = await sdk.resolveActor(uri as URI);
    await renderActorResources(resolution.actor as FCTPActor & Record<string, unknown>);
    return `${formatActor(resolution.actor as Record<string, unknown>)}\nResolved through ${resolution.source}.`;
  });
}

function appendResource(parent: HTMLElement, label: string, uri: string, actorId: string, kind: 'resource' | 'text' = 'resource', onLoaded?: (value: unknown) => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = `${label}: ${uri}`; button.disabled = busy; button.dataset.resourceAction = 'true';
  button.addEventListener('click', () => {
    field('resource-get-form', 'uri').value = uri;
    field('resource-get-form', 'resourceActor').value = actorId;
    void task('resource-result', async () => {
      const token = session?.role === 'player' ? session.credential : value('authority-form', 'nativeToken') || nativeToken;
      const result = kind === 'text'
        ? await readTextPublicThenAuthenticated(uri, actorId, token || undefined)
        : await sdk.get(uri as URI, { ...(token ? { nativeToken: token, resourceServer: actorId as URI } : {}), cache: false });
      onLoaded?.(result);
      return result;
    });
  });
  parent.append(button);
  return button;
}

function appendCreationMedia(parent: HTMLElement, collection: unknown, actorId: string): void {
  for (const existing of [...parent.querySelectorAll<HTMLButtonElement>('button[data-creation-media="true"]')]) existing.remove();
  if (!isRecord(collection)) return;
  const items = Array.isArray(collection.orderedItems) ? collection.orderedItems : Array.isArray(collection.items) ? collection.items : [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    for (const entry of Array.isArray(item.media) ? item.media : []) {
      if (!isRecord(entry) || typeof entry.url !== 'string') continue;
      const button = appendResource(parent, `Asset text ${String(item.name ?? '')}`, entry.url, actorId, 'text');
      button.dataset.creationMedia = 'true';
    }
  }
}

async function renderActorResources(actor: FCTPActor & Record<string, unknown>): Promise<void> {
  const panel = byId('resource-browser');
  for (const child of [...panel.children]) if (!(child instanceof HTMLButtonElement && child.dataset.resourceChoice === 'true')) child.remove();
  if (typeof actor.creations === 'string') appendResource(panel, 'Published Player creations', actor.creations, actor.id, 'resource', (collection) => appendCreationMedia(panel, collection, actor.id));
  const native = session?.role === 'player' ? session.credential : value('authority-form', 'nativeToken') || nativeToken;
  const requestOptions = native ? { nativeToken: native } : {};
  let territory: Awaited<ReturnType<typeof territoryResources>>;
  try { territory = await territoryResources(actor, native || undefined); }
  catch (error) { appendResourceError(panel, 'Territory topology', error); territory = { ports: [], routes: [], areas: [] }; }
  const details = document.createElement('p'); details.textContent = `Territory topology for ${actor.id}`; panel.append(details);
  for (const [title, items] of [['Ports', territory.ports], ['Routes', territory.routes], ['Areas', territory.areas]] as const) {
    const heading = document.createElement('h3'); heading.textContent = title; panel.append(heading);
    for (const item of items) {
      const id = typeof item.id === 'string' ? item.id : '';
      appendResource(panel, String(item.name ?? title), id, actor.id);
      if (title === 'Ports') {
        try {
          for (const listing of await portListings(item, actor.id, native || undefined)) appendResource(panel, `Listing ${String(listing.id)}`, String(listing.id), actor.id);
        } catch (error) { appendResourceError(panel, `Listings for ${String(item.name ?? item.id)}`, error); }
      }
    }
  }
  const resources = isRecord(actor.resources) ? actor.resources : {};
  if (typeof resources.map === 'string') {
    appendResource(panel, 'MapDescriptor', resources.map, actor.id);
    const mapButton = document.createElement('button'); mapButton.type = 'button'; mapButton.textContent = 'Fetch supported ASCII map'; mapButton.disabled = busy; mapButton.dataset.resourceAction = 'true';
    mapButton.addEventListener('click', () => void task('resource-result', async () => {
      const descriptor = await sdk.get<import('@fctp/protocol').MapDescriptor>(resources.map as URI, { ...requestOptions, resourceServer: actor.id as URI, cache: false });
      return await mapText(descriptor, actor.id, playerToken());
    }));
    panel.append(mapButton);
  }
  for (const name of ['varieties', 'assets']) {
    const linked = actor[name];
    if (!Array.isArray(linked)) continue;
    const heading = document.createElement('h3'); heading.textContent = name === 'varieties' ? 'Varieties and Production' : 'Assets'; panel.append(heading);
    for (const reference of linked) {
      let item: Record<string, unknown>;
      try { item = await resolveReference<Record<string, unknown>>(reference, actor.id, requestOptions); }
      catch (error) { appendResourceError(panel, `${name} ${String(reference)}`, error); continue; }
      const id = String(item.id ?? reference);
      appendResource(panel, String(item.name ?? item.type ?? name), id, actor.id);
      const media = Array.isArray(item.media) ? item.media : [];
      for (const entry of media) if (isRecord(entry) && typeof entry.url === 'string') appendResource(panel, `Text ${String(item.name ?? '')}`, entry.url, actor.id, 'text');
      if (typeof item.asset === 'string') appendResource(panel, 'Asset', item.asset, actor.id);
      if (typeof item.asset === 'string') {
        let asset: Record<string, unknown>;
        try { asset = await resolveReference<Record<string, unknown>>(item.asset, actor.id, requestOptions); }
        catch (error) { appendResourceError(panel, `Asset ${item.asset}`, error); continue; }
        for (const entry of Array.isArray(asset.media) ? asset.media : []) if (isRecord(entry) && typeof entry.url === 'string') appendResource(panel, `Asset text ${String(asset.name ?? '')}`, entry.url, actor.id, 'text');
      }
    }
  }
}

function appendResourceError(panel: HTMLElement, label: string, error: unknown): void {
  const message = document.createElement('p');
  message.textContent = `${label}: ${error instanceof Error ? error.message : String(error)}`;
  panel.append(message);
}

function applyRoleScope(): void {
  document.querySelectorAll<HTMLElement>('[data-roles]').forEach((element) => {
    const roles = (element.dataset.roles ?? '').split(/\s+/);
    element.hidden = !session || !roles.includes(session.role);
  });
}

function renderDiscovery(id: string, result: BrowserLocalActionDiscovery): void {
  const panel = byId(id);
  panel.replaceChildren();
  const state = document.createElement('pre');
  state.textContent = formatDiscovery(result);
  panel.append(state);
  for (const action of result.actions) {
    const item = document.createElement('article');
    const title = document.createElement('h4'); title.textContent = action.label;
    const effect = document.createElement('p'); effect.textContent = `Effect: ${action.effect}`;
    item.append(title, effect);
    if (action.reason) { const reason = document.createElement('p'); reason.textContent = `Blocked: ${formatActionReason(action.reason)}`; item.append(reason); }
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.action = 'discovered'; button.dataset.discoveredAction = 'true'; button.dataset.unavailable = String(!action.available || !action.request); button.dataset.roles = 'player'; button.textContent = action.label; button.disabled = busy || !action.available || !action.request;
    button.setAttribute('aria-label', `${action.available ? 'Run' : 'Unavailable'}: ${action.label}`);
    button.addEventListener('click', () => void task(result.kind === 'registry' ? 'registry-state' : result.kind === 'policy' ? 'policy-result' : 'simulation-result', async () => {
      if (!action.available || !action.request || !session) throw new Error(action.reason ?? 'Action is unavailable');
      const targetOrigin = configuredOrigin(action.request.href, config);
      const token = targetOrigin === new URL(config.origins.authority).origin ? playerToken() : await localPlayerToken(targetOrigin === new URL(config.origins.policy).origin ? territoryIds.policy : territoryIds.simulation);
      await localRequest<unknown>(targetOrigin, action.request.href.replace(targetOrigin, ''), { method: action.request.method, ...(action.request.body ? { body: action.request.body } : {}), token });
      return 'Request accepted. Refresh the relevant state to see whether the Territory completed it.';
    }, () => result.kind === 'registry' ? refreshAuthority() : result.kind === 'policy' ? refreshPolicy() : refreshSimulation()));
    item.append(button);
    panel.append(item);
  }
  applyRoleScope();
}

async function discover(kind: 'registry' | 'policy' | 'simulation'): Promise<void> {
  if (!session || !session.player || !session.vessel) throw new Error('Apply a Player session with Player and vessel URIs');
  const origin = kind === 'registry' ? config.origins.authority : config.origins[kind];
  const token = kind === 'registry' ? playerToken() : await localPlayerToken(kind === 'policy' ? territoryIds.policy : territoryIds.simulation);
  const path = kind === 'registry' ? `/local/registry/actions?${new URLSearchParams({ vessel: session.vessel })}` : `/local/actions?${new URLSearchParams({ player: session.player, vessel: session.vessel })}`;
  const result = await localRequest<BrowserLocalActionDiscovery>(origin, path, { token });
  renderDiscovery(`${kind}-discovery`, result);
}

form('session-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void task('session-status', async () => {
    const role = value('session-form', 'role') as SessionRole;
    const player = value('session-form', 'player');
    const vessel = value('session-form', 'vessel');
    const credentialField = field('session-form', 'credential') as HTMLInputElement;
    const credential = credentialField.value;
    if (!credential) throw new Error('Credential is required');
    if (role === 'player' && (!player || !vessel)) throw new Error('Player sessions require Player and vessel URIs');
    nativeToken = '';
    field('authority-form', 'nativeToken').value = '';
    registrySnapshot = {};
    resetAdminState();
    for (const id of ['registry-state', 'policy-state', 'simulation-state', 'registry-discovery', 'policy-discovery', 'simulation-discovery', 'policy-result', 'simulation-result', 'exit-result', 'actor-result', 'resource-result']) byId(id).replaceChildren();
    const resourcePanel = byId('resource-browser');
    for (const child of [...resourcePanel.children]) if (!(child instanceof HTMLButtonElement && child.dataset.resourceChoice === 'true')) child.remove();
    session = { role, player, vessel, credential };
    authoring.sessionChanged();
    credentialField.value = '';
    applyRoleScope();
    const status = byId('session-status');
    status.textContent = `Session applied: ${role}${player ? ` · Player ${player}` : ''}${vessel ? ` · vessel ${vessel}` : ''}. Credential held in page memory.`;
    return status.textContent;
  });
});

for (const [action, kind] of [['discover-registry', 'registry'], ['discover-policy', 'policy'], ['discover-simulation', 'simulation']] as const) {
  addAction(action, async () => discover(kind));
}

form('actor-form').addEventListener('submit', (event) => { event.preventDefault(); void discoverActor(); });
form('resource-get-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void task('resource-result', () => getAuthenticated(value('resource-get-form', 'uri'), value('resource-get-form', 'resourceActor'), playerToken(), value('resource-get-form', 'route') as 'direct' | 'proxy', config));
});
form('exit-form').addEventListener('submit', (event) => { event.preventDefault(); void verifySelectedExit(); });

addAction('issue-token', async () => {
  const result = await localRequest<{ nativeToken: string }>(config.origins.authority, '/local/home/issue', { method: 'POST', token: authorityAdmin(), body: {} });
  nativeToken = result.nativeToken;
  field('authority-form', 'nativeToken').value = nativeToken;
  show('registry-state', 'Test-authority login succeeded; native token is held in page memory.');
});
addAction('rotate-token', async () => {
  const result = await localRequest<{ nativeToken: string }>(config.origins.authority, '/local/home/rotate', { method: 'POST', token: authorityAdmin(), body: {} });
  nativeToken = result.nativeToken; field('authority-form', 'nativeToken').value = nativeToken;
  show('registry-state', 'Native token rotated in memory.');
});
addAction('digest-request', async () => {
  await localRequest(config.origins.authority, '/local/home/digest-request', { method: 'POST', token: authorityAdmin(), body: { resourceActor: value('authority-form', 'resourceActor') } });
  show('registry-state', 'Token digest request queued.');
});
addAction('revoke-token', async () => {
  await localRequest(config.origins.authority, '/local/home/revoke', { method: 'POST', token: authorityAdmin(), body: { resourceActor: value('authority-form', 'resourceActor') } });
  show('registry-state', 'Token revocation queued.');
});
addAction('registry-entry', async () => {
  const result = await localRequest(config.origins.authority, '/local/registry/entry', { method: 'POST', token: playerToken(), body: { vessel: session?.vessel, territory: value('registry-form', 'territory'), port: value('registry-form', 'port'), route: value('registry-form', 'route') } });
  show('registry-state', { acceptedForDelivery: true, request: result, note: 'HTTP delivery acknowledgement does not assert Territory business success.' });
  await refreshAuthority();
});
addAction('registry-departure', async () => {
  const result = await localRequest(config.origins.authority, '/local/registry/departure', { method: 'POST', token: playerToken(), body: { vessel: session?.vessel, territory: value('registry-form', 'territory'), port: value('registry-form', 'port'), route: value('registry-form', 'route') } });
  show('registry-state', { acceptedForDelivery: true, request: result, note: 'Territory departure and ExitEvent completion are asynchronous.' });
  await refreshAuthority();
});
addAction('registry-adoption', async () => {
  await localRequest(config.origins.authority, '/local/registry/adoption', { method: 'POST', token: playerToken(), body: { vessel: session?.vessel, adoption: value('registry-form', 'adoption') === 'true' } });
  await refreshAuthority();
});
addAction('refresh-authority', async () => refreshAuthority());
addAction('refresh-fleet', async () => refreshFleet());

addAction('policy-update', async () => {
  await localRequest(config.origins.policy, '/local/admin/policy', { method: 'POST', token: policyAdmin(), body: policyBody() });
  show('policy-result', 'Policy updated. The refreshed state below reflects the new local rules.');
  await refreshPolicy();
});
addAction('admission-update', async () => {
  await localRequest(config.origins.policy, '/local/admin/admission', { method: 'POST', token: policyAdmin(), body: admissionBody() });
  show('policy-result', 'Admission policy updated. The refreshed state below reflects the new local rules.');
  await refreshPolicy();
});
addAction('policy-mine', async () => {
  const result = await localRequest(config.origins.policy, '/local/mine', { method: 'POST', token: await localPlayerToken(territoryIds.policy), body: { count: numberField('policy-operation-form', 'mineCount') } });
  show('policy-result', result); await refreshPolicy();
});
addAction('policy-manufacture', async () => {
  const result = await localRequest(config.origins.policy, '/local/manufacture', { method: 'POST', token: await localPlayerToken(territoryIds.policy), body: { count: numberField('policy-operation-form', 'manufactureCount'), recipe: value('policy-operation-form', 'recipe') } });
  show('policy-result', result); await refreshPolicy();
});
addAction('policy-transfer', async () => {
  const result = await localRequest(config.origins.policy, '/local/transfer', { method: 'POST', token: await localPlayerToken(territoryIds.policy), body: { direction: value('policy-operation-form', 'direction'), variety: value('policy-operation-form', 'variety'), count: numberField('policy-operation-form', 'transferCount') } });
  show('policy-result', result); await refreshPolicy();
});
for (const operation of ['load', 'unload'] as const) addAction(`policy-${operation}`, async () => {
  if (!policyCargoAvailable || session?.role !== 'player') throw new Error('Refresh Territory A and confirm your current berth before cargo handling');
  const result = await localRequest(config.origins.policy, `/local/${operation}`, { method: 'POST', token: await localPlayerToken(territoryIds.policy), body: { vessel: session.vessel, variety: value('policy-operation-form', 'cargoVariety'), count: numberField('policy-operation-form', 'cargoCount') } });
  show('policy-result', result); await refreshPolicy();
});
addAction('refresh-policy', async () => refreshPolicy());

addAction('facilities-update', async () => {
  await localRequest(config.origins.simulation, '/local/admin/facilities', { method: 'POST', token: simulationAdmin(), body: facilitiesBody() });
  show('simulation-result', 'Facility settings updated. Future jobs use the new limits.');
  await refreshSimulation();
});
addAction('simulation-tick', async () => {
  await localRequest(config.origins.simulation, '/local/admin/tick', { method: 'POST', token: simulationAdmin(), body: {} });
  show('simulation-result', 'Advanced one local tick. Refresh to inspect completed work.');
  await refreshSimulation();
});
addAction('simulation-mine', async () => {
  const result = await localRequest<{ job: string }>(config.origins.simulation, '/local/mine', { method: 'POST', token: await localPlayerToken(territoryIds.simulation), body: { count: numberField('simulation-operation-form', 'mineCount'), duration: numberField('simulation-operation-form', 'mineDuration') } });
  show('simulation-result', { scheduledJob: result.job, completion: 'Not complete until later ticks; state refreshed.' }); await refreshSimulation();
});
addAction('simulation-manufacture', async () => {
  const result = await localRequest<{ job: string }>(config.origins.simulation, '/local/manufacture', { method: 'POST', token: await localPlayerToken(territoryIds.simulation), body: { count: numberField('simulation-operation-form', 'manufactureCount'), recipe: value('simulation-operation-form', 'recipe') } });
  show('simulation-result', { scheduledJob: result.job, completion: 'Not complete until later ticks; state refreshed.' }); await refreshSimulation();
});
for (const operation of ['load', 'unload'] as const) addAction(`simulation-${operation}`, async () => {
  if (!simulationCargoAvailable || !simulationCurrentEntryRequest || session?.role !== 'player') throw new Error('Refresh Territory B and confirm your current berth before cargo handling');
  const result = await localRequest<{ job: string }>(config.origins.simulation, `/local/${operation}`, { method: 'POST', token: await localPlayerToken(territoryIds.simulation), body: { entryRequest: simulationCurrentEntryRequest, cargo: JSON.parse(value('simulation-operation-form', 'cargo')) as unknown, duration: numberField('simulation-operation-form', 'duration') } });
  show('simulation-result', { scheduledJob: result.job, completion: 'Not complete until later ticks; state refreshed.' }); await refreshSimulation();
});
addAction('refresh-simulation', async () => refreshSimulation());

for (const name of ['policyMode', 'admissionMode']) field('policy-admin-form', name).addEventListener('change', syncAdminModes);

byId('connection-status').textContent = `Connected to authority ${config.origins.authority}, Territory A ${territoryIds.policy}, Territory B ${territoryIds.simulation}.`;
field('registry-form', 'territory').value = territoryIds.policy;
const resourceChoices = byId('resource-browser');
const destinationChoice = field('registry-form', 'destination') as HTMLSelectElement;
for (const [label, uri] of [['Open Territory A resources', territoryIds.policy], ['Open Territory B resources', territoryIds.simulation]] as const) {
  const button = document.createElement('button'); button.type = 'button'; button.dataset.resourceChoice = 'true'; button.textContent = label;
  button.addEventListener('click', () => { void discoverTerritory(uri); });
  resourceChoices.append(button);
}
function setupDestinationFields(): void {
  const name = destinationChoice.value === 'simulation' ? 'simulation' : 'policy';
  const info = name === 'policy' ? policyInfo : simulationInfo;
  const ids = isRecord(info.ids) ? info.ids : {};
  const ports = Array.isArray(ids.ports) ? ids.ports : [];
  const routes = Array.isArray(ids.routes) ? ids.routes : [];
  if (!ports[0] || !routes[0]) throw new Error(`${name} /local/info has no destination port or route`);
  field('registry-form', 'territory').value = String(ids.actor ?? info.actor ?? territoryIds[name]);
  field('registry-form', 'port').value = String(ports[0]);
  field('registry-form', 'route').value = String(routes[0]);
}
destinationChoice.addEventListener('change', () => { void task('registry-state', async () => setupDestinationFields()); });
applyRoleScope();
void task('connection-status', async () => {
    await Promise.all((['policy', 'simulation'] as const).map(async (name) => {
      const info = await localRequest<Record<string, unknown>>(config.origins[name], '/local/info');
      if (name === 'policy') policyInfo = info;
      else simulationInfo = info;
      const ids = isRecord(info.ids) ? info.ids : {};
      const varieties = isRecord(ids.varieties) ? ids.varieties : {};
      if (name === 'policy') {
        if (typeof varieties.metal === 'string') {
          field('policy-operation-form', 'variety').value = varieties.metal;
          field('policy-operation-form', 'cargoVariety').value = varieties.metal;
        }
      } else if (typeof varieties.importedMetal === 'string') {
        field('simulation-operation-form', 'cargo').value = JSON.stringify({ entries: [{ variety: varieties.importedMetal, count: 1, data: {} }] }, null, 2);
      }
    }));
    setupDestinationFields();
    syncAdminModes();
    updateControlAvailability();
    return 'Service configuration loaded. Apply a session to refresh private state.';
});
