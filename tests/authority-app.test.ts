import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalDocumentLoader, verifyProofCryptography } from '@fctp/identity';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';

test('authority app discovers Actors, issues native credentials, and publishes a signed Registry entry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-app-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let published: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input) === 'https://territory.test/inbox' && init?.method === 'POST') {
      published = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response('{}', { status: 202 });
    }
    if (String(input) === 'https://territory.test/actors/territory') {
      return Response.json({ id: 'https://territory.test/actors/territory', inbox: 'https://territory.test/inbox' });
    }
    return fetch(input, init);
  };
  const app = await createAuthorityApp({ origin, storeFile: join(directory, 'authority.json'), adminSecret: 'local-admin-secret', fetcher });
  try {
    await app.authority.listen(port);
    const actorResponse = await fetch(app.ids.actor.registry);
    assert.equal(actorResponse.status, 200);
    assert.equal((await actorResponse.json() as { id: string }).id, app.ids.actor.registry);

    const infoResponse = await fetch(`${origin}/local/info`);
    assert.equal(infoResponse.status, 200);
    const info = await infoResponse.json() as Record<string, unknown>;
    assert.equal(info.kind, 'authority');
    assert.equal(JSON.stringify(info).includes('local-admin-secret'), false);

    const vesselResponse = await fetch(app.ids.vessel);
    assert.equal(vesselResponse.status, 200);
    assert.equal((await vesselResponse.json() as { id: string }).id, app.ids.vessel);

    const issueDenied = await fetch(`${origin}/local/home/issue`, { method: 'POST' });
    assert.equal(issueDenied.status, 401);
    const issueResponse = await fetch(`${origin}/local/home/issue`, { method: 'POST', headers: { Authorization: 'Bearer local-admin-secret', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(issueResponse.status, 200);
    assert.equal(typeof (await issueResponse.json() as { nativeToken: unknown }).nativeToken, 'string');

    const entryResponse = await fetch(`${origin}/local/registry/entry`, {
      method: 'POST',
      headers: { Authorization: 'Bearer local-admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ territory: 'https://territory.test/actors/territory', port: 'https://territory.test/objects/ports/main', route: 'https://territory.test/objects/routes/approach' })
    });
    assert.equal(entryResponse.status, 202);
    assert.equal(await app.authority.server.processOutbox(), 1);
    assert.ok(published);
    const keyId = app.authority.key('registry').keyPair.id;
    const key = await fetch(keyId).then((response) => response.json()) as Record<string, unknown>;
    const verification = await verifyProofCryptography(published, createLocalDocumentLoader(new Map([[keyId, key]])));
    assert.equal(verification.verified, true);
    const envelope = published as { object?: { type?: string; vessel?: { id?: string } } };
    assert.equal(envelope.object?.type, 'EntryRequest');
    assert.equal(envelope.object?.vessel?.id, app.ids.vessel);
  } finally {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('authority app preserves persisted Registry adoption when restarted without an option', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-authority-adoption-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const storeFile = join(directory, 'authority.json');
  let app = await createAuthorityApp({ origin, storeFile, adminSecret: 'local-admin-secret' });
  try {
    assert.equal((await app.registry.state()).adoption, true);
    await app.registry.switchAdoption(false);
    await app.authority.close();
    app = await createAuthorityApp({ origin, storeFile, adminSecret: 'local-admin-secret' });
    assert.equal((await app.registry.state()).adoption, false);
  } finally {
    await app.authority.close();
    await rm(directory, { recursive: true, force: true });
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
