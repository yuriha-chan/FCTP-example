import type { AccountRecord, AuthoringKind, LibraryEntry } from '@fctp/client-sdk';
import type { ActionReference } from '../actions.js';

const forbiddenDraftFields = new Set(['accountId', 'holder', 'endpoint', 'target']);

const imageMediaTypes: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isImageMediaType(value: unknown): value is ImageMediaType {
  return typeof value === 'string' && imageMediaTypes.has(value);
}

export function imageUploadEndpoint(account: AccountRecord): string {
  return new URL('/local/repository/authoring/images', authoringOrigin(account)).href;
}

export function guardedImageUrl(value: unknown, origin: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.search !== '' || url.hash !== '') return undefined;
  if (url.origin !== origin) return undefined;
  if (!/^\/objects\/players\/[^/]+\/images\/[^/]+$/.test(url.pathname)) return undefined;
  return url.href;
}

function publicationMedia(value: unknown): Array<{ url: string; mediaType: ImageMediaType }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const media = value.flatMap((descriptor) => {
    if (!isRecord(descriptor)) return [];
    const { url, mediaType } = descriptor;
    if (typeof url !== 'string' || !isImageMediaType(mediaType)) return [];
    return [{ url, mediaType }];
  });
  return media.length > 0 ? media : undefined;
}

export function sanitizeDraftFields(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('Draft fields must be an object');
  return Object.fromEntries(Object.entries(value).filter(([key]) => !forbiddenDraftFields.has(key)).map(([key, entry]) => [key, structuredClone(entry)]));
}

export function authoringOrigin(account: AccountRecord): string {
  const reference = account.homeAuthority ?? account.actorId;
  if (reference === undefined) throw new Error('A Home origin is required to issue authoring requests');
  const origin = new URL(reference).origin;
  if (account.login.status === 'signed-in' && new URL(origin).host !== account.login.homeServer) throw new TypeError('Authoring native authentication requires the issuing Home server');
  return origin;
}

export function publicationPath(kind: AuthoringKind): string {
  return kind === 'asset' ? '/local/repository/authoring/assets' : '/local/repository/authoring/varieties';
}

export function publicationEndpoint(account: AccountRecord, kind: AuthoringKind): string {
  return new URL(publicationPath(kind), authoringOrigin(account)).href;
}

export function publicationBody(kind: AuthoringKind, fields: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'asset') {
    const body: Record<string, unknown> = {
      name: typeof fields.name === 'string' ? fields.name : '',
      text: typeof fields.text === 'string' ? fields.text : ''
    };
    const media = publicationMedia(fields.media);
    if (media !== undefined) body.media = media;
    return body;
  }
  const body: Record<string, unknown> = {
    name: typeof fields.name === 'string' ? fields.name : '',
    mass: typeof fields.mass === 'number' ? fields.mass : Number(fields.mass),
    version: typeof fields.version === 'string' ? fields.version : String(fields.version ?? '')
  };
  if (typeof fields.asset === 'string' && fields.asset) body.asset = fields.asset;
  if (Array.isArray(fields.production)) body.production = structuredClone(fields.production);
  return body;
}

export function publicationReferences(payload: unknown): ActionReference[] {
  if (!isRecord(payload)) return [];
  const references: ActionReference[] = [];
  if (isRecord(payload.asset) && typeof payload.asset.id === 'string') references.push({ kind: 'resource', id: payload.asset.id });
  if (isRecord(payload.variety) && typeof payload.variety.id === 'string') references.push({ kind: 'resource', id: payload.variety.id });
  if (isRecord(payload.grant) && typeof payload.grant.id === 'string') references.push({ kind: 'resource', id: payload.grant.id });
  return references;
}

export function publicationObjects(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload)) return [];
  return [payload.asset, payload.variety, payload.grant].filter(isRecord);
}

export function catalogEntries(value: unknown): Pick<LibraryEntry, 'id' | 'type' | 'name' | 'creator' | 'holder' | 'mass' | 'version' | 'asset' | 'variety' | 'grantee' | 'production' | 'media'>[] {
  const items = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.orderedItems)
      ? value.orderedItems
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : [];
  return items.filter(isRecord).flatMap((entry) => {
    if (typeof entry.id !== 'string') return [];
    return [{
      id: entry.id,
      ...(typeof entry.type === 'string' ? { type: entry.type } : {}),
      ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
      ...(Array.isArray(entry.creator) && entry.creator.every((item) => typeof item === 'string') ? { creator: entry.creator } : {}),
      ...(typeof entry.holder === 'string' ? { holder: entry.holder } : {}),
      ...(typeof entry.mass === 'number' ? { mass: entry.mass } : {}),
      ...(typeof entry.version === 'string' ? { version: entry.version } : {}),
      ...(typeof entry.asset === 'string' ? { asset: entry.asset } : {}),
      ...(typeof entry.variety === 'string' ? { variety: entry.variety } : {}),
      ...(typeof entry.grantee === 'string' ? { grantee: entry.grantee } : {}),
      ...(Array.isArray(entry.production) ? { production: entry.production } : {}),
      ...(Array.isArray(entry.media) ? { media: entry.media } : {})
    }];
  });
}

export function catalogData(value: unknown): { assets: LibraryEntry[]; varieties: LibraryEntry[]; grants: LibraryEntry[] } {
  if (!isRecord(value)) return { assets: [], varieties: [], grants: [] };
  const assets = Array.isArray(value.assets) ? value.assets.filter(isRecord) as unknown as LibraryEntry[] : [];
  const varieties = Array.isArray(value.varieties) ? value.varieties.filter(isRecord) as unknown as LibraryEntry[] : [];
  const grants = Array.isArray(value.grants) ? value.grants.filter(isRecord) as unknown as LibraryEntry[] : [];
  return { assets: structuredClone(assets), varieties: structuredClone(varieties), grants: structuredClone(grants) };
}
