import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CargoManifest, URI } from '@fctp/protocol';
import {
  DEFAULT_ADMISSION,
  admissionPermits,
  createHost,
  entryAdmissionAllows,
  type AdmissionList,
  type AdmissionPolicy
} from '@fctp/server-base';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { territoryAProduction } from '../apps/territory-policy/src/domain.js';
import { installPolicyTerritory, type PolicyTerritoryOptions } from '../apps/territory-policy/src/territory.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';
import { installSimulationTerritory, simulationExpectedIssuer } from '../apps/territory-sim/src/territory.js';

const ADMISSION_FIELDS = ['trustedRegistry', 'acceptedRegistry', 'acceptedTerritory', 'vesselBuildingRegistry'] as const;

const EXPECTED_DEFAULTS: AdmissionPolicy = {
  trustedRegistry: { mode: 'allowlist', allowlist: [], denylist: [] },
  acceptedRegistry: { mode: 'denylist', allowlist: [], denylist: [] },
  acceptedTerritory: { mode: 'allowlist', allowlist: [], denylist: [] },
  vesselBuildingRegistry: { mode: 'allowlist', allowlist: [], denylist: [] }
};

const policyOrigin = 'http://policy-admission.test';
const policyRegistry = `${policyOrigin}/actors/registry` as URI;
const policyTerritory = `${policyOrigin}/actors/territory` as URI;
const policyPort = `${policyOrigin}/objects/ports/main` as URI;
const policyRoute = `${policyOrigin}/objects/routes/approach` as URI;

const simOrigin = 'https://sim-admission.test';
const simRegistry = `${simOrigin}/actors/registry` as URI;
const simTerritory = `${simOrigin}/actors/territory` as URI;
const simPort = `${simOrigin}/ports/main` as URI;
const simRoute = `${simOrigin}/routes/approach` as URI;
const simCommodity = {
  ore: `${simOrigin}/commodities/ore`,
  nativeMetal: `${simOrigin}/commodities/metal`,
  importedMetal: `${simOrigin}/commodities/imported`,
  refinedProduct: `${simOrigin}/commodities/refined`
};

function list(mode: AdmissionList['mode'], allowlist: string[] = [], denylist: string[] = []): AdmissionList {
  return { mode, allowlist: allowlist as URI[], denylist: denylist as URI[] };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP port allocated');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('admissionPermits implements allowlist membership and denylist non-membership', () => {
  const member = `${policyOrigin}/registries/member`;
  const other = `${policyOrigin}/registries/other`;
  assert.equal(admissionPermits(list('allowlist', [member]), member), true);
  assert.equal(admissionPermits(list('allowlist', [member]), other), false);
  assert.equal(admissionPermits(list('denylist', [], [member]), member), false);
  assert.equal(admissionPermits(list('denylist', [], [member]), other), true);
});

