import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAuthority } from '../apps/test-authority/src/bootstrap.js';
import { installHome } from '../apps/test-authority/src/home.js';
import { createInboundVerifier } from '@fctp/server-base';

test('Home persists player credentials, rotates and revokes scoped declarations, and proxies with matching authorization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-home-'));
  let resource: Awaited<ReturnType<typeof createAuthority>> | undefined;
  let homeAuthority: Awaited<ReturnType<typeof createAuthority>> | undefined;
  try {
  const homePort = await availablePort();
  const resourcePort = await availablePort();
  const homeOrigin = `http://127.0.0.1:${homePort}`;
  const resourceOrigin = `http://127.0.0.1:${resourcePort}`;
  const adminSecret = 'home-test-admin-secret';
  let resourceAuthorized = true;
  resource = await createAuthority({
    origin: resourceOrigin,
    storeFile: join(directory, 'resource.json'),
    verifyInbound: createInboundVerifier({ resolveExpectedIssuer: async (_local, sender) => sender }),
    authorizeResource: async () => ({ allowed: resourceAuthorized })
  });
  const homeAuthorityOptions = { origin: homeOrigin, storeFile: join(directory, 'home.json'), adminSecret };
  homeAuthority = await createAuthority(homeAuthorityOptions);
  let home = installHome(homeAuthority);
  await homeAuthority.server.enrollPlayer(homeAuthority.actor('player').id, homeAuthority.actor('home').id);
  await resource.server.enrollPlayer(homeAuthority.actor('player').id, homeAuthority.actor('home').id);
  const resourceUri = `${resourceOrigin}/objects/private`;
  resource.server.registerResource(resourceUri, { value: 'permitted' }, { public: false, actorId: resource.actor('registry').id });
  await homeAuthority.listen(homePort);
  await resource.listen(resourcePort);

  const adminHeaders = { Authorization: `Bearer ${adminSecret}`, 'Content-Type': 'application/json' };
  const issuedResponse = await fetch(`${homeOrigin}/local/home/issue`, { method: 'POST', headers: adminHeaders, body: '{}' });
  assert.equal(issuedResponse.status, 200);
  const issued = await issuedResponse.json() as { nativeToken: string };
  assert.equal(Buffer.from(issued.nativeToken, 'base64url').length, 32);
  const resourceActor = { id: resource.actor('registry').id, inbox: resource.actor('registry').inbox as string };
  const resourceActorId = resource.actor('registry').id;
  await assert.rejects(home.issueNativeToken(homeAuthority.actor('player').id), /native-token-already-issued/);
  const first = await home.requestDigest(homeAuthority.actor('player').id, resourceActor);
  assert.equal(first.revision, 1);
  assert.notEqual(await home.deriveToken(homeAuthority.actor('player').id, resource.actor('registry').id), issued.nativeToken);

  await homeAuthority.server.processOutbox();
  assert.equal(await resource.server.processInbox(), 1);
  const diplomaticToken = await home.deriveToken(homeAuthority.actor('player').id, resource.actor('registry').id);
  const direct = await fetch(resourceUri, { headers: { Authorization: `Bearer ${diplomaticToken}` } });
  assert.equal(direct.status, 200);
  const proxy = await fetch(`${homeOrigin}/local/home/proxy?uri=${encodeURIComponent(resourceUri)}&resourceActor=${encodeURIComponent(resource.actor('registry').id)}`, { headers: { Authorization: `Bearer ${issued.nativeToken}` } });
  assert.equal(proxy.status, direct.status);
  assert.deepEqual(await proxy.json(), await direct.json());
  resourceAuthorized = false;
  const deniedDirect = await fetch(resourceUri, { headers: { Authorization: `Bearer ${diplomaticToken}` } });
  const deniedProxy = await fetch(`${homeOrigin}/local/home/proxy?uri=${encodeURIComponent(resourceUri)}&resourceActor=${encodeURIComponent(resource.actor('registry').id)}`, { headers: { Authorization: `Bearer ${issued.nativeToken}` } });
  assert.equal(deniedDirect.status, 403);
  assert.equal(deniedProxy.status, deniedDirect.status);
  resourceAuthorized = true;

  const rotatedResponse = await fetch(`${homeOrigin}/local/home/rotate`, { method: 'POST', headers: adminHeaders, body: '{}' });
  const rotated = await rotatedResponse.json() as { nativeToken: string };
  assert.equal(rotatedResponse.status, 200);
  assert.notEqual(rotated.nativeToken, issued.nativeToken);
  await homeAuthority.server.processOutbox();
  assert.equal(await resource.server.processInbox(), 1);
  const rotatedDiplomaticToken = await home.deriveToken(homeAuthority.actor('player').id, resource.actor('registry').id);
  const oldCredential = await fetch(resourceUri, { headers: { Authorization: `Bearer ${diplomaticToken}` } });
  const newCredential = await fetch(resourceUri, { headers: { Authorization: `Bearer ${rotatedDiplomaticToken}` } });
  assert.equal(oldCredential.status, 401);
  assert.equal(newCredential.status, 200);
  await home.revoke(homeAuthority.actor('player').id, resourceActor);
  await homeAuthority.server.processOutbox();
  assert.equal(await resource.server.processInbox(), 1);
  assert.equal((await fetch(resourceUri, { headers: { Authorization: `Bearer ${rotatedDiplomaticToken}` } })).status, 401);

  const concurrent = await Promise.all([
    home.requestDigest(homeAuthority.actor('player').id, resourceActor),
    home.rotateNativeToken(homeAuthority.actor('player').id),
    home.revoke(homeAuthority.actor('player').id, resourceActor)
  ]);
  assert.equal(concurrent[0].revision, 4);
  await homeAuthority.server.processOutbox();
  assert.equal(await resource.server.processInbox(), 3);
  const currentNativeToken = concurrent[1];
  const currentDiplomaticToken = await home.deriveToken(homeAuthority.actor('player').id, resourceActor.id);
  assert.notEqual(currentNativeToken, rotated.nativeToken);
  assert.equal((await fetch(resourceUri, { headers: { Authorization: `Bearer ${rotatedDiplomaticToken}` } })).status, 401);
  assert.equal((await fetch(resourceUri, { headers: { Authorization: `Bearer ${currentDiplomaticToken}` } })).status, 401);

  const recovered = await home.requestDigest(homeAuthority.actor('player').id, resourceActor);
  assert.equal(recovered.revision, 7);
  await homeAuthority.server.processOutbox();
  assert.equal(await resource.server.processInbox(), 1);
  assert.equal((await fetch(resourceUri, { headers: { Authorization: `Bearer ${currentDiplomaticToken}` } })).status, 200);

  const persisted = await homeAuthority.server.store.read((state) => state.domain.home as { players: Record<string, { revisions: Record<string, number> }> });
  assert.equal(persisted.players[homeAuthority.actor('player').id]?.revisions[resource.actor('registry').id], 7);

  await homeAuthority.close();
  homeAuthority = undefined;
  await resource.close();
  resource = undefined;
  homeAuthority = await createAuthority(homeAuthorityOptions);
  home = installHome(homeAuthority);
  assert.equal(await home.deriveToken(homeAuthority.actor('player').id, resourceActorId), currentDiplomaticToken);
  await homeAuthority.close();
  homeAuthority = undefined;
  } finally {
    try {
      if (homeAuthority) await homeAuthority.close();
    } finally {
      try {
        if (resource) await resource.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
