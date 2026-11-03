import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHomeAuthority } from '@fctp/identity';
import type { FCTPActor } from '@fctp/protocol';

const NODEINFO_2_0 = 'http://nodeinfo.diaspora.software/ns/schema/2.0';
const NODEINFO_2_1 = 'http://nodeinfo.diaspora.software/ns/schema/2.1';

interface TransportCall {
  url: URL;
  method: string;
  headers: Headers;
  cache: RequestCache;
  credentials: RequestCredentials;
  redirect: RequestRedirect;
}

interface Reply {
  status?: number;
  body?: unknown;
  contentType?: string;
}

interface HomeScenario {
  playerOrigin: string;
  nodeInfoPath?: string;
  nodeInfoLinks?: Array<{ rel: string; href: string }>;
  metadata?: Record<string, unknown>;
  homeAccountName?: string;
  subject?: string;
  selfHref?: string;
  actorId?: string;
  role?: string;
}

function homeTransport(scenario: HomeScenario): {
  fetcher: typeof fetch;
  calls: TransportCall[];
  actorId: string;
  webfingerResource: string;
} {
  const player = new URL(scenario.playerOrigin);
  const authority = player.host;
  const nodeInfoUrl = new URL(scenario.nodeInfoPath ?? '/nodeinfo/2.1', player.origin).href;
  const accountName = scenario.homeAccountName ?? 'system.home';
  const webfingerResource = `acct:${accountName}@${authority}`;
  const selfHref = scenario.selfHref ?? 'https://home.example/actors/home';
  const actorId = scenario.actorId ?? selfHref;
  const links = scenario.nodeInfoLinks ?? [
    { rel: NODEINFO_2_0, href: new URL('/nodeinfo/2.0', player.origin).href },
    { rel: NODEINFO_2_1, href: nodeInfoUrl }
  ];
  const calls: TransportCall[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    calls.push({
      url,
      method: request.method,
      headers: request.headers,
      cache: request.cache,
      credentials: request.credentials,
      redirect: request.redirect
    });
    const reply = route(url);
    if (reply === undefined) return new Response(null, { status: 404 });
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: reply.contentType === undefined ? {} : { 'Content-Type': reply.contentType }
    });
  }) as typeof fetch;
  return { fetcher, calls, actorId, webfingerResource };

  function route(url: URL): Reply | undefined {
    if (url.origin === player.origin && url.pathname === '/.well-known/nodeinfo') {
      return { body: { links } };
    }
    if (url.href === nodeInfoUrl) {
      return { body: { version: '2.1', metadata: scenario.metadata ?? { homeAccountName: accountName } } };
    }
    if (url.origin === player.origin && url.pathname === '/.well-known/webfinger') {
      return { body: { subject: scenario.subject ?? webfingerResource, links: [{ rel: 'self', type: 'application/activity+json', href: selfHref }] } };
    }
    if (url.href === selfHref) {
      const actor: FCTPActor = {
        id: (scenario.actorId ?? selfHref) as FCTPActor['id'],
        type: 'Service',
        role: (scenario.role ?? 'home') as FCTPActor['role'],
        inbox: `${selfHref}/inbox`,
        outbox: `${selfHref}/outbox`,
        publicKeys: []
      };
      return { body: actor, contentType: 'application/activity+json' };
    }
    return undefined;
  }
}

function assertCredentialFreeGets(calls: TransportCall[]): void {
  assert.ok(calls.length > 0, 'Expected discovery requests');
  for (const call of calls) {
    assert.equal(call.method, 'GET');
    assert.equal(call.cache, 'no-store');
    assert.equal(call.credentials, 'omit');
    assert.equal(call.redirect, 'error', 'Must not follow redirects outside the validated discovery URLs');
    assert.equal(call.headers.has('authorization'), false, 'Must not forward authorization credentials');
    assert.equal(call.headers.has('proxy-authorization'), false, 'Must not forward proxy credentials');
    assert.equal(call.headers.has('cookie'), false, 'Must not forward cookies');
  }
}

