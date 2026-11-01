import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  WEBFINGER_CONTEXT, parseWebFingerAddress, reverseDiscoverWebFinger,
  type ReverseDiscoveryError, type ReverseDiscoveryResult
} from '@fctp/identity';
import type { FCTPActor } from '@fctp/protocol';
import { FctpServer, createHost } from '@fctp/server-base';

test('parseWebFingerAddress normalizes plain, handle, acct, role and port forms', () => {
  assert.deepEqual(parseWebFingerAddress('player@host'), {
    address: 'player@host', handle: '@player@host', subject: 'acct:player@host'
  });
  assert.deepEqual(parseWebFingerAddress('@player@host'), {
    address: 'player@host', handle: '@player@host', subject: 'acct:player@host'
  });
  assert.deepEqual(parseWebFingerAddress('territory.territory@host:4100'), {
    address: 'territory.territory@host:4100',
    handle: '@territory.territory@host:4100',
    subject: 'acct:territory.territory@host:4100'
  });
  assert.deepEqual(parseWebFingerAddress('acct:player@host'), {
    address: 'player@host', handle: '@player@host', subject: 'acct:player@host'
  });
  assert.deepEqual(parseWebFingerAddress('ACCT:player@host'), {
    address: 'player@host', handle: '@player@host', subject: 'acct:player@host'
  });
});

test('parseWebFingerAddress rejects malformed, whitespace, port and non-string input', () => {
  const parse = parseWebFingerAddress as unknown as (value: unknown) => unknown;
  for (const value of [
    '', ' ', 'player', '@', '@host', 'player@', 'player@@host', 'acct:player@@host',
    'player@host:0', 'player@host:65536', 'player@host:port',
    ' player@host', 'player @host', 'player@ host', 'player@host '
  ]) {
    assert.throws(() => parse(value), TypeError, `Expected rejection for ${JSON.stringify(value)}`);
  }
  assert.throws(() => parse(123), TypeError);
  assert.throws(() => parse(undefined), TypeError);
});

test('createHost Actor documents publish a plain webfinger property and the FEP context', async () => {
  const fixture = await startHost('fep2c59-publication-', [
    { name: 'player', role: 'player' },
    { name: 'harbor', role: 'territory' }
  ]);
  try {
    const player = await fetch(fixture.host.actor('player').id).then((response) => response.json()) as Record<string, unknown>;
    const territory = await fetch(fixture.host.actor('harbor').id).then((response) => response.json()) as Record<string, unknown>;
    assert.equal(player.webfinger, `player@${fixture.hostPart}`);
    assert.equal(territory.webfinger, `harbor.territory@${fixture.hostPart}`);
    assert.equal(hasContext(player['@context'], WEBFINGER_CONTEXT), true);
    assert.equal(hasContext(territory['@context'], WEBFINGER_CONTEXT), true);
  } finally {
    await fixture.close();
  }
});

test('reverseDiscoverWebFinger verifies a createHost Actor over loopback and returns its handle', async () => {
  const fixture = await startHost('fep2c59-verified-', [{ name: 'player', role: 'player' }]);
  try {
    const actorId = fixture.host.actor('player').id;
    const result = await reverseDiscoverWebFinger(actorId);
    assert.equal(result.verified, true);
    if (!result.verified) assert.fail('Expected verified discovery');
    assert.equal(result.actor.id, actorId);
    assert.equal(result.address, `player@${fixture.hostPart}`);
    assert.equal(result.handle, `@player@${fixture.hostPart}`);
  } finally {
    await fixture.close();
  }
});