test('entryAdmissionAllows splits trustedRegistry and acceptedRegistry/acceptedTerritory by evidence presence', () => {
  const registry = `${policyOrigin}/actors/registry` as URI;
  const otherRegistry = `${policyOrigin}/actors/other-registry` as URI;
  const territory = `${policyOrigin}/actors/other-territory` as URI;

  assert.deepEqual(DEFAULT_ADMISSION, EXPECTED_DEFAULTS);
  assert.equal(entryAdmissionAllows(DEFAULT_ADMISSION, registry).allowed, false, 'defaults reject evidence-free entry');
  assert.equal(entryAdmissionAllows(DEFAULT_ADMISSION, registry, territory).allowed, false, 'defaults reject evidence entry without an accepted Territory');

  const accepted = {
    ...EXPECTED_DEFAULTS,
    acceptedRegistry: list('allowlist', [registry]),
    acceptedTerritory: list('allowlist', [territory])
  };
  assert.equal(entryAdmissionAllows(accepted, registry, territory).allowed, true, 'evidence entry is accepted when both accepted lists permit');

  const emptyTerritory = { ...accepted, acceptedTerritory: list('allowlist', []) };
  assert.equal(entryAdmissionAllows(emptyTerritory, registry, territory).allowed, false, 'empty acceptedTerritory rejects evidence entry');

  const allowlistMiss = { ...accepted, acceptedRegistry: list('allowlist', [otherRegistry]) };
  assert.equal(entryAdmissionAllows(allowlistMiss, registry, territory).allowed, false, 'acceptedRegistry allowlist must contain the Registry');

  const denylistHit = { ...accepted, acceptedRegistry: list('denylist', [], [registry]) };
  assert.equal(entryAdmissionAllows(denylistHit, registry, territory).allowed, false, 'acceptedRegistry denylist rejects a member Registry');

  const denylistMiss = { ...accepted, acceptedRegistry: list('denylist', [], [otherRegistry]) };
  assert.equal(entryAdmissionAllows(denylistMiss, registry, territory).allowed, true, 'acceptedRegistry denylist accepts a non-member Registry');

  const trustedDenied = { ...accepted, trustedRegistry: list('allowlist', []) };
  assert.equal(entryAdmissionAllows(trustedDenied, registry, territory).allowed, true, 'trustedRegistry is irrelevant when exit evidence is present');

  const acceptedDeniedWithoutEvidence = {
    ...EXPECTED_DEFAULTS,
    trustedRegistry: list('allowlist', [registry]),
    acceptedRegistry: list('denylist', [], [registry]),
    acceptedTerritory: list('allowlist', [])
  };
  assert.equal(entryAdmissionAllows(acceptedDeniedWithoutEvidence, registry).allowed, true, 'accepted lists are irrelevant without exit evidence');

  const trustedDeniedWithoutEvidence = {
    ...acceptedDeniedWithoutEvidence,
    trustedRegistry: list('allowlist', [])
  };
  assert.equal(entryAdmissionAllows(trustedDeniedWithoutEvidence, registry).allowed, false, 'evidence-free entry requires trustedRegistry');
});

async function policyHttpFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-admission-policy-http-'));
  const origin = `http://127.0.0.1:${await freePort()}`;
  const adminSecret = 'admission-policy-admin-secret';
  const app = await createPolicyApp({
    origin,
    storeFile: join(directory, 'policy.json'),

    adminSecret
  });
  await app.host.listen(Number(new URL(origin).port));
  const adminHeaders = { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' };
  const state = async (): Promise<{ admission: Record<string, unknown> }> => {
    const response = await fetch(`${origin}/local/state`, { headers: { Authorization: `Bearer ${adminSecret}` } });
    assert.equal(response.status, 200);
    return await response.json() as { admission: Record<string, unknown> };
  };
  const post = (body: unknown): Promise<Response> => fetch(`${origin}/local/admin/admission`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify(body)
  });
  return {
    origin,
    state,
    post,
    close: async () => { await app.host.close(); await rm(directory, { recursive: true, force: true }); }
  };
}

test('policy HTTP state exposes the four-list admission defaults', async () => {
  const fixture = await policyHttpFixture();
  try {
    const view = await fixture.state();
    for (const field of ADMISSION_FIELDS) {
      assert.deepEqual(view.admission[field], EXPECTED_DEFAULTS[field], `policy ${field} default`);
    }
    assert.equal('registryAcceptance' in view.admission, false, 'legacy registryAcceptance is absent');
    assert.equal('territoryAcceptance' in view.admission, false, 'legacy territoryAcceptance is absent');
  } finally {
    await fixture.close();
  }
});

