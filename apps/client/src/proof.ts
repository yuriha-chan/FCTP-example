import { checkExitEvidenceBinding, checkExpectedIssuer, createLocalDocumentLoader, verifyKeyAttribution, verifyProofCryptography, withDocuments } from '@fctp/identity';
import { ResourceError } from '@fctp/resources';
import type { ExitEvent, FCTPActor, URI } from '@fctp/protocol';

export async function verifyExit(uri: string, expectedVessel: string, expectedRegistry: string, registryRequests: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const get = async <T>(resourceUri: string): Promise<T> => {
    const response = await fetcher(resourceUri, { headers: { Accept: 'application/ld+json, application/json' }, cache: 'no-store' });
    if (!response.ok) throw new ResourceError(response.status, response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status === 404 ? 'not-found' : 'http-error');
    return response.json() as Promise<T>;
  };
  const exit = await get<ExitEvent>(uri);
  const territoryActor = await get<FCTPActor>(exit.territory);
  const territory = { actor: territoryActor };
  const keyUris = territoryActor.publicKeys;
  const proof = exit.proof;
  const keyUri = proof.verificationMethod;
  if (!keyUris.includes(keyUri)) throw new Error('Exit proof verification method is not listed by the issuing Territory Actor');
  const keyDocument = await get<Record<string, unknown>>(keyUri);
  const keyDocumentUrl = keyUri.split('#')[0]!;
  const allowed = withDocuments(createLocalDocumentLoader(), new Map([[keyUri, keyDocument], [keyDocumentUrl, keyDocument]]));
  const crypto = await verifyProofCryptography(exit as unknown as Record<string, unknown>, allowed);
  const attribution = await verifyKeyAttribution(exit as unknown as Record<string, unknown>, territory.actor, allowed);
  const request = registryRequests[exit.entryRequest];
  const requestEntry = isRecord(request) && request.type === 'EntryRequest' ? request : undefined;
  const requestVessel = requestEntry && isRecord(requestEntry.vessel) ? requestEntry.vessel : undefined;
  const requestDestination = requestEntry && isRecord(requestEntry.destination) ? requestEntry.destination : undefined;
  const exactRequest = requestEntry?.id === exit.entryRequest;
  const contextMatches = requestVessel?.id === expectedVessel && requestVessel.registry === expectedRegistry;
  const destinationTerritory = typeof requestDestination?.territory === 'string' ? requestDestination.territory : undefined;
  const expectedIssuer = destinationTerritory
    ? checkExpectedIssuer(territoryActor.id as URI, destinationTerritory as URI)
    : { status: 'unknown', reason: 'EntryRequest destination territory is unavailable' };
  const checkedBinding = checkExitEvidenceBinding(exit, {
    vessel: expectedVessel as URI,
    entryRequest: (requestEntry?.id ?? exit.entryRequest) as URI,
    ...(destinationTerritory ? { territory: destinationTerritory as URI } : {})
  });
  const binding = {
    ...checkedBinding,
    requestExists: Boolean(requestEntry),
    exactRequest,
    expectedVesselMatches: requestVessel?.id === expectedVessel,
    registryMatches: requestVessel?.registry === expectedRegistry,
    destinationTerritoryMatches: destinationTerritory === exit.territory,
    bound: checkedBinding.bound && Boolean(requestEntry) && exactRequest && contextMatches && destinationTerritory === exit.territory
  };
  return {
    exit: { id: exit.id, territory: exit.territory, vessel: exit.vessel, entryRequest: exit.entryRequest, cargo: exit.cargo },
    proofCryptography: crypto.verified ? 'verified' : 'failed',
    keyAttribution: attribution.attributed ? 'attributed' : `not attributed: ${attribution.reason ?? 'unknown'}`,
    expectedIssuer: 'status' in expectedIssuer ? expectedIssuer : expectedIssuer.matches ? 'verified' : 'failed',
    binding,
    registryDeclaredCargo: undefined,
    difference: undefined
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
