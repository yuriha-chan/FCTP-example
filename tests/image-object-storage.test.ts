import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createS3ImageStorage, validateS3ImageStorageOptions } from '../apps/test-authority/src/s3-image-storage.js';

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const INITIALIZER_PATH = fileURLToPath(new URL('../docker/authority/init-image-bucket.mjs', import.meta.url));
const INITIALIZER_ACCESS_KEY = 'AKIDINITIALIZEREXAMPLE';
const INITIALIZER_SECRET_KEY = 'initializer-private-secret-access-key';

interface RecordedRequest {
  method: string | undefined;
  pathname: string;
  search: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface S3Fixture {
  endpoint: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

async function startS3Fixture(options: {
  putStatus?: number;
  getStatus?: number;
  hang?: boolean;
  createBucket?: { status: number; code: string; message: string };
} = {}): Promise<S3Fixture> {
  const requests: RecordedRequest[] = [];
  const objects = new Map<string, { body: Buffer; mediaType: string }>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const url = new globalThis.URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    requests.push({ method: request.method, pathname: url.pathname, search: url.search, headers: request.headers, body });
    if (options.hang) return;
    const [, bucket, ...rest] = url.pathname.split('/');
    assert.ok(bucket);
    const key = rest.map((part) => decodeURIComponent(part)).join('/');
    if (request.method === 'PUT' && key === '' && options.createBucket) {
      const { status, code, message } = options.createBucket;
      if (status >= 200 && status < 300) {
        response.writeHead(status);
        response.end();
        return;
      }
      response.writeHead(status, { 'Content-Type': 'application/xml' });
      response.end(`<Error><Code>${code}</Code><Message>${message}</Message></Error>`);
      return;
    }
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

async function runInitializer(fixture: S3Fixture): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'init-image-bucket-'));
  try {
    const accessKeyFile = join(directory, 'access-key');
    const secretKeyFile = join(directory, 'secret-key');
    await writeFile(accessKeyFile, `${INITIALIZER_ACCESS_KEY}\n`);
    await writeFile(secretKeyFile, `${INITIALIZER_SECRET_KEY}\n`);
    const child = spawn(process.execPath, [INITIALIZER_PATH], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        OBJECT_STORAGE_ENDPOINT: fixture.endpoint,
        OBJECT_STORAGE_REGION: 'us-east-1',
        OBJECT_STORAGE_BUCKET: 'image-bucket',
        OBJECT_STORAGE_ACCESS_KEY_FILE: accessKeyFile,
        OBJECT_STORAGE_SECRET_ACCESS_KEY_FILE: secretKeyFile,
        OBJECT_STORAGE_FORCE_PATH_STYLE: 'true'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    assert.ok(stdout && stderr);
    let output = '';
    let errors = '';
    stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Timed out waiting for the image bucket initializer'));
      }, 15_000);
      child.once('error', (error) => { globalThis.clearTimeout(timer); reject(error); });
      child.once('close', (exitCode) => { globalThis.clearTimeout(timer); resolve(exitCode); });
    });
    return { code, stdout: output, stderr: errors };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertInitializerRedacted(result: { stdout: string; stderr: string }): void {
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(output.includes(INITIALIZER_ACCESS_KEY), false, 'access key must not be printed');
  assert.equal(output.includes(INITIALIZER_SECRET_KEY), false, 'secret key must not be printed');
}

function assertSingleBucketCreation(fixture: S3Fixture): void {
  assert.equal(fixture.requests.length, 1, 'the initializer must send the failed operation only once');
  assert.equal(fixture.requests[0]?.method, 'PUT');
  assert.equal(fixture.requests.some((request) => /[?&]policy(?:=|&|$)/i.test(request.search)), false, 'no bucket policy request');
  assert.equal(fixture.requests.some((request) => /PublicRead|BucketPolicy/i.test(request.body.toString('utf8'))), false, 'no public bucket policy body');
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

test('image bucket initializer reports recognized S3 authorization diagnostics without leaking secrets or raw server text', async () => {
  for (const code of ['AccessDenied', 'InvalidAccessKeyId']) {
    const rawMessage = `raw-server-message-${code}`;
    const fixture = await startS3Fixture({ createBucket: { status: 403, code, message: rawMessage } });
    try {
      const result = await runInitializer(fixture);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Unable to initialize image bucket/);
      assert.match(result.stderr, new RegExp(code));
      assert.match(result.stderr, /\b403\b/);
      assert.equal(result.stderr.includes(rawMessage), false, 'raw server message must not be printed');
      assert.equal(result.stdout, '');
      assertInitializerRedacted(result);
      assertSingleBucketCreation(fixture);
    } finally {
      await fixture.close();
    }
  }
});

test('image bucket initializer reports BucketAlreadyExists as a failure with diagnostic metadata', async () => {
  const rawMessage = 'raw-server-message-BucketAlreadyExists';
  const fixture = await startS3Fixture({ createBucket: { status: 409, code: 'BucketAlreadyExists', message: rawMessage } });
  try {
    const result = await runInitializer(fixture);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unable to initialize image bucket/);
    assert.match(result.stderr, /BucketAlreadyExists/);
    assert.match(result.stderr, /\b409\b/);
    assert.equal(result.stderr.includes(rawMessage), false, 'raw server message must not be printed');
    assert.equal(result.stdout, '');
    assertInitializerRedacted(result);
    assertSingleBucketCreation(fixture);
  } finally {
    await fixture.close();
  }
});

test('image bucket initializer keeps BucketAlreadyOwnedByYou as silent success', async () => {
  const fixture = await startS3Fixture({ createBucket: { status: 409, code: 'BucketAlreadyOwnedByYou', message: 'raw-server-message-owned' } });
  try {
    const result = await runInitializer(fixture);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assertInitializerRedacted(result);
    assertSingleBucketCreation(fixture);
  } finally {
    await fixture.close();
  }
});

test('image bucket initializer succeeds silently when the bucket is created', async () => {
  const fixture = await startS3Fixture();
  try {
    const result = await runInitializer(fixture);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assertInitializerRedacted(result);
    assertSingleBucketCreation(fixture);
  } finally {
    await fixture.close();
  }
});

test('image bucket initializer redacts unknown error codes and messages', async () => {
  const code = 'DefinitelyNotAnS3Error';
  const rawMessage = '<script>raw-server-message-unknown</script>';
  const fixture = await startS3Fixture({ createBucket: { status: 400, code, message: rawMessage } });
  try {
    const result = await runInitializer(fixture);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unable to initialize image bucket/);
    assert.match(result.stderr, /UnknownError/);
    assert.equal(result.stderr.includes(code), false, 'unknown server code must not be printed');
    assert.equal(result.stderr.includes(rawMessage), false, 'raw server message must not be printed');
    assert.equal(result.stderr.includes('<script>'), false);
    assert.equal(result.stdout, '');
    assertInitializerRedacted(result);
    assertSingleBucketCreation(fixture);
  } finally {
    await fixture.close();
  }
});
