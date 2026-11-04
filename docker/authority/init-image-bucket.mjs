import { readFile } from 'node:fs/promises';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';

const OPERATION_TIMEOUT_MS = 10_000;

function required(name) {
  const value = globalThis.process.env[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${name}`);
  return value;
}

async function readSecret(path) {
  const value = (await readFile(path, 'utf8')).replace(/\r?\n$/, '');
  if (!value) throw new Error('Empty object storage secret file');
  return value;
}

function forcePathStyle() {
  const value = globalThis.process.env.OBJECT_STORAGE_FORCE_PATH_STYLE;
  if (value === undefined) return true;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('Invalid OBJECT_STORAGE_FORCE_PATH_STYLE');
}

function endpoint(value) {
  let url;
  try { url = new globalThis.URL(value); } catch { throw new Error('Invalid OBJECT_STORAGE_ENDPOINT'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) throw new Error('Invalid OBJECT_STORAGE_ENDPOINT');
  return url.origin;
}

async function main() {
  const region = required('OBJECT_STORAGE_REGION');
  const bucket = required('OBJECT_STORAGE_BUCKET');
  const accessKeyId = await readSecret(required('OBJECT_STORAGE_ACCESS_KEY_FILE'));
  const secretAccessKey = await readSecret(required('OBJECT_STORAGE_SECRET_ACCESS_KEY_FILE'));
  const client = new S3Client({
    endpoint: endpoint(required('OBJECT_STORAGE_ENDPOINT')),
    region,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: forcePathStyle(),
    maxAttempts: 1
  });
  try {
    await client.send(new CreateBucketCommand({
      Bucket: bucket,
      ...(region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: region } })
    }), { abortSignal: globalThis.AbortSignal.timeout(OPERATION_TIMEOUT_MS) });
  } catch (error) {
    const name = error && typeof error === 'object' ? error.name : undefined;
    if (name !== 'BucketAlreadyOwnedByYou') throw new Error('Unable to initialize image bucket');
  } finally {
    client.destroy();
  }
}

try {
  await main();
} catch (error) {
  globalThis.console.error(error instanceof Error ? error.message : 'Unable to initialize image bucket');
  globalThis.process.exitCode = 1;
}
