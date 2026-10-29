import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveDiplomaticToken, encodeNativeToken, type HomeLoginRequest, type HomeLoginResult } from '@fctp/auth';
import { generateActorKey, createLocalDocumentLoader, parseHandle, resolveWebFinger, signJsonLd, webFingerSubject, withDocuments } from '@fctp/identity';
import { actionIsComplete, FctpClient, observationIsCurrent, resourceAudience as sdkResourceAudience, toPublicAccount, type AccountRecord, type AccountScopedRequest, type ActionRecord, type AuthorityRecord, type PageResponse, type ServerRecord } from '@fctp/client-sdk';
import { ResourceError } from '@fctp/resources';
import type { URI } from '@fctp/protocol';
import { verifyExit } from '../apps/client/src/proof.js';
import { formatActor, formatAuthoringEntry, formatResource } from '../apps/client/src/presentation.js';
import { identityDisplay, technicalAddresses } from '../apps/client/src/identity-display.js';

const territoryId = 'https://territory.test/actors/blue';
const registryId = 'https://registry.test/actors/main';
const vesselId = 'https://registry.test/vessels/1';
const entryId = 'https://registry.test/requests/1';
const exitId = 'https://territory.test/events/exit/1';

test('handle parsing separates account and authority identities with explicit server ports', () => {
  assert.deepEqual(parseHandle('@sana-okonkwo@harbor.test:4200'), {
    handle: '@sana-okonkwo@harbor.test:4200', localName: 'sana-okonkwo', server: 'harbor.test:4200', kind: 'account'
  });
  assert.deepEqual(parseHandle('@orla.home@harbor.test:4200'), {
    handle: '@orla.home@harbor.test:4200', localName: 'orla', server: 'harbor.test:4200', kind: 'authority', role: 'home'
  });
  assert.deepEqual(parseHandle('@orla.registry@other.test:4200'), {
    handle: '@orla.registry@other.test:4200', localName: 'orla', server: 'other.test:4200', kind: 'authority', role: 'registry'
  });
});

test('handle parsing rejects missing names, ambiguous separators, and invalid server ports', () => {
  for (const invalid of ['name@harbor.test', '@name@', '@@harbor.test', '@name@harbor.test/path', '@name@harbor.test:0', '@name@harbor.test:65536', '@name@harbor.test:nope', '@one.two.three@harbor.test', '@one@@harbor.test']) {
    assert.throws(() => parseHandle(invalid), { name: 'TypeError' }, invalid);
  }
});

test('an accepted action is complete only after its outcome has observed evidence', () => {
  const record: ActionRecord = {
    id: 'action-1', accountId: '@sana@home.test:4200', targetId: 'https://territory.test/actors/one',
    statusUrl: '/api/activity/action-1', resultReferences: [{ kind: 'job', id: 'job-1' }],
    intent: { kind: 'mine', inputs: { count: 1 } }, submittedAt: '2026-10-29T12:00:00Z',
    submission: { status: 'accepted', result: 'job-1' },
    outcome: { status: 'pending', evidence: [] }
  };
  assert.equal(actionIsComplete(record), false);
  assert.equal(record.statusUrl, '/api/activity/action-1');
  assert.deepEqual(record.resultReferences, [{ kind: 'job', id: 'job-1' }]);
  assert.equal(actionIsComplete({ ...record, outcome: { status: 'unverified', evidence: [] } }), false);
  assert.equal(actionIsComplete({ ...record, outcome: { status: 'completed', evidence: [] } }), false);
  assert.equal(actionIsComplete({ ...record, outcome: { status: 'completed', evidence: [{ source: 'https://territory.test/state', observedAt: '2026-10-29T12:01:00Z' }] } }), true);
  assert.equal(actionIsComplete({ ...record, submission: { status: 'rejected', error: 'no inputs' }, outcome: { status: 'failed', evidence: [] } }), false);
  assert.equal(actionIsComplete({ ...record, submission: { status: 'unverified' }, outcome: { status: 'unverified', evidence: [] } }), false);
});

test('only available or empty sourced observations are current prerequisites', () => {
  const source = 'https://territory.test/state';
  const observedAt = '2026-10-29T12:00:00Z';
  assert.equal(observationIsCurrent({ state: 'available', source, observedAt, value: { stock: 1 } }), true);
  assert.equal(observationIsCurrent({ state: 'empty', source, observedAt, value: [] }), true);
  assert.equal(observationIsCurrent({ state: 'not-retrieved', source }), false);
  assert.equal(observationIsCurrent({ state: 'stale', source, observedAt, value: { stock: 1 } }), false);
  assert.equal(observationIsCurrent({ state: 'unavailable', source, error: 'timed out' }), false);
});

test('public account responses retain distinct home identities without exposing native credentials', () => {
  const first: AccountRecord = {
    id: '@sana@first.test:4200', handle: '@sana@first.test:4200', homeServer: 'first.test:4200',
    homeAuthority: 'https://first.test:4200/actors/home', actorId: 'https://first.test:4200/actors/sana',
    login: { status: 'signed-in', homeServer: 'first.test:4200', nativeToken: 'private-native-token', expiresAt: '2026-11-01T00:00:00Z' }
  };
  const second: AccountRecord = { ...first, id: '@sana@second.test:4200', handle: '@sana@second.test:4200', homeServer: 'second.test:4200', homeAuthority: 'https://second.test:4200/actors/home', actorId: 'https://second.test:4200/actors/sana', login: { status: 'signed-out' } };
  const publicFirst = toPublicAccount(first);
  const publicSecond = toPublicAccount(second);
  assert.notEqual(publicFirst.id, publicSecond.id);
  assert.equal(publicFirst.homeServer, 'first.test:4200');
  assert.equal(publicSecond.login.status, 'signed-out');
  assert.deepEqual(publicFirst.login, { status: 'signed-in', expiresAt: '2026-11-01T00:00:00Z' });
  assert.equal(JSON.stringify(publicFirst).includes('private-native-token'), false);
});

