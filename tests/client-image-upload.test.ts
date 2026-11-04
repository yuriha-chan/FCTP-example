import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalDocumentLoader, verifyProofCryptography } from '@fctp/identity';
import { actionIsComplete } from '@fctp/client-sdk';
import type { ActionRecord } from '@fctp/client-sdk';
import { createClientApplication } from '../apps/client-server/src/app.js';
import { startClientServer } from '../apps/demo/src/client-server.js';
import { createAuthorityApp } from '../apps/test-authority/src/app.js';

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_MEDIA_TYPE = 'image/png';
const REGION = 'eu-west-2';
const BUCKET = 'private-images';
const ACCESS_KEY_ID = 'AKIDIMAGEINTEGRATION';
const SECRET_ACCESS_KEY = 'image-integration-secret-access-key';
const ADMIN_SECRET = 'image-integration-admin';
const PLAYER = 'sana';
const PASSWORD = 'sana-password';

interface RecordedRequest {
  method: string | undefined;
  pathname: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface S3Fixture {
  endpoint: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

interface HttpResult {
  status: number;
  text: string;
  body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  assert.ok(isRecord(value), `${label}: ${JSON.stringify(value)}`);
  return value;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startS3Fixture(): Promise<S3Fixture> {
  const requests: RecordedRequest[] = [];
  const objects = new Map<string, { body: Buffer; mediaType: string }>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    requests.push({ method: request.method, pathname: url.pathname, headers: request.headers, body });
    const [, bucket, ...rest] = url.pathname.split('/');
    assert.ok(bucket);
    const key = rest.map((part) => decodeURIComponent(part)).join('/');
    if (request.method === 'PUT') {
      const mediaType = request.headers['content-type'] ?? 'application/octet-stream';
      objects.set(key, { body, mediaType });
      response.writeHead(200, { ETag: `"${body.byteLength}"` });
      response.end();
      return;
    }
    if (request.method === 'GET') {
      const stored = objects.get(key);
      if (!stored) {
        response.writeHead(404, { 'Content-Type': 'application/xml' });
        response.end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      response.writeHead(200, { 'Content-Type': stored.mediaType, 'Content-Length': String(stored.body.byteLength) });
      response.end(stored.body);
      return;
    }
    response.writeHead(400, { 'Content-Type': 'application/xml' });
    response.end('<Error><Code>BadRequest</Code></Error>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function assertSignedS3Authorization(value: string | undefined): void {
  assert.equal(typeof value, 'string');
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(value ?? '');
  assert.ok(match, `unexpected Authorization header: ${String(value)}`);
  assert.equal(match[1], ACCESS_KEY_ID);
  assert.equal(match[3], REGION);
  assert.ok(match[4]!.split(';').includes('host'), 'signature covers the host header');
}

async function readResponse(response: Response): Promise<HttpResult> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: response.status, text, body };
}

async function postJson(url: URL, token: string | undefined, body: unknown): Promise<HttpResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  return readResponse(await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) }));
}

function draftFrom(body: unknown): Record<string, unknown> {
  const draft = requireRecord(requireRecord(body, 'draft response').draft, 'draft');
  return draft;
}

function actionFrom(body: unknown): ActionRecord {
  return requireRecord(requireRecord(body, 'action response').action, 'action') as unknown as ActionRecord;
}

function requestCount(fixture: S3Fixture, method: string): number {
  return fixture.requests.filter((request) => request.method === method).length;
}

