import * as Ed25519Multikey from '@digitalbazaar/ed25519-multikey';
import { DataIntegrityProof } from '@digitalbazaar/data-integrity';
import { cryptosuite } from '@digitalbazaar/eddsa-rdfc-2022-cryptosuite';
import integrityContexts from '@digitalbazaar/data-integrity-context';
import multikeyContexts from '@digitalbazaar/multikey-context';
import jsigs from 'jsonld-signatures';
import type { FCTPActor, URI } from '@fctp/protocol';

export type JsonDocument = Record<string, unknown>;
export type DocumentLoader = (url: string) => Promise<{ contextUrl: string | null; document: JsonDocument; documentUrl: string }>;

export const FCTP_CONTEXT = 'https://fctp.example/context';
export const AS_CONTEXT = 'https://www.w3.org/ns/activitystreams';
export const DI_CONTEXT = 'https://w3id.org/security/data-integrity/v2';
export const MULTIKEY_CONTEXT = 'https://w3id.org/security/multikey/v1';
export const DID_CONTEXT = 'https://www.w3.org/ns/did/v1';

const fctpTerms = {
  '@vocab': 'https://fctp.example/ns#',
  fctp: 'https://fctp.example/ns#',
  id: '@id', type: '@type', name: 'https://schema.org/name', role: 'fctp:role', inbox: { '@id': 'as:inbox', '@type': '@id' },
  outbox: { '@id': 'as:outbox', '@type': '@id' }, publicKeys: { '@id': 'fctp:publicKeys', '@type': '@id', '@container': '@set' },
  territory: { '@id': 'fctp:territory', '@type': '@id' }, port: { '@id': 'fctp:port', '@type': '@id' }, area: { '@id': 'fctp:area', '@type': '@id' },
  route: { '@id': 'fctp:route', '@type': '@id' }, vessel: 'fctp:vessel', registry: { '@id': 'fctp:registry', '@type': '@id' },
  possessor: { '@id': 'fctp:possessor', '@type': '@id' }, holder: { '@id': 'fctp:holder', '@type': '@id' }, variety: { '@id': 'fctp:variety', '@type': '@id' },
  asset: { '@id': 'fctp:asset', '@type': '@id' }, creator: { '@id': 'fctp:creator', '@type': '@id', '@container': '@set' },
  from: { '@id': 'fctp:from', '@type': '@id' }, to: { '@id': 'fctp:to', '@type': '@id' }, seller: { '@id': 'fctp:seller', '@type': '@id' },
  request: { '@id': 'fctp:request', '@type': '@id' }, entryRequest: { '@id': 'fctp:entryRequest', '@type': '@id' },
  actor: { '@id': 'as:actor', '@type': '@id' }, object: { '@id': 'as:object', '@type': '@id' }, target: { '@id': 'as:target', '@type': '@id' },
  toActors: { '@id': 'as:to', '@type': '@id', '@container': '@set' }, cc: { '@id': 'as:cc', '@type': '@id', '@container': '@set' },
  effectiveAt: { '@id': 'fctp:effectiveAt', '@type': 'http://www.w3.org/2001/XMLSchema#dateTime' },
  mass: 'fctp:mass', capacity: 'fctp:capacity', count: 'fctp:count', revision: 'fctp:revision', tokenDigest: 'fctp:tokenDigest',
  tokenRevoke: 'fctp:tokenRevoke', cargo: 'fctp:cargo', entries: { '@id': 'fctp:entries', '@container': '@list' }, data: { '@id': 'fctp:data', '@type': '@json' },
  journey: 'fctp:journey', destination: 'fctp:destination',
  Asset: 'fctp:Asset', Variety: 'fctp:Variety', Production: 'fctp:Production', AssetGrant: 'fctp:AssetGrant',
  media: { '@id': 'fctp:media', '@type': '@id', '@container': '@set' }, production: { '@id': 'fctp:production', '@container': '@list' },
  version: 'fctp:version', duration: 'fctp:duration', yield: { '@id': 'fctp:yield', '@container': '@list' }, probability: 'fctp:probability',
  ingredients: { '@id': 'fctp:ingredients', '@container': '@list' }, location: { '@id': 'fctp:location', '@type': '@id', '@container': '@set' }, grantee: { '@id': 'fctp:grantee', '@type': '@id' },
  as: 'https://www.w3.org/ns/activitystreams#'
};