test('legacy and plain WebFinger subjects resolve to the same Actor with an exact self link', async () => {
  const fixture = await startHost('fep2c59-subjects-', [
    { name: 'player', role: 'player' },
    { name: 'harbor', role: 'territory' }
  ]);
  try {
    const cases = [
      { name: 'player', resources: [`acct:@player@${fixture.hostPart}`, `acct:player@${fixture.hostPart}`] },
      { name: 'harbor', resources: [`acct:@harbor.territory@${fixture.hostPart}`, `acct:harbor.territory@${fixture.hostPart}`] }
    ];
    for (const { name, resources } of cases) {
      for (const resource of resources) {
        const endpoint = new URL('/.well-known/webfinger', fixture.origin);
        endpoint.searchParams.set('resource', resource);
        const response = await fetch(endpoint);
        assert.equal(response.status, 200, `Expected ${resource} to resolve`);
        assert.match(response.headers.get('content-type') ?? '', /^application\/jrd\+json/);
        const jrd = await response.json() as { subject?: string; links?: Array<{ rel?: string; href?: string }> };
        assert.equal(jrd.subject, resource.slice('acct:'.length));
        assert.ok(jrd.links?.some((link) => link.rel === 'self' && link.href === fixture.host.actor(name).id));
      }
    }
  } finally {
    await fixture.close();
  }
});

test('reverse discovery reports webfinger-not-published when the Actor omits the property', async () => {
  let actorId = '';
  const server = await startLoopback((url, response) => {
    if (url.pathname !== '/actors/player') return false;
    reply(response, 200, actorDocument(actorId), 'application/activity+json');
    return true;
  });
  actorId = `${server.origin}/actors/player`;
  try {
    const failed = expectUnverified(await reverseDiscoverWebFinger(actorId), 'webfinger-not-published');
    assert.equal(failed.actor.id, actorId);
  } finally {
    await server.close();
  }
});

test('reverse discovery reports webfinger-invalid when the published property is not an address', async () => {
  let actorId = '';
  const server = await startLoopback((url, response) => {
    if (url.pathname !== '/actors/player') return false;
    reply(response, 200, actorDocument(actorId, 'not-an-address'), 'application/activity+json');
    return true;
  });
  actorId = `${server.origin}/actors/player`;
  try {
    const failed = expectUnverified(await reverseDiscoverWebFinger(actorId), 'webfinger-invalid');
    assert.equal(failed.actor.id, actorId);
  } finally {
    await server.close();
  }
});

test('reverse discovery rejects a JRD whose subject denotes a different address', async () => {
  let actorId = '';
  let host = '';
  const server = await startLoopback((url, response) => {
    if (url.pathname === '/actors/player') {
      reply(response, 200, actorDocument(actorId, `player@${host}`), 'application/activity+json');
      return true;
    }
    if (url.pathname === '/.well-known/webfinger') {
      reply(response, 200, {
        subject: `acct:other@${host}`,
        links: [{ rel: 'self', type: 'application/activity+json', href: actorId }]
      }, 'application/jrd+json');
      return true;
    }
    return false;
  });
  actorId = `${server.origin}/actors/player`;
  host = new URL(server.origin).host;
  try {
    const failed = expectUnverified(await reverseDiscoverWebFinger(actorId), 'webfinger-unverified');
    assert.equal(failed.actor.id, actorId);
  } finally {
    await server.close();
  }
});

test('reverse discovery rejects a JRD self link that points at another Actor', async () => {
  let actorId = '';
  let origin = '';
  let host = '';
  const server = await startLoopback((url, response) => {
    if (url.pathname === '/actors/player') {
      reply(response, 200, actorDocument(actorId, `player@${host}`), 'application/activity+json');
      return true;
    }
    if (url.pathname === '/.well-known/webfinger') {
      reply(response, 200, {
        subject: `acct:player@${host}`,
        links: [{ rel: 'self', type: 'application/activity+json', href: `${origin}/actors/other` }]
      }, 'application/jrd+json');
      return true;
    }
    return false;
  });
  actorId = `${server.origin}/actors/player`;
  origin = server.origin;
  host = new URL(server.origin).host;
  try {
    const failed = expectUnverified(await reverseDiscoverWebFinger(actorId), 'webfinger-unverified');
    assert.equal(failed.actor.id, actorId);
  } finally {
    await server.close();
  }
});

