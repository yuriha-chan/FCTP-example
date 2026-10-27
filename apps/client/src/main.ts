import type { CargoManifest, FCTPActor, URI } from '@fctp/protocol';
import { configuredOrigin, mapText, getAuthenticated, isRecord, loadConfig, localRequest as rawLocalRequest, portListings, readText, resolveInput, resolveReference, sdk, territoryResources, verifyExit, type BrowserLocalActionDiscovery } from './client.js';
import { setupAuthoring } from './authoring.js';

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
const show = (id: string, content: unknown): void => { byId(id).textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2); };
const jsonField = (formId: string, name: string): unknown => JSON.parse(value(formId, name));
const numberField = (formId: string, name: string): number => {
  const result = Number(value(formId, name));
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
  'policy-update': 'policy-result', 'admission-update': 'policy-result', 'policy-mine': 'policy-result', 'policy-manufacture': 'policy-result',
  'policy-transfer': 'policy-result', 'policy-load': 'policy-result', 'policy-unload': 'policy-result', 'refresh-policy': 'policy-state',
  'facilities-update': 'simulation-result', 'simulation-tick': 'simulation-result', 'simulation-mine': 'simulation-result',
  'simulation-manufacture': 'simulation-result', 'simulation-load': 'simulation-result', 'simulation-unload': 'simulation-result', 'refresh-simulation': 'simulation-state'
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
  output.textContent = JSON.stringify({ ...registrySnapshot, declaredCargo: cargo }, null, 2);
  const vessel = isRecord(registrySnapshot.vessel) ? registrySnapshot.vessel.id : undefined;
  if (typeof vessel === 'string') field('policy-operation-form', 'vessel').value = vessel;
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

async function refreshPolicy(): Promise<void> {
  if (!session) throw new Error('Apply a session first');
  const token = session.role === 'player' ? await localPlayerToken(territoryIds.policy) : policyAdmin();
  const result = await localRequest<Record<string, unknown>>(config.origins.policy, '/local/state', { token });
  const state = isRecord(result.state) ? result.state : result;
  const policy = isRecord(state.policy) ? state.policy : undefined;
  const admission = isRecord(result.admission) ? result.admission : undefined;
  if (policy) field('policy-admin-form', 'policy').value = JSON.stringify(policy, null, 2);
  if (admission) field('policy-admin-form', 'admission').value = JSON.stringify(admission, null, 2);
  const ids = isRecord(policyInfo.ids) ? policyInfo.ids : {};
  const varieties = isRecord(ids.varieties) ? ids.varieties : {};
  if (typeof varieties.metal === 'string') field('policy-operation-form', 'variety').value ||= varieties.metal;
  if (typeof varieties.metal === 'string') field('policy-operation-form', 'cargoVariety').value ||= varieties.metal;
  show('policy-state', result);
}

async function refreshSimulation(): Promise<void> {
  if (!session) throw new Error('Apply a session first');
  const currentSession = session;
  const token = currentSession.role === 'player' ? await localPlayerToken(territoryIds.simulation) : simulationAdmin();
  const result = await localRequest<Record<string, unknown>>(config.origins.simulation, '/local/state', { token });
  const visits = isRecord(result.visits) ? result.visits : {};
  const activeVisit = Object.values(visits).filter((visit) => {
    if (!isRecord(visit)) return false;
    const request = isRecord(visit.request) ? visit.request : {};
    const requestVessel = isRecord(request.vessel) ? request.vessel : {};
    const vesselId = typeof visit.vessel === 'string' ? visit.vessel : requestVessel.id;
    const possessor = typeof visit.possessor === 'string' ? visit.possessor : requestVessel.possessor;
    return visit.decision && isRecord(visit.decision) && visit.decision.accepted === true && vesselId === currentSession.vessel && possessor === currentSession.player && visit.exited !== true;
  }).at(-1);
  if (isRecord(activeVisit) && isRecord(activeVisit.request) && typeof activeVisit.request.id === 'string') field('simulation-operation-form', 'entryRequest').value = activeVisit.request.id;
  show('simulation-state', result);
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
    return sideBySide;
  });
}

async function discoverActor(): Promise<void> {
  await task('actor-result', async () => {
    const resolution = await resolveInput(value('actor-form', 'actor'));
    await renderActorResources(resolution.actor as FCTPActor & Record<string, unknown>);
    return { source: resolution.source, actor: resolution.actor };
  });
}

