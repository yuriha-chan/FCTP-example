import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ActionDescriptor, ActionRecord, PageResponse } from '@fctp/client-sdk';
import { startDemo } from '../apps/demo/src/launcher.js';

interface ApplicationAccount {
  name: string;
  handle: string;
  homeOrigin?: string;
}

interface ApplicationTransport {
  login(password: string): Promise<Record<string, unknown>>;
  page(path: string): Promise<Record<string, unknown>>;
  action(descriptor: ActionDescriptor, inputs?: Record<string, unknown>): Promise<Record<string, unknown>>;
  result(actionId: string): Promise<PageResponse<{ action: ActionRecord }>>;
}

type ApplicationTransportFactory = (options: {
  origin: string;
  account: ApplicationAccount;
  fetch?: typeof fetch;
}) => ApplicationTransport;

async function loadTransport(): Promise<ApplicationTransportFactory> {
  const modulePath = '../scripts/browser-api.mjs';
  const loaded = await import(modulePath) as { createApplicationTransport: ApplicationTransportFactory };
  return loaded.createApplicationTransport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function pageData(value: unknown): Record<string, unknown> {
  return record(record(value).data);
}

function descriptor(id: string, endpoint: string, names: readonly string[] = []): ActionDescriptor {
  return { id, label: id, endpoint, method: 'POST', inputs: names.map((name) => ({ name, required: true })), blockers: [] };
}

function actionOf(value: unknown): ActionRecord {
  const action = record(record(value).action ?? pageData(value).action);
  assert.equal(typeof action.id, 'string', `Expected an action record in ${JSON.stringify(value)}`);
  return action as unknown as ActionRecord;
}

function resultAction(page: PageResponse<{ action: ActionRecord }>): ActionRecord {
  return page.data.action;
}

function operationList(value: unknown): Array<Record<string, unknown>> {
  return records(pageData(value).operations);
}

function operationInputs(operation: Record<string, unknown>): Array<Record<string, unknown>> {
  return records(operation.inputs);
}

function requireOperation(value: unknown, kind: string, predicate: (operation: Record<string, unknown>) => boolean = () => true): Record<string, unknown> {
  const operation = operationList(value).find((candidate) => candidate.kind === kind && predicate(candidate));
  assert.ok(operation, `Expected a ${kind} operation in ${JSON.stringify(value)}`);
  return operation;
}

async function executeOperation(
  transport: ApplicationTransport,
  vesselId: string,
  operation: Record<string, unknown>,
  inputs: Record<string, unknown>
): Promise<ActionRecord> {
  const operationId = String(operation.operationId);
  const names = operationInputs(operation).map((input) => String(input.name));
  const body = await transport.action(
    descriptor(`execute:${operationId}`, `/api/production/operations/${encodeURIComponent(operationId)}/execute`, names),
    { vesselId, inputs }
  );
  return actionOf(body);
}

async function refreshAction(transport: ApplicationTransport, actionId: string): Promise<ActionRecord> {
  const body = await transport.action(descriptor(`refresh:${actionId}`, `/api/activity/${encodeURIComponent(actionId)}/refresh`), {});
  return actionOf(body);
}

async function refreshUntil(
  transport: ApplicationTransport,
  actionId: string,
  predicate: (action: ActionRecord) => boolean,
  label: string,
  between?: () => Promise<void>,
  attempts = 20
): Promise<ActionRecord> {
  let action = resultAction(await transport.result(actionId));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate(action)) return action;
    if (between) await between();
    action = await refreshAction(transport, actionId);
  }
  assert.ok(predicate(action), label);
  return action;
}

async function drainWorld(demo: Awaited<ReturnType<typeof startDemo>>): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await demo.authority.authority.server.processOutbox();
    await demo.policy.host.server.processInbox();
    await demo.policy.host.server.processOutbox();
    await demo.simulation.host.server.processInbox();
    await demo.simulation.host.server.processOutbox();
    await demo.authority.authority.server.processInbox();
  }
}

async function drainSimulation(demo: Awaited<ReturnType<typeof startDemo>>): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await demo.authority.authority.server.processOutbox();
    await demo.simulation.host.server.processInbox();
    await demo.simulation.host.server.processOutbox();
    await demo.authority.authority.server.processInbox();
  }
}