test('policy HTTP admission administration edits each list and validates input', async () => {
  const fixture = await policyHttpFixture();
  try {
    const updates: Record<typeof ADMISSION_FIELDS[number], AdmissionList> = {
      trustedRegistry: list('allowlist', [`${fixture.origin}/registries/trusted`]),
      acceptedRegistry: list('denylist', [], [`${fixture.origin}/registries/denied`]),
      acceptedTerritory: list('allowlist', [`${fixture.origin}/territories/accepted`]),
      vesselBuildingRegistry: list('denylist', [`${fixture.origin}/registries/building-allowed`], [`${fixture.origin}/registries/building-denied`])
    };
    for (const field of ADMISSION_FIELDS) {
      const response = await fixture.post({ [field]: updates[field] });
      assert.equal(response.status, 200, `policy update accepts ${field}`);
      const body = await response.json() as { admission: Record<string, unknown> };
      assert.deepEqual(body.admission[field], updates[field], `policy update response reflects ${field}`);
      assert.deepEqual((await fixture.state()).admission[field], updates[field], `policy state reflects ${field}`);
    }

    const invalid = [
      ['invalid mode', { trustedRegistry: { mode: 'sometimes', allowlist: [], denylist: [] } }],
      ['non-array allowlist', { acceptedRegistry: { mode: 'allowlist', allowlist: 'not-an-array', denylist: [] } }],
      ['non-array denylist', { acceptedTerritory: { mode: 'denylist', allowlist: [], denylist: {} } }],
      ['non-absolute URI', { vesselBuildingRegistry: { mode: 'allowlist', allowlist: ['relative/path'], denylist: [] } }],
      ['unknown field', { mysteryRegistry: list('allowlist', []) }]
    ] as const;
    for (const [name, body] of invalid) {
      assert.equal((await fixture.post(body)).status, 400, `policy rejects ${name}`);
    }
  } finally {
    await fixture.close();
  }
});

async function simulationHttpFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-admission-sim-http-'));
  const origin = `http://127.0.0.1:${await freePort()}`;
  const adminSecret = 'admission-sim-admin-secret';
  const app = await createSimulationApp({
    origin,
    storeFile: join(directory, 'simulation.json'),
    peerOrigin: 'https://peer.example',
    adminSecret
  });
  await app.host.listen(Number(new URL(origin).port));
  const adminHeaders = { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' };
  const state = async (): Promise<{ admission: Record<string, unknown> }> => {
    const response = await fetch(`${origin}/local/state`, { headers: { Authorization: `Bearer ${adminSecret}` } });
    assert.equal(response.status, 200);
    return await response.json() as { admission: Record<string, unknown> };
  };
  const post = (body: unknown): Promise<Response> => fetch(`${origin}/local/admin/admission`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify(body)
  });
  return {
    origin,
    state,
    post,
    close: async () => { await app.host.close(); await rm(directory, { recursive: true, force: true }); }
  };
}

test('simulation HTTP state exposes the four-list admission defaults and edits each list', async () => {
  const fixture = await simulationHttpFixture();
  try {
    const defaults = await fixture.state();
    for (const field of ADMISSION_FIELDS) {
      assert.deepEqual(defaults.admission[field], EXPECTED_DEFAULTS[field], `simulation ${field} default`);
    }

    const updates: Record<typeof ADMISSION_FIELDS[number], AdmissionList> = {
      trustedRegistry: list('denylist', [], [`${fixture.origin}/registries/denied`]),
      acceptedRegistry: list('allowlist', [`${fixture.origin}/registries/accepted`]),
      acceptedTerritory: list('denylist', [`${fixture.origin}/territories/allowed`], [`${fixture.origin}/territories/denied`]),
      vesselBuildingRegistry: list('allowlist', [`${fixture.origin}/registries/building`])
    };
    for (const field of ADMISSION_FIELDS) {
      const response = await fixture.post({ [field]: updates[field] });
      assert.equal(response.status, 200, `simulation update accepts ${field}`);
      const body = await response.json() as { admission: Record<string, unknown> };
      assert.deepEqual(body.admission[field], updates[field], `simulation update response reflects ${field}`);
      assert.deepEqual((await fixture.state()).admission[field], updates[field], `simulation state reflects ${field}`);
    }

    assert.equal((await fixture.post({ trustedRegistry: { mode: 'sometimes', allowlist: [], denylist: [] } })).status, 400, 'simulation rejects an invalid mode');
    assert.equal((await fixture.post({ mysteryRegistry: list('allowlist', []) })).status, 400, 'simulation rejects an unknown field');
  } finally {
    await fixture.close();
  }
});