async function discoverTerritory(uri: string): Promise<void> {
  await task('actor-result', async () => {
    const resolution = await sdk.resolveActor(uri as URI);
    await renderActorResources(resolution.actor as FCTPActor & Record<string, unknown>);
    return { source: resolution.source, actor: resolution.actor };
  });
}

function appendResource(parent: HTMLElement, label: string, uri: string, actorId: string, kind: 'resource' | 'text' = 'resource'): void {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = `${label}: ${uri}`; button.disabled = busy; button.dataset.resourceAction = 'true';
  button.addEventListener('click', () => {
    field('resource-get-form', 'uri').value = uri;
    field('resource-get-form', 'resourceActor').value = actorId;
    void task('resource-result', async () => {
      const token = session?.role === 'player' ? session.credential : value('authority-form', 'nativeToken') || nativeToken;
      if (kind === 'text') {
        if (token) return readText(uri, token, actorId);
        const response = await fetch(uri, { headers: { Accept: 'text/plain' }, cache: 'no-store' });
        if (!response.ok) throw new Error(`Resource request failed: ${response.status}`);
        return response.text();
      }
      return sdk.get(uri as URI, { ...(token ? { nativeToken: token, resourceServer: actorId as URI } : {}), cache: false });
    });
  });
  parent.append(button);
}

