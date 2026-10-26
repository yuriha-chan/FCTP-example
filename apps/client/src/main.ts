import type { CargoManifest, FCTPActor, URI } from '@fctp/protocol';
import { mapText, getAuthenticated, isRecord, loadConfig, localRequest, portListings, readText, resolveInput, resolveReference, sdk, territoryResources, verifyExit } from './client.js';

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

const config = await loadConfig();
const actorIds = config.actors ?? {};
const territoryIds: Record<'policy' | 'simulation', string> = {
  policy: actorIds.policy ?? `${config.origins.policy}/actors/territory`,
  simulation: actorIds.simulation ?? `${config.origins.simulation}/actors/territory`
};
let nativeToken = '';
let registrySnapshot: Record<string, unknown> = {};
let policyInfo: Record<string, unknown> = {};
let simulationInfo: Record<string, unknown> = {};

const authorityAdmin = (): string => value('authority-form', 'authorityAdmin');
const policyAdmin = (): string => value('authority-form', 'policyAdmin');
const simulationAdmin = (): string => value('authority-form', 'simulationAdmin');
const playerToken = (): string => {
  const token = value('authority-form', 'nativeToken') || nativeToken;
  if (!token) throw new Error('Issue or enter the native token first');
  return token;
};
const localPlayerToken = async (territory: string): Promise<string> => {
  const { deriveDiplomaticToken } = await import('@fctp/auth');
  return deriveDiplomaticToken(playerToken(), territory as URI);
};

async function task<T>(output: string, action: () => Promise<T>, refresh?: () => Promise<void>): Promise<void> {
  try {
    const result = await action();
    if (result !== undefined) show(output, result);
    if (refresh) await refresh();
  } catch (error) {
    show(output, error instanceof Error ? error.message : String(error));
  }
}

const actionOutputs: Record<string, string> = {
  'issue-token': 'registry-state', 'rotate-token': 'registry-state', 'digest-request': 'registry-state', 'revoke-token': 'registry-state',
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
  registrySnapshot = await localRequest<Record<string, unknown>>(config.origins.authority, '/local/registry/state', { token: authorityAdmin() });
  const cargo = registrySnapshot.cargo as CargoManifest | undefined;
  const output = byId('registry-state');
  output.textContent = JSON.stringify({ ...registrySnapshot, declaredCargo: cargo }, null, 2);
  const vessel = isRecord(registrySnapshot.vessel) ? registrySnapshot.vessel.id : undefined;
  if (typeof vessel === 'string') field('policy-operation-form', 'vessel').value = vessel;
  const exitUris = Array.isArray(registrySnapshot.exitEvidence) ? registrySnapshot.exitEvidence.filter((uri): uri is string => typeof uri === 'string') : [];
  for (const uri of exitUris) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = `Verify ${uri}`;
    button.addEventListener('click', () => { field('exit-form', 'exitUri').value = uri; void verifySelectedExit(); });
    output.append(document.createElement('br'), button);
  }
}

async function refreshPolicy(): Promise<void> {
  const result = await localRequest<Record<string, unknown>>(config.origins.policy, '/local/state', { token: policyAdmin() });
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
  const result = await localRequest<Record<string, unknown>>(config.origins.simulation, '/local/state', { token: simulationAdmin() });
  if (isRecord(result.visits)) {
    const activeRequest = Object.entries(result.visits).find(([, visit]) => isRecord(visit) && isRecord(visit.decision) && visit.decision.accepted === true && visit.exited !== true)?.[0];
    if (activeRequest) field('simulation-operation-form', 'entryRequest').value = activeRequest;
  }
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
  button.type = 'button'; button.textContent = `${label}: ${uri}`;
  button.addEventListener('click', () => {
    field('resource-get-form', 'uri').value = uri;
    field('resource-get-form', 'resourceActor').value = actorId;
    void task('resource-result', async () => {
      const token = value('authority-form', 'nativeToken') || nativeToken;
      if (kind === 'text') return readText(uri, token, actorId);
      return sdk.get(uri as URI, { ...(token ? { nativeToken: token, resourceServer: actorId as URI } : {}), cache: false });
    });
  });
  parent.append(button);
}

async function renderActorResources(actor: FCTPActor & Record<string, unknown>): Promise<void> {
  const panel = byId('resource-browser');
  for (const child of [...panel.children]) if (!(child instanceof HTMLButtonElement && child.dataset.resourceChoice === 'true')) child.remove();
  const native = value('authority-form', 'nativeToken') || nativeToken;
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
    const mapButton = document.createElement('button'); mapButton.type = 'button'; mapButton.textContent = 'Fetch supported ASCII map';
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
  const result = await localRequest(config.origins.authority, '/local/registry/entry', { method: 'POST', token: authorityAdmin(), body: { territory: value('registry-form', 'territory'), port: value('registry-form', 'port'), route: value('registry-form', 'route') } });
  show('registry-state', { acceptedForDelivery: true, request: result, note: 'HTTP delivery acknowledgement does not assert Territory business success.' });
  await refreshAuthority();
});
addAction('registry-departure', async () => {
  const result = await localRequest(config.origins.authority, '/local/registry/departure', { method: 'POST', token: authorityAdmin(), body: { territory: value('registry-form', 'territory'), port: value('registry-form', 'port'), route: value('registry-form', 'route') } });
  show('registry-state', { acceptedForDelivery: true, request: result, note: 'Territory departure and ExitEvent completion are asynchronous.' });
  await refreshAuthority();
});
addAction('registry-adoption', async () => {
  await localRequest(config.origins.authority, '/local/registry/adoption', { method: 'POST', token: authorityAdmin(), body: { adoption: value('registry-form', 'adoption') === 'true' } });
  await refreshAuthority();
});
addAction('refresh-authority', async () => refreshAuthority());

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
destinationChoice.addEventListener('change', () => {
  const name = destinationChoice.value === 'simulation' ? 'simulation' : 'policy';
  void task('registry-state', async () => {
    const info = name === 'policy' ? policyInfo : simulationInfo;
    const ids = isRecord(info.ids) ? info.ids : {};
    const ports = Array.isArray(ids.ports) ? ids.ports : [];
    const routes = Array.isArray(ids.routes) ? ids.routes : [];
    if (!ports[0] || !routes[0]) throw new Error(`${name} /local/info has no destination port or route`);
    field('registry-form', 'territory').value = String(ids.actor ?? info.actor ?? territoryIds[name]);
    field('registry-form', 'port').value = String(ports[0]);
    field('registry-form', 'route').value = String(routes[0]);
  });
});
void (async () => {
  await Promise.allSettled([
    refreshAuthority(), refreshPolicy(), refreshSimulation(),
    ...(['policy', 'simulation'] as const).map(async (name) => {
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
    })
  ]);
  destinationChoice.dispatchEvent(new Event('change'));
})();