test('a page references retained authorities and describes sourced action prerequisites', () => {
  const server: ServerRecord = { server: 'harbor.test:4200', origin: 'https://harbor.test:4200', authorities: ['https://harbor.test:4200/actors/registry'] };
  const authority: AuthorityRecord = {
    handle: '@harbor.registry@harbor.test:4200', actorId: server.authorities[0]!, server: server.server, roles: ['registry']
  };
  const page: PageResponse<{ vesselId: string; authorityId: string }> = {
    context: { accountId: '@sana@harbor.test:4200', vesselId: 'vessel-1' },
    data: { vesselId: 'vessel-1', authorityId: authority.actorId },
    observations: {
      cargo: { state: 'available', source: 'https://harbor.test:4200/local/registry/state', observedAt: '2026-10-29T12:00:00Z', value: { entries: [] } },
      visit: { state: 'not-retrieved', source: 'https://territory.test/local/state' }
    },
    actions: [{ id: 'request-entry', label: 'Request entry', endpoint: '/api/logistics/vessels/vessel-1/entry-requests', method: 'POST', targetId: authority.actorId, inputs: [{ name: 'port', required: true }], blockers: ['Refresh destination visit'], expectedResult: 'EntryRequest' }]
  };
  assert.equal(page.data.authorityId, authority.actorId);
  assert.equal(observationIsCurrent(page.observations.cargo!), true);
  assert.equal(observationIsCurrent(page.observations.visit!), false);
  assert.equal(page.actions[0]!.targetId, server.authorities[0]);
  const read: AccountScopedRequest<{ vesselId: string }> = { accountId: page.context.accountId!, vesselId: page.data.vesselId };
  const action: AccountScopedRequest<{ port: string }> = { accountId: read.accountId, port: 'https://territory.test/ports/east' };
  assert.equal(action.accountId, read.accountId);
});

test('Home login contracts distinguish issued credentials from rejected and unavailable accounts', async () => {
  const request: HomeLoginRequest = { handle: '@sana@home.test:4200', password: 'test-secret' };
  assert.equal(request.handle, '@sana@home.test:4200');
  const issued: HomeLoginResult = { status: 'signed-in', handle: request.handle, actorId: 'https://home.test:4200/actors/sana', nativeToken: encodeNativeToken(new Uint8Array(32).fill(9)) };
  const rejected: HomeLoginResult = { status: 'rejected', handle: request.handle, reason: 'Invalid credentials' };
  const unavailable: HomeLoginResult = { status: 'unavailable', handle: request.handle, reason: 'Account unavailable' };
  if (issued.status !== 'signed-in') throw new Error('Expected issued credentials');
  assert.equal(typeof await deriveDiplomaticToken(issued.nativeToken, 'https://territory.test/actors/one'), 'string');
  assert.equal(rejected.status, 'rejected');
  assert.equal(unavailable.status, 'unavailable');
  assert.equal('nativeToken' in rejected, false);
  assert.equal('nativeToken' in unavailable, false);
});

test('SDK Home login posts credentials to the Home origin and returns the issued identity without retaining tokens', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const nativeToken = encodeNativeToken(new Uint8Array(32).fill(3));
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Response.json({ status: 'signed-in', handle: '@alice@home.test:4200', actorId: 'https://home.test:4200/actors/alice', nativeToken });
  };
  const client = new FctpClient({ fetcher });
  const result = await client.login({ handle: '@alice@home.test:4200', password: 'alice-login-secret' }, 'https://home.test:4200');
  assert.equal(result.status, 'signed-in');
  if (result.status !== 'signed-in') throw new Error('Expected a signed-in login result');
  assert.equal(result.actorId, 'https://home.test:4200/actors/alice');
  assert.equal(result.nativeToken, nativeToken);
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(new URL(request.url).pathname, '/local/home/login');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.url.includes('alice-login-secret'), false);
  assert.deepEqual(JSON.parse(String(request.init.body)), { handle: '@alice@home.test:4200', password: 'alice-login-secret' });
});

test('SDK Home login reports rejected credentials without returning or requesting token material', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Response.json({ status: 'rejected', handle: '@alice@home.test:4200', reason: 'invalid-credentials' }, { status: 401 });
  };
  const client = new FctpClient({ fetcher });
  const result = await client.login({ handle: '@alice@home.test:4200', password: 'wrong-secret' }, 'https://home.test:4200');
  assert.equal(result.status, 'rejected');
  assert.equal(Object.hasOwn(result, 'nativeToken'), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url.includes('wrong-secret'), false);
});

test('SDK Home login maps an unavailable account response without issuing credentials', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Response.json({ status: 'unavailable', handle: '@alice@home.test:4200', reason: 'account-unavailable' }, { status: 401 });
  };
  const client = new FctpClient({ fetcher });
  const result = await client.login({ handle: '@alice@home.test:4200', password: 'alice-login-secret' }, 'https://home.test:4200');
  assert.equal(result.status, 'unavailable');
  assert.equal(Object.hasOwn(result, 'nativeToken'), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url.includes('alice-login-secret'), false);
});

test('SDK public-first reads JSON and text without Authorization even when credentials are supplied', async () => {
  const nativeToken = encodeNativeToken(new Uint8Array(32).fill(5));
  const resourceServer: URI = 'https://resource.test/actors/main';
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return String(input).endsWith('/readme')
      ? new Response('public text', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
      : Response.json({ id: 'https://resource.test/objects/asset', name: 'Public asset' });
  };
  const client = new FctpClient({ fetcher });
  let audienceCalls = 0;
  const resolveAudience = async (): Promise<URI> => {
    audienceCalls++;
    throw new Error('a successful public read must not resolve an audience');
  };
  const asset = await client.getPublicFirst<{ id: string; name: string }>('https://resource.test/objects/asset', { nativeToken, resourceServer, resolveAudience });
  const text = await client.getPublicFirst<string>('https://resource.test/objects/readme', { nativeToken, resourceServer, accept: 'text/plain', resolveAudience });
  assert.equal(asset.name, 'Public asset');
  assert.equal(text, 'public text');
  assert.equal(audienceCalls, 0);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(new Headers(call.init.headers).has('Authorization'), false);
  assert.equal(new Headers(calls[1]!.init.headers).get('Accept'), 'text/plain');
});