interface PolicyEntryRequest extends Record<string, unknown> {
  id: string;
  vessel: { id: string; registry: string; possessor: string; capacity: number };
  cargo: CargoManifest;
  journey: { events: unknown[]; exitEvidence?: string };
  destination: { territory: string; port: string; route: string };
}

function policyEntry(id: string, vessel: string, cargo: CargoManifest = { entries: [] }, exitEvidence?: string): PolicyEntryRequest {
  return {
    id, type: 'EntryRequest',
    vessel: { id: vessel, registry: policyRegistry, possessor: `${policyOrigin}/actors/player`, capacity: 20 },
    cargo,
    journey: { events: [], ...(exitEvidence === undefined ? {} : { exitEvidence }) },
    destination: { territory: policyTerritory, port: policyPort, route: policyRoute }
  };
}

type PolicyAdmissionOptions = Pick<PolicyTerritoryOptions, 'trustedRegistry' | 'acceptedRegistry' | 'acceptedTerritory' | 'vesselBuildingRegistry'>;

async function policyFixture(admission: PolicyAdmissionOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-admission-policy-'));
  const documents = new Map<string, unknown>();
  let host: Awaited<ReturnType<typeof createHost>> | undefined = undefined;
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    url.hash = '';
    const uri = url.toString();
    if (documents.has(uri)) return Response.json(documents.get(uri));
    if (uri === policyRegistry) return Response.json({ ...host!.actor('registry'), inbox: `${policyOrigin}/inbox/registry` });
    if (uri === policyTerritory) return Response.json(host!.actor('territory'));
    if (uri === `${policyOrigin}/keys/registry`) return Response.json(host!.key('registry').publicKey);
    if (uri === `${policyOrigin}/keys/territory`) return Response.json(host!.key('territory').publicKey);
    return new Response('not found', { status: 404 });
  };
  host = await createHost({
    origin: policyOrigin,
    storeFile: join(directory, 'store.json'),
    actors: [{ name: 'registry', role: 'registry' }, { name: 'territory', role: 'territory' }],
    fetcher,
    resolveExpectedIssuer: async (_local, _sender, activity) => {
      const object = activity.object as Record<string, unknown> | undefined;
      if (object?.type === 'ExitEvent') return policyTerritory;
      return object?.type === 'EntryRequest' || object?.type === 'DepartureRequest' ? policyRegistry : undefined;
    }
  });
  const policy = installPolicyTerritory(host, {
    name: 'territory',
    portIds: [policyPort],
    routeIds: [policyRoute],
    commodities: [{ variety: territoryAProduction.ore, mass: 2 }, { variety: territoryAProduction.metal, mass: 1 }],
    initialPolicy: { miningPermitted: true, miningQuota: 10, oreReserve: 10, manufacturePermits: ['ore-to-metal'], recipes: territoryAProduction.recipes, warehouseLimits: {}, portLimits: {}, decisions: {} },
    ...admission,
    fetcher
  });
  const sendAsRegistry = async (object: Record<string, unknown>): Promise<void> => {
    const activity = await host.sign('registry', {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
      id: `${String(object.id)}/activity`, type: 'Create', actor: policyRegistry, object, to: [policyTerritory]
    } as never);
    await host.server.receive(policyTerritory, activity);
    await host.server.processInbox();
  };
  return {
    host,
    policy,
    documents,
    sendAsRegistry,
    close: async () => { await host.close(); await rm(directory, { recursive: true, force: true }); }
  };
}

