import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import test from 'node:test';
import { createS3ImageStorage, validateS3ImageStorageOptions } from '../apps/test-authority/src/s3-image-storage.js';

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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

async function startS3Fixture(options: { putStatus?: number; getStatus?: number; hang?: boolean } = {}): Promise<S3Fixture> {
  const requests: RecordedRequest[] = [];
  const objects = new Map<string, { body: Buffer; mediaType: string }>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const url = new globalThis.URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    requests.push({ method: request.method, pathname: url.pathname, headers: request.headers, body });
    if (options.hang) return;
    const [, bucket, ...rest] = url.pathname.split('/');
    assert.ok(bucket);
    const key = rest.map((part) => decodeURIComponent(part)).join('/');
    if (request.method === 'PUT') {
      const status = options.putStatus ?? 200;
      if (status !== 200) {
        response.writeHead(status, { 'Content-Type': 'application/xml' });
        response.end('<Error><Code>InternalError</Code></Error>');
        return;
      }
      const mediaType = request.headers['content-type'] ?? 'application/octet-stream';
      objects.set(key, { body, mediaType });
      response.writeHead(200, { ETag: `"${Buffer.byteLength(body)}"` });
      response.end();
      return;
    }
    if (request.method === 'GET') {
      const status = options.getStatus ?? 200;
      if (status !== 200) {
        response.writeHead(status, { 'Content-Type': 'application/xml' });
        response.end('<Error><Code>InternalError</Code></Error>');
        return;
      }
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

function assertSignedS3Authorization(value: string | undefined, expected: { accessKeyId: string; region: string }): void {
  assert.equal(typeof value, 'string');
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(value ?? '');
  assert.ok(match, `unexpected Authorization header: ${String(value)}`);
  assert.equal(match[1], expected.accessKeyId);
  assert.equal(match[3], expected.region);
  assert.ok(match[4]!.split(';').includes('host'), 'signature covers the host header');
}

test('S3 image storage validates explicit endpoint, region, bucket, and credentials', async () => {
  await validateS3ImageStorageOptions({
    endpoint: 'https://objects.example.test:9443',
    region: 'eu-west-2',
    bucket: 'image-bucket',
    accessKeyId: 'access-key',
    secretAccessKey: 'secret-key',
    forcePathStyle: true
  });
  for (const invalid of [
    undefined,
    {},
    { endpoint: 'objects.example.test', region: 'eu-west-2', bucket: 'image-bucket', accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
    { endpoint: '/objects', region: 'eu-west-2', bucket: 'image-bucket', accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
    { endpoint: 'ftp://objects.example.test', region: 'eu-west-2', bucket: 'image-bucket', accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
    { endpoint: 'https://user:password@objects.example.test', region: 'eu-west-2', bucket: 'image-bucket', accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
    { endpoint: 'https://objects.example.test?policy=public', region: 'eu-west-2', bucket: 'image-bucket', accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
    { endpoint: 'https://objects.example.test#fragment', region: 'eu-west-2', bucket: 'image-bucket', accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
    { endpoint: 'https://objects.example.test', region: '', bucket: 'image-bucket', accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
    { endpoint: 'https://objects.example.test', region: 'eu-west-2', bucket: '', accessKeyId: 'access-key', secretAccessKey: 'secret-key' },
    { endpoint: 'https://objects.example.test', region: 'eu-west-2', bucket: 'image-bucket', accessKeyId: '', secretAccessKey: 'secret-key' },
    { endpoint: 'https://objects.example.test', region: 'eu-west-2', bucket: 'image-bucket', accessKeyId: 'access-key', secretAccessKey: '' },
    { endpoint: 'https://objects.example.test', region: 'eu-west-2', bucket: 'image-bucket', accessKeyId: 'access-key', secretAccessKey: 'secret-key', forcePathStyle: 'yes' }
  ]) {
    await assert.rejects(async () => { await validateS3ImageStorageOptions(invalid as never); }, TypeError);
  }
});

test('S3 image storage puts and gets exact bytes through a signed path-style request', async () => {
  const fixture = await startS3Fixture();
  try {
    const storage = createS3ImageStorage({
      endpoint: fixture.endpoint,
      region: 'eu-west-2',
      bucket: 'image-bucket',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'SECRETKEYEXAMPLE'
    });
    await storage.put('images/hello world.png', TINY_PNG, 'image/png');
    const put = fixture.requests.find((request) => request.method === 'PUT');
    assert.ok(put);
    assert.equal(put.pathname, '/image-bucket/images/hello%20world.png');
    assert.equal(put.headers['content-type'], 'image/png');
    assert.deepEqual(put.body, TINY_PNG);
    assertSignedS3Authorization(put.headers.authorization, { accessKeyId: 'AKIDEXAMPLE', region: 'eu-west-2' });

    const read = await storage.get('images/hello world.png');
    assert.deepEqual(Buffer.from(read), TINY_PNG);
    const get = fixture.requests.find((request) => request.method === 'GET');
    assert.ok(get);
    assert.equal(get.pathname, '/image-bucket/images/hello%20world.png');
    assertSignedS3Authorization(get.headers.authorization, { accessKeyId: 'AKIDEXAMPLE', region: 'eu-west-2' });
  } finally {
    await fixture.close();
  }
});

test('S3 image storage rejects failed operations without retrying or exposing the secret key', async () => {
  const fixture = await startS3Fixture({ putStatus: 503, getStatus: 500 });
  try {
    const secretAccessKey = 'private-secret-access-key';
    const storage = createS3ImageStorage({
      endpoint: fixture.endpoint,
      region: 'us-east-1',
      bucket: 'image-bucket',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey
    });
    await assert.rejects(storage.put('images/failure.png', TINY_PNG, 'image/png'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(secretAccessKey), false);
      return true;
    });
    assert.equal(fixture.requests.filter((request) => request.method === 'PUT').length, 1);
    await assert.rejects(storage.get('images/failure.png'));
    assert.equal(fixture.requests.filter((request) => request.method === 'GET').length, 1);
  } finally {
    await fixture.close();
  }
});

test('S3 image storage bounds a stalled operation', { timeout: 15_000 }, async () => {
  const fixture = await startS3Fixture({ hang: true });
  try {
    const storage = createS3ImageStorage({
      endpoint: fixture.endpoint,
      region: 'us-east-1',
      bucket: 'image-bucket',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'SECRETKEYEXAMPLE'
    });
    const started = Date.now();
    await assert.rejects(storage.put('images/stalled.png', TINY_PNG, 'image/png'));
    assert.ok(Date.now() - started < 14_000, 'operation is bounded near ten seconds');
  } finally {
    await fixture.close();
  }
});