test('SDK public-first retries only after an authentication response with the exact target Actor audience', async () => {
  const nativeToken = encodeNativeToken(new Uint8Array(32).fill(7));
  const resourceServer: URI = 'https://resource.test/actors/territory';
  const expected = await deriveDiplomaticToken(nativeToken, resourceServer);
  for (const status of [401, 403]) {
    let calls = 0;
    let audienceCalls = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      calls++;
      const authorization = new Headers(init?.headers).get('Authorization');
      if (calls === 1) {
        assert.equal(authorization, null);
        return new Response(null, { status });
      }
      assert.equal(authorization, `Bearer ${expected}`);
      return Response.json({ value: 'permitted' });
    };
    const client = new FctpClient({ fetcher });
    const result = await client.getPublicFirst<{ value: string }>('https://resource.test/objects/private', {
      nativeToken,
      resourceServer,
      resolveAudience: async () => { audienceCalls++; throw new Error('an explicit audience must bypass lazy resolution'); }
    });
    assert.equal(result.value, 'permitted');
    assert.equal(audienceCalls, 0);
    assert.equal(calls, 2);
  }
});

test('SDK public-first resolves a lazy audience once after a challenge and retries with the exact derived token', async () => {
  const nativeToken = encodeNativeToken(new Uint8Array(32).fill(11));
  const resourceServer: URI = 'https://resource.test/actors/territory';
  const expected = await deriveDiplomaticToken(nativeToken, resourceServer);
  for (const status of [401, 403]) {
    let calls = 0;
    let audienceCalls = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      calls++;
      const authorization = new Headers(init?.headers).get('Authorization');
      if (calls === 1) {
        assert.equal(authorization, null);
        return new Response(null, { status });
      }
      assert.equal(authorization, `Bearer ${expected}`);
      return Response.json({ value: 'resolved' });
    };
    const client = new FctpClient({ fetcher });
    const result = await client.getPublicFirst<{ value: string }>('https://resource.test/objects/private', {
      nativeToken,
      resolveAudience: async () => { audienceCalls++; return resourceServer; }
    });
    assert.equal(result.value, 'resolved');
    assert.equal(audienceCalls, 1);
    assert.equal(calls, 2);
  }
});

test('SDK public-first stops after one request when lazy audience resolution is absent or fails', async () => {
  const nativeToken = encodeNativeToken(new Uint8Array(32).fill(12));
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    return new Response(null, { status: 401 });
  };
  const client = new FctpClient({ fetcher });
  let audienceCalls = 0;
  await assert.rejects(
    client.getPublicFirst('https://resource.test/objects/private', {
      nativeToken,
      resolveAudience: async () => { audienceCalls++; return undefined; }
    }),
    /audience|resourceServer|identif/i
  );
  assert.equal(audienceCalls, 1);
  assert.equal(calls, 1);

  calls = 0;
  audienceCalls = 0;
  await assert.rejects(
    client.getPublicFirst('https://resource.test/objects/private', {
      nativeToken,
      resolveAudience: async () => { audienceCalls++; throw new Error('audience lookup failed'); }
    }),
    /audience lookup failed/
  );
  assert.equal(audienceCalls, 1);
  assert.equal(calls, 1);
});

test('SDK public-first propagates an authenticated retry failure without another request', async () => {
  const nativeToken = encodeNativeToken(new Uint8Array(32).fill(13));
  const resourceServer: URI = 'https://resource.test/actors/territory';
  for (const status of [401, 403, 500]) {
    let calls = 0;
    let audienceCalls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return calls === 1 ? new Response(null, { status: 401 }) : new Response(null, { status });
    };
    const client = new FctpClient({ fetcher });
    await assert.rejects(
      client.getPublicFirst('https://resource.test/objects/private', {
        nativeToken,
        resolveAudience: async () => { audienceCalls++; return resourceServer; }
      }),
      (error: unknown) => error instanceof ResourceError && error.status === status
    );
    assert.equal(audienceCalls, 1);
    assert.equal(calls, 2);
  }
});

test('SDK public-first reports a missing resource audience instead of inventing one', async () => {
  const nativeToken = encodeNativeToken(new Uint8Array(32).fill(8));
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    return new Response(null, { status: 401 });
  };
  const client = new FctpClient({ fetcher });
  await assert.rejects(client.getPublicFirst('https://resource.test/objects/private', { nativeToken }), /audience|resourceServer/i);
  assert.ok(calls <= 1, 'without an audience the client must not retry');
});

test('SDK public-first reports an authentication requirement without resolving or retrying when no nonempty native token is available', async () => {
  const resourceServer: URI = 'https://resource.test/actors/territory';
  for (const nativeToken of [undefined, '']) {
    let calls = 0;
    let audienceCalls = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      return new Response(null, { status: 401 });
    };
    const client = new FctpClient({ fetcher });
    const options = {
      resourceServer,
      ...(nativeToken === undefined ? {} : { nativeToken }),
      resolveAudience: async (): Promise<URI> => { audienceCalls++; return resourceServer; }
    };
    await assert.rejects(
      client.getPublicFirst('https://resource.test/objects/private', options),
      (error: unknown) => error instanceof ResourceError && error.status === 401 && error.code === 'unauthorized'
    );
    assert.equal(audienceCalls, 0);
    assert.equal(calls, 1);
  }
});

test('SDK public-first reports other HTTP failures as ResourceError without retry', async () => {
  for (const status of [404, 500]) {
    let calls = 0;
    let audienceCalls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return new Response(null, { status });
    };
    const client = new FctpClient({ fetcher });
    await assert.rejects(
      client.getPublicFirst('https://resource.test/objects/missing', {
        nativeToken: encodeNativeToken(new Uint8Array(32).fill(9)),
        resourceServer: 'https://resource.test/actors/territory' as URI,
        resolveAudience: async () => { audienceCalls++; throw new Error('a non-authentication failure must not resolve an audience'); }
      }),
      (error: unknown) => error instanceof ResourceError && error.status === status
    );
    assert.equal(audienceCalls, 0);
    assert.equal(calls, 1);
  }
});