test('reverse discovery does not verify an Actor whose webfinger names another Actor address', async () => {
  let origin = '';
  let host = '';
  const server = await startLoopback((url, response) => {
    if (url.pathname === '/actors/a') {
      reply(response, 200, actorDocument(`${origin}/actors/a`, `b@${host}`), 'application/activity+json');
      return true;
    }
    if (url.pathname === '/actors/b') {
      reply(response, 200, actorDocument(`${origin}/actors/b`, `b@${host}`), 'application/activity+json');
      return true;
    }
    if (url.pathname === '/.well-known/webfinger') {
      reply(response, 200, {
        subject: `acct:b@${host}`,
        links: [{ rel: 'self', type: 'application/activity+json', href: `${origin}/actors/b` }]
      }, 'application/jrd+json');
      return true;
    }
    return false;
  });
  origin = server.origin;
  host = new URL(server.origin).host;
  try {
    const failed = expectUnverified(await reverseDiscoverWebFinger(`${origin}/actors/a`), 'webfinger-unverified');
    assert.equal(failed.actor.id, `${origin}/actors/a`);
  } finally {
    await server.close();
  }
});

test('Actor retrieval failure rejects after requesting the exact Actor URI', async () => {
  const actorId = 'https://public.example/actors/player';
  const calls: Array<{ url: string; accept: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: requestUrl(input), accept: new Headers(input instanceof Request ? input.headers : init?.headers).get('accept') ?? '' });
    return new Response(null, { status: 502 });
  };
  await assert.rejects(reverseDiscoverWebFinger(actorId, fetcher));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, actorId);
  assert.equal(calls[0]!.accept, 'application/activity+json, application/ld+json');
});

test('a public non-loopback Actor URL does not downgrade WebFinger to HTTP', async () => {
  const actorId = 'http://public.example/actors/player';
  const address = 'player@finger.example';
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = requestUrl(input);
    calls.push(url);
    if (url === actorId) {
      return jsonResponse(actorDocument(actorId, address), 'application/activity+json');
    }
    assert.equal(new URL(url).protocol, 'https:');
    return jsonResponse({
      subject: `acct:${address}`,
      links: [{ rel: 'self', type: 'application/activity+json', href: actorId }]
    }, 'application/jrd+json');
  };
  const result = await reverseDiscoverWebFinger(actorId, fetcher);
  assert.equal(result.verified, true);
  if (!result.verified) assert.fail('Expected verified discovery');
  assert.equal(result.handle, `@${address}`);
  assert.deepEqual(calls, [actorId, `https://finger.example/.well-known/webfinger?resource=acct%3Aplayer%40finger.example`]);
});

function actorDocument(id: string, webfinger?: string): FCTPActor {
  return {
    id,
    type: 'Service',
    role: 'player',
    inbox: `${id}/inbox`,
    outbox: `${id}/outbox`,
    publicKeys: [],
    ...(webfinger === undefined ? {} : { webfinger })
  };
}

function expectUnverified(result: ReverseDiscoveryResult, error: ReverseDiscoveryError): Extract<ReverseDiscoveryResult, { verified: false }> {
  if (result.verified) assert.fail(`Expected ${error}, got verified handle ${result.handle}`);
  assert.equal(result.error, error);
  assert.equal('handle' in result, false);
  return result;
}

function hasContext(context: unknown, expected: string): boolean {
  return context === expected || (Array.isArray(context) && context.includes(expected));
}

function requestUrl(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input);
}

function jsonResponse(body: unknown, type: string): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': type } });
}

function reply(response: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  response.writeHead(status, { 'Content-Type': type });
  response.end(JSON.stringify(body));
}

async function startLoopback(handler: (url: URL, response: ServerResponse) => boolean): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (!handler(url, response)) response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unexpected loopback address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function startHost(prefix: string, actors: Array<{ name: string; role: string }>): Promise<{
  directory: string;
  host: Awaited<ReturnType<typeof createHost>>;
  origin: string;
  hostPart: string;
  close: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const probe = new FctpServer({ storeFile: join(directory, 'probe.json') });
  const initial = await probe.listen();
  const origin = `http://127.0.0.1:${initial.port}`;
  await initial.close();
  const host = await createHost({ origin, storeFile: join(directory, 'host.json'), keyFile: join(directory, 'keys.json'), actors });
  await host.listen(initial.port);
  return {
    directory,
    host,
    origin,
    hostPart: new URL(origin).host,
    close: async () => {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}
