import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ActorIdentityRecord } from '@fctp/client-sdk';
import { createClientApplication, type ClientApplication } from '../apps/client-server/src/app.js';
import { startClientServer } from '../apps/demo/src/client-server.js';

const FIRST = 'identity-first.test:4200';
const SECOND = 'identity-second.test:4200';
const THIRD = 'identity-third.test:4200';
const FOURTH = 'identity-fourth.test:4200';
const FIFTH = 'identity-fifth.test:4200';
const SIXTH = 'identity-sixth.test:4200';
const DISCOVERY = 'identity-discovery.test:4200';

const FIRST_ACTOR = `https://${FIRST}/actors/sana`;
const SECOND_ACTOR = `https://${SECOND}/actors/orla`;
const MISSING_FINGER_ACTOR = `https://${THIRD}/actors/missing`;
const INVALID_FINGER_ACTOR = `https://${FOURTH}/actors/invalid`;
const SELF_MISMATCH_ACTOR = `https://${FIFTH}/actors/self`;
const SUBJECT_MISMATCH_ACTOR = `https://${SIXTH}/actors/subject`;
const FAILING_ACTOR = `https://${THIRD}/actors/unavailable`;
const DISCOVERED_ACTOR = `https://${FIRST}/actors/sana`;
const DISCOVERY_ORIGIN = `https://${DISCOVERY}`;

interface UpstreamCall {
  url: string;
  method: string;
  authorization: string;
  accept: string;
  body?: string;
}

interface Harness {
  application: ClientApplication;
  client: Awaited<ReturnType<typeof startClientServer>>;
  calls: UpstreamCall[];
  close(): Promise<void>;
}

interface ActorFixture {
  id: string;
  name: string;
  role?: string;
  published?: string;
  jrdSubject?: string;
  jrdSelf?: string;
  actorStatus?: number;
  fingerStatus?: number;
}