test('image upload flows through real Authority S3 storage and the running Client from login to public read', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fctp-image-client-e2e-'));
  const fixture = await startS3Fixture();
  const authorityPort = await freePort();
  const authorityOrigin = `http://127.0.0.1:${authorityPort}`;
  let authority: Awaited<ReturnType<typeof createAuthorityApp>> | undefined;
  let application: Awaited<ReturnType<typeof createClientApplication>> | undefined;
  let client: Awaited<ReturnType<typeof startClientServer>> | undefined;
  try {
    const authorityApp = await createAuthorityApp({
      origin: authorityOrigin,
      storeFile: join(directory, 'authority.json'),
      adminSecret: ADMIN_SECRET,
      playerNames: [PLAYER],
      accountPasswords: { [PLAYER]: PASSWORD },
      objectStorage: {
        endpoint: fixture.endpoint,
        region: REGION,
        bucket: BUCKET,
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY
      }
    });
    authority = authorityApp;
    await authorityApp.authority.listen(authorityPort, '127.0.0.1');

    const clientApplication = await createClientApplication({ storeFile: join(directory, 'client.json') });
    application = clientApplication;
    const clientServer = await startClientServer({ port: 0, application: clientApplication });
    client = clientServer;

    const handle = `@${PLAYER}@${new URL(authorityOrigin).host}`;
    const login = await postJson(new URL('/api/accounts/login', clientServer.origin), undefined, { handle, password: PASSWORD });
    assert.equal(login.status, 200, login.text);
    const loginBody = requireRecord(login.body, 'login response');
    assert.equal(loginBody.status, 'signed-in');
    const accountId = String(requireRecord(loginBody.account, 'login account').id);
    const clientToken = String(loginBody.clientToken);
    const account = await clientApplication.state.read((current) => current.accounts[accountId]);
    assert.ok(account && account.login.status === 'signed-in', 'login retains the native credential only inside the client store');
    const nativeToken = account.login.nativeToken;

    const created = await postJson(new URL('/api/drafts', clientServer.origin), clientToken, {
      accountId,
      kind: 'asset',
      fields: { name: 'Harbor Image', text: '' }
    });
    assert.equal(created.status, 201, created.text);
    const draftId = String(draftFrom(created.body).id);

    const upload = await postJson(new URL(`/api/drafts/${encodeURIComponent(draftId)}/images`, clientServer.origin), clientToken, {
      accountId,
      mediaType: PNG_MEDIA_TYPE,
      data: TINY_PNG.toString('base64')
    });
    assert.equal(upload.status, 201, upload.text);
    const descriptorBody = requireRecord(upload.body, 'upload descriptor');
    assert.deepEqual(Object.keys(descriptorBody).sort(), ['mediaType', 'url'], 'the upload returns only the canonical descriptor');
    assert.equal(descriptorBody.mediaType, PNG_MEDIA_TYPE);
    assert.equal(typeof descriptorBody.url, 'string');
    const descriptor = { url: String(descriptorBody.url), mediaType: PNG_MEDIA_TYPE };
    const descriptorUrl = new URL(descriptor.url);
    assert.equal(descriptorUrl.origin, authorityOrigin, 'the descriptor points at the canonical Repository origin, not object storage');
    assert.match(descriptorUrl.pathname, new RegExp(`^/objects/players/${PLAYER}/images/[0-9a-f]{32}$`));
    assert.equal(descriptorUrl.search, '');
    assert.equal(descriptorUrl.hash, '');
    assert.equal(descriptorUrl.href.includes(fixture.endpoint), false);

    assert.equal(requestCount(fixture, 'PUT'), 1, 'the upload performs exactly one S3 PUT without retry');
    const put = fixture.requests.find((request) => request.method === 'PUT');
    assert.ok(put);
    const putMatch = new RegExp(`^/${BUCKET}/([0-9a-f]{32})$`).exec(put.pathname);
    assert.ok(putMatch, `unexpected S3 PUT path ${put.pathname}`);
    const storageKey = putMatch[1]!;
    assert.equal(put.headers['content-type'], PNG_MEDIA_TYPE);
    assert.equal(put.headers['x-amz-acl'], undefined, 'the bucket object is written without a public ACL');
    assert.deepEqual(put.body, TINY_PNG);
    assertSignedS3Authorization(put.headers.authorization);
    assert.equal(requestCount(fixture, 'GET'), 0, 'upload does not read stored bytes');

    const saved = await postJson(new URL(`/api/drafts/${encodeURIComponent(draftId)}`, clientServer.origin), clientToken, {
      accountId,
      fields: { name: 'Harbor Image', text: '', media: [descriptor] }
    });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(requireRecord(draftFrom(saved.body).fields, 'saved fields').media, [descriptor]);

    const anonymous = await readResponse(await fetch(descriptorUrl));
    assert.equal(anonymous.status, 401, 'an unpublished image is not anonymously readable');
    assert.equal(requestCount(fixture, 'GET'), 0, 'a denied private read never reaches object storage or exposes bytes');

    const preview = await postJson(new URL(`/api/drafts/${encodeURIComponent(draftId)}/images/read`, clientServer.origin), clientToken, {
      accountId,
      url: descriptor.url
    });
    assert.equal(preview.status, 200, preview.text);
    const previewBody = requireRecord(preview.body, 'preview response');
    assert.equal(previewBody.mediaType, PNG_MEDIA_TYPE);
    assert.equal(previewBody.data, TINY_PNG.toString('base64'), 'the owner preview returns the exact uploaded bytes');
    assert.equal(requestCount(fixture, 'GET'), 1, 'the owner preview performs exactly one S3 GET without retry');
    const previewGet = fixture.requests.find((request) => request.method === 'GET');
    assert.ok(previewGet);
    assert.equal(previewGet.pathname, `/${BUCKET}/${storageKey}`);
    assertSignedS3Authorization(previewGet.headers.authorization);

    const publication = await postJson(new URL(`/api/drafts/${encodeURIComponent(draftId)}/publish`, clientServer.origin), clientToken, { accountId });
    assert.equal(publication.status, 200, publication.text);
    const action = actionFrom(publication.body);
    assert.equal(action.submission.status, 'accepted');
    assert.equal(actionIsComplete(action), false, 'HTTP acceptance alone is not publication completion');
    const assetReference = action.resultReferences.find((reference) => reference.kind === 'resource');
    assert.ok(assetReference, 'publication retains the signed Asset identity');
    assert.equal(requestCount(fixture, 'PUT'), 1, 'publication never re-uploads object bytes');
    const getsAfterPublication = requestCount(fixture, 'GET');
    assert.equal(getsAfterPublication, 2, 'publication exposes the image through one normal media observation without retry');
    for (const get of fixture.requests.filter((request) => request.method === 'GET')) {
      assert.equal(get.pathname, `/${BUCKET}/${storageKey}`);
      assertSignedS3Authorization(get.headers.authorization);
    }

    const refresh = await postJson(new URL(`/api/activity/${encodeURIComponent(action.id)}/refresh`, clientServer.origin), clientToken, { accountId });
    assert.equal(refresh.status, 200, refresh.text);
    const refreshed = requireRecord(requireRecord(refresh.body, 'refresh response').data, 'refresh data').action as unknown as ActionRecord;
    assert.equal(actionIsComplete(refreshed), true, 'an explicit Action refresh records completed publication evidence');
    assert.equal(refreshed.outcome.status, 'completed');
    assert.ok(refreshed.outcome.evidence.some((evidence) => evidence.source === assetReference.id));
    assert.equal(requestCount(fixture, 'PUT'), 1, 'Action refresh does not resubmit or retry publication');
    assert.equal(requestCount(fixture, 'GET'), getsAfterPublication, 'Action refresh does not refetch the image');

    const assetResult = await readResponse(await fetch(assetReference.id, { headers: { Accept: 'application/ld+json, application/json' } }));
    assert.equal(assetResult.status, 200, assetResult.text);
    const asset = requireRecord(assetResult.body, 'signed Asset');
    assert.equal(asset.type, 'Asset');
    assert.equal(asset.id, assetReference.id);
    assert.equal(asset.holder, authorityApp.ids.players[PLAYER]);
    const media = Array.isArray(asset.media) ? asset.media.filter(isRecord) : [];
    const imageMedia = media.find((entry) => entry.url === descriptor.url);
    assert.ok(imageMedia, 'the signed Asset references the exact uploaded image URL');
    assert.equal(imageMedia.mediaType, PNG_MEDIA_TYPE);
    assert.equal(media.some((entry) => entry.mediaType === 'text/plain'), false, 'blank text does not add an empty text descriptor');
    assert.equal(new URL(descriptor.url).search, '', 'the public media reference is stable and not an expiring URL');
    const key = requireRecord((await readResponse(await fetch(`${authorityOrigin}/keys/${PLAYER}`))).body, 'player key');
    const loader = createLocalDocumentLoader(new Map([[String(key.id), key]]));
    assert.equal((await verifyProofCryptography(asset, loader)).verified, true, 'the published Asset proof is cryptographically signed');

    const publicImage = await fetch(descriptorUrl);
    assert.equal(publicImage.status, 200, 'the published image is publicly readable');
    assert.equal(publicImage.headers.get('content-type'), PNG_MEDIA_TYPE);
    assert.equal(publicImage.headers.get('x-content-type-options'), 'nosniff');
    assert.match(publicImage.headers.get('cache-control') ?? '', /public/);
    assert.deepEqual(Buffer.from(await publicImage.arrayBuffer()), TINY_PNG, 'the public image returns the exact uploaded bytes');
    assert.equal(requestCount(fixture, 'GET'), getsAfterPublication + 1, 'the public read performs exactly one additional S3 GET without retry');

    const results: Array<[string, HttpResult]> = [
      ['login', login],
      ['draft', created],
      ['upload', upload],
      ['save', saved],
      ['anonymous denial', anonymous],
      ['preview', preview],
      ['publication', publication],
      ['refresh', refresh],
      ['signed Asset', assetResult]
    ];
    for (const [label, result] of results) {
      for (const secret of [ACCESS_KEY_ID, SECRET_ACCESS_KEY, nativeToken, storageKey]) {
        assert.equal(result.text.includes(secret), false, `${label} must not expose S3 or native credentials`);
      }
    }
  } finally {
    await client?.close();
    await application?.close();
    await authority?.authority.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