test('SDK public-first derives distinct diplomatic tokens for distinct accounts and resource Actors', async () => {
  const alice = encodeNativeToken(new Uint8Array(32).fill(1));
  const bob = encodeNativeToken(new Uint8Array(32).fill(2));
  const actorOne: URI = 'https://one.test/actors/territory';
  const actorTwo: URI = 'https://two.test/actors/territory';
  const expected = {
    aliceOne: await deriveDiplomaticToken(alice, actorOne),
    aliceTwo: await deriveDiplomaticToken(alice, actorTwo),
    bobOne: await deriveDiplomaticToken(bob, actorOne)
  };
  async function authorizationFor(nativeToken: string, resourceServer: URI): Promise<string> {
    let authorization = '';
    const fetcher: typeof fetch = async (_input, init) => {
      const header = new Headers(init?.headers).get('Authorization');
      if (!header) return new Response(null, { status: 401 });
      authorization = header;
      return Response.json({ ok: true });
    };
    await new FctpClient({ fetcher }).getPublicFirst('https://resource.test/objects/private', { nativeToken, resourceServer });
    return authorization;
  }
  assert.equal(await authorizationFor(alice, actorOne), `Bearer ${expected.aliceOne}`);
  assert.equal(await authorizationFor(alice, actorTwo), `Bearer ${expected.aliceTwo}`);
  assert.equal(await authorizationFor(bob, actorOne), `Bearer ${expected.bobOne}`);
  assert.notEqual(expected.aliceOne, expected.aliceTwo);
  assert.notEqual(expected.aliceOne, expected.bobOne);
});

test('SDK resource audience prefers an explicit Actor over linked and known Actor candidates', () => {
  const uri = 'https://resource.test/objects/one';
  assert.equal(sdkResourceAudience(uri, 'https://explicit.test/actors/one', new Map([[uri, 'https://linked.test/actors/one']]), ['https://resource.test/actors/known']), 'https://explicit.test/actors/one');
  assert.equal(sdkResourceAudience(uri, 'https://explicit.test/actors/one', new Map(), []), 'https://explicit.test/actors/one');
});

test('SDK resource audience uses a single linked provenance Actor before origin matching', () => {
  const uri = 'https://resource.test/objects/one';
  assert.equal(sdkResourceAudience(uri, '', new Map([[uri, 'https://linked.test/actors/one']]), ['https://resource.test/actors/known']), 'https://linked.test/actors/one');
  assert.equal(sdkResourceAudience(uri, '', new Map([[uri, new Set(['https://linked.test/actors/two'])]]), ['https://resource.test/actors/known']), 'https://linked.test/actors/two');
});

test('SDK resource audience rejects multiple linked provenance Actors', () => {
  const uri = 'https://resource.test/objects/one';
  assert.throws(() => sdkResourceAudience(uri, '', new Map([[uri, new Set(['https://actors.test/a', 'https://actors.test/b'])]]), ['https://actors.test/a']), /multiple/i);
});

test('SDK resource audience uses one known Actor on the resource origin', () => {
  const uri = 'https://resource.test/objects/one';
  assert.equal(sdkResourceAudience(uri, '', new Map(), ['https://other.test/actors/other', 'https://resource.test/actors/known', 'https://resource.test/actors/known']), 'https://resource.test/actors/known');
});

test('SDK resource audience rejects unknown and ambiguous resource origins', () => {
  const uri = 'https://resource.test/objects/one';
  assert.throws(() => sdkResourceAudience(uri, '', new Map(), []), /identif/i);
  assert.throws(() => sdkResourceAudience(uri, '', new Map(), ['https://other.test/actors/one']), /identif/i);
  assert.throws(() => sdkResourceAudience(uri, '', new Map(), ['https://resource.test/actors/one', 'https://resource.test/actors/two']), /ambiguous/i);
});

test('SDK collection reads URI references, id-only references, and retains inline objects', async () => {
  const collection = 'https://resource.test/collections/items';
  const stringRef = 'https://resource.test/objects/string';
  const idRef = 'https://resource.test/objects/id';
  const inline = { id: 'https://resource.test/objects/inline', name: 'Inline', nested: { value: 1 } };
  const documents = new Map<string, unknown>([
    [collection, { id: collection, type: 'OrderedCollection', orderedItems: [stringRef, { id: idRef }, inline] }],
    [stringRef, { id: stringRef, name: 'String reference' }],
    [idRef, { id: idRef, name: 'Id reference' }]
  ]);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return documents.has(url) ? Response.json(documents.get(url)) : new Response(null, { status: 404 });
  };
  const items = await new FctpClient({ fetcher }).readCollection<Record<string, unknown>>(collection as URI, 'https://resource.test/actors/territory' as URI);
  assert.deepEqual(items.map((item) => item.name), ['String reference', 'Id reference', 'Inline']);
  assert.deepEqual(items[2], inline);
  assert.deepEqual(calls, [collection, stringRef, idRef]);
});

test('SDK collection follows next page URIs and id-only page references', async () => {
  const first = 'https://resource.test/collections/first';
  const second = 'https://resource.test/collections/second';
  const third = 'https://resource.test/collections/third';
  const documents = new Map<string, unknown>([
    [first, { items: [{ id: 'https://resource.test/objects/a', name: 'A' }], next: second }],
    [second, { items: [{ id: 'https://resource.test/objects/b', name: 'B' }], next: { id: third } }],
    [third, { orderedItems: [{ id: 'https://resource.test/objects/c', name: 'C' }] }]
  ]);
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return documents.has(url) ? Response.json(documents.get(url)) : new Response(null, { status: 404 });
  };
  const items = await new FctpClient({ fetcher }).readCollection<Record<string, unknown>>(first as URI, 'https://resource.test/actors/territory' as URI);
  assert.deepEqual(items.map((item) => item.name), ['A', 'B', 'C']);
  assert.deepEqual(calls, [first, second, third]);
});