interface DiscoveryBody {
  servers?: Array<{ server?: string; origin?: string; authorities?: string[] }>;
  authorities?: Array<{ actorId?: string; roles?: string[]; name?: string }>;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function openHarness(
  storeFile: string,
  handler: (call: UpstreamCall) => Response | undefined | Promise<Response | undefined>
): Promise<Harness> {
  const calls: UpstreamCall[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = request ? request.url : String(input);
    const method = init?.method ?? request?.method ?? 'GET';
    const headers = new Headers(init?.headers ?? request?.headers);
    const call: UpstreamCall = {
      url,
      method,
      authorization: headers.get('authorization') ?? '',
      accept: headers.get('accept') ?? '',
      ...(typeof init?.body === 'string' ? { body: init.body } : {})
    };
    calls.push(call);
    return await handler(call) ?? json({ error: 'not-found' }, 404);
  };
  const application = await createClientApplication({ storeFile, fetch: fetcher, observationTimeoutMs: 2_000 });
  const client = await startClientServer({ port: 0, application });
  return {
    application,
    client,
    calls,
    close: async () => {
      await client.close();
      await application.close();
    }
  };
}

function fingerEndpointFor(address: string): string | undefined {
  if (!/^[^@\s]+@[^@\s]+$/.test(address)) return undefined;
  const server = address.slice(address.lastIndexOf('@') + 1);
  const endpoint = new URL('/.well-known/webfinger', `https://${server}`);
  endpoint.searchParams.set('resource', `acct:${address}`);
  return endpoint.href;
}

function identityHandler(fixtures: readonly ActorFixture[]) {
  return (call: UpstreamCall): Response | undefined => {
    const actor = fixtures.find((fixture) => fixture.id === call.url);
    if (actor !== undefined) {
      if (actor.actorStatus !== undefined && actor.actorStatus !== 200) return json({ error: 'actor-unavailable' }, actor.actorStatus);
      return json({
        id: actor.id,
        type: 'Person',
        name: actor.name,
        ...(actor.role === undefined ? {} : { role: actor.role }),
        ...(actor.published === undefined ? {} : { webfinger: actor.published })
      });
    }
    for (const fixture of fixtures) {
      if (fixture.published === undefined) continue;
      const endpoint = fingerEndpointFor(fixture.published);
      if (endpoint === undefined || endpoint !== call.url) continue;
      if (fixture.fingerStatus !== undefined && fixture.fingerStatus !== 200) return json({ error: 'finger-unavailable' }, fixture.fingerStatus);
      return json({
        subject: fixture.jrdSubject ?? `acct:${fixture.published}`,
        links: [{ rel: 'self', href: fixture.jrdSelf ?? fixture.id }]
      });
    }
    return undefined;
  };
}

function discoveryHandler(fixtures: readonly ActorFixture[], info: unknown) {
  const identity = identityHandler(fixtures);
  return (call: UpstreamCall): Response | undefined => {
    if (call.url === `${DISCOVERY_ORIGIN}/local/info`) return json(info);
    return identity(call);
  };
}

function embeddedIdentities(body: unknown): ActorIdentityRecord[] {
  const identities = (body as { identities?: unknown }).identities;
  assert.ok(Array.isArray(identities), 'expected a top-level identities array');
  return identities as ActorIdentityRecord[];
}

function identityById(records: readonly ActorIdentityRecord[], actorId: string): ActorIdentityRecord {
  const record = records.find((entry) => entry.actorId === actorId);
  assert.ok(record, `expected identity ${actorId}`);
  return record;
}

async function postServers(origin: string, body: unknown): Promise<Response> {
  return fetch(new URL('/api/servers', origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('identity resolution returns the verified handle, published name, and observation time', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-identities-verified-'));
  const storeFile = join(directory, 'client.store.json');
  const harness = await openHarness(storeFile, identityHandler([
    { id: FIRST_ACTOR, name: 'Sana', published: `sana@${FIRST}` }
  ]));
  try {
    const [record] = await harness.application.identities.resolve([FIRST_ACTOR]);
    assert.ok(record);
    assert.equal(record.actorId, FIRST_ACTOR);
    assert.equal(record.source, FIRST_ACTOR);
    assert.equal(record.state, 'available');
    assert.equal(record.verified, true);
    assert.equal(record.handle, `@sana@${FIRST}`);
    assert.equal(record.name, 'Sana');
    assert.equal(record.reason, undefined);
    assert.equal(record.error, undefined);
    assert.equal(typeof record.observedAt, 'string');

    assert.equal(harness.calls.length, 2, 'a verified identity needs one Actor and one WebFinger read');
    for (const call of harness.calls) {
      assert.equal(call.method, 'GET');
      assert.equal(call.authorization, '', 'identity resolution must not forward a credential upstream');
      assert.equal(call.body, undefined);
    }
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('unverified WebFinger outcomes stay explicitly unknown without a fabricated handle', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-identities-unverified-'));
  const storeFile = join(directory, 'client.store.json');
  const selfPublished = `self@${FIFTH}`;
  const subjectPublished = `subject@${SIXTH}`;
  const harness = await openHarness(storeFile, identityHandler([
    { id: MISSING_FINGER_ACTOR, name: 'Missing Finger' },
    { id: INVALID_FINGER_ACTOR, name: 'Invalid Finger', published: 'not-an-address' },
    { id: SELF_MISMATCH_ACTOR, name: 'Self Mismatch', published: selfPublished, jrdSelf: `https://${FIFTH}/actors/other` },
    { id: SUBJECT_MISMATCH_ACTOR, name: 'Subject Mismatch', published: subjectPublished, jrdSubject: `acct:other@${SIXTH}` }
  ]));
  try {
    const records = await harness.application.identities.resolve([
      MISSING_FINGER_ACTOR, INVALID_FINGER_ACTOR, SELF_MISMATCH_ACTOR, SUBJECT_MISMATCH_ACTOR
    ]);
    assert.equal(records.length, 4);

    const cases: Array<[string, string, string]> = [
      [MISSING_FINGER_ACTOR, 'Missing Finger', 'webfinger-not-published'],
      [INVALID_FINGER_ACTOR, 'Invalid Finger', 'webfinger-invalid'],
      [SELF_MISMATCH_ACTOR, 'Self Mismatch', 'webfinger-unverified'],
      [SUBJECT_MISMATCH_ACTOR, 'Subject Mismatch', 'webfinger-unverified']
    ];
    for (const [actorId, name, reason] of cases) {
      const record = identityById(records, actorId);
      assert.equal(record.source, actorId);
      assert.equal(record.state, 'empty');
      assert.equal(record.verified, false);
      assert.equal(record.reason, reason);
      assert.equal(record.handle, undefined, `${reason} must not fabricate a handle`);
      assert.equal(record.name, name, 'a published Actor name may be retained');
      assert.equal(record.error, undefined);
      assert.equal(typeof record.observedAt, 'string');
    }

    assert.equal(harness.calls.some((call) => call.method !== 'GET'), false);
    assert.equal(harness.calls.some((call) => call.authorization !== ''), false);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed re-resolution retains the prior verified identity as stale', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-identities-stale-'));
  const storeFile = join(directory, 'client.store.json');
  const fixture: ActorFixture = { id: FIRST_ACTOR, name: 'Sana', published: `sana@${FIRST}` };
  const harness = await openHarness(storeFile, identityHandler([fixture]));
  try {
    const [verified] = await harness.application.identities.resolve([FIRST_ACTOR]);
    assert.ok(verified);
    assert.equal(verified.state, 'available');
    assert.equal(verified.verified, true);
    assert.equal(typeof verified.observedAt, 'string');

    fixture.actorStatus = 500;
    const [stale] = await harness.application.identities.resolve([FIRST_ACTOR]);
    assert.ok(stale);
    assert.equal(stale.state, 'stale');
    assert.equal(stale.verified, true);
    assert.equal(stale.handle, verified.handle);
    assert.equal(stale.name, verified.name);
    assert.equal(stale.observedAt, verified.observedAt, 'a stale record keeps the prior observation time');
    assert.equal(typeof stale.error, 'string');
    assert.equal(stale.reason, undefined);

    const retained = identityById(await harness.application.identities.read(), FIRST_ACTOR);
    assert.equal(retained.state, 'stale');
    assert.equal(retained.handle, verified.handle);
    assert.equal(retained.observedAt, verified.observedAt);
    assert.equal(typeof retained.error, 'string');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a first resolution failure is unavailable without a handle or observation time', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-identities-unavailable-'));
  const storeFile = join(directory, 'client.store.json');
  const harness = await openHarness(storeFile, identityHandler([
    { id: FAILING_ACTOR, name: 'Unavailable', actorStatus: 503 }
  ]));
  try {
    const [record] = await harness.application.identities.resolve([FAILING_ACTOR]);
    assert.ok(record);
    assert.equal(record.source, FAILING_ACTOR);
    assert.equal(record.state, 'unavailable');
    assert.equal(record.verified, false);
    assert.equal(record.handle, undefined);
    assert.equal(record.observedAt, undefined);
    assert.equal(record.reason, undefined);
    assert.equal(typeof record.error, 'string');
    assert.equal(harness.calls.some((call) => call.url === FAILING_ACTOR), true);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a repeated resolution failure stays unavailable when no observation was retained', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-identities-repeat-failure-'));
  const storeFile = join(directory, 'client.store.json');
  const fixture: ActorFixture = { id: FAILING_ACTOR, name: 'Unavailable', actorStatus: 503 };
  const harness = await openHarness(storeFile, identityHandler([fixture]));
  try {
    const [firstRecord] = await harness.application.identities.resolve([FAILING_ACTOR]);
    assert.ok(firstRecord);
    assert.equal(firstRecord.state, 'unavailable');

    fixture.actorStatus = 500;
    const [record] = await harness.application.identities.resolve([FAILING_ACTOR]);
    assert.ok(record);
    assert.equal(record.state, 'unavailable', 'a failure without a retained observation must not become stale');
    assert.equal(record.verified, false);
    assert.equal(record.handle, undefined);
    assert.equal(record.observedAt, undefined);
    assert.equal(record.reason, undefined);
    assert.equal(typeof record.error, 'string');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a partial batch returns both the verified and the failed identity', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-identities-partial-'));
  const storeFile = join(directory, 'client.store.json');
  const harness = await openHarness(storeFile, identityHandler([
    { id: FIRST_ACTOR, name: 'Sana', published: `sana@${FIRST}` },
    { id: FAILING_ACTOR, name: 'Unavailable', actorStatus: 502 }
  ]));
  try {
    const records = await harness.application.identities.resolve([FIRST_ACTOR, FAILING_ACTOR]);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => record.actorId), [FIRST_ACTOR, FAILING_ACTOR]);
    assert.equal(identityById(records, FIRST_ACTOR).state, 'available');
    assert.equal(identityById(records, FIRST_ACTOR).handle, `@sana@${FIRST}`);
    assert.equal(identityById(records, FAILING_ACTOR).state, 'unavailable');
    assert.equal(typeof identityById(records, FAILING_ACTOR).error, 'string');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('repeated Actor IDs resolve once and keep first occurrence order', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-identities-dedupe-'));
  const storeFile = join(directory, 'client.store.json');
  const harness = await openHarness(storeFile, identityHandler([
    { id: FIRST_ACTOR, name: 'Sana', published: `sana@${FIRST}` },
    { id: SECOND_ACTOR, name: 'Orla', published: `orla@${SECOND}` }
  ]));
  try {
    const records = await harness.application.identities.resolve([SECOND_ACTOR, FIRST_ACTOR, SECOND_ACTOR, SECOND_ACTOR]);
    assert.deepEqual(records.map((record) => record.actorId), [SECOND_ACTOR, FIRST_ACTOR]);
    assert.equal(harness.calls.filter((call) => call.url === FIRST_ACTOR).length, 1);
    assert.equal(harness.calls.filter((call) => call.url === SECOND_ACTOR).length, 1);
    assert.equal(harness.calls.length, 4, 'duplicate Actor IDs share one Actor and one WebFinger read');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('retained identity records survive application restart without upstream calls', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-identities-retained-'));
  const storeFile = join(directory, 'client.store.json');
  const harness = await openHarness(storeFile, identityHandler([
    { id: FIRST_ACTOR, name: 'Sana', published: `sana@${FIRST}` },
    { id: SECOND_ACTOR, name: 'Orla', published: `orla@${SECOND}` }
  ]));
  let reopened: Harness | undefined;
  try {
    const resolved = await harness.application.identities.resolve([SECOND_ACTOR, FIRST_ACTOR]);
    assert.deepEqual(
      resolved.map((record) => record.actorId),
      [SECOND_ACTOR, FIRST_ACTOR],
      'resolution order follows first occurrence'
    );
    assert.deepEqual(
      (await harness.application.identities.read()).map((record) => record.actorId),
      [FIRST_ACTOR, SECOND_ACTOR],
      'retained reads are sorted by Actor ID'
    );

    await harness.close();
    reopened = await openHarness(storeFile, () => undefined);
    const retained = await reopened.application.identities.read();
    assert.deepEqual(
      retained.map((record) => record.actorId),
      [FIRST_ACTOR, SECOND_ACTOR]
    );
    assert.equal(reopened.calls.length, 0, 'a restarted retained read performs no upstream IO');
  } finally {
    await reopened?.close();
    if (reopened === undefined) await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('POST /api/servers embeds the verified identity of the discovered Actor', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-identities-discovery-'));
  const storeFile = join(directory, 'client.store.json');
  const fixtures: ActorFixture[] = [
    { id: DISCOVERED_ACTOR, name: 'Sana', role: 'territory', published: 'sana@identity-first.test' },
    { id: SECOND_ACTOR, name: 'Orla', published: `orla@${SECOND}` }
  ];
  const info = { actor: { territory: DISCOVERED_ACTOR }, ids: { actor: { territory: DISCOVERED_ACTOR } } };
  const harness = await openHarness(storeFile, discoveryHandler(fixtures, info));
  try {
    const response = await postServers(harness.client.origin, { origin: DISCOVERY_ORIGIN });
    assert.equal(response.status, 200);
    const body = await response.json() as DiscoveryBody;

    assert.equal(body.servers?.length, 1);
    assert.equal(body.servers?.[0]?.server, DISCOVERY);
    assert.equal(body.servers?.[0]?.origin, DISCOVERY_ORIGIN);
    assert.deepEqual(body.servers?.[0]?.authorities, [DISCOVERED_ACTOR]);
    assert.equal(body.authorities?.[0]?.actorId, DISCOVERED_ACTOR);
    assert.deepEqual(body.authorities?.[0]?.roles, ['territory']);

    const identities = embeddedIdentities(body);
    assert.equal(identities.length, 1, 'only Actors referenced by the response are embedded');
    const discovered = identityById(identities, DISCOVERED_ACTOR);
    assert.equal(discovered.state, 'available');
    assert.equal(discovered.verified, true);
    assert.equal(discovered.handle, '@sana@identity-first.test');
    assert.equal(discovered.name, 'Sana');
    assert.equal(typeof discovered.observedAt, 'string');
    assert.equal(identities.some((record) => record.actorId === SECOND_ACTOR), false, 'unrelated Actors get no embedded handle');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('GET /api/servers returns the retained embedded identity without upstream calls', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-identities-retained-read-'));
  const storeFile = join(directory, 'client.store.json');
  const fixture: ActorFixture = { id: DISCOVERED_ACTOR, name: 'Sana', role: 'territory', published: 'sana@identity-first.test' };
  const info = { actor: { territory: DISCOVERED_ACTOR }, ids: { actor: { territory: DISCOVERED_ACTOR } } };
  const harness = await openHarness(storeFile, discoveryHandler([fixture], info));
  try {
    const discovered = await postServers(harness.client.origin, { origin: DISCOVERY_ORIGIN });
    assert.equal(discovered.status, 200);
    assert.equal(embeddedIdentities(await discovered.json()).length, 1);
    const resolvedCalls = harness.calls.length;

    const response = await fetch(new URL('/api/servers', harness.client.origin));
    assert.equal(response.status, 200);
    const identities = embeddedIdentities(await response.json());
    assert.equal(identities.length, 1);
    const retained = identityById(identities, DISCOVERED_ACTOR);
    assert.equal(retained.state, 'available');
    assert.equal(retained.verified, true);
    assert.equal(retained.handle, '@sana@identity-first.test');
    assert.equal(harness.calls.length, resolvedCalls, 'a retained read performs no upstream IO');
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('GET /api/identities is removed', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-identities-get-removed-'));
  const storeFile = join(directory, 'client.store.json');
  const harness = await openHarness(storeFile, () => undefined);
  try {
    const response = await fetch(new URL('/api/identities', harness.client.origin));
    assert.equal(response.status, 404);
    assert.equal(harness.calls.length, 0);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('POST /api/identities is removed', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-identities-post-removed-'));
  const storeFile = join(directory, 'client.store.json');
  const harness = await openHarness(storeFile, () => undefined);
  try {
    const response = await fetch(new URL('/api/identities', harness.client.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorIds: [FIRST_ACTOR] })
    });
    assert.equal(response.status, 404);
    assert.equal(harness.calls.length, 0);
  } finally {
    await harness.close();
    await rm(directory, { recursive: true, force: true });
  }
});