test('policy Territory entry without evidence follows trustedRegistry', async (t) => {
  const otherRegistry = `${policyOrigin}/registries/other`;
  const cases: Array<{ name: string; list: AdmissionList; accepted: boolean }> = [
    { name: 'allowlist containing the Registry accepts', list: list('allowlist', [policyRegistry]), accepted: true },
    { name: 'empty allowlist rejects', list: list('allowlist', []), accepted: false },
    { name: 'denylist containing the Registry rejects', list: list('denylist', [], [policyRegistry]), accepted: false },
    { name: 'denylist omitting the Registry accepts', list: list('denylist', [], [otherRegistry]), accepted: true }
  ];

  for (const [index, item] of cases.entries()) {
    await t.test(item.name, async () => {
      const fixture = await policyFixture({ trustedRegistry: item.list });
      try {
        const request = policyEntry(`${policyOrigin}/requests/trusted-${index}`, `${policyOrigin}/objects/vessels/trusted-${index}`);
        fixture.documents.set(request.id, request);
        await fixture.sendAsRegistry(request as unknown as Record<string, unknown>);
        const decision = (await fixture.policy.ledger).decisions[request.id];
        assert.equal(decision?.accepted, item.accepted, JSON.stringify(decision));
      } finally {
        await fixture.close();
      }
    });
  }
});

test('policy Territory entry with exit evidence follows acceptedRegistry and acceptedTerritory', async () => {
  const fixture = await policyFixture({
    trustedRegistry: list('allowlist', []),
    acceptedRegistry: list('allowlist', [policyRegistry]),
    acceptedTerritory: list('allowlist', [])
  });
  try {
    const vessel = `${policyOrigin}/objects/vessels/returning`;
    const basis = policyEntry(`${policyOrigin}/requests/evidence-basis`, vessel);
    fixture.documents.set(basis.id, basis);
    const unsignedExit = {
      id: `${policyOrigin}/objects/exits/evidence`, type: 'ExitEvent',
      vessel, territory: policyTerritory, route: policyRoute,
      entryRequest: basis.id, cargo: { entries: [] }, effectiveAt: '2025-01-01T00:00:00.000Z'
    };
    const exit = await fixture.host.signObject('territory', unsignedExit as unknown as Record<string, unknown>) as unknown as Record<string, unknown>;
    fixture.documents.set(String(exit.id), exit);

    const cargo = { entries: [] } as CargoManifest;
    const evidence = String(exit.id);

    await fixture.policy.updateAdmissionPolicy({
      acceptedRegistry: list('allowlist', [policyRegistry]),
      acceptedTerritory: list('allowlist', [])
    });
    const emptyTerritory = policyEntry(`${policyOrigin}/requests/evidence-empty-territory`, vessel, cargo, evidence);
    await fixture.sendAsRegistry(emptyTerritory as unknown as Record<string, unknown>);
    assert.equal((await fixture.policy.ledger).decisions[emptyTerritory.id]?.accepted, false, 'empty acceptedTerritory rejects evidence entry');

    await fixture.policy.updateAdmissionPolicy({
      acceptedRegistry: list('denylist', [], [policyRegistry]),
      acceptedTerritory: list('allowlist', [policyTerritory])
    });
    const deniedRegistry = policyEntry(`${policyOrigin}/requests/evidence-denied-registry`, vessel, cargo, evidence);
    await fixture.sendAsRegistry(deniedRegistry as unknown as Record<string, unknown>);
    assert.equal((await fixture.policy.ledger).decisions[deniedRegistry.id]?.accepted, false, 'acceptedRegistry denylist rejects the Registry even with accepted Territory');

    await fixture.policy.updateAdmissionPolicy({
      acceptedRegistry: list('allowlist', [policyRegistry]),
      acceptedTerritory: list('allowlist', [policyTerritory])
    });
    const accepted = policyEntry(`${policyOrigin}/requests/evidence-accepted`, vessel, cargo, evidence);
    await fixture.sendAsRegistry(accepted as unknown as Record<string, unknown>);
    const acceptedDecision = (await fixture.policy.ledger).decisions[accepted.id];
    assert.equal(acceptedDecision?.accepted, true, `evidence entry is accepted when both accepted lists permit: ${JSON.stringify(acceptedDecision)}`);
  } finally {
    await fixture.close();
  }
});

