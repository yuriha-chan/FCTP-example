import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createActivity } from '@fctp/federation';
import { createLocalDocumentLoader, verifyProofCryptography } from '@fctp/identity';
import { createAuthority } from '../apps/test-authority/src/bootstrap.js';

test('authority persists private keys, publishes public keys, discovers Actors, and routes inboxes separately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const options = { origin, storeFile: join(directory, 'authority.json'), adminSecret: 'authority-admin-secret' };
  let authority = await createAuthority(options);
  await authority.listen(port);
  const persisted = JSON.parse(await readFile(`${options.storeFile}.keys`, 'utf8')) as Record<string, { id: string; secretKeyMultibase: string }>;
  const mode = (await stat(`${options.storeFile}.keys`)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.ok(Object.values(persisted).every((key) => key.secretKeyMultibase));

  const registryKeyUri = authority.key('registry').keyPair.id;
  const keyResponse = await fetch(registryKeyUri);
  assert.equal(keyResponse.status, 200);
  const publicKey = await keyResponse.json() as Record<string, unknown>;
  assert.equal(publicKey.id, registryKeyUri);
  assert.equal(publicKey.controller, authority.actor('registry').id);
  assert.equal('secretKeyMultibase' in publicKey, false);

  for (const role of ['registry', 'home', 'player'] as const) {
    const actorResponse = await fetch(authority.actor(role).id);
    assert.equal(actorResponse.status, 200);
    assert.equal((await actorResponse.json() as Record<string, unknown>).id, authority.actor(role).id);
  }
  const webfinger = new URL('/.well-known/webfinger', origin);
  webfinger.searchParams.set('resource', `acct:@registry.registry@127.0.0.1:${port}`);
  const discovery = await fetch(webfinger);
  assert.equal(discovery.status, 200);
  assert.equal((await discovery.json() as { links: Array<{ href: string }> }).links[0]?.href, authority.actor('registry').id);

  const dispatched: string[] = [];
  authority.server.on(authority.actor('registry').id, 'RegistryMessage', async () => { dispatched.push('registry'); });
  authority.server.on(authority.actor('home').id, 'HomeMessage', async () => { dispatched.push('home'); });
  await authority.server.receive(authority.actor('registry').id, createActivity({
    id: `${origin}/activities/registry`, actor: `${origin}/remote`, object: { id: `${origin}/objects/registry`, type: 'RegistryMessage' }, to: authority.actor('registry').id
  }));
  await authority.server.receive(authority.actor('home').id, createActivity({
    id: `${origin}/activities/home`, actor: `${origin}/remote`, object: { id: `${origin}/objects/home`, type: 'HomeMessage' }, to: authority.actor('home').id
  }));
  assert.equal(await authority.server.processInbox(), 2);
  assert.deepEqual(dispatched, ['registry', 'home']);

  const remoteInbox = `${origin}/remote/inbox`;
  const signed = await authority.server.publish(authority.actor('registry').id, `${origin}/remote`, remoteInbox, {
    id: `${origin}/objects/outbound`, type: 'RegistryMessage'
  }, `${origin}/activities/outbound`);
  const verification = await verifyProofCryptography(signed as unknown as Record<string, unknown>, createLocalDocumentLoader(new Map([[registryKeyUri, publicKey]])));
  assert.equal(verification.verified, true);

  await authority.close();
  authority = await createAuthority(options);
  assert.equal(authority.key('registry').keyPair.id, registryKeyUri);
  assert.deepEqual(await authority.key('registry').keyPair.export({ publicKey: true, includeContext: true }), publicKey);
  await authority.listen(port);
  await authority.close();
  await rm(directory, { recursive: true, force: true });
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
