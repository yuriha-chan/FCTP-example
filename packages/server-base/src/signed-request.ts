import type { IncomingMessage } from 'node:http';
import { resolveActor } from '@fctp/identity';
import type { FCTPActor, URI } from '@fctp/protocol';
import { verifyPublishedDocument } from './verification.js';

export const ACCOUNT_HEADER = 'x-fctp-account';
export const SIGNED_REQUEST_HEADER = 'x-fctp-signed-request';
const MAX_REQUEST_AGE_MS = 5 * 60_000;

export function accountIdFromRequest(request: IncomingMessage): URI | undefined {
  const value = request.headers[ACCOUNT_HEADER];
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return absoluteHttpUri(value, false);
}

export function encodeSignedRequest(document: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(document), 'utf8').toString('base64url');
}

export interface VerifiedSignedRequest {
  actorId: URI;
  objectId: URI;
  actor: FCTPActor;
  document: Record<string, unknown>;
}

export async function verifySignedRequest(
  encoded: string,
  requestUrl: string,
  fetcher: typeof fetch = fetch
): Promise<VerifiedSignedRequest | undefined> {
  if (encoded.length === 0 || encoded.length > 16_384) return undefined;
  let document: unknown;
  try {
    document = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(document) || document.type !== 'TokenDigestRequest') return undefined;
  const actorId = absoluteHttpUri(document.actor, false);
  const objectId = absoluteHttpUri(document.object, false);
  const target = absoluteHttpUri(document.target, true);
  const requestId = absoluteHttpUri(document.id, false);
  if (actorId === undefined || objectId === undefined || target === undefined || requestId === undefined) return undefined;
  if (target !== requestUrl) return undefined;
  if (typeof document.published !== 'string') return undefined;
  const published = Date.parse(document.published);
  if (!Number.isFinite(published) || Math.abs(Date.now() - published) > MAX_REQUEST_AGE_MS) return undefined;

  const boundedFetcher: typeof fetch = (input, init) => fetcher(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000)
  });
  const report = await verifyPublishedDocument(document, actorId, actorId, boundedFetcher);
  if (!report.cryptographic.verified || !report.attribution.attributed) return undefined;

  let actor: FCTPActor;
  try {
    actor = (await resolveActor(actorId, boundedFetcher)).actor;
  } catch {
    return undefined;
  }
  if (actor.id !== actorId || typeof actor.inbox !== 'string') return undefined;
  return { actorId, objectId, actor, document };
}

function absoluteHttpUri(value: unknown, allowQuery: boolean): URI | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return undefined;
  if (!allowQuery && url.search) return undefined;
  return value as URI;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
