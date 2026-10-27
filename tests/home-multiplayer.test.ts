import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FCTPActor, URI } from '@fctp/protocol';
import type { GeneratedActorKey } from '@fctp/identity';
import { createAuthority } from '../apps/test-authority/src/bootstrap.js';
import { installHome } from '../apps/test-authority/src/home.js';

test('one authority and Home isolates five published Players and their native credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-home-multiplayer-'));
  let authority: Awaited<ReturnType<typeof createAuthority>> | undefined;
  try {
    const port = await availablePort();
    const options = { origin: `http://127.0.0.1:${port}`, storeFile: join(directory, 'authority.json'), playerNames: ['player', 'player-2', 'player-3', 'player-4', 'player-5'] };
    authority = await createAuthority(options);
    assert.deepEqual(Object.keys(authority.players), options.playerNames);
    assert.equal(authority.actor('home').id, `${options.origin}/actors/home`);
    assert.equal(authority.actor('registry').id, `${options.origin}/actors/registry`);
    await authority.listen(port);
    for (const name of options.playerNames) {
      const player: FCTPActor & Record<string, unknown> = authority.players[name]!;
      assert.equal(player.role, 'player');
      assert.equal((await fetch(player.id)).status, 200);
      const key: GeneratedActorKey = authority.keys[name]!;
      const published = await fetch(key.keyPair.id);
      assert.equal(published.status, 200);
      assert.equal((await published.json() as { controller: string }).controller, player.id);
    }
    const firstKeys = JSON.parse(await readFile(`${options.storeFile}.keys`, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(firstKeys).sort(), ['home', 'player', 'player-2', 'player-3', 'player-4', 'player-5', 'registry'].sort());
    const home = installHome(authority);
    const tokens = await Promise.all(options.playerNames.map((name) => home.issueNativeToken(authority!.players[name]!.id)));
    for (let index = 0; index < options.playerNames.length; index++) {
      const playerId: URI = authority.players[options.playerNames[index]!]!.id;
      assert.equal(await home.authenticateNativeToken(tokens[index]!), playerId);
      assert.equal(await home.authenticateNativeToken(`${tokens[index]}x`), undefined);
    }
    assert.equal(await home.authenticateNativeToken('unissued'), undefined);
    const rotated = await home.rotateNativeToken(authority.players['player-3']!.id);
    const resourceId = `${options.origin}/actors/registry`;
    await home.revoke(authority.players['player-3']!.id, { id: resourceId, inbox: `${resourceId}/inbox` });
    assert.equal(await home.authenticateNativeToken(tokens[2]!), undefined);
    assert.equal(await home.authenticateNativeToken(rotated), authority.players['player-3']!.id);
    for (const index of [0, 1, 3, 4]) assert.equal(await home.authenticateNativeToken(tokens[index]!), authority.players[options.playerNames[index]!]!.id);
    await authority.close();
    authority = await createAuthority(options);
    assert.deepEqual(Object.keys(authority.players), options.playerNames);
    const recoveredHome = installHome(authority);
    const persisted = await authority.server.store.read((store) => store.domain.home as { players: Record<string, { revisions: Record<string, number> }> });
    assert.equal(persisted.players[authority.players['player-3']!.id]?.revisions[resourceId], 1);
    for (const index of [0, 1, 3, 4]) assert.deepEqual(persisted.players[authority.players[options.playerNames[index]!]!.id]?.revisions, {});
    assert.equal(await recoveredHome.authenticateNativeToken(rotated), authority.players['player-3']!.id);
    assert.equal(await recoveredHome.authenticateNativeToken(tokens[2]!), undefined);
    for (const index of [0, 1, 3, 4]) assert.equal(await recoveredHome.authenticateNativeToken(tokens[index]!), authority.players[options.playerNames[index]!]!.id);
    await assert.rejects(recoveredHome.issueNativeToken(`${options.origin}/actors/unknown`), /unknown-local-player/);
    await authority.close();
    authority = undefined;
  } finally {
    if (authority) await authority.close();
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