test('SDK collection never sends Authorization for public pages or items even with a token', async () => {
  const nativeToken = encodeNativeToken(new Uint8Array(32).fill(4));
  const resourceServer = 'https://resource.test/actors/territory' as URI;
  const collection = 'https://resource.test/collections/public';
  const item = 'https://resource.test/objects/public';
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
    return url === collection
      ? Response.json({ orderedItems: [{ id: item }] })
      : Response.json({ id: item, name: 'Public' });
  };
  const items = await new FctpClient({ fetcher }).readCollection<Record<string, unknown>>(collection as URI, resourceServer, nativeToken);
  assert.deepEqual(items.map((item) => item.name), ['Public']);
  assert.deepEqual(calls.map((call) => call.url), [collection, item]);
  for (const call of calls) assert.equal(call.authorization, null);
});

test('SDK collection retries authentication-required pages and items with the resource Actor token', async () => {
  const nativeToken = encodeNativeToken(new Uint8Array(32).fill(6));
  const resourceServer = 'https://resource.test/actors/territory' as URI;
  const expected = `Bearer ${await deriveDiplomaticToken(nativeToken, resourceServer)}`;
  for (const status of [401, 403]) {
    const collection = `https://resource.test/collections/protected-${status}`;
    const item = `https://resource.test/objects/protected-${status}`;
    let collectionCalls = 0;
    let itemCalls = 0;
    const authorization: Array<string | null> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const header = new Headers(init?.headers).get('Authorization');
      if (String(input) === collection) {
        collectionCalls++;
        authorization.push(header);
        if (collectionCalls === 1) {
          assert.equal(header, null);
          return new Response(null, { status });
        }
        assert.equal(header, expected);
        return Response.json({ orderedItems: [{ id: item }] });
      }
      if (String(input) === item) {
        itemCalls++;
        authorization.push(header);
        if (itemCalls === 1) {
          assert.equal(header, null);
          return new Response(null, { status });
        }
        assert.equal(header, expected);
        return Response.json({ id: item, name: 'Protected' });
      }
      return new Response(null, { status: 404 });
    };
    const items = await new FctpClient({ fetcher }).readCollection<Record<string, unknown>>(collection as URI, resourceServer, nativeToken);
    assert.deepEqual(items.map((item) => item.name), ['Protected']);
    assert.equal(collectionCalls, 2);
    assert.equal(itemCalls, 2);
    assert.deepEqual(authorization, [null, expected, null, expected]);
  }
});

test('SDK collection rejects unsupported item shapes', async () => {
  const collection = 'https://resource.test/collections/unsupported';
  for (const item of [42, true, null, ['https://resource.test/objects/array']]) {
    const fetcher: typeof fetch = async () => Response.json({ items: [item] });
    await assert.rejects(
      new FctpClient({ fetcher }).readCollection(collection as URI, 'https://resource.test/actors/territory' as URI),
      { name: 'TypeError' }
    );
  }
});

test('SDK collection propagates failed page and item reads', async () => {
  const resourceServer = 'https://resource.test/actors/territory' as URI;
  const missing = 'https://resource.test/collections/missing';
  await assert.rejects(
    new FctpClient({ fetcher: async () => new Response(null, { status: 404 }) }).readCollection(missing as URI, resourceServer),
    (error: unknown) => error instanceof ResourceError && error.status === 404
  );
  const collection = 'https://resource.test/collections/items';
  const brokenItem = 'https://resource.test/objects/broken';
  const fetcher: typeof fetch = async (input) => String(input) === collection
    ? Response.json({ orderedItems: [brokenItem] })
    : new Response(null, { status: 500 });
  await assert.rejects(
    new FctpClient({ fetcher }).readCollection(collection as URI, resourceServer),
    (error: unknown) => error instanceof ResourceError && error.status === 500
  );
});

test('SDK collection rejects pagination loops instead of hanging', { timeout: 1000 }, async () => {
  const first = 'https://resource.test/collections/loop-a';
  const second = 'https://resource.test/collections/loop-b';
  const fetcher: typeof fetch = async (input) => String(input) === first
    ? Response.json({ items: [], next: second })
    : Response.json({ items: [], next: { id: first } });
  await assert.rejects(
    new FctpClient({ fetcher }).readCollection(first as URI, 'https://resource.test/actors/territory' as URI),
    /loop|pagination/i
  );
});

async function fixture() {
  const key = await generateActorKey(territoryId);
  const keyId = String(key.publicKey.id);
  const loader = withDocuments(createLocalDocumentLoader(), new Map([[keyId, key.publicKey]]));
  const exit = await signJsonLd({
    '@context': 'https://www.w3.org/ns/activitystreams', id: exitId, type: 'ExitEvent',
    vessel: vesselId, territory: territoryId, route: 'https://territory.test/routes/1',
    entryRequest: entryId, cargo: { entries: [] }, effectiveAt: '2026-01-01T00:00:00Z'
  }, key.keyPair, loader);
  const actor = { id: territoryId, type: 'Actor', publicKeys: [keyId] };
  const entry = {
    id: entryId, type: 'EntryRequest',
    vessel: { id: vesselId, registry: registryId },
    destination: { territory: territoryId }
  };
  const documents = new Map<string, unknown>([[exitId, exit], [territoryId, actor], [keyId, key.publicKey]]);
  const fetcher: typeof fetch = async (input) => documents.has(String(input))
    ? Response.json(documents.get(String(input)))
    : new Response(null, { status: 404 });
  return { entry, documents, fetcher };
}

test('client ExitEvent helper verifies signed proof independently from exact Registry request binding', async () => {
  const current = await fixture();
  const good = await verifyExit(exitId, vesselId, registryId, { [entryId]: current.entry }, current.fetcher);
  assert.equal(good.proofCryptography, 'verified');
  assert.equal(good.keyAttribution, 'attributed');
  assert.equal(good.expectedIssuer, 'verified');
  assert.equal((good.binding as { bound: boolean }).bound, true);

  const wrongTerritory = structuredClone(current.entry) as typeof current.entry;
  wrongTerritory.destination.territory = 'https://territory.test/actors/other';
  const territoryResult = await verifyExit(exitId, vesselId, registryId, { [entryId]: wrongTerritory }, current.fetcher);
  assert.equal(territoryResult.proofCryptography, 'verified');
  assert.equal((territoryResult.binding as { bound: boolean }).bound, false);

  const wrongRequest = await verifyExit(exitId, vesselId, registryId, { [entryId]: { ...current.entry, id: 'https://registry.test/requests/other' } }, current.fetcher);
  assert.equal((wrongRequest.binding as { bound: boolean }).bound, false);

  const unknownRequest = await verifyExit(exitId, vesselId, registryId, {}, current.fetcher);
  assert.equal((unknownRequest.binding as { bound: boolean; requestExists: boolean }).bound, false);
  assert.equal((unknownRequest.binding as { requestExists: boolean }).requestExists, false);

  const wrongVessel = await verifyExit(exitId, 'https://registry.test/vessels/other', registryId, { [entryId]: current.entry }, current.fetcher);
  assert.equal((wrongVessel.binding as { bound: boolean }).bound, false);
});