function assertNoConventionalFallback(calls: TransportCall[]): void {
  for (const call of calls) {
    if (call.url.origin === calls[0]?.url.origin) {
      assert.notEqual(call.url.pathname, '/actors/home', 'Must not guess the Home Actor path at the Player origin');
    }
    assert.notEqual(call.url.pathname, '/local/info', 'Must not fall back to enrollment discovery');
  }
}

function expectedUrls(calls: TransportCall[]): string[] {
  return calls.map((call) => call.url.href);
}

test('resolveHomeAuthority resolves a delegated Home from NodeInfo and canonical WebFinger', async () => {
  const playerOrigin = 'https://players.example:8443';
  const playerActorId = `${playerOrigin}/some/nonstandard/identity/player-42`;
  const fixture = homeTransport({
    playerOrigin,
    nodeInfoPath: '/meta/nodeinfo/2.1.json',
    homeAccountName: 'system.home',
    selfHref: 'https://home.delegate.example:9443/actors/home'
  });
  const result = await resolveHomeAuthority(playerActorId, fixture.fetcher);

  assert.equal(result.actor.id, 'https://home.delegate.example:9443/actors/home');
  assert.equal(result.actor.role, 'home');
  assert.equal(result.source, 'webfinger');
  assert.deepEqual(expectedUrls(fixture.calls), [
    'https://players.example:8443/.well-known/nodeinfo',
    'https://players.example:8443/meta/nodeinfo/2.1.json',
    'https://players.example:8443/.well-known/webfinger?resource=acct%3Asystem.home%40players.example%3A8443',
    'https://home.delegate.example:9443/actors/home'
  ]);
  assert.equal(fixture.calls[2]!.url.searchParams.get('resource'), 'acct:system.home@players.example:8443');
  assertCredentialFreeGets(fixture.calls);
  assertNoConventionalFallback(fixture.calls);
});

test('resolveHomeAuthority uses the Player origin authority rather than Player path tails', async () => {
  const fixture = homeTransport({
    playerOrigin: 'https://players.example',
    homeAccountName: 'academy.home',
    selfHref: 'https://home.example/actors/home'
  });
  await resolveHomeAuthority('https://players.example/unusual/actor/location', fixture.fetcher);
  assert.equal(fixture.calls[2]!.url.searchParams.get('resource'), 'acct:academy.home@players.example');
  assertNoConventionalFallback(fixture.calls);
});

test('resolveHomeAuthority rejects insecure non-loopback Player origins without changing their identity', async () => {
  const fixture = homeTransport({
    playerOrigin: 'https://public.example',
    homeAccountName: 'system.home',
    selfHref: 'https://home.example/actors/home'
  });
  await assert.rejects(resolveHomeAuthority('http://public.example/actors/player', fixture.fetcher), /home-unresolved/);
  assert.equal(fixture.calls.length, 0);
});

test('resolveHomeAuthority preserves the exact loopback HTTP exception and port authority', async () => {
  const fixture = homeTransport({
    playerOrigin: 'http://127.0.0.1:4100',
    homeAccountName: 'local.home',
    selfHref: 'http://127.0.0.1:4100/actors/home'
  });
  const result = await resolveHomeAuthority('http://127.0.0.1:4100/actors/player', fixture.fetcher);
  assert.equal(result.actor.id, 'http://127.0.0.1:4100/actors/home');
  assert.equal(result.actor.role, 'home');
  assert.equal(fixture.calls[2]!.url.searchParams.get('resource'), 'acct:local.home@127.0.0.1:4100');
  for (const call of fixture.calls) assert.equal(call.url.protocol, 'http:');
  assertCredentialFreeGets(fixture.calls);
});