async function refreshAdministration(transport: ApplicationTransport, authorityId: string): Promise<Record<string, unknown>> {
  await transport.action(descriptor('refresh-administration', '/api/administration/refresh', ['authorityId']), { authorityId });
  return transport.page('/api/administration');
}

async function pendingAdministrationRequest(
  transport: ApplicationTransport,
  authorityId: string
): Promise<Record<string, unknown> | undefined> {
  const page = await refreshAdministration(transport, authorityId);
  return records(pageData(page).requests).find((request) => request.authorityId === authorityId && String(request.status).toLowerCase() === 'pending');
}

async function administrationControl(
  transport: ApplicationTransport,
  authorityId: string,
  control: string,
  inputs: Record<string, unknown>,
  drain: (demo: Awaited<ReturnType<typeof startDemo>>) => Promise<void>,
  demo: Awaited<ReturnType<typeof startDemo>>
): Promise<ActionRecord> {
  const action = actionOf(await transport.action(
    descriptor(`control:${control}`, '/api/administration/controls', ['authorityId', 'control', 'inputs']),
    { authorityId, control, inputs }
  ));
  return refreshUntil(transport, action.id, (candidate) => candidate.outcome.status === 'completed', `${control} control is observed`, () => drain(demo));
}

async function decideAdministration(
  transport: ApplicationTransport,
  authorityId: string,
  requestId: string,
  decision: 'approve' | 'reject',
  reason?: string
): Promise<ActionRecord> {
  const body = await transport.action(
    descriptor(`${decision}:${requestId}`, `/api/administration/entry-requests/${encodeURIComponent(requestId)}/${decision}`, ['authorityId']),
    { authorityId, ...(reason === undefined ? {} : { reason }) }
  );
  return actionOf(body);
}

function observationStates(value: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const seen = new Set<object>();
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) { for (const item of entry) visit(item); return; }
    if (!isRecord(entry) || seen.has(entry)) return;
    seen.add(entry);
    if (typeof entry.source === 'string' && typeof entry.state === 'string') found.push(entry);
    for (const child of Object.values(entry)) visit(child);
  };
  visit(value);
  return found;
}

function stockCount(state: Record<string, unknown>, commodity: string): number {
  const simulation = record(state.simulation);
  const items = [...records(simulation.rawStock), ...records(simulation.productStock)];
  return items.filter((item) => item.commodity === commodity).reduce((total, item) => total + Number(item.count ?? 0), 0);
}

