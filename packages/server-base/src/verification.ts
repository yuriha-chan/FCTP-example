import {
  checkExpectedIssuer,
  createLocalDocumentLoader,
  resolveActor,
  verifyKeyAttribution,
  verifyProofCryptography,
  withDocuments,
  type DocumentLoader,
  type JsonDocument
} from '@fctp/identity';
import type { URI } from '@fctp/protocol';
import type { Activity } from '@fctp/federation';
import type { FctpServerOptions, VerificationReport } from './server.js';

export interface InboundVerifierOptions {
  fetcher?: typeof fetch;
  loader?: DocumentLoader;
  resolveExpectedIssuer: (localActorId: URI, senderActorId: URI, activity: Activity) => Promise<URI | undefined>;
}

export function createInboundVerifier(options: InboundVerifierOptions): NonNullable<FctpServerOptions['verifyInbound']> {
  const fetcher = options.fetcher ?? fetch;
  const baseLoader = options.loader ?? createLocalDocumentLoader();

  return async (localActorId, senderActorId, activity): Promise<VerificationReport> => {
    let expectedIssuer: VerificationReport['expectedIssuer'];
    let expectedPublisher: URI | undefined;
    try {
      expectedPublisher = await options.resolveExpectedIssuer(localActorId, senderActorId, activity);
      expectedIssuer = expectedPublisher === undefined ? { matches: false } : checkExpectedIssuer(senderActorId, expectedPublisher);
    } catch {
      expectedIssuer = { matches: false };
    }
    const report = await verifyPublishedDocument(activity, senderActorId, expectedPublisher ?? senderActorId, fetcher, baseLoader);
    return { ...report, expectedIssuer };
  };
}

export async function verifyPublishedDocument(
  document: Record<string, unknown>,
  publisherId: URI,
  expectedIssuer: URI,
  fetcher: typeof fetch = fetch,
  baseLoader: DocumentLoader = createLocalDocumentLoader()
): Promise<VerificationReport> {
  let actor: Awaited<ReturnType<typeof resolveActor>>['actor'] | undefined;
  let actorError: string | undefined;
  try {
    actor = (await resolveActor(publisherId, fetcher)).actor;
    if (!Array.isArray(actor.publicKeys) || actor.publicKeys.some((key) => typeof key !== 'string')) {
      throw new TypeError('Publisher Actor publicKeys must be an array of key document URIs');
    }
  } catch (error) {
    actorError = errorMessage(error);
  }

  const documents = new Map<string, JsonDocument>();
  if (actor) {
    for (const keyId of actor.publicKeys) {
      try {
        const response = await fetcher(keyId, { headers: { Accept: 'application/ld+json, application/json' } });
        if (!response.ok) throw new Error(`Key retrieval failed: HTTP ${response.status}`);
        const key = await response.json() as JsonDocument;
        if (!key || typeof key !== 'object' || Array.isArray(key) || key.id !== keyId) throw new TypeError('Key document id does not match requested URI');
        documents.set(keyId, key);
      } catch {
        continue;
      }
    }
  }
  const loader = withDocuments(baseLoader, documents);
  let cryptographic: VerificationReport['cryptographic'];
  try {
    const result = await verifyProofCryptography(document, loader);
    cryptographic = result.verified ? { verified: true } : { verified: false, error: errorMessage(result.error ?? 'proof verification failed') };
  } catch (error) {
    cryptographic = { verified: false, error: errorMessage(error) };
  }
  let attribution: VerificationReport['attribution'];
  if (!actor) {
    attribution = { attributed: false, error: actorError ?? 'publisher Actor resolution failed' };
  } else {
    try {
      const result = await verifyKeyAttribution(document, actor, loader);
      attribution = {
        attributed: result.attributed,
        ...(result.controller ? { publisher: result.controller } : {}),
        ...(result.verificationMethod ? { key: result.verificationMethod } : {}),
        ...(!result.attributed ? { error: result.reason ?? 'key attribution failed' } : {})
      };
    } catch (error) {
      attribution = { attributed: false, error: errorMessage(error) };
    }
  }
  return { cryptographic, attribution, expectedIssuer: checkExpectedIssuer(publisherId, expectedIssuer) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