test('resolveHomeAuthority reports home-unresolved when metadata.homeAccountName is missing or not a string', async () => {
  for (const metadata of [
    {},
    { homeAccountName: 42 },
    { homeAccountName: null },
    { homeAccountName: ['system.home'] }
  ]) {
    const fixture = homeTransport({
      playerOrigin: 'https://players.example',
      metadata,
      selfHref: 'https://home.example/actors/home'
    });
    await assert.rejects(
      resolveHomeAuthority('https://players.example/actors/player', fixture.fetcher),
      /home-unresolved/
    );
    assert.equal(
      fixture.calls.some((call) => call.url.pathname === '/.well-known/webfinger'),
      false,
      'Must not query WebFinger without a usable homeAccountName'
    );
    assertNoConventionalFallback(fixture.calls);
  }
});

test('resolveHomeAuthority reports home-unresolved for invalid Home account-name local parts', async () => {
  for (const homeAccountName of ['system', '@system.home', 'system.home@players.example', 'system..home', 'System.Home', 'system home', '']) {
    const fixture = homeTransport({
      playerOrigin: 'https://players.example',
      homeAccountName,
      selfHref: 'https://home.example/actors/home'
    });
    await assert.rejects(
      resolveHomeAuthority('https://players.example/actors/player', fixture.fetcher),
      /home-unresolved/,
      `Expected ${JSON.stringify(homeAccountName)} to be unresolved`
    );
    assert.equal(
      fixture.calls.some((call) => call.url.pathname === '/.well-known/webfinger'),
      false,
      'Must validate the Home local part before querying WebFinger'
    );
    assertNoConventionalFallback(fixture.calls);
  }
});