const simulationConfig = () => ({
  commodities: simCommodity,
  commodityMasses: Object.fromEntries(Object.values(simCommodity).map((id) => [id, 1])),
  depositAmount: 10, miningCapacity: 4, miningEnabled: true, manufacturingSlots: 1,
  manufacturingTime: 2, portCapacity: 20, berthCapacity: 1
});

async function simulationFixture(trustedRegistry: AdmissionList) {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-admission-sim-'));
  const documents = new Map<string, unknown>();
  const fetcher: typeof fetch = async (input) => {
    const document = documents.get(String(input));
    return document === undefined
      ? new Response(null, { status: 404 })
      : new Response(JSON.stringify(document), { status: 200, headers: { 'Content-Type': 'application/ld+json' } });
  };
  const host = await createHost({
    origin: simOrigin,
    storeFile: join(directory, 'store.json'),
    actors: [{ name: 'registry', role: 'registry' }, { name: 'territory', role: 'territory' }],
    fetcher,
    resolveExpectedIssuer: async (_local, sender, activity) => simulationExpectedIssuer(sender, activity.object, simRegistry)
  });
  for (const name of ['registry', 'territory']) {
    documents.set(host.actor(name).id, host.actor(name));
    documents.set(String(host.key(name).publicKey.id), host.key(name).publicKey);
  }
  const sim = installSimulationTerritory(host, {
    territoryActor: 'territory',
    port: simPort,
    route: simRoute,
    config: simulationConfig(),
    acceptedRegistries: [],
    acceptedTerritories: [],
    trustedRegistry,
    fetcher,
    registryInbox: async () => `${simRegistry}/inbox` as URI,
    epoch: '2025-01-01T00:00:00.000Z',
    tickDurationMs: 1_000
  } as Parameters<typeof installSimulationTerritory>[1]);
  const sendAsRegistry = async (object: Record<string, unknown>): Promise<void> => {
    const activity = await host.sign('registry', {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://fctp.example/context'],
      id: `${String(object.id)}/activity`, type: 'Create', actor: simRegistry, object, to: [simTerritory]
    } as never);
    await host.server.receive(simTerritory, activity);
    await host.server.processInbox();
  };
  return {
    host,
    sim,
    sendAsRegistry,
    close: async () => { await host.close(); await rm(directory, { recursive: true, force: true }); }
  };
}

function simulationEntry(id: string, vessel: string): Record<string, unknown> {
  return {
    id, type: 'EntryRequest',
    vessel: { id: vessel, registry: simRegistry, possessor: `${simOrigin}/actors/player`, capacity: 10 },
    cargo: { entries: [] }, journey: { events: [] },
    destination: { territory: simTerritory, port: simPort, route: simRoute }
  };
}

test('simulation Territory entry without evidence follows trustedRegistry', async (t) => {
  const otherRegistry = `${simOrigin}/registries/other`;
  const cases: Array<{ name: string; list: AdmissionList; accepted: boolean }> = [
    { name: 'allowlist containing the Registry accepts', list: list('allowlist', [simRegistry]), accepted: true },
    { name: 'empty allowlist rejects', list: list('allowlist', []), accepted: false },
    { name: 'denylist containing the Registry rejects', list: list('denylist', [], [simRegistry]), accepted: false },
    { name: 'denylist omitting the Registry accepts', list: list('denylist', [], [otherRegistry]), accepted: true }
  ];

  for (const [index, item] of cases.entries()) {
    await t.test(item.name, async () => {
      const fixture = await simulationFixture(item.list);
      try {
        const request = simulationEntry(`${simOrigin}/requests/trusted-${index}`, `${simOrigin}/vessels/trusted-${index}`);
        await fixture.sendAsRegistry(request);
        const state = await fixture.sim.state();
        const decision = state.decisions.find((entry) => entry.request === request.id);
        assert.equal(decision?.accepted, item.accepted, JSON.stringify(decision));
      } finally {
        await fixture.close();
      }
    });
  }
});
