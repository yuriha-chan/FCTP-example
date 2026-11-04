import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ImageObjectStorage } from './image-storage.js';

export interface S3ImageStorageOptions {
  endpoint: string;
  publicBaseUrl: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

const OPERATION_TIMEOUT_MS = 10_000;

export function validateS3ImageStorageOptions(options: unknown): S3ImageStorageOptions {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Invalid object storage configuration');
  const input = options as Record<string, unknown>;
  const endpoint = validateEndpoint(input.endpoint);
  const publicBaseUrl = validatePublicBaseUrl(input.publicBaseUrl);
  const region = validateText(input.region, 'Invalid object storage region');
  const bucket = validateText(input.bucket, 'Invalid object storage bucket');
  const accessKeyId = validateText(input.accessKeyId, 'Invalid object storage access key');
  const secretAccessKey = validateText(input.secretAccessKey, 'Invalid object storage secret key');
  if (input.forcePathStyle !== undefined && typeof input.forcePathStyle !== 'boolean') throw new TypeError('Invalid object storage forcePathStyle');
  return {
    endpoint,
    publicBaseUrl,
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(input.forcePathStyle === undefined ? {} : { forcePathStyle: input.forcePathStyle })
  };
}

export function createS3ImageStorage(options: S3ImageStorageOptions): ImageObjectStorage {
  const validated = validateS3ImageStorageOptions(options);
  const client = new S3Client({
    endpoint: validated.endpoint,
    region: validated.region,
    credentials: { accessKeyId: validated.accessKeyId, secretAccessKey: validated.secretAccessKey },
    forcePathStyle: validated.forcePathStyle ?? true,
    maxAttempts: 1
  });
  return {
    publicUrl(key): string {
      return `${validated.publicBaseUrl}/${encodeURIComponent(key)}`;
    },
    async put(key, bytes, mediaType): Promise<void> {
      const abortSignal = AbortSignal.timeout(OPERATION_TIMEOUT_MS);
      try {
        await client.send(new PutObjectCommand({ Bucket: validated.bucket, Key: key, Body: bytes, ContentType: mediaType }), { abortSignal });
      } catch {
        throw new Error('image storage put failed');
      }
    }
  };
}

function validateEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('Invalid object storage endpoint');
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError('Invalid object storage endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) throw new TypeError('Invalid object storage endpoint');
  return url.origin;
}

function validatePublicBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('Invalid object storage public base URL');
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError('Invalid object storage public base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('Invalid object storage public base URL');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function validateText(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(message);
  return value;
}