test('a complete game runs through the application transport, survives restart, and isolates an unavailable source', { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-client-gameplay-'));
  const ports = await Promise.all(Array.from({ length: 4 }, () => freePort()));
  const portOptions = { authority: ports[0]!, policy: ports[1]!, simulation: ports[2]!, client: ports[3]! };
  let demo = await startDemo({ dataDir: directory, ports: portOptions });
  try {
    const createTransport = await loadTransport();
    const host = new URL(demo.origins.authority).host;
    const accounts = {
      first: { name: 'player', handle: `@player@${host}`, homeOrigin: demo.origins.authority },
      second: { name: 'player-2', handle: `@player-2@${host}`, homeOrigin: demo.origins.authority },
      governor: { name: 'governor', handle: `@governor@${host}`, homeOrigin: demo.origins.authority }
    } satisfies Record<string, ApplicationAccount>;
    const make = (account: ApplicationAccount): ApplicationTransport => createTransport({ origin: demo.origins.client, account });
    let first = make(accounts.first);
    let second = make(accounts.second);
    let governor = make(accounts.governor);

    const publicServers = await first.page('/api/servers');
    assert.equal(typeof record(publicServers).servers, 'object', 'public discovery is readable before login');

    const firstLogin = await first.login('demo-player-password');
    const secondLogin = await second.login('demo-player-2-password');
    const governorLogin = await governor.login('demo-governor-password');
    for (const login of [firstLogin, secondLogin, governorLogin]) assert.equal(record(login).status, 'signed-in');
    const firstId = String(record(record(firstLogin).account).id);
    const secondId = String(record(record(secondLogin).account).id);
    assert.notEqual(firstId, secondId, 'the two Players keep independent request contexts');

    for (const origin of [demo.origins.authority, demo.origins.policy, demo.origins.simulation]) {
      await first.action(descriptor('discover', '/api/servers', ['origin']), { origin });
    }
    await first.action(descriptor('refresh-explore', '/api/explore/refresh'));
    const geography = await first.page('/api/explore/places');
    const places = records(pageData(geography).places);
    assert.ok(places.some((place) => place.id === demo.policy.ids.ports[0]), 'public geography includes East Haven');
    assert.ok(places.some((place) => place.id === demo.policy.ids.ports[1]), 'public geography includes West Haven');
    assert.ok(places.some((place) => place.id === demo.simulation.ids.ports[0]), 'public geography includes the simulation harbor');

    const firstVessel = demo.authority.ids.vessels.player!;
    const secondVessel = demo.authority.ids.vessels['player-2']!;
    const entryAction = actionOf(await first.action(
      descriptor('enter-policy', `/api/logistics/vessels/${encodeURIComponent(firstVessel)}/entry`, ['territoryId', 'portId', 'routeId']),
      { territoryId: demo.policy.ids.actor, portId: demo.policy.ids.ports[0], routeId: demo.policy.ids.routes[0] }
    ));
    const entered = await refreshUntil(first, entryAction.id, (action) => action.outcome.status === 'completed', 'first Player enters Policy', () => drainWorld(demo));
    assert.ok(entered.outcome.evidence.length > 0);

    const refreshProduction = async (): Promise<void> => {
      await first.action(descriptor('refresh-production', '/api/production/refresh', ['vesselId']), { vesselId: firstVessel });
    };
    const productionPage = async (): Promise<unknown> => first.page(`/api/production?vesselId=${encodeURIComponent(firstVessel)}`);

    await refreshProduction();
    const mine = requireOperation(await productionPage(), 'mine', (operation) => operation.authorityId === demo.policy.ids.actor);
    let operationAction = await executeOperation(first, firstVessel, mine, { count: 2 });
    assert.equal(operationAction.outcome.status, 'completed', 'mining two real units completes');
    assert.ok(operationAction.outcome.evidence.length > 0);

    await refreshProduction();
    const manufacture = requireOperation(await productionPage(), 'manufacture', (operation) =>
      operation.authorityId === demo.policy.ids.actor
      && operationInputs(operation).some((input) => records(input.choices).some((choice) => choice.value === 'ore-to-metal')));
    operationAction = await executeOperation(first, firstVessel, manufacture, { recipe: 'ore-to-metal', count: 1 });
    assert.equal(operationAction.outcome.status, 'completed', 'manufacturing one metal completes');

    await refreshProduction();
    const transfer = requireOperation(await productionPage(), 'transfer', (operation) => operation.authorityId === demo.policy.ids.actor);
    operationAction = await executeOperation(first, firstVessel, transfer, {
      direction: 'to-port', variety: demo.policy.ids.varieties.metal, count: 1
    });
    assert.equal(operationAction.outcome.status, 'completed', 'transferring metal to the port completes');

    await refreshProduction();
    const load = requireOperation(await productionPage(), 'load', (operation) => operation.authorityId === demo.policy.ids.actor);
    operationAction = await executeOperation(first, firstVessel, load, { variety: demo.policy.ids.varieties.metal, count: 1 });
    assert.equal(operationAction.outcome.status, 'completed', 'loading real metal onto the vessel completes');

    const routeResponse = await first.action(
      descriptor('save-route', '/api/explore/routes', ['from', 'to']),
      { from: demo.policy.ids.ports[0], to: demo.simulation.ids.ports[0] }
    );
    const plan = record(pageData(routeResponse).plan);
    const planId = String(plan.id);
    const legs = records(plan.legs);
    assert.deepEqual(legs.map((leg) => leg.routeId), [
      demo.policy.ids.routes[1],
      `${demo.origins.policy}/objects/routes/outbound`,
      demo.simulation.ids.routes[0]
    ], 'the saved plan uses the directed East to West, outbound, and simulation approach legs');

    await administrationControl(governor, demo.simulation.ids.actor, 'admission', { reviewMode: 'manual' }, drainWorld, demo);

    let journey = actionOf(await first.action(
      descriptor('traverse', `/api/logistics/vessels/${encodeURIComponent(firstVessel)}/traverse`, ['routePlanId']),
      { routePlanId: planId }
    ));
    let pendingRequest: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 30 && pendingRequest === undefined; attempt += 1) {
      journey = await refreshAction(first, journey.id);
      await drainWorld(demo);
      pendingRequest = await pendingAdministrationRequest(governor, demo.simulation.ids.actor);
    }
    assert.ok(pendingRequest, 'the simulation entry is pending manual review before berthing');
    assert.notEqual(journey.outcome.status, 'completed', 'a pending review is not a completed journey');

    const pendingId = String(pendingRequest.requestId);
    let approvalAction = await decideAdministration(governor, demo.simulation.ids.actor, pendingId, 'approve');
    approvalAction = await refreshAction(governor, approvalAction.id);
    assert.notEqual(approvalAction.outcome.status, 'completed', 'approval remains pending before the administrator tick');
    const beforeTick = await demo.authority.registry.state(firstVessel);
    assert.equal(records(beforeTick.events).some((event) => event.type === 'BerthingEvent' && event.request === pendingId), false);

    await administrationControl(governor, demo.simulation.ids.actor, 'tick', {}, drainWorld, demo);
    journey = await refreshUntil(first, journey.id, (action) => action.outcome.status === 'completed', 'journey completes only after the delayed berth', () => drainWorld(demo), 30);
    assert.ok(journey.outcome.evidence.length > 0);

    const registry = await demo.authority.registry.state(firstVessel);
    const exit = records(registry.events).find((event) => event.type === 'ExitEvent');
    assert.ok(exit, 'the signed ExitEvent is real Registry evidence');
    const forwarded = Object.values(record(registry.requests)).map(record).find((request) =>
      request.type === 'EntryRequest'
      && record(request.destination).territory === demo.simulation.ids.actor
      && record(request.journey).exitEvidence === exit.id);
    assert.ok(forwarded, 'the destination EntryRequest carries the signed exit evidence');

    await refreshProduction();
    const unload = requireOperation(await productionPage(), 'unload', (operation) =>
      operation.authorityId === demo.simulation.ids.actor
      && operationInputs(operation).some((input) => records(input.choices).some((choice) => choice.value === demo.simulation.ids.varieties.importedMetal)));
    const unloadAction = await executeOperation(first, firstVessel, unload, {
      variety: demo.simulation.ids.varieties.importedMetal, count: 1, duration: 2
    });
    await administrationControl(governor, demo.simulation.ids.actor, 'tick', {}, drainWorld, demo);
    await administrationControl(governor, demo.simulation.ids.actor, 'tick', {}, drainWorld, demo);
    const unloaded = await refreshUntil(first, unloadAction.id, (action) => action.outcome.status === 'completed', 'timed unloading completes through governor ticks', () => drainWorld(demo));
    assert.ok(unloaded.outcome.evidence.length > 0);
    assert.ok(stockCount((await demo.simulation.territory.state()) as unknown as Record<string, unknown>, demo.simulation.ids.varieties.importedMetal) > 0, 'imported metal is in the shared stock');

    await refreshProduction();
    const importedManufacture = requireOperation(await productionPage(), 'manufacture', (operation) =>
      operation.authorityId === demo.simulation.ids.actor
      && operationInputs(operation).some((input) => records(input.choices).some((choice) => choice.value === 'imported')));
    let pendingManufacture = await executeOperation(first, firstVessel, importedManufacture, { recipe: 'imported', count: 1 });
    await administrationControl(governor, demo.simulation.ids.actor, 'tick', {}, drainWorld, demo);
    pendingManufacture = await refreshAction(first, pendingManufacture.id);
    assert.notEqual(pendingManufacture.outcome.status, 'completed', 'the imported manufacture remains pending before restart');

    const assetDraftResponse = await first.action(
      descriptor('create-asset-draft', '/api/drafts', ['kind', 'fields']),
      { kind: 'asset', fields: { name: 'Gameplay Asset', text: 'Readable gameplay asset text' } }
    );
    const assetDraftId = String(record(record(assetDraftResponse).draft).id);
    const assetAction = await refreshUntil(
      first,
      actionOf(await first.action(descriptor('publish-asset', `/api/drafts/${encodeURIComponent(assetDraftId)}/publish`), {})).id,
      (action) => action.outcome.status === 'completed',
      'published Asset is readable'
    );
    const assetId = assetAction.resultReferences.find((reference) => reference.kind === 'resource')?.id;
    assert.ok(assetId, 'publication returns the exact Asset identity');
    await first.action(descriptor('refresh-asset', `/api/resources/${encodeURIComponent(assetId)}/refresh`), {});
    const assetPage = await first.page(`/api/resources/${encodeURIComponent(assetId)}`);
    assert.equal(record(pageData(assetPage).value).type, 'Asset');
    assert.match(JSON.stringify(assetPage), /Readable gameplay asset text/, 'the shared resource API reads the Asset text document');

    const production = [{
      type: 'manufacture', duration: 1,
      ingredients: [{ variety: demo.simulation.ids.varieties.metal, count: 1, data: {} }],
      yield: [{ probability: 1, count: 1, data: {} }]
    }];
    const varietyDraftResponse = await first.action(
      descriptor('create-variety-draft', '/api/drafts', ['kind', 'fields']),
      { kind: 'variety', fields: { name: 'Gameplay Variety', mass: 1, version: '1', asset: assetId, production } }
    );
    const varietyDraft = record(record(varietyDraftResponse).draft);
    assert.equal(record(varietyDraft.fields).asset, assetId, 'the draft references the exact published Asset ID');
    const firstProduction = records(record(varietyDraft.fields).production)[0];
    const draftIngredient = record(records(firstProduction?.ingredients)[0]);
    assert.equal(draftIngredient.variety, demo.simulation.ids.varieties.metal, 'the draft keeps exact production ingredient identities');
    const varietyDraftId = String(varietyDraft.id);
    const varietyAction = await refreshUntil(
      first,
      actionOf(await first.action(descriptor('publish-variety', `/api/drafts/${encodeURIComponent(varietyDraftId)}/publish`), {})).id,
      (action) => action.outcome.status === 'completed',
      'published Variety is readable'
    );
    const varietyId = varietyAction.resultReferences.find((reference) => reference.kind === 'resource')?.id;
    assert.ok(varietyId);
    await first.action(descriptor('refresh-variety', `/api/resources/${encodeURIComponent(varietyId)}/refresh`), {});
    const varietyPage = await first.page(`/api/resources/${encodeURIComponent(varietyId)}`);
    assert.equal(record(pageData(varietyPage).value).type, 'Variety');
    assert.equal(record(pageData(varietyPage).value).asset, assetId);

    const policyAdmission = await administrationControl(governor, demo.policy.ids.actor, 'admission', { reviewMode: 'manual' }, drainWorld, demo);
    assert.ok(policyAdmission.outcome.evidence.length > 0, 'a supported administrator control is observed');
    const secondEntry = actionOf(await second.action(
      descriptor('enter-policy-manual', `/api/logistics/vessels/${encodeURIComponent(secondVessel)}/entry`, ['territoryId', 'portId', 'routeId']),
      { territoryId: demo.policy.ids.actor, portId: demo.policy.ids.ports[0], routeId: demo.policy.ids.routes[0] }
    ));
    const secondRequest = secondEntry.resultReferences.find((reference) => reference.kind === 'request');
    assert.ok(secondRequest);
    await drainWorld(demo);
    const secondPending = await pendingAdministrationRequest(governor, demo.policy.ids.actor);
    assert.ok(secondPending, 'the second Player entry waits for manual review');
    await decideAdministration(governor, demo.policy.ids.actor, String(secondPending.requestId), 'reject', 'destination-rejected');
    await drainWorld(demo);
    const rejected = await refreshUntil(second, secondEntry.id, (action) => action.outcome.status === 'failed', 'the second Player entry is rejected', () => drainWorld(demo));
    assert.ok(rejected.outcome.evidence.length > 0);
    assert.match(JSON.stringify(rejected), /EntryRejected|destination-rejected/i);
    const secondRegistry = await demo.authority.registry.state(secondVessel);
    assert.ok(records(secondRegistry.events).some((event) => event.type === 'EntryRejected' && event.request === secondRequest.id), 'rejection produces real Registry EntryRejected evidence');

    await drainWorld(demo);
    const requestsBeforeRestart = Object.keys(record((await demo.authority.registry.state(firstVessel)).requests)).length;
    await demo.close();
    demo = await startDemo({ dataDir: directory, ports: portOptions });
    first = make(accounts.first);
    second = make(accounts.second);
    governor = make(accounts.governor);

    const recoveredAccounts = records(record(await first.page('/api/accounts')).accounts);
    assert.ok(recoveredAccounts.some((account) => account.id === firstId && record(account.login).status === 'signed-in'));
    assert.ok(recoveredAccounts.some((account) => account.id === secondId && record(account.login).status === 'signed-in'));
    const recoveredDraft = record(record(await first.page(`/api/drafts/${encodeURIComponent(assetDraftId)}`)).draft);
    assert.equal(recoveredDraft.id, assetDraftId, 'drafts recover from the same client store');
    const recoveredPlan = record(pageData(await first.page(`/api/explore/routes/${encodeURIComponent(planId)}`)).plan);
    assert.equal(recoveredPlan.id, planId, 'the selected route plan recovers');
    const recoveredAction = resultAction(await first.result(pendingManufacture.id));
    assert.equal(recoveredAction.id, pendingManufacture.id, 'the pending action recovers');
    assert.notEqual(recoveredAction.outcome.status, 'completed');
    const recoveredProduction = await first.page(`/api/production?vesselId=${encodeURIComponent(firstVessel)}`);
    assert.ok(records(pageData(recoveredProduction).jobs).length > 0, 'retained job observations recover');
    const recoveredLogistics = await first.page(`/api/logistics/vessels/${encodeURIComponent(firstVessel)}`);
    assert.match(JSON.stringify(recoveredLogistics), new RegExp(escapeRegExp(demo.simulation.ids.actor)), 'retained observations recover');
    const requestsAfterRestart = Object.keys(record((await demo.authority.registry.state(firstVessel)).requests)).length;
    assert.equal(requestsAfterRestart, requestsBeforeRestart, 'recovery does not replay actions or resubmit requests');

    await administrationControl(governor, demo.simulation.ids.actor, 'tick', {}, drainWorld, demo);
    const finishedManufacture = await refreshUntil(first, pendingManufacture.id, (action) => action.outcome.status === 'completed', 'the recovered pending job finishes after restart', () => drainWorld(demo));
    assert.ok(finishedManufacture.outcome.evidence.length > 0);
    assert.ok(stockCount((await demo.simulation.territory.state()) as unknown as Record<string, unknown>, demo.simulation.ids.varieties.refined) > 0, 'refined product stock is observed');

    await demo.policy.host.close();
    await first.action(descriptor('refresh-explore-after-source-loss', '/api/explore/refresh'));
    const degraded = await first.page('/api/explore/places');
    const states = observationStates(degraded);
    assert.ok(states.some((observation) => String(observation.source).startsWith(demo.origins.policy) && ['unavailable', 'stale'].includes(String(observation.state))), 'the stopped Policy source is stale or unavailable');
    assert.ok(states.some((observation) => String(observation.source).startsWith(demo.origins.simulation) && ['available', 'empty'].includes(String(observation.state))), 'the other Territory remains available');

    await first.action(descriptor('refresh-production-after-source-loss', '/api/production/refresh', ['vesselId']), { vesselId: firstVessel });
    const simulationProduction = await first.page(`/api/production?vesselId=${encodeURIComponent(firstVessel)}`);
    const simulationMine = requireOperation(simulationProduction, 'mine', (operation) => operation.authorityId === demo.simulation.ids.actor);
    let simulationAction = await executeOperation(first, firstVessel, simulationMine, { count: 1, duration: 1 });
    await administrationControl(governor, demo.simulation.ids.actor, 'tick', {}, drainSimulation, demo);
    simulationAction = await refreshUntil(first, simulationAction.id, (action) => action.outcome.status === 'completed', 'the remaining Territory still executes operations', () => drainSimulation(demo));
    assert.ok(simulationAction.outcome.evidence.length > 0);

    await demo.simulation.host.close();
    const retainedAction = resultAction(await first.result(finishedManufacture.id));
    assert.equal(retainedAction.id, finishedManufacture.id, 'retained action GET performs no world IO');
    const retainedLogisticsAfterLoss = await first.page(`/api/logistics/vessels/${encodeURIComponent(firstVessel)}`);
    assert.match(JSON.stringify(retainedLogisticsAfterLoss), new RegExp(escapeRegExp(demo.simulation.ids.actor)), 'retained observations remain readable with all Territory sources stopped');
  } finally {
    await demo.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not allocate a TCP port');
  const { port } = address;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}