test('resolveHomeAuthority reports home-unresolved when the NodeInfo 2.1 schema link is absent', async () => {
  for (const nodeInfoLinks of [
    [],
    [{ rel: NODEINFO_2_0, href: 'https://players.example/nodeinfo/2.0' }],
    [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.1/', href: 'https://players.example/nodeinfo/2.1' }]
  ]) {
    const fixture = homeTransport({
      playerOrigin: 'https://players.example',
      nodeInfoLinks,
      selfHref: 'https://home.example/actors/home'
    });
    await assert.rejects(
      resolveHomeAuthority('https://players.example/actors/player', fixture.fetcher),
      /home-unresolved/
    );
    assert.equal(fixture.calls.every((call) => call.url.pathname === '/.well-known/nodeinfo'), true);
    assertNoConventionalFallback(fixture.calls);
  }
});

test('resolveHomeAuthority rejects insecure or credential-bearing NodeInfo links before retrieving them', async () => {
  for (const href of ['http://metadata.example/nodeinfo/2.1', 'https://user:password@players.example/nodeinfo/2.1']) {
    const fixture = homeTransport({ playerOrigin: 'https://players.example', nodeInfoLinks: [{ rel: NODEINFO_2_1, href }] });
    await assert.rejects(resolveHomeAuthority('https://players.example/actors/player', fixture.fetcher), /home-unresolved/);
    assert.equal(fixture.calls.length, 1);
  }
});

test('resolveHomeAuthority reports home-unresolved on transport failure without guessing a Home path', async () => {
  const playerActorId = 'https://players.example/actors/player';
  for (const failure of ['nodeinfo-list', 'nodeinfo-document', 'webfinger', 'actor'] as const) {
    const calls: TransportCall[] = [];
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url);
      calls.push({ url, method: request.method, headers: request.headers, cache: request.cache, credentials: request.credentials, redirect: request.redirect });
      const failing =
        (failure === 'nodeinfo-list' && url.pathname === '/.well-known/nodeinfo') ||
        (failure === 'nodeinfo-document' && url.pathname === '/nodeinfo/2.1') ||
        (failure === 'webfinger' && url.pathname === '/.well-known/webfinger') ||
        (failure === 'actor' && url.href === 'https://home.example/actors/home');
      if (failing) throw new Error('simulated transport failure');
      if (url.pathname === '/.well-known/nodeinfo') {
        return jsonResponse({ links: [{ rel: NODEINFO_2_1, href: 'https://players.example/nodeinfo/2.1' }] });
      }
      if (url.pathname === '/nodeinfo/2.1') {
        return jsonResponse({ version: '2.1', metadata: { homeAccountName: 'system.home' } });
      }
      if (url.pathname === '/.well-known/webfinger') {
        return jsonResponse({
          subject: 'acct:system.home@players.example',
          links: [{ rel: 'self', href: 'https://home.example/actors/home' }]
        });
      }
      if (url.href === 'https://home.example/actors/home') {
        return jsonResponse({
          id: 'https://home.example/actors/home',
          type: 'Service',
          role: 'home',
          inbox: 'https://home.example/actors/home/inbox',
          outbox: 'https://home.example/actors/home/outbox',
          publicKeys: []
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    await assert.rejects(resolveHomeAuthority(playerActorId, fetcher), /home-unresolved/);
    assertNoConventionalFallback(calls);
  }
});

test('resolveHomeAuthority reports home-unresolved for an invalid Player Actor identifier', async () => {
  const fixture = homeTransport({
    playerOrigin: 'https://players.example',
    selfHref: 'https://home.example/actors/home'
  });
  await assert.rejects(resolveHomeAuthority('not a player actor uri', fixture.fetcher), /home-unresolved/);
  assert.equal(fixture.calls.length, 0);
});

test('resolveHomeAuthority requires the JRD subject to equal the canonical acct resource exactly', async () => {
  for (const subject of [
    'acct:@system.home@players.example',
    'acct:other.home@players.example',
    'acct:system.home@other.example',
    'acct:System.Home@players.example',
    '@system.home@players.example',
    'system.home@players.example'
  ]) {
    const fixture = homeTransport({
      playerOrigin: 'https://players.example',
      subject,
      selfHref: 'https://home.example/actors/home'
    });
    await assert.rejects(
      resolveHomeAuthority('https://players.example/actors/player', fixture.fetcher),
      /home-mismatch/,
      `Expected ${JSON.stringify(subject)} to be a subject mismatch`
    );
    assert.equal(
      fixture.calls.some((call) => call.url.href === 'https://home.example/actors/home'),
      false,
      'Must not fetch an Actor after a subject mismatch'
    );
  }
});

test('resolveHomeAuthority requires exactly one self link', async () => {
  for (const links of [
    [],
    [{ rel: 'alternate', href: 'https://home.example/actors/home' }],
    [
      { rel: 'self', href: 'https://home.example/actors/home' },
      { rel: 'self', href: 'https://other.example/actors/home' }
    ]
  ]) {
    const fixture = homeTransport({
      playerOrigin: 'https://players.example',
      selfHref: 'https://home.example/actors/home'
    });
    const custom = withWebFingerLinks(fixture, links);
    await assert.rejects(
      resolveHomeAuthority('https://players.example/actors/player', custom.fetcher),
      /home-mismatch/,
      `Expected ${JSON.stringify(links)} to be rejected`
    );
  }
});

test('resolveHomeAuthority requires the self link to be an absolute HTTPS URI outside exact loopback', async () => {
  for (const selfHref of [
    '/actors/home',
    'actors/home',
    'http://home.example/actors/home',
    'http://127.0.0.1.evil.example/actors/home',
    'https://user:password@home.example/actors/home',
    'mailto:home@example',
    'not a url',
    ''
  ]) {
    const fixture = homeTransport({
      playerOrigin: 'https://players.example',
      selfHref
    });
    await assert.rejects(
      resolveHomeAuthority('https://players.example/actors/player', fixture.fetcher),
      /home-mismatch/,
      `Expected ${JSON.stringify(selfHref)} to be rejected`
    );
  }
});

test('resolveHomeAuthority reports home-mismatch when the fetched Actor id differs from the self link', async () => {
  const fixture = homeTransport({
    playerOrigin: 'https://players.example',
    selfHref: 'https://home.example/actors/home',
    actorId: 'https://home.example/actors/other'
  });
  await assert.rejects(
    resolveHomeAuthority('https://players.example/actors/player', fixture.fetcher),
    /home-mismatch/
  );
  assert.equal(fixture.calls.at(-1)!.url.href, 'https://home.example/actors/home');
});

test('resolveHomeAuthority reports home-mismatch when the fetched Actor role is not home', async () => {
  for (const role of ['player', 'territory', 'registry', '']) {
    const fixture = homeTransport({
      playerOrigin: 'https://players.example',
      selfHref: 'https://home.example/actors/home',
      role
    });
    await assert.rejects(
      resolveHomeAuthority('https://players.example/actors/player', fixture.fetcher),
      /home-mismatch/,
      `Expected role ${JSON.stringify(role)} to be rejected`
    );
  }
});

test('resolveHomeAuthority retains no cache between calls and reobserves discovery', async () => {
  let accountName = 'first.home';
  let selfHref = 'https://home.example/actors/first';
  const calls: TransportCall[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    calls.push({ url, method: request.method, headers: request.headers, cache: request.cache, credentials: request.credentials, redirect: request.redirect });
    if (url.pathname === '/.well-known/nodeinfo') {
      return jsonResponse({ links: [{ rel: NODEINFO_2_1, href: 'https://players.example/nodeinfo/2.1' }] });
    }
    if (url.pathname === '/nodeinfo/2.1') {
      return jsonResponse({ version: '2.1', metadata: { homeAccountName: accountName } });
    }
    if (url.pathname === '/.well-known/webfinger') {
      return jsonResponse({
        subject: `acct:${accountName}@players.example`,
        links: [{ rel: 'self', href: selfHref }]
      });
    }
    if (url.href === selfHref) {
      return jsonResponse({
        id: selfHref,
        type: 'Service',
        role: 'home',
        inbox: `${selfHref}/inbox`,
        outbox: `${selfHref}/outbox`,
        publicKeys: []
      });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const first = await resolveHomeAuthority('https://players.example/actors/player', fetcher);
  accountName = 'second.home';
  selfHref = 'https://home.example/actors/second';
  const second = await resolveHomeAuthority('https://players.example/actors/player', fetcher);

  assert.equal(first.actor.id, 'https://home.example/actors/first');
  assert.equal(second.actor.id, 'https://home.example/actors/second');
  assert.equal(calls.length, 8);
  assert.equal(calls[2]!.url.searchParams.get('resource'), 'acct:first.home@players.example');
  assert.equal(calls[6]!.url.searchParams.get('resource'), 'acct:second.home@players.example');
  assert.equal(calls[3]!.url.href, 'https://home.example/actors/first');
  assert.equal(calls[7]!.url.href, 'https://home.example/actors/second');
  assertCredentialFreeGets(calls);
});

function withWebFingerLinks(
  fixture: { calls: TransportCall[]; actorId: string; webfingerResource: string },
  links: unknown[]
): { fetcher: typeof fetch } {
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    fixture.calls.push({
      url,
      method: request.method,
      headers: request.headers,
      cache: request.cache,
      credentials: request.credentials,
      redirect: request.redirect
    });
    if (url.pathname === '/.well-known/nodeinfo') {
      return jsonResponse({ links: [{ rel: NODEINFO_2_1, href: 'https://players.example/nodeinfo/2.1' }] });
    }
    if (url.pathname === '/nodeinfo/2.1') {
      return jsonResponse({ version: '2.1', metadata: { homeAccountName: 'system.home' } });
    }
    if (url.pathname === '/.well-known/webfinger') {
      return jsonResponse({ subject: fixture.webfingerResource, links });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { fetcher };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