test('presentation retains real identities and addresses', () => {
  const actor = { id: 'https://actors.test/actors/blue', type: 'Actor', role: 'territory', name: 'Blue Coast' };
  identityDisplay.register(actor);
  identityDisplay.register({ id: 'https://actors.test/actors/registry', type: 'Actor', role: 'registry', name: 'Harbor Registry' });
  assert.match(formatActor(actor), /Actor: Blue Coast/);
  assert.equal(webFingerSubject(actor as never), '@blue.territory@actors.test');
  assert.match(formatActor(actor), /Handle: @blue\.territory@actors\.test/);
  const actorWithEndpoints = { ...actor, inbox: 'https://actors.test/inbox', outbox: 'https://actors.test/outbox' };
  assert.doesNotMatch(formatActor(actorWithEndpoints), /https:\/\//);
  assert.deepEqual(technicalAddresses(actorWithEndpoints).map((entry) => entry.address), [actor.id, actorWithEndpoints.inbox, actorWithEndpoints.outbox]);
  const unnamedActor = { id: 'https://actors.test/actors/player-1', role: 'player' };
  identityDisplay.register(unnamedActor);
  assert.equal(identityDisplay.label(unnamedActor.id), '@player-1@actors.test');
  const dottedActor = { id: 'https://actors.test/actors/blue.coast', role: 'territory', name: 'Blue Coast Archive' };
  identityDisplay.register(dottedActor);
  assert.equal(identityDisplay.label(dottedActor.id), 'Blue Coast Archive');
  assert.doesNotMatch(formatActor(dottedActor), /Handle:/);
  const rootActor = { id: 'https://actors.test/', role: 'territory', name: 'Root Actor' };
  identityDisplay.register(rootActor);
  assert.equal(identityDisplay.label(rootActor.id), 'Root Actor');
  const resource = { id: 'https://resources.test/assets/ore', name: 'Iron Ore', holder: 'https://actors.test/actors/registry', creator: ['https://actors.test/actors/blue'] };
  identityDisplay.register(resource);
  const ordinary = formatResource(resource);
  assert.match(ordinary, /Name: Iron Ore/);
  assert.match(ordinary, /Holder: Harbor Registry \(@registry.registry@actors.test\)/);
  assert.match(ordinary, /Creators: Blue Coast \(@blue.territory@actors.test\)/);
  assert.doesNotMatch(ordinary, /https:\/\//);
  assert.deepEqual(technicalAddresses(resource).map((entry) => entry.address), [resource.id, resource.holder, ...resource.creator]);
  assert.equal(identityDisplay.label(resource.id), 'Iron Ore');
  const authoring = formatAuthoringEntry('Asset', resource);
  assert.match(authoring, /Asset: “Iron Ore”/);
  assert.doesNotMatch(authoring, /https:\/\//);
  const collection = { orderedItems: [{ id: 'https://resources.test/objects/one', name: 'Named entry' }, 'https://resources.test/objects/two'] };
  assert.match(formatResource(collection), /Named entry[\s\S]*two/);
  assert.doesNotMatch(formatResource(collection), /https:\/\//);
  const collectionAddresses = technicalAddresses(collection).map((entry) => entry.address);
  assert.ok(collectionAddresses.includes((collection.orderedItems[0] as { id: string }).id));
  assert.ok(collectionAddresses.includes(collection.orderedItems[1] as string));
  const productionAddresses = technicalAddresses({ production: [{ ingredients: [{ variety: 'https://goods.test/ore', id: 'https://items.test/ore-1', data: { reference: 'https://private.test/data' } }], tool: 'https://tools.test/press', location: { id: 'https://areas.test/foundry', territory: 'https://actors.test/territory', name: 'Foundry' }, text: 'https://authored.test/text', proof: { id: 'https://proof.test/key' } }] }).map((entry) => entry.address);
  assert.deepEqual(productionAddresses, ['https://goods.test/ore', 'https://items.test/ore-1', 'https://tools.test/press', 'https://areas.test/foundry', 'https://actors.test/territory']);
});

test('WebFinger resolution accepts matching explicit origins and both bare and acct-prefixed subjects', async () => {
  const actorId = 'http://home.test:4200/actors/people/alice';
  const scenarios = [
    { handle: '@alice@home.test:4200', subject: '@alice@home.test:4200' },
    { handle: 'alice@home.test:4200', subject: 'acct:@alice@home.test:4200' }
  ];
  for (const scenario of scenarios) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (new URL(url).pathname === '/.well-known/webfinger') {
        return Response.json({ subject: scenario.subject, links: [{ rel: 'self', type: 'application/activity+json', href: actorId }] });
      }
      if (url === actorId) return Response.json({ id: actorId, type: 'Actor', role: 'player' });
      return new Response(null, { status: 404 });
    };
    const resolved = await resolveWebFinger(scenario.handle, fetcher, 'http://home.test:4200');
    assert.equal(resolved.actor.id, actorId);
    assert.equal(resolved.source, 'webfinger');
    const webfinger = calls.find((call) => new URL(call.url).pathname === '/.well-known/webfinger')!;
    const endpoint = new URL(webfinger.url);
    assert.equal(endpoint.origin, 'http://home.test:4200');
    assert.equal(endpoint.searchParams.get('resource'), 'acct:@alice@home.test:4200');
    assert.equal(new Headers(webfinger.init.headers).get('Accept'), 'application/jrd+json');
  }
});

test('WebFinger resolution rejects mismatched identities and origins', async () => {
  const actorId = 'http://home.test:4200/actors/people/alice';
  const mismatched: typeof fetch = async (input) => {
    if (new URL(String(input)).pathname === '/.well-known/webfinger') {
      return Response.json({ subject: 'acct:@bob@home.test:4200', links: [{ rel: 'self', href: actorId }] });
    }
    return Response.json({ id: actorId, type: 'Actor', role: 'player' });
  };
  await assert.rejects(
    resolveWebFinger('@alice@home.test:4200', mismatched, 'http://home.test:4200'),
    (error: unknown) => error instanceof Error
  );
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(null, { status: 500 }); };
  await assert.rejects(
    resolveWebFinger('@alice@home.test:4200', fetcher, 'http://other.test:4200'),
    (error: unknown) => error instanceof Error
  );
  assert.equal(calls, 0);
});

test('resolveAccount verifies the advertised Home Actor without sending credentials', async () => {
  const handle = '@alice@home.test:4200';
  const accountId = 'https://home.test:4200/actors/people/alice';
  const homeId = 'https://home.test:4200/actors/community/home';
  const accountActor = { id: accountId, type: 'Actor', role: 'player', name: 'Alice' };
  const homeActor = { id: homeId, type: 'Actor', role: 'home', name: 'Harbor Home' };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const path = new URL(url).pathname;
    if (path === '/.well-known/webfinger') return Response.json({ subject: `acct:${handle}`, links: [{ rel: 'self', href: accountId }] });
    if (url === accountId) return Response.json(accountActor);
    if (url === homeId) return Response.json(homeActor);
    if (path === '/local/info') return Response.json({ kind: 'authority', actor: { home: homeId } });
    return new Response(null, { status: 404 });
  };
  const result = await new FctpClient({ fetcher }).resolveAccount(handle);
  assert.equal(result.handle, handle);
  assert.equal(result.actorId, accountId);
  assert.deepEqual(result.actor, accountActor);
  assert.equal(result.homeServer, 'home.test:4200');
  assert.equal(result.homeOrigin, 'https://home.test:4200');
  assert.equal(result.homeAuthority, homeId);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, 'https://home.test:4200');
    assert.equal(new Headers(call.init.headers).has('Authorization'), false);
  }
});

