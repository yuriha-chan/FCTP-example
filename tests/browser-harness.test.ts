import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { createBrowserSession, type BrowserSession } from '../dist/apps/browser-harness/index.js';

let server: Server;
let origin: string;
let received = '';
const sessions: BrowserSession[] = [];

const page = `<!doctype html><html><head><style>.hidden{display:none}</style><script>
document.addEventListener('DOMContentLoaded', () => {
  document.querySelector('#form').addEventListener('submit', async (event) => {
    event.preventDefault();
    document.documentElement.dataset.clientBusy = 'true';
    const data = new FormData(event.currentTarget);
    await fetch('/submit', {method:'POST', body:data});
    document.querySelector('#status').textContent = 'Saved';
    document.documentElement.dataset.clientBusy = 'false';
  });
  document.querySelector('#nav').addEventListener('click', (event) => {
    if (event.target.matches('a')) return;
    document.querySelector('#status').textContent = 'Clicked';
  });
});
</script></head><body>
 <h1>Isolated form</h1><p>Visible prose <span>with a <a href="/next">nested link</a></span><span class="hidden">hidden descendant</span></p><pre>line one\n  line two</pre>
<div class="hidden">Hidden text</div><script>const concealed='not rendered';</script>
 <form id="form"><label for="name">Name</label><input id="name" name="name"><label for="credential">Credential</label><input id="credential" name="credential" type="password"><label for="choice">Choice</label><select id="choice" name="choice"><option value="a">Alpha</option><option value="b">Beta</option></select><label><input id="enabled" type="checkbox" checked>Enabled</label><button id="submit" type="submit">Save</button><button id="not-submit" type="button">Not submit</button><button id="disabled" disabled>Unavailable</button></form>
<div id="nav"><button id="click">Click handler</button></div><a href="/next">Next page</a><p id="status"></p>
</body></html>`;

before(async () => {
  server = createServer(async (request, response) => {
    if (request.url === '/submit' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = Buffer.concat(chunks).toString();
      response.writeHead(204).end();
      return;
    }
    if (request.url === '/next') {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Second page</h1><a href="/">Home</a>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' }).end(page);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await Promise.all(sessions.map((session) => session.close()));
  server.close();
  await once(server, 'close');
});

test('renders visible DOM, handles real controls, rejects stale refs and isolates sessions', async () => {
  const session = await createBrowserSession({ url: origin, allowedOrigins: [origin] });
  sessions.push(session);
  let result = await session.view();
  assert.match(result.markdown, /# Isolated form/);
  assert.match(result.markdown, /Visible prose/);
  assert.match(result.markdown, /nested link/);
  assert.match(result.markdown, /line one\n\x20{2}line two/);
  assert.doesNotMatch(result.markdown, /Hidden text|concealed|hidden descendant/);
  const nameRef = result.markdown.match(/Name: .*?\[([\da-f]+-[\da-z]+)\]/)?.[1];
  const credentialRef = result.markdown.match(/Credential: .*?\[([\da-f]+-[\da-z]+)\]/)?.[1];
  const selectRef = result.markdown.match(/Choice: .*?\[([\da-f]+-[\da-z]+)\]/)?.[1];
  const submitRef = result.markdown.match(/Save \[([\da-f]+-[\da-z]+)\]/)?.[1];
  const disabledRef = result.markdown.match(/Unavailable \[([\da-f]+-[\da-z]+)\]/)?.[1];
  const notSubmitRef = result.markdown.match(/Not submit \[([\da-f]+-[\da-z]+)\]/)?.[1];
  const clickRef = result.markdown.match(/Click handler \[([\da-f]+-[\da-z]+)\]/)?.[1];
  const linkRef = result.markdown.match(/\[Next page\]\([^)]*\) \[([\da-f]+-[\da-z]+)\]/)?.[1];
  assert(nameRef && credentialRef && selectRef && submitRef && disabledRef && notSubmitRef && clickRef && linkRef);
  await assert.rejects(session.click(disabledRef), /visible enabled/);
  await assert.rejects(session.submit(disabledRef), /visible enabled/);
  await assert.rejects(session.submit(notSubmitRef), /not a submit control/);
  result = await session.fill(nameRef, 'Ada');
  assert.match(result.markdown, /Name: Ada/);
  await assert.rejects(session.fill(nameRef, 'stale'), /stale/);
  result = await session.view();
  const refreshedNameRef = result.markdown.match(/Name: .*?\[([\da-f]+-[\da-z]+)\]/)?.[1];
  const refreshedCredentialRef = result.markdown.match(/Credential: .*?\[([\da-f]+-[\da-z]+)\]/)?.[1];
  const refreshedSelectRef = result.markdown.match(/Choice: .*?\[([\da-f]+-[\da-z]+)\]/)?.[1];
  const refreshedSubmitRef = result.markdown.match(/Save \[([\da-f]+-[\da-z]+)\]/)?.[1];
  const refreshedClickRef = result.markdown.match(/Click handler \[([\da-f]+-[\da-z]+)\]/)?.[1];
  const refreshedLinkRef = result.markdown.match(/\[Next page\]\([^)]*\) \[([\da-f]+-[\da-z]+)\]/)?.[1];
  assert(refreshedNameRef && refreshedCredentialRef && refreshedSelectRef && refreshedSubmitRef && refreshedClickRef && refreshedLinkRef);
  result = await session.fill(refreshedCredentialRef, 'injected-secret');
  assert.doesNotMatch(result.markdown, /injected-secret/);
  const currentSelectRef = result.markdown.match(/Choice: .*?\[([\da-f]+-[\da-z]+)\]/)?.[1];
  assert(currentSelectRef);
  result = await session.select(currentSelectRef, 'b');
  assert.match(result.markdown, /\*Beta=b/);
  const submit = result.markdown.match(/Save \[([\da-f]+-[\da-z]+)\]/)?.[1];
  assert(submit);
  result = await session.submit(submit);
  assert.match(result.markdown, /Saved/);
  assert.match(received, /Ada/);
  assert.match(received, /injected-secret/);
  const click = result.markdown.match(/Click handler \[([\da-f]+-[\da-z]+)\]/)?.[1];
  assert(click);
  result = await session.click(click);
  assert.match(result.markdown, /Clicked/);
  const next = result.markdown.match(/\[Next page\]\([^)]*\) \[([\da-f]+-[\da-z]+)\]/)?.[1];
  assert(next);
  result = await session.click(next);
  assert.match(result.markdown, /# Second page/);
  result = await session.back();
  assert.match(result.markdown, /# Isolated form/);
  result = await session.reload();
  assert.match(result.markdown, /# Isolated form/);
  const checkboxRef = result.markdown.match(/Enabled:.*?\[([\da-f]+-[\da-z]+)\]/)?.[1];
  assert(checkboxRef);
  assert.match(result.markdown, /Enabled:.*\[checked\]/);
  result = await session.click(checkboxRef);
  assert.match(result.markdown, /Enabled:.*\[unchecked\]/);
  const uncheckedCheckboxRef = result.markdown.match(/Enabled:.*?\[([\da-f]+-[\da-z]+)\]/)?.[1];
  assert(uncheckedCheckboxRef);
  result = await session.click(uncheckedCheckboxRef);
  assert.match(result.markdown, /Enabled:.*\[checked\]/);

  const isolated = await createBrowserSession({ url: origin, allowedOrigins: [origin] });
  sessions.push(isolated);
  assert.doesNotMatch((await isolated.view()).markdown, /Ada|injected-secret/);
  await assert.rejects(createBrowserSession({ url: origin, allowedOrigins: ['https://example.invalid'] }), /not allowed/);
});
