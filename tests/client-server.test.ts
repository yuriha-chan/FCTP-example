import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startClientServer } from '../apps/demo/src/client-server.js';

test('serves the existing browser client and public config on an isolated port', async () => {
  const config = {
    origins: { authority: 'http://authority.example', policy: 'http://policy.example', simulation: 'http://simulation.example' },
    actors: { registry: 'https://authority.example/registry', home: 'https://authority.example/home', player: 'https://authority.example/player', policy: 'https://policy.example/actor', simulation: 'https://simulation.example/actor' }
  };
  const client = await startClientServer({ port: 0, config });
  try {
    const html = await fetch(client.origin);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /href=["']\/styles\.css["']/);
    const stylesheet = await fetch(new URL('/styles.css', client.origin));
    assert.equal(stylesheet.status, 200);
    assert.ok((await stylesheet.text()).length > 0);
    const bundle = await fetch(new URL('/dist/client/main.js', client.origin));
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type') ?? '', /javascript/);
    assert.ok((await bundle.text()).length > 0);
    const configResponse = await fetch(new URL('/config.json', client.origin));
    assert.equal(configResponse.status, 200);
    assert.equal(configResponse.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await configResponse.json(), config);
    assert.equal((await fetch(new URL('/package.json', client.origin))).status, 404);
    assert.equal((await fetch(new URL('/../../package.json', client.origin))).status, 404);
  } finally {
    await client.close();
  }
  await assert.rejects(fetch(new URL('/config.json', client.origin)));
});
