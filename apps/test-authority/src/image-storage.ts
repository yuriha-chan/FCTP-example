import { randomBytes } from 'node:crypto';

export interface ImageObjectStorage {
  put(key: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_UPLOAD_JSON_MAX_BYTES = 15 * 1024 * 1024;

const SUPPORTED_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export class ImageValidationError extends Error {}

export function imageObjectKey(): string { return randomBytes(16).toString('hex'); }

export function validateImageUpload(mediaType: unknown, data: unknown): { mediaType: ImageMediaType; bytes: Uint8Array } {
  if (typeof mediaType !== 'string' || !SUPPORTED_MEDIA_TYPES.has(mediaType)) throw new ImageValidationError('unsupported image media type');
  if (typeof data !== 'string' || !isCanonicalBase64(data)) throw new ImageValidationError('image data must be canonical base64');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0) throw new ImageValidationError('image data must not be empty');
  if (bytes.length > IMAGE_MAX_BYTES) throw new ImageValidationError('image data exceeds 10 MiB');
  const type = mediaType as ImageMediaType;
  if (!matchesSignature(type, bytes)) throw new ImageValidationError('image signature does not match media type');
  return { mediaType: type, bytes };
}

function isCanonicalBase64(data: string): boolean {
  if (data.length === 0 || data.length % 4 !== 0) return false;
  if (data.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4) return false;
  return Buffer.from(data, 'base64').toString('base64') === data;
}

function matchesSignature(mediaType: ImageMediaType, bytes: Uint8Array): boolean {
  const data = Buffer.from(bytes);
  switch (mediaType) {
    case 'image/png':
      return data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a;
    case 'image/jpeg':
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case 'image/gif': {
      if (data.length < 6) return false;
      const header = data.toString('ascii', 0, 6);
      return header === 'GIF87a' || header === 'GIF89a';
    }
    case 'image/webp':
      return data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  }
}
