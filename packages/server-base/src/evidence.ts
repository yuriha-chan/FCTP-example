import { validateModel, type DepartureEvent, type DepartureRequest, type EntryRequest, type ExitEvent, type URI } from '@fctp/protocol';
import { createLocalDocumentLoader } from '@fctp/identity';
import { verifyPublishedDocument } from './verification.js';
import type { VerificationReport } from './server.js';

export interface ExitEvidenceExpected { vessel: URI; registry: URI }
export interface ExitEvidenceOptions { fetcher?: typeof fetch }
export interface ExitEvidenceResult {
  exit?: ExitEvent;
  entry?: EntryRequest;
  verification: VerificationReport;
  binding: { bound: boolean; reason?: string };
  difference?: never;
  error?: string;
}

const failedVerification = (error: string): VerificationReport => ({
  cryptographic: { verified: false, error },
  attribution: { attributed: false, error },
  expectedIssuer: { matches: false }
});

export async function resolveExitEvidence(
  uri: URI,
  expected: ExitEvidenceExpected,
  options: ExitEvidenceOptions = {}
): Promise<ExitEvidenceResult> {
  const fetcher = options.fetcher ?? fetch;
  let exit: ExitEvent;
  try {
    exit = await resolveModel<ExitEvent>(uri, 'ExitEvent', fetcher);
  } catch (error) {
    const message = messageOf(error);
    return { verification: failedVerification(message), binding: { bound: false, reason: message }, error: message };
  }

  const verification = await verifyPublishedDocument(exit, exit.territory, exit.territory, fetcher, createLocalDocumentLoader());
  try {
    const entry = await resolveModel<EntryRequest>(exit.entryRequest, 'EntryRequest', fetcher);
    if (entry.id !== exit.entryRequest) throw new Error('EntryRequest id does not match requested URI');
    const reasons: string[] = [];
    if (exit.vessel !== expected.vessel) reasons.push('exit-vessel-mismatch');
    if (entry.vessel.id !== expected.vessel || entry.vessel.registry !== expected.registry) reasons.push('entry-vessel-or-registry-mismatch');
    if (entry.destination.territory !== exit.territory) reasons.push('entry-destination-does-not-match-exit-territory');
    if (exit.departureEvent) {
      const departure = await resolveModel<DepartureEvent>(exit.departureEvent, 'DepartureEvent', fetcher);
      if (departure.id !== exit.departureEvent) throw new Error('DepartureEvent id does not match requested URI');
      const departureRequest = await resolveModel<DepartureRequest>(departure.request, 'DepartureRequest', fetcher);
      if (departureRequest.id !== departure.request || departure.vessel !== expected.vessel || departure.territory !== exit.territory || departureRequest.vessel !== departure.vessel || departureRequest.territory !== departure.territory) {
        reasons.push('departure-event-or-request-linkage-mismatch');
      }
    }
    const bound = reasons.length === 0;
    return {
      exit,
      entry,
      verification,
      binding: {
        bound,
        ...(!bound ? { reason: reasons.join('; ') } : { reason: 'entry-request-publisher-unproven' })
      }
    };
  } catch (error) {
    const message = messageOf(error);
    return { exit, verification, binding: { bound: false, reason: message }, error: message };
  }
}

async function resolveModel<T>(uri: URI, model: 'ExitEvent' | 'EntryRequest' | 'DepartureEvent' | 'DepartureRequest', fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(uri, { headers: { Accept: 'application/ld+json, application/json' } });
  if (!response.ok) throw new Error(`Resource retrieval failed: HTTP ${response.status}`);
  const value: unknown = await response.json();
  const validated = validateModel<T & Record<string, unknown>>(value, model);
  if (!validated.success) throw new TypeError(`Invalid ${model}: ${validated.issues.map((issue) => `${issue.path} ${issue.message}`).join(', ')}`);
  if (validated.data.id !== uri) throw new Error(`${model} id does not match requested URI`);
  return validated.data;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