async function renderActorResources(actor: FCTPActor & Record<string, unknown>): Promise<void> {
  const panel = byId('resource-browser');
  for (const child of [...panel.children]) if (!(child instanceof HTMLButtonElement && child.dataset.resourceChoice === 'true')) child.remove();
  if (typeof actor.creations === 'string') appendResource(panel, 'Published Player creations', actor.creations, actor.id);
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
  state.textContent = JSON.stringify({ observedAt: result.observedAt, state: result.state, notes: result.notes }, null, 2);
  panel.append(state);
  for (const action of result.actions) {
    const item = document.createElement('article');
    const title = document.createElement('h4'); title.textContent = action.label;
    const effect = document.createElement('p'); effect.textContent = `Effect: ${action.effect}`;
    item.append(title, effect);
    if (action.reason) { const reason = document.createElement('p'); reason.textContent = `Blocked: ${action.reason}`; item.append(reason); }
    if (action.request) {
      const details = document.createElement('pre');
      details.textContent = JSON.stringify(action.request, null, 2);
      item.append(details);
    }
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.action = 'discovered'; button.dataset.discoveredAction = 'true'; button.dataset.unavailable = String(!action.available || !action.request); button.dataset.roles = 'player'; button.textContent = action.label; button.disabled = busy || !action.available || !action.request;
    button.setAttribute('aria-label', `${action.available ? 'Run' : 'Unavailable'}: ${action.label}`);
    button.addEventListener('click', () => void task(id, async () => {
      if (!action.available || !action.request || !session) throw new Error(action.reason ?? 'Action is unavailable');
      const targetOrigin = configuredOrigin(action.request.href, config);
      const token = targetOrigin === new URL(config.origins.authority).origin ? playerToken() : await localPlayerToken(targetOrigin === new URL(config.origins.policy).origin ? territoryIds.policy : territoryIds.simulation);
      const response = await localRequest<unknown>(targetOrigin, action.request.href.replace(targetOrigin, ''), { method: action.request.method, ...(action.request.body ? { body: action.request.body } : {}), token });
      return { requestAccepted: true, response, note: 'Delivery acknowledgement does not establish Territory business completion.' };
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
    for (const id of ['registry-state', 'policy-state', 'simulation-state', 'registry-discovery', 'policy-discovery', 'simulation-discovery', 'policy-result', 'simulation-result', 'exit-result', 'actor-result', 'resource-result']) byId(id).replaceChildren();
    const resourcePanel = byId('resource-browser');
    for (const child of [...resourcePanel.children]) if (!(child instanceof HTMLButtonElement && child.dataset.resourceChoice === 'true')) child.remove();
    session = { role, player, vessel, credential };
    authoring.sessionChanged();
    credentialField.value = '';
    if (role === 'player') field('policy-operation-form', 'vessel').value = vessel;
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
  const policy = jsonField('policy-admin-form', 'policy');
  const result = await localRequest(config.origins.policy, '/local/admin/policy', { method: 'POST', token: policyAdmin(), body: policy });
  show('policy-result', result); await refreshPolicy();
});
addAction('admission-update', async () => {
  const admission = jsonField('policy-admin-form', 'admission');
  const result = await localRequest(config.origins.policy, '/local/admin/admission', { method: 'POST', token: policyAdmin(), body: admission });
  show('policy-result', result); await refreshPolicy();
});
addAction('policy-mine', async () => {
  const result = await localRequest(config.origins.policy, '/local/mine', { method: 'POST', token: await localPlayerToken(territoryIds.policy), body: { count: numberField('policy-operation-form', 'mineCount') } });
  show('policy-result', result); await refreshPolicy();
});
addAction('policy-manufacture', async () => {
  const result = await localRequest(config.origins.policy, '/local/manufacture', { method: 'POST', token: await localPlayerToken(territoryIds.policy), body: { count: numberField('policy-operation-form', 'manufactureCount'), recipe: 'ore-to-metal' } });
  show('policy-result', result); await refreshPolicy();
});
addAction('policy-transfer', async () => {
  const result = await localRequest(config.origins.policy, '/local/transfer', { method: 'POST', token: await localPlayerToken(territoryIds.policy), body: { direction: value('policy-operation-form', 'direction'), variety: value('policy-operation-form', 'variety'), count: numberField('policy-operation-form', 'transferCount') } });
  show('policy-result', result); await refreshPolicy();
});
for (const operation of ['load', 'unload'] as const) addAction(`policy-${operation}`, async () => {
  const result = await localRequest(config.origins.policy, `/local/${operation}`, { method: 'POST', token: await localPlayerToken(territoryIds.policy), body: { vessel: value('policy-operation-form', 'vessel'), variety: value('policy-operation-form', 'cargoVariety'), count: numberField('policy-operation-form', 'cargoCount') } });
  show('policy-result', result); await refreshPolicy();
});
addAction('refresh-policy', async () => refreshPolicy());

addAction('facilities-update', async () => {
  const result = await localRequest(config.origins.simulation, '/local/admin/facilities', { method: 'POST', token: simulationAdmin(), body: jsonField('simulation-admin-form', 'facilities') });
  show('simulation-result', result); await refreshSimulation();
});
addAction('simulation-tick', async () => {
  const result = await localRequest(config.origins.simulation, '/local/admin/tick', { method: 'POST', token: simulationAdmin(), body: {} });
  show('simulation-result', { tickAdvanced: true, state: result }); await refreshSimulation();
});
addAction('simulation-mine', async () => {
  const result = await localRequest<{ job: string }>(config.origins.simulation, '/local/mine', { method: 'POST', token: await localPlayerToken(territoryIds.simulation), body: { count: numberField('simulation-operation-form', 'mineCount'), duration: numberField('simulation-operation-form', 'mineDuration') } });
  show('simulation-result', { scheduledJob: result.job, completion: 'Not complete until later ticks; state refreshed.' }); await refreshSimulation();
});
addAction('simulation-manufacture', async () => {
  const result = await localRequest<{ job: string }>(config.origins.simulation, '/local/manufacture', { method: 'POST', token: await localPlayerToken(territoryIds.simulation), body: { recipe: value('simulation-operation-form', 'recipe'), count: numberField('simulation-operation-form', 'manufactureCount') } });
  show('simulation-result', { scheduledJob: result.job, completion: 'Not complete until later ticks; state refreshed.' }); await refreshSimulation();
});
for (const operation of ['load', 'unload'] as const) addAction(`simulation-${operation}`, async () => {
  const result = await localRequest<{ job: string }>(config.origins.simulation, `/local/${operation}`, { method: 'POST', token: await localPlayerToken(territoryIds.simulation), body: { entryRequest: value('simulation-operation-form', 'entryRequest'), cargo: jsonField('simulation-operation-form', 'cargo'), duration: numberField('simulation-operation-form', 'duration') } });
  show('simulation-result', { scheduledJob: result.job, completion: 'Not complete until later ticks; state refreshed.' }); await refreshSimulation();
});
addAction('refresh-simulation', async () => refreshSimulation());

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
      if (name === 'policy' && isRecord(ids.varieties) && typeof ids.varieties.metal === 'string') {
        field('policy-operation-form', 'variety').value = ids.varieties.metal;
        field('policy-operation-form', 'cargoVariety').value = ids.varieties.metal;
      }
      if (name === 'simulation' && isRecord(ids.varieties) && typeof ids.varieties.importedMetal === 'string') {
        field('simulation-operation-form', 'cargo').value = JSON.stringify({ entries: [{ variety: isRecord(ids.varieties) ? ids.varieties.importedMetal : '', count: 1, data: {} }] }, null, 2);
      }
    }));
    setupDestinationFields();
    return 'Service configuration loaded. Apply a session to refresh private state.';
});