const builtins = new Map<string, JsonDocument>([
  [FCTP_CONTEXT, { '@context': fctpTerms }],
  [AS_CONTEXT, { '@context': {
    as: 'https://www.w3.org/ns/activitystreams#', id: '@id', type: '@type', actor: { '@id': 'as:actor', '@type': '@id' },
    object: { '@id': 'as:object', '@type': '@id' }, to: { '@id': 'as:to', '@type': '@id', '@container': '@set' }, cc: { '@id': 'as:cc', '@type': '@id', '@container': '@set' },
    inbox: { '@id': 'as:inbox', '@type': '@id' }, outbox: { '@id': 'as:outbox', '@type': '@id' }, orderedItems: { '@id': 'as:orderedItems', '@container': '@list' },
    items: { '@id': 'as:items', '@container': '@set' }, totalItems: 'as:totalItems', published: { '@id': 'as:published', '@type': 'http://www.w3.org/2001/XMLSchema#dateTime' },
    Create: 'as:Create', Update: 'as:Update', Delete: 'as:Delete', Follow: 'as:Follow', Undo: 'as:Undo', Accept: 'as:Accept', Reject: 'as:Reject'
  } }],
  [DI_CONTEXT, integrityContexts.contexts.get(DI_CONTEXT)!],
  [MULTIKEY_CONTEXT, multikeyContexts.contexts.get(MULTIKEY_CONTEXT)!],
  [DID_CONTEXT, { '@context': { id: '@id', type: '@type', assertionMethod: { '@id': 'https://w3id.org/security#assertionMethod', '@type': '@id', '@container': '@set' } } }]
]);

export function createLocalDocumentLoader(documents: ReadonlyMap<string, JsonDocument> = new Map()): DocumentLoader {
  return async (url) => {
    const document = documents.get(url) ?? builtins.get(url);
    if (!document) throw new Error(`Document is not in the local allowlist: ${url}`);
    return { contextUrl: null, document: structuredClone(document), documentUrl: url };
  };
}

export function withDocuments(loader: DocumentLoader, documents: ReadonlyMap<string, JsonDocument>): DocumentLoader {
  return async (url) => {
    const document = documents.get(url);
    return document ? { contextUrl: null, document: structuredClone(document), documentUrl: url } : loader(url);
  };
}

export interface GeneratedActorKey {
  keyPair: { id: string; controller: string; signer(): unknown; export(options?: Record<string, unknown>): Promise<JsonDocument> };
  publicKey: JsonDocument;
}

export async function generateActorKey(actorId: URI, keyId = `${actorId}#key-1`): Promise<GeneratedActorKey> {
  const keyPair = await Ed25519Multikey.generate({ controller: actorId, id: keyId }) as GeneratedActorKey['keyPair'];
  return { keyPair, publicKey: await keyPair.export({ publicKey: true, includeContext: true }) };
}

export async function importActorKey(document: JsonDocument): Promise<GeneratedActorKey['keyPair']> {
  return await Ed25519Multikey.from(document) as GeneratedActorKey['keyPair'];
}

export async function signJsonLd<T extends JsonDocument>(document: T, keyPair: GeneratedActorKey['keyPair'], loader: DocumentLoader): Promise<T> {
  const value = structuredClone(document);
  const writable = value as Record<string, unknown>;
  const context = writable['@context'];
  const contexts = context === undefined ? [AS_CONTEXT] : Array.isArray(context) ? [...context] : [context];
  if (!contexts.includes(FCTP_CONTEXT)) contexts.push(FCTP_CONTEXT);
  writable['@context'] = contexts;
  const suite = new DataIntegrityProof({ signer: keyPair.signer(), cryptosuite });
  return await jsigs.sign(value, { suite, purpose: new jsigs.purposes.AssertionProofPurpose(), documentLoader: loader }) as T;
}

export async function verifyProofCryptography(document: JsonDocument, loader: DocumentLoader): Promise<{ verified: boolean; error?: unknown }> {
  const suite = new DataIntegrityProof({ cryptosuite });
  const purpose = new jsigs.purposes.ProofPurpose({ term: 'assertionMethod' });
  const result = await jsigs.verify(document, { suite, purpose, documentLoader: loader });
  return result.verified ? { verified: true } : { verified: false, error: result.error };
}