test('resolveAccount uses an explicit matching HTTP origin and keeps equal local names distinct', async () => {
  async function resolveAt(port: number, accountPath: string, homePath: string) {
    const origin = `http://127.0.0.1:${port}`;
    const handle = `@sana@127.0.0.1:${port}`;
    const accountId = `${origin}${accountPath}`;
    const homeId = `${origin}${homePath}`;
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      const parsed = new URL(url);
      if (parsed.origin !== origin) return new Response(null, { status: 500 });
      if (parsed.pathname === '/.well-known/webfinger') return Response.json({ subject: handle, links: [{ rel: 'self', href: accountId }] });
      if (url === accountId) return Response.json({ id: accountId, type: 'Actor', role: 'player', name: 'Sana' });
      if (url === homeId) return Response.json({ id: homeId, type: 'Actor', role: 'home' });
      if (parsed.pathname === '/local/info') return Response.json({ actor: { home: homeId } });
      return new Response(null, { status: 404 });
    };
    const result = await new FctpClient({ fetcher }).resolveAccount(handle, { homeOrigin: origin });
    return { origin, result };
  }
  const first = await resolveAt(4100, '/actors/people/sana', '/actors/community/home');
  const second = await resolveAt(4101, '/actors/people/sana', '/actors/community/home');
  assert.equal(first.result.homeOrigin, 'http://127.0.0.1:4100');
  assert.equal(second.result.homeOrigin, 'http://127.0.0.1:4101');
  assert.notEqual(first.result.actorId, second.result.actorId);
  assert.notEqual(first.result.homeAuthority, second.result.homeAuthority);
});

test('resolveAccount rejects authority handles and mismatched or non-HTTP origins before fetching', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(null, { status: 500 }); };
  const client = new FctpClient({ fetcher });
  await assert.rejects(client.resolveAccount('@alice.home@home.test:4200'), (error: unknown) => error instanceof Error);
  await assert.rejects(client.resolveAccount('@alice@home.test:4200', { homeOrigin: 'http://other.test:4200' }), (error: unknown) => error instanceof Error);
  await assert.rejects(client.resolveAccount('@alice@home.test:4200', { homeOrigin: 'ftp://home.test:4200' }), (error: unknown) => error instanceof Error);
  assert.equal(calls, 0);
});

test('resolveAccount rejects non-Player accounts and malformed, missing, unverified, or failed Home discovery', async () => {
  const handle = '@alice@home.test:4200';
  const accountId = 'https://home.test:4200/actors/people/alice';
  const homeId = 'https://home.test:4200/actors/community/home';
  async function attempt(accountRole: string, infoResponse: () => Response, homeResponse: () => Response): Promise<void> {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      const path = new URL(url).pathname;
      if (path === '/.well-known/webfinger') return Response.json({ subject: handle, links: [{ rel: 'self', href: accountId }] });
      if (url === accountId) return Response.json({ id: accountId, type: 'Actor', role: accountRole });
      if (path === '/local/info') return infoResponse();
      if (url === homeId) return homeResponse();
      return new Response(null, { status: 404 });
    };
    await assert.rejects(
      new FctpClient({ fetcher }).resolveAccount(handle),
      (error: unknown) => error instanceof Error
    );
  }
  const home = () => Response.json({ id: homeId, type: 'Actor', role: 'home' });
  await attempt('registry', () => Response.json({ actor: { home: homeId } }), home);
  await attempt('player', () => Response.json({}), home);
  await attempt('player', () => Response.json({ actor: {} }), home);
  await attempt('player', () => Response.json({ actor: { home: 42 } }), home);
  await attempt('player', () => Response.json({ actor: { home: homeId } }), () => Response.json({ id: homeId, type: 'Actor', role: 'registry' }));
  await attempt('player', () => Response.json({ actor: { home: homeId } }), () => new Response(null, { status: 404 }));
  await attempt('player', () => new Response(null, { status: 500 }), home);
});

