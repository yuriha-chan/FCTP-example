import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBrowserSession, type BrowserSession, type TextView } from '../dist/apps/browser-harness/index.js';
import { resolveExitEvidence } from '@fctp/server-base';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';
import { startClientServer } from '../apps/demo/src/client-server.js';

const playerNames = ['player', 'player-2', 'player-3', 'player-4', 'player-5'];
const adminSecret = 'browser-gameplay-isolated-admin';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function refFor(view: TextView, label: string, within?: string): string {
  const markdown = within ? view.markdown.split(`## ${within}`)[1]?.split('\n## ')[0] ?? '' : view.markdown;
  const matches = [...markdown.matchAll(new RegExp(`^.*(?:${escapeRegExp(label)}).*?\\[([A-Za-z0-9-]+)\\](?: \\(disabled\\))?$`, 'gm'))];
  assert.equal(matches.length, 1, `Expected one control labelled ${label}${within ? ` in ${within}` : ''}, found ${matches.length}`);
  return matches[0]![1]!;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function control(session: BrowserSession, view: TextView, label: string, operation: 'click' | 'submit' = 'click', within?: string): Promise<TextView> {
  return session[operation](refFor(view, label, within));
}

async function formField(session: BrowserSession, view: TextView, label: string, value: string): Promise<TextView> {
  return session.fill(refFor(view, label), value);
}

async function waitFor<T>(read: () => Promise<T>, matches: (value: T) => boolean, description: string): Promise<T> {
  const deadline = Date.now() + 12_000;
  let value = await read();
  while (!matches(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    value = await read();
  }
  assert.ok(matches(value), `Timed out waiting for ${description}`);
  return value;
}

test('real browser Player sessions discover and execute isolated A-to-Registry gameplay', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-browser-gameplay-'));
  const [authorityPort, policyPort, simulationPort, clientPort] = await Promise.all(Array.from({ length: 4 }, freePort));
  const origins = {
    authority: `http://127.0.0.1:${authorityPort}`,
    policy: `http://127.0.0.1:${policyPort}`,
    simulation: `http://127.0.0.1:${simulationPort}`
  };
  const services: {
    authority?: Awaited<ReturnType<typeof createAuthorityApp>>;
    policy?: Awaited<ReturnType<typeof createPolicyApp>>;
    simulation?: Awaited<ReturnType<typeof createSimulationApp>>;
    clientServer?: Awaited<ReturnType<typeof startClientServer>>;
  } = {};
  const sessions: BrowserSession[] = [];
  t.after(async () => {
    const shutdowns = [
      ...sessions.map((session) => session.close()),
      ...(services.clientServer ? [services.clientServer.close()] : []),
      ...(services.simulation ? [services.simulation.host.close()] : []),
      ...(services.policy ? [services.policy.host.close()] : []),
      ...(services.authority ? [services.authority.authority.close()] : [])
    ];
    const results = await Promise.allSettled(shutdowns);
    await rm(directory, { recursive: true, force: true });
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Browser gameplay fixture cleanup failed');
  });

  services.authority = await createAuthorityApp({ origin: origins.authority, storeFile: join(directory, 'authority.json'), adminSecret, playerNames });
  services.policy = await createPolicyApp({ origin: origins.policy, storeFile: join(directory, 'policy.json'), authorityOrigin: origins.authority, playerNames, peerOrigin: origins.simulation, adminSecret });
  services.simulation = await createSimulationApp({ origin: origins.simulation, storeFile: join(directory, 'simulation.json'), authorityOrigin: origins.authority, playerNames, peerOrigin: origins.policy, adminSecret });
  await services.authority.authority.listen(authorityPort, '127.0.0.1');
  await services.policy.host.listen(policyPort, '127.0.0.1');
  await services.simulation.host.listen(simulationPort, '127.0.0.1');
  services.clientServer = await startClientServer({
    port: clientPort!,
    config: { origins, actors: { registry: services.authority.ids.actor.registry, home: services.authority.ids.actor.home, player: services.authority.ids.actor.player, policy: services.policy.ids.actor, simulation: services.simulation.ids.actor } }
  });
  const authority = services.authority;
  const policy = services.policy;
  const simulation = services.simulation;
  const clientServer = services.clientServer;

  const adminHeaders = { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' };
  const nativeTokens = new Map<string, string>();
  const authorityApp = authority;
  const policyApp = policy;
  const simulationApp = simulation;
  for (const name of ['player-2', 'player-3']) {
    const response: Response = await fetch(`${origins.authority}/local/home/issue`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: authorityApp.ids.players[name] }) });
    assert.equal(response.status, 200);
    nativeTokens.set(name, (await response.json() as { nativeToken: string }).nativeToken);
    for (const territory of [policyApp, simulationApp]) {
      await authorityApp.home.requestDigest(authorityApp.ids.players[name]!, { id: territory.ids.actor, inbox: territory.host.actor('territory').inbox });
      assert.equal(await authorityApp.authority.server.processOutbox(), 1, 'signed Home token digest delivered');
      assert.equal(await territory.host.server.processInbox(), 1, 'Territory applies signed token digest');
    }
  }
  const player2 = authority.ids.players['player-2']!;
  const vessel2 = authority.ids.vessels['player-2']!;
  const vessel3 = authority.ids.vessels['player-3']!;
  const headers2 = { Authorization: `Bearer ${nativeTokens.get('player-2')}`, 'Content-Type': 'application/json' };
  const headers3 = { Authorization: `Bearer ${nativeTokens.get('player-3')}`, 'Content-Type': 'application/json' };
  const registryState = async (headers: HeadersInit, vessel: string) => fetch(`${origins.authority}/local/registry/state?vessel=${encodeURIComponent(vessel)}`, { headers });
  const authorityState = async () => authority!.authority.server.store.read((store) => structuredClone(store.domain.registry));
  const policyState = async () => policy!.host.server.store.read((store) => structuredClone(store.domain.policyTerritory));

  const playerSession = await createBrowserSession({ url: clientServer.origin, allowedOrigins: [clientServer.origin, ...Object.values(origins)] });
  sessions.push(playerSession);
  let view = await playerSession.view();
  view = await sessionLogin(playerSession, view, player2, vessel2, nativeTokens.get('player-2')!);
  assert.match(view.markdown, new RegExp(`Player ${escapeRegExp(player2)}.*vessel ${escapeRegExp(vessel2)}`));
  assert.match(view.markdown, /Credential: \[REDACTED\]/);
  assert.doesNotMatch(view.markdown, new RegExp(escapeRegExp(nativeTokens.get('player-2')!)));
  view = await control(playerSession, view, 'Refresh A state and actions');
  assert.match(view.markdown, /Manufacture one metal/);
  assert.match(view.markdown, /not-enough-ingredients|insufficient|ore/i);
  assert.match(view.markdown, /Load one metal \[[A-Za-z0-9-]+\] \(disabled\)/);
  assert.match(view.markdown, /Blocked: A current local berth is required before cargo can move\./);
  view = await control(playerSession, view, 'Run: Mine one ore');
  assert.match(view.markdown, /Request accepted\./);
  view = await control(playerSession, view, 'Refresh A state and actions');
  view = await control(playerSession, view, 'Run: Mine one ore');
  view = await control(playerSession, view, 'Refresh A state and actions');
  view = await control(playerSession, view, 'Run: Manufacture one metal');
  view = await control(playerSession, view, 'Refresh A state and actions');
  view = await control(playerSession, view, 'Run: Transfer one metal to port');
  view = await control(playerSession, view, 'Refresh A state and actions');
  assert.match(view.markdown, /Load one metal \[[A-Za-z0-9-]+\] \(disabled\)/);
  const afterProduction = await policyState() as { state?: { rawInventory?: Record<string, number>; portInventory?: Record<string, number> } };
  assert.equal(afterProduction.state?.rawInventory?.[policy.ids.varieties.ore], 0);
  assert.equal(afterProduction.state?.portInventory?.[policy.ids.varieties.metal], 1);
  const productionLedger = await policyState() as { visits?: Record<string, unknown>; state?: { vessels?: Record<string, unknown> } };
  assert.deepEqual(Object.keys(productionLedger.visits ?? {}), []);
  assert.deepEqual(Object.keys(productionLedger.state?.vessels ?? {}), []);

  view = await control(playerSession, view, 'Refresh A state and actions');
  assert.match(view.markdown, /Request local entry at East Haven/);
  view = await control(playerSession, view, 'Run: Request local entry at East Haven');
  assert.match(view.markdown, /Request accepted\./);
  const registryAfterEntry = await waitFor(async () => {
    await authority!.authority.server.processOutbox();
    await authority!.authority.server.processInbox();
    await policy!.host.server.processInbox();
    await policy!.host.server.processOutbox();
    await authority!.authority.server.processInbox();
    return registryState(headers2, vessel2).then(async (response) => { assert.equal(response.status, 200); return response.json() as Promise<Record<string, unknown>>; });
  }, (state) => Object.keys((state.requests ?? {}) as object).length > 0, 'Registry entry processing');
  assert.ok(registryAfterEntry);
  await waitFor(async () => {
    await authority!.authority.server.processOutbox();
    await policy!.host.server.processInbox();
    await policy!.host.server.processOutbox();
    await authority!.authority.server.processInbox();
    return policyState();
  }, (state) => {
    const ledger = state as { visits?: Record<string, { departed?: boolean }> };
    return !!ledger.visits?.[vessel2] && ledger.visits[vessel2]!.departed !== true;
  }, 'A active berth');

  view = await control(playerSession, view, 'Refresh A state and actions');
  assert.match(view.markdown, /Load one metal/);
  view = await control(playerSession, view, 'Run: Load one metal');
  const loaded = await policyState() as { state?: { portInventory?: Record<string, number>; vessels?: Record<string, { manifest?: { entries?: unknown[] } }> } };
  assert.equal(loaded.state?.portInventory?.[policy.ids.varieties.metal], 0);
  assert.deepEqual(loaded.state?.vessels?.[vessel2]?.manifest?.entries, [{ variety: policy.ids.varieties.metal, count: 1, data: {} }]);
  const registryState2 = await (await registryState(headers2, vessel2)).json() as { cargo?: { entries?: unknown[] } };
  const registryState3 = await (await registryState(headers3, vessel3)).json() as { cargo?: { entries?: unknown[] } };
  assert.deepEqual(registryState2.cargo?.entries, []);
  assert.deepEqual(registryState3.cargo?.entries, []);

  view = await control(playerSession, view, 'Refresh Registry state and actions');
  const registryDeparture = view.markdown.split('#### Request departure from recorded berth')[1]?.split(/\n#{3,4} /)[0] ?? '';
  assert.match(registryDeparture, /Run: Request departure from recorded berth/);

  view = await control(playerSession, view, 'Refresh A state and actions');
  assert.match(view.markdown, /Request departure from current berth/);
  assert.match(view.markdown, /Run: Request departure from current berth/);

  const otherSession = await createBrowserSession({ url: clientServer.origin, allowedOrigins: [clientServer.origin, ...Object.values(origins)] });
  sessions.push(otherSession);
  let otherView = await otherSession.view();
  otherView = await sessionLogin(otherSession, otherView, authority.ids.players['player-3']!, vessel3, nativeTokens.get('player-3')!);
  otherView = await control(otherSession, otherView, 'Refresh Registry state and actions');
  assert.match(otherView.markdown, new RegExp(escapeRegExp(vessel3)));
  assert.doesNotMatch(otherView.markdown, new RegExp(escapeRegExp(vessel2)));
  assert.doesNotMatch(otherView.markdown, new RegExp(escapeRegExp(nativeTokens.get('player-2')!)));
  assert.deepEqual((await registryState(headers3, vessel3)).status, 200);
  const registryBeforeDeparture = await authorityState();
  const activeBerth = String(JSON.stringify(registryBeforeDeparture));
  assert.ok(activeBerth?.includes(vessel2));
  assert.ok(activeBerth?.includes(origins.policy));

  view = await control(playerSession, view, 'Run: Request departure from current berth');
  assert.match(view.markdown, /Request accepted\./);
  const exitDeadline = Date.now() + 12_000;
  let exitObserved: Record<string, unknown> | undefined;
  let exitDiagnostics = 'No Registry state was read';
  while (!exitObserved && Date.now() < exitDeadline) {
    await authority!.authority.server.processOutbox();
    await policy!.host.server.processInbox();
    await policy!.host.server.processOutbox();
    await authority!.authority.server.processInbox();
    const state = await registryState(headers2, vessel2).then((response) => response.json() as Promise<Record<string, unknown>>);
    const territory = await policyState() as { visits?: Record<string, { departed?: boolean; cargo?: unknown }>; decisions?: Record<string, { accepted?: boolean; reason?: string }> };
    const vesselState = (state.state ?? {}) as Record<string, unknown>;
    exitDiagnostics = JSON.stringify({
      registry: {
        location: vesselState.location,
        exitEvidenceCount: Array.isArray(state.exitEvidence) ? state.exitEvidence.length : 0,
        latestExitEvidence: vesselState.latestExitEvidence,
        pendingRequests: vesselState.pendingRequests,
        eventTypes: Array.isArray(state.events) ? state.events.map((event) => (event as { type?: unknown }).type) : []
      },
      territory: {
        visit: territory.visits?.[vessel2] ? { departed: territory.visits[vessel2]!.departed, cargo: territory.visits[vessel2]!.cargo } : null,
        decisions: Object.values(territory.decisions ?? {}).map((decision) => ({ accepted: decision.accepted, reason: decision.reason }))
      }
    });
    if (Array.isArray(state.exitEvidence) && state.exitEvidence.length > 0) exitObserved = state;
    else await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(exitObserved, `Timed out waiting for a Registry-recorded ExitEvent; current redacted domain/event/rejection state: ${exitDiagnostics}`);
  const exitId = (exitObserved.exitEvidence as string[]).at(-1)!;
  const verified = await resolveExitEvidence(exitId, { vessel: vessel2, registry: authority.ids.actor.registry });
  assert.equal(verified.verification.cryptographic.verified, true, `ExitEvent proof verification failed: ${JSON.stringify(verified.verification)}`);
  assert.equal(verified.verification.attribution.attributed, true, `ExitEvent key attribution failed: ${JSON.stringify(verified.verification)}`);
  assert.equal(verified.verification.expectedIssuer.matches, true, `ExitEvent issuer verification failed: ${JSON.stringify(verified.verification)}`);
  assert.equal(verified.binding.bound, true, `ExitEvent request binding failed: ${JSON.stringify(verified.binding)}`);
  assert.ok(verified.exit, `ExitEvent could not be resolved: ${verified.error ?? JSON.stringify(verified.binding)}`);
  assert.ok(verified.entry, `ExitEvent EntryRequest could not be resolved: ${verified.error ?? JSON.stringify(verified.binding)}`);
  assert.equal(verified.exit.id, exitId);
  assert.equal(verified.exit.vessel, vessel2);
  assert.equal(verified.exit.territory, policy.ids.actor);
  const registryVisit = registryBeforeDeparture as { vessels?: Record<string, { events?: Array<{ type?: string; territory?: string; request?: string }> }> };
  assert.equal(verified.exit.entryRequest, registryVisit.vessels?.[vessel2]?.events
    ?.find((event) => event.type === 'BerthingEvent' && event.territory === policy.ids.actor)?.request);
  assert.equal(verified.entry.id, verified.exit.entryRequest);
  assert.equal(verified.entry.vessel.id, vessel2);
  assert.equal(verified.entry.vessel.registry, authority.ids.actor.registry);
  assert.deepEqual(verified.exit.cargo, loaded.state?.vessels?.[vessel2]?.manifest);
});

async function sessionLogin(session: BrowserSession, initial: TextView, player: string, vessel: string, credential: string): Promise<TextView> {
  let view = await session.select(refFor(initial, 'Role'), 'player');
  view = await formField(session, view, 'Player URI', player);
  view = await formField(session, view, 'Vessel URI', vessel);
  view = await formField(session, view, 'Credential', credential);
  return control(session, view, 'Apply session', 'submit');
}
