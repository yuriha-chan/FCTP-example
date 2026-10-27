import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalDocumentLoader, verifyKeyAttribution, verifyProofCryptography } from '@fctp/identity';
import { createBrowserSession, type BrowserSession, type TextView } from '../dist/apps/browser-harness/index.js';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';
import { createPolicyApp } from '../apps/territory-policy/src/app.js';
import { createSimulationApp } from '../apps/territory-sim/src/app.js';
import { startClientServer } from '../apps/demo/src/client-server.js';

const playerNames = ['player', 'player-2', 'player-3', 'player-4', 'player-5'];
const adminSecret = 'browser-authoring-isolated-admin';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function refFor(view: TextView, label: string, within?: string, occurrence = 0): string {
  const markdown = within === 'Player creations'
    ? view.markdown.split('# Player creations')[1]?.split('\n# ')[0] ?? ''
    : within ? view.markdown.split(`## ${within}`)[1]?.split('\n## ')[0] ?? '' : view.markdown;
  const matches = [...markdown.matchAll(new RegExp(`^.*(?:${escapeRegExp(label)})[\\s\\S]*?\\[([A-Za-z0-9-]+)\\](?: \\(disabled\\))?$`, 'gm'))];
  assert.ok(matches.length > occurrence, `Expected control ${occurrence + 1} labelled ${label}${within ? ` in ${within}` : ''}, found ${matches.length}`);
  return matches[occurrence]![1]!;
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function control(session: BrowserSession, view: TextView, label: string, operation: 'click' | 'submit' = 'click', within?: string, occurrence = 0): Promise<TextView> {
  return session[operation](refFor(view, label, within, occurrence));
}

async function formField(session: BrowserSession, view: TextView, label: string, value: string, within?: string, occurrence = 0): Promise<TextView> {
  return session.fill(refFor(view, label, within, occurrence), value);
}

async function login(session: BrowserSession, view: TextView, player: string, vessel: string, credential: string): Promise<TextView> {
  view = await session.select(refFor(view, 'Role'), 'player');
  view = await formField(session, view, 'Player URI', player);
  view = await formField(session, view, 'Vessel URI', vessel);
  view = await formField(session, view, 'Credential', credential);
  return control(session, view, 'Apply session', 'submit');
}

test('compiled browser authoring creates and verifies isolated Player creations through rendered forms', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-browser-authoring-'));
  const [authorityPort, policyPort, simulationPort, clientPort] = await Promise.all(Array.from({ length: 4 }, freePort));
  const origins = { authority: `http://127.0.0.1:${authorityPort}`, policy: `http://127.0.0.1:${policyPort}`, simulation: `http://127.0.0.1:${simulationPort}` };
  const services: {
    authority?: Awaited<ReturnType<typeof createAuthorityApp>>;
    policy?: Awaited<ReturnType<typeof createPolicyApp>>;
    simulation?: Awaited<ReturnType<typeof createSimulationApp>>;
    clientServer?: Awaited<ReturnType<typeof startClientServer>>;
  } = {};
  const sessions: BrowserSession[] = [];
  t.after(async () => {
    const results = await Promise.allSettled([
      ...sessions.map((session) => session.close()),
      ...(services.clientServer ? [services.clientServer.close()] : []),
      ...(services.simulation ? [services.simulation.host.close()] : []),
      ...(services.policy ? [services.policy.host.close()] : []),
      ...(services.authority ? [services.authority.authority.close()] : [])
    ]);
    await rm(directory, { recursive: true, force: true });
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Browser authoring fixture cleanup failed');
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
  const clientServer = services.clientServer;
  const adminHeaders = { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' };
  const nativeTokens = new Map<string, string>();
  for (const name of ['player-2', 'player-3']) {
    const response = await fetch(`${origins.authority}/local/home/issue`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ actor: authority.ids.players[name] }) });
    assert.equal(response.status, 200);
    nativeTokens.set(name, (await response.json() as { nativeToken: string }).nativeToken);
  }
  const player2 = authority.ids.players['player-2']!;
  const player3 = authority.ids.players['player-3']!;
  const vessel2 = authority.ids.vessels['player-2']!;
  const vessel3 = authority.ids.vessels['player-3']!;
  const session = await createBrowserSession({ url: clientServer.origin, allowedOrigins: [clientServer.origin, ...Object.values(origins)] });
  sessions.push(session);
  let view = await session.view();
  view = await login(session, view, player2, vessel2, nativeTokens.get('player-2')!);
  assert.match(view.markdown, /# Player creations/);
  assert.match(view.markdown, /Refresh my creations/);

  const sourceText = '<h1>Injected heading</h1>\n& literal text';
  view = await formField(session, view, 'Name', 'Literal text Asset', 'Player creations');
  view = await formField(session, view, 'Text', sourceText, 'Player creations');
  view = await control(session, view, 'Create Asset', 'submit');
  assert.match(view.markdown, /Literal text Asset/);
  const catalog2 = await authority.authoring.catalog(player2);
  assert.equal(catalog2.assets.length, 1);
  const asset = catalog2.assets[0]!;
  assert.equal(asset.creator?.[0], player2);
  assert.equal(asset.holder, player2);
  assert.match(view.markdown, /View text Asset/);
  view = await control(session, view, 'Fetch Asset');
  assert.match(view.markdown, /Type: Asset\./);
  assert.match(view.markdown, /Name: Literal text Asset\./);
  assert.match(view.markdown, /Technical addresses[\s\S]*objects\/players\/player-2\//);
  view = await control(session, view, 'Refresh my creations');
  view = await control(session, view, 'View text Asset');
  assert.ok(view.markdown.includes(sourceText));
  assert.doesNotMatch(view.markdown, /^# Injected heading$/m);

  view = await control(session, view, 'Refresh my creations');
  view = await formField(session, view, 'Name', 'Fractional variety', 'Player creations', 1);
  view = await formField(session, view, 'Mass', '2.75', 'Player creations');
  view = await formField(session, view, 'Version', '3.1', 'Player creations');
  view = await session.select(refFor(view, 'Optional own Asset', 'Player creations'), String(asset.id));
  view = await session.select(refFor(view, 'Production authoring mode', 'Player creations'), 'structured');
  view = await control(session, view, 'Add Production entry', 'click', 'Player creations');
  view = await session.select(refFor(view, 'Production kind', 'Player creations'), 'manufacture');
  view = await formField(session, view, 'Production time in ticks', '2', 'Player creations');
  view = await control(session, view, 'Add ingredient', 'click', 'Player creations');
  view = await formField(session, view, 'Variety URI', 'https://example.test/raw', 'Player creations');
  view = await formField(session, view, 'Count (Stack)', '3', 'Player creations');
  view = await formField(session, view, 'Data JSON object', '{"grade":"high"}', 'Player creations');
  view = await control(session, view, 'Add location', 'click', 'Player creations');
  view = await formField(session, view, 'Area ID URI', 'https://example.test/area', 'Player creations');
  view = await formField(session, view, 'Area name', 'Test Area', 'Player creations');
  view = await formField(session, view, 'Territory URI', 'https://example.test/territory', 'Player creations');
  view = await formField(session, view, 'Optional tool URI', 'https://example.test/tool', 'Player creations');
  view = await control(session, view, 'Add yield', 'click', 'Player creations');
  view = await formField(session, view, 'Probability', '0.75', 'Player creations');
  view = await formField(session, view, 'Count', '2', 'Player creations', 1);
  view = await control(session, view, 'Add Production entry', 'click', 'Player creations');
  view = await session.select(refFor(view, 'Production kind', 'Player creations', 1), 'mine');
  view = await formField(session, view, 'Production time in ticks', '4', 'Player creations', 1);
  view = await control(session, view, 'Add yield', 'click', 'Player creations', 1);
  view = await formField(session, view, 'Probability', '1.5', 'Player creations', 1);
  view = await formField(session, view, 'Count', '1', 'Player creations', 2);
  view = await formField(session, view, 'Data JSON object', '{"source":"second"}', 'Player creations', 2);
  const outboxBeforeFailure = await authority.authority.server.store.read((state) => state.outboxArchive.length);
  view = await formField(session, view, 'Data JSON object', '[]', 'Player creations', 1);
  view = await control(session, view, 'Create Variety', 'submit');
  assert.match(view.markdown, /data|object/i);
  assert.match(view.markdown, /Fractional variety/);
  assert.equal((await authority.authority.server.store.read((state) => state.outboxArchive.length)), outboxBeforeFailure);
  assert.equal((await authority.authoring.catalog(player2)).varieties.length, 0);

  view = await formField(session, view, 'Data JSON object', '{}', 'Player creations', 1);
  view = await control(session, view, 'Create Variety', 'submit');
  const privateCatalog = await authority.authoring.catalog(player2);
  assert.equal(privateCatalog.varieties.length, 1);
  assert.equal(privateCatalog.grants.length, 1);
  const variety = privateCatalog.varieties[0]!;
  const grant = privateCatalog.grants[0]!;
  assert.equal(variety.mass, 2.75);
  assert.equal(variety.holder, player2);
  assert.equal(variety.asset, asset.id);
  assert.deepEqual(variety.production, [
    { type: 'manufacture', duration: 2, tool: 'https://example.test/tool', ingredients: [{ variety: 'https://example.test/raw', count: 3, data: { grade: 'high' } }], location: [{ id: 'https://example.test/area', name: 'Test Area', territory: 'https://example.test/territory' }], yield: [{ probability: 0.75, count: 2, data: {} }] },
    { type: 'mine', duration: 4, yield: [{ probability: 1.5, count: 1, data: { source: 'second' } }] }
  ]);
  assert.equal(grant.asset, asset.id);
  assert.equal(grant.variety, variety.id);
  assert.equal(grant.grantee, player2);
  assert.match(view.markdown, /Fetch Variety/);
  assert.match(view.markdown, /Fetch Grant/);
  view = await control(session, view, 'Fetch Variety');
  assert.match(view.markdown, /Fractional variety/);
  view = await control(session, view, 'Refresh my creations');
  view = await control(session, view, 'Fetch Grant');
  assert.match(view.markdown, /Type: AssetGrant\./);
  view = await control(session, view, 'Refresh my creations');

  view = await session.select(refFor(view, 'Production authoring mode', 'Player creations'), 'advanced');
  const advancedProduction = [{ type: 'mine', duration: 0, yield: [{ probability: 1.5, count: 0, data: { unusual: true } }], extension: { retained: 'yes' } }];
  view = await formField(session, view, 'Advanced Production JSON array · authoritative while this mode is selected', JSON.stringify(advancedProduction), 'Player creations');
  view = await formField(session, view, 'Name', 'Advanced variety', 'Player creations', 1);
  view = await formField(session, view, 'Mass', '1', 'Player creations');
  view = await control(session, view, 'Create Variety', 'submit');
  const advancedVariety = (await authority.authoring.catalog(player2)).varieties[1]!;
  assert.deepEqual(advancedVariety.production, advancedProduction);

  const actor = await fetch(player2).then((response) => response.json());
  assert.equal(authority.authority.players['player-2']?.creations, actor.creations);
  const key = await fetch(`${origins.authority}/keys/player-2`).then((response) => response.json());
  const loader = createLocalDocumentLoader(new Map([[String(key.id), key]]));
  const verifiedObjects = [asset, variety, grant, advancedVariety];
  for (const object of verifiedObjects) {
    const retrieved = await fetch(String(object.id)).then((response) => response.json());
    if (retrieved.type === 'Variety' && retrieved.id === variety.id) assert.deepEqual(retrieved.production, variety.production);
    assert.equal((await verifyProofCryptography(retrieved, loader)).verified, true);
    const attribution = await verifyKeyAttribution(retrieved, actor, loader);
    assert.equal(attribution.attributed, true);
    assert.equal(attribution.controller, player2);
    if (retrieved.type === 'Asset' || retrieved.type === 'Variety') assert.equal(retrieved.holder, player2);
    if (retrieved.type === 'AssetGrant') {
      assert.equal(retrieved.grantee, player2);
      assert.equal(retrieved.asset, asset.id);
      assert.equal(retrieved.variety, variety.id);
    }
  }
  const mediaUri = (asset.media?.[0] as { url: string }).url;
  const mediaResponse = await fetch(mediaUri, { headers: { Accept: 'text/plain' } });
  assert.equal(mediaResponse.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await mediaResponse.text(), sourceText);
  const archived = await authority.authority.server.store.read((state) => state.outboxArchive);
  const activities = archived.map((entry) => entry.activity);
  assert.equal(activities.length, 4);
  for (const activity of activities) {
    assert.equal((await verifyProofCryptography(activity, loader)).verified, true);
    assert.equal((await verifyKeyAttribution(activity, actor, loader)).attributed, true);
  }
  const creations = await fetch(`${origins.authority}/objects/players/player-2/creations`).then((response) => response.json()) as { orderedItems: string[] };
  assert.equal(creations.orderedItems.length, 4);
  const outbox = await fetch(`${origins.authority}/actors/player-2/outbox`).then((response) => response.json()) as { totalItems: number };
  assert.equal(outbox.totalItems, 4);
  assert.equal(await authority.authority.server.store.read((state) => state.outbox.length), 0);

  view = await control(session, view, 'Refresh my creations');
  view = await formField(session, view, 'Text', 'private unsent draft', 'Player creations');
  view = await formField(session, view, 'Name', 'Private unsent name', 'Player creations', 1);
  view = await session.select(refFor(view, 'Production authoring mode', 'Player creations'), 'structured');
  view = await control(session, view, 'Add Production entry', 'click', 'Player creations');
  view = await control(session, view, 'Add ingredient', 'click', 'Player creations');
  view = await formField(session, view, 'Variety URI', 'https://example.test/private', 'Player creations');
  view = await session.select(refFor(view, 'Production authoring mode', 'Player creations'), 'advanced');
  view = await formField(session, view, 'Advanced Production JSON array · authoritative while this mode is selected', '[{"type":"mine","duration":3,"yield":[{"probability":1.5,"count":0,"data":{"extension":true}}],"extension":{"preserve":"yes"}}]', 'Player creations');
  view = await login(session, view, player3, vessel3, nativeTokens.get('player-3')!);
  assert.doesNotMatch(view.markdown, /Literal text Asset|Fractional variety|private unsent draft|Private unsent name|extension/);
  assert.match(view.markdown, /Name: {2}\[/);
  assert.match(view.markdown, /Text: {2}\[/);
  assert.match(view.markdown, /Optional own Asset: {2}\{\*None=/);
  view = await control(session, view, 'Refresh my creations');
  assert.equal((await authority.authoring.catalog(player3)).assets.length, 0);
  assert.equal((await authority.authoring.catalog(player3)).varieties.length, 0);

  view = await formField(session, view, 'Actor URI or WebFinger handle', player2);
  view = await control(session, view, 'Resolve Actor', 'submit');
  view = await control(session, view, 'Published Player creations');
  view = await control(session, view, 'Published Player creations');
  assert.equal(view.markdown.match(/^Asset text Literal text Asset \[/gm)?.length, 1, 'reloading a collection replaces the media button and its technical-address details');
  for (const object of [asset, variety, grant]) assert.ok(view.markdown.includes(String(object.id)), `Expected public creation ${object.id} in rendered resource result:\n${view.markdown}`);
  view = await control(session, view, 'Asset text Literal text Asset');
  assert.ok(view.markdown.includes(sourceText), `Expected Player-3 to read Player-2 Asset text:\n${view.markdown}`);
  assert.doesNotMatch(view.markdown, /^# Injected heading$/m);
  view = await formField(session, view, 'Resource URI', String(asset.id));
  assert.doesNotMatch(view.markdown, /Resource Server Actor URI override:.*https:\/\//, 'changing the URI clears any old manual audience');
  view = await control(session, view, 'Get resource');
  assert.match(view.markdown, /Name: Literal text Asset/, `Expected a pasted public Asset URL to load without an Actor override:\n${view.markdown}`);
  view = await formField(session, view, 'Resource URI', mediaUri);
  view = await control(session, view, 'Get resource');
  assert.ok(view.markdown.includes(sourceText), `Expected a pasted public text URL to load without an Actor override:\n${view.markdown}`);

  await authority.authority.server.store.transaction((state) => {
    const authoring = state.domain.authoring as { players?: Record<string, { assets?: Array<{ id: string; media?: Array<{ url: string; mediaType: string }> }> }> } | undefined;
    const stored = authoring?.players?.[player2]?.assets?.find((item) => item.id === asset.id);
    assert.ok(stored, 'Expected the authored Asset in the authority store');
    stored.media = [{ url: `${origins.authority}/objects/players/player-2/media/missing`, mediaType: 'text/plain' }];
  });
  view = await formField(session, view, 'Actor URI or WebFinger handle', player2);
  view = await control(session, view, 'Resolve Actor', 'submit');
  view = await control(session, view, 'Published Player creations');
  view = await control(session, view, 'Asset text Literal text Asset');
  assert.match(view.markdown, /Resource request failed: HTTP 404/, `Expected failed Asset text request to remain visible:\n${view.markdown}`);

  view = await session.select(refFor(view, 'Role'), 'authority-admin');
  view = await formField(session, view, 'Credential', adminSecret);
  view = await control(session, view, 'Apply session', 'submit');
  assert.doesNotMatch(view.markdown, /# Player creations|Create Asset|Create Variety|Refresh my creations/);
  assert.equal((await fetch(String(asset.id)).then((response) => response.status)), 200);
  assert.equal((await fetch(String(variety.id)).then((response) => response.status)), 200);
});