test('resolveAuthority returns the published authority role from the resolved Actor', async () => {
  const handle = '@orla.home@harbor.test:4200';
  const actorId = 'http://harbor.test:4200/actors/authorities/orla-registry';
  const actor = { id: actorId, type: 'Actor', role: 'registry', name: 'Orla Registry' };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const path = new URL(url).pathname;
    if (path === '/.well-known/webfinger') return Response.json({ subject: handle, links: [{ rel: 'self', href: actorId }] });
    if (url === actorId) return Response.json(actor);
    return new Response(null, { status: 404 });
  };
  const result = await new FctpClient({ fetcher }).resolveAuthority(handle, { origin: 'http://harbor.test:4200' });
  assert.equal(result.handle, handle);
  assert.equal(result.actorId, actorId);
  assert.deepEqual(result.actor, actor);
  assert.equal(result.server, 'harbor.test:4200');
  assert.deepEqual(result.roles, ['registry']);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, 'http://harbor.test:4200');
    assert.equal(new Headers(call.init.headers).has('Authorization'), false);
  }
});

test('resolveAuthority rejects account handles, Player or role-less Actors, invalid origins, and failed reads', async () => {
  let calls = 0;
  const unused: typeof fetch = async () => { calls++; return new Response(null, { status: 500 }); };
  const client = new FctpClient({ fetcher: unused });
  await assert.rejects(client.resolveAuthority('@alice@harbor.test:4200'), (error: unknown) => error instanceof Error);
  await assert.rejects(client.resolveAuthority('@orla.registry@harbor.test:4200', { origin: 'http://other.test:4200' }), (error: unknown) => error instanceof Error);
  assert.equal(calls, 0);

  const handle = '@orla.registry@harbor.test:4200';
  const actorId = 'https://harbor.test:4200/actors/authorities/orla';
  async function attempt(actor: unknown, webfingerStatus = 200, actorStatus = 200): Promise<void> {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (new URL(url).pathname === '/.well-known/webfinger') {
        if (webfingerStatus !== 200) return new Response(null, { status: webfingerStatus });
        return Response.json({ subject: handle, links: [{ rel: 'self', href: actorId }] });
      }
      if (url === actorId) return actorStatus === 200 ? Response.json(actor) : new Response(null, { status: actorStatus });
      return new Response(null, { status: 404 });
    };
    await assert.rejects(
      new FctpClient({ fetcher }).resolveAuthority(handle),
      (error: unknown) => error instanceof Error
    );
  }
  await attempt({ id: actorId, type: 'Actor', role: 'player' });
  await attempt({ id: actorId, type: 'Actor' });
  await attempt({ id: actorId, type: 'Actor', role: 'registry' }, 404);
  await attempt({ id: actorId, type: 'Actor', role: 'registry' }, 200, 500);
});

test('SDK reference resolution retains inline objects without fetching and rejects unsupported shapes', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({ id: 'https://resource.test/objects/unexpected' }); };
  const client = new FctpClient({ fetcher });
  const inline = { id: 'https://resource.test/objects/inline', name: 'Inline', nested: { value: 1 } };
  assert.deepEqual(await client.resolveReference(inline), inline);
  assert.equal(calls, 0);
  for (const invalid of [42, true, null, undefined, ['https://resource.test/objects/array']]) {
    await assert.rejects(client.resolveReference(invalid), { name: 'TypeError' });
  }
  assert.equal(calls, 0);
});

test('SDK reference resolution fetches string and singleton id references through public reads', async () => {
  const stringRef = 'https://resource.test/objects/string';
  const idRef = 'https://resource.test/objects/id';
  const calls: Array<{ url: string; headers: Headers }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    return url === stringRef
      ? Response.json({ id: stringRef, name: 'String reference' })
      : Response.json({ id: idRef, name: 'Id reference' });
  };
  const client = new FctpClient({ fetcher });
  const stringValue = await client.resolveReference<{ id: string; name: string }>(stringRef);
  const idValue = await client.resolveReference<{ id: string; name: string }>({ id: idRef });
  assert.deepEqual(stringValue, { id: stringRef, name: 'String reference' });
  assert.deepEqual(idValue, { id: idRef, name: 'Id reference' });
  assert.deepEqual(calls.map((call) => call.url), [stringRef, idRef]);
  for (const call of calls) {
    assert.equal(call.headers.has('Authorization'), false);
    assert.match(call.headers.get('Accept') ?? '', /application\/ld\+json/);
  }
});

test('SDK reference resolution reads publicly and authenticates only after a challenge', async () => {
  const uri = 'https://resource.test/objects/private';
  const resourceServer = 'https://resource.test/actors/territory';
  const nativeToken = encodeNativeToken(new Uint8Array(32).fill(21));
  const expected = `Bearer ${await deriveDiplomaticToken(nativeToken, resourceServer as URI)}`;
  for (const status of [401, 403]) {
    let calls = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      calls++;
      const authorization = new Headers(init?.headers).get('Authorization');
      if (calls === 1) {
        assert.equal(authorization, null);
        return new Response(null, { status });
      }
      assert.equal(authorization, expected);
      return Response.json({ id: uri, name: 'Protected' });
    };
    const result = await new FctpClient({ fetcher }).resolveReference(uri, resourceServer, { nativeToken });
    assert.deepEqual(result, { id: uri, name: 'Protected' });
    assert.equal(calls, 2);
  }
  let publicCalls = 0;
  const publicFetcher: typeof fetch = async (_input, init) => {
    publicCalls++;
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    return Response.json({ id: uri, name: 'Public' });
  };
  const publicResult = await new FctpClient({ fetcher: publicFetcher }).resolveReference(uri, undefined, { nativeToken });
  assert.deepEqual(publicResult, { id: uri, name: 'Public' });
  assert.equal(publicCalls, 1);
});

test('SDK reference resolution propagates public read failures', async () => {
  for (const status of [404, 500]) {
    const fetcher: typeof fetch = async () => new Response(null, { status });
    await assert.rejects(
      new FctpClient({ fetcher }).resolveReference('https://resource.test/objects/missing'),
      (error: unknown) => error instanceof ResourceError && error.status === status
    );
  }
});