export async function verifyKeyAttribution(
  document: JsonDocument, publisher: FCTPActor, loader: DocumentLoader
): Promise<{ attributed: boolean; verificationMethod?: URI; controller?: URI; reason?: string }> {
  const proof = document.proof;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return { attributed: false, reason: 'missing-proof' };
  const method = (proof as Record<string, unknown>).verificationMethod;
  if (typeof method !== 'string' || !publisher.publicKeys.includes(method)) return { attributed: false, reason: 'key-not-listed' };
  try {
    const loaded = await loader(method);
    const key = loaded.document;
    if (key.id !== method || key.controller !== publisher.id) return { attributed: false, verificationMethod: method, controller: String(key.controller ?? ''), reason: 'controller-mismatch' };
    return { attributed: true, verificationMethod: method, controller: publisher.id };
  } catch {
    return { attributed: false, verificationMethod: method, reason: 'key-unavailable' };
  }
}

export function checkExpectedIssuer(publisherId: URI, expectedIssuer: URI): { matches: boolean; expectedIssuer: URI; publisher: URI } {
  return { matches: publisherId === expectedIssuer, expectedIssuer, publisher: publisherId };
}

export function checkExitEvidenceBinding(
  exit: { vessel: URI; territory: URI; entryRequest: URI },
  expected: { vessel: URI; territory?: URI; entryRequest: URI }
): { vesselMatches: boolean; entryRequestMatches: boolean; territoryMatches?: boolean; bound: boolean } {
  const vesselMatches = exit.vessel === expected.vessel;
  const entryRequestMatches = exit.entryRequest === expected.entryRequest;
  const territoryMatches = expected.territory === undefined ? undefined : exit.territory === expected.territory;
  return {
    vesselMatches,
    entryRequestMatches,
    ...(territoryMatches === undefined ? {} : { territoryMatches }),
    bound: vesselMatches && entryRequestMatches && (territoryMatches ?? true)
  };
}

export interface ActorResolution { actor: FCTPActor; source: 'uri' | 'webfinger' }
export type ParsedHandle =
  | { handle: string; localName: string; server: string; kind: 'account' }
  | { handle: string; localName: string; server: string; kind: 'authority'; role: string };

export function parseHandle(handle: string): ParsedHandle {
  const match = /^@([a-zA-Z0-9-]+)(?:\.([a-zA-Z0-9-]+))?@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*)(?::([0-9]+))?$/.exec(handle);
  if (!match) throw new TypeError('Expected @name@server or @name.role@server');
  const [, localName, role, domain, port] = match;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) throw new TypeError('Invalid server port');
  const server = `${domain}${port === undefined ? '' : `:${port}`}`;
  return role === undefined
    ? { handle, localName: localName!, server, kind: 'account' }
    : { handle, localName: localName!, server, kind: 'authority', role };
}

export async function resolveActor(uri: URI, fetcher: typeof fetch = fetch): Promise<ActorResolution> {
  const response = await fetcher(uri, { headers: { Accept: 'application/activity+json, application/ld+json' } });
  if (!response.ok) throw new Error(`Actor retrieval failed: HTTP ${response.status}`);
  const actor = await response.json() as FCTPActor;
  if (actor.id !== uri) throw new Error('Actor document id does not match requested URI');
  return { actor, source: 'uri' };
}

export async function resolveWebFinger(handle: string, fetcher: typeof fetch = fetch): Promise<ActorResolution> {
  const normalized = handle.startsWith('@') ? handle : `@${handle}`;
  const at = normalized.lastIndexOf('@');
  if (at <= 1 || at === normalized.length - 1) throw new TypeError('Expected @localpart@domain');
  const domain = normalized.slice(at + 1);
  const subject = `acct:${normalized}`;
  const endpoint = new URL(`https://${domain}/.well-known/webfinger`);
  endpoint.searchParams.set('resource', subject);
  const response = await fetcher(endpoint, { headers: { Accept: 'application/jrd+json' } });
  if (!response.ok) throw new Error(`WebFinger failed: HTTP ${response.status}`);
  const jrd = await response.json() as { subject?: string; links?: Array<{ rel?: string; type?: string; href?: string }> };
  if (jrd.subject !== subject) throw new Error('WebFinger subject mismatch');
  const self = jrd.links?.find((link) => link.rel === 'self' && link.href);
  if (!self?.href) throw new Error('WebFinger response has no self link');
  const resolved = await resolveActor(self.href, fetcher);
  return { ...resolved, source: 'webfinger' };
}

export function webFingerSubject(actor: FCTPActor): string {
  const role = actor.role;
  const name = new URL(actor.id).pathname.split('/').filter(Boolean).at(-1);
  if (!name || name.includes('.')) throw new Error('Actor URI must end in a single role name without periods');
  return role === 'player' ? `@${name}@${new URL(actor.id).host}` : `@${name}.${role}@${new URL(actor.id).host}`;
}
