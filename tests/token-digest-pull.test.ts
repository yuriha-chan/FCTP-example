import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveDiplomaticToken } from '@fctp/auth';
import { FctpClient } from '@fctp/client-sdk';
import { createLocalDocumentLoader, generateActorKey, signJsonLd } from '@fctp/identity';
import { accountIdFromRequest, createHost } from '@fctp/server-base';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function signedHeader(document: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(document)).toString('base64url');
}

test('a resource server pulls a missing TokenDigest from Home with a signed GET', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-token-pull-'));
  const authorityOrigin = `http://127.0.0.1:${await freePort()}`;
  const targetOrigin = `http://127.0.0.1:${await freePort()}`;
  const authority = await createAuthorityApp({
    origin: authorityOrigin,
    storeFile: join(directory, 'authority.json'),
    adminSecret: 'admin',
    playerNames: ['player'],
    administratorNames: ['governor'],
    vesselNames: { player: 'boat' },
    accountPasswords: { player: 'password', governor: 'governor-password' }
  });
  let pulls = 0;
  const countingFetch: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === '/local/home/token-digest') pulls += 1;
    return fetch(request);
  };
  const target = await createHost({
    origin: targetOrigin,
    storeFile: join(directory, 'target.json'),
    actors: [{ name: 'territory', role: 'territory' }],
    nodeInfo: { name: 'fixture-territory' },
    fetcher: countingFetch
  });
  t.after(async () => {
    await target.close();
    await authority.authority.close();
    await rm(directory, { recursive: true, force: true });
  });
  await authority.authority.listen(Number(new URL(authorityOrigin).port));
  await target.listen(Number(new URL(targetOrigin).port));

  const targetActorId = target.actor('territory').id;
  target.server.addRoute(async ({ request, response, url }) => {
    if (url.pathname !== '/check') return false;
    const authorization = request.headers.authorization ?? '';
    const accountId = accountIdFromRequest(request);
    const playerId = authorization.startsWith('Bearer ')
      ? await target.server.authenticateDiplomaticToken(targetActorId, authorization.slice(7), accountId)
      : undefined;
    response.writeHead(playerId ? 200 : 401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ player: playerId ?? null }));
    return true;
  });

  const host = new URL(authorityOrigin).host;
  const loginResponse = await fetch(`${authorityOrigin}/local/home/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: `@player@${host}`, password: 'password' })
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json() as { status: string; nativeToken: string };
  assert.equal(login.status, 'signed-in');
  const governorResponse = await fetch(`${authorityOrigin}/local/home/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: `@governor@${host}`, password: 'governor-password' })
  });
  assert.equal(governorResponse.status, 200);
  const governor = await governorResponse.json() as { status: string; nativeToken: string };
  assert.equal(governor.status, 'signed-in');
  const playerId = authority.ids.players.player!;
  const token = await deriveDiplomaticToken(login.nativeToken, targetActorId);

  assert.equal(await target.server.authenticateDiplomaticToken(targetActorId, token), undefined, 'no account hint means no pull');
  assert.equal(pulls, 0);

  const missingHeader = await fetch(`${targetOrigin}/check`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(missingHeader.status, 401);
  assert.equal(pulls, 0);

  const sdk = new FctpClient({ fetcher: countingFetch });
  const sdkResult = await sdk.getPublicFirst<{ player: string }>(`${targetOrigin}/check`, {
    nativeToken: login.nativeToken,
    resourceServer: targetActorId,
    accountActor: playerId
  });
  assert.deepEqual(sdkResult, { player: playerId });
  assert.equal(pulls, 1);

  const withHeader = await fetch(`${targetOrigin}/check`, {
    headers: { Authorization: `Bearer ${token}`, 'X-FCTP-Account': playerId }
  });
  assert.equal(withHeader.status, 200);
  assert.deepEqual(await withHeader.json(), { player: playerId });
  assert.equal(pulls, 1);

  assert.equal(await target.server.authenticateDiplomaticToken(targetActorId, token, playerId), playerId);
  assert.equal(pulls, 1, 'a retained declaration is not re-pulled');

  const rotateResponse = await fetch(`${authorityOrigin}/local/home/rotate`, {
    method: 'POST',
    headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor: playerId })
  });
  assert.equal(rotateResponse.status, 200);
  const rotated = await rotateResponse.json() as { nativeToken: string };
  assert.equal(await authority.authority.server.processOutbox(), 1);
  assert.equal(await target.server.processInbox(), 1);
  assert.equal(await target.server.authenticateDiplomaticToken(targetActorId, token, playerId), undefined);
  const rotatedToken = await deriveDiplomaticToken(rotated.nativeToken, targetActorId);
  assert.equal(await target.server.authenticateDiplomaticToken(targetActorId, rotatedToken, playerId), playerId);
  assert.equal(pulls, 1);

  const target2Origin = `http://127.0.0.1:${await freePort()}`;
  let pulls2 = 0;
  const countingFetch2: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === '/local/home/token-digest') pulls2 += 1;
    return fetch(request);
  };
  const target2 = await createHost({
    origin: target2Origin,
    storeFile: join(directory, 'target2.json'),
    actors: [{ name: 'territory', role: 'territory' }],
    nodeInfo: { name: 'fixture-territory-2' },
    fetcher: countingFetch2
  });
  t.after(() => target2.close());
  await target2.listen(Number(new URL(target2Origin).port));
  const disableResponse = await fetch(`${authorityOrigin}/local/home/accounts/availability`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${governor.nativeToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle: `@player@${host}`, available: false })
  });
  assert.equal(disableResponse.status, 200);
  const target2ActorId = target2.actor('territory').id;
  const disabledToken = await deriveDiplomaticToken(rotated.nativeToken, target2ActorId);
  assert.equal(await target2.server.authenticateDiplomaticToken(target2ActorId, disabledToken, playerId), undefined);
  assert.equal(pulls2, 1, 'Home returns TokenRevoke for a disabled account');

  const homeEndpoint = `${authorityOrigin}/local/home/token-digest?actor=${encodeURIComponent(playerId)}`;
  const fakeController = `${targetOrigin}/actors/missing`;
  const fakeKey = await generateActorKey(fakeController);
  const signed = await signJsonLd({
    '@context': ['https://www.w3.org/ns/activitystreams'],
    id: `${fakeController}/requests/1`,
    type: 'TokenDigestRequest',
    actor: fakeController,
    object: playerId,
    target: homeEndpoint,
    published: new Date().toISOString()
  }, fakeKey.keyPair, createLocalDocumentLoader());
  const forged = await fetch(homeEndpoint, {
    headers: { 'X-FCTP-Signed-Request': signedHeader(signed) }
  });
  assert.equal(forged.status, 401);
});
