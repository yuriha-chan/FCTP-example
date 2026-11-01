import type { ObservationService } from './observations.js';

const SEP = '\u0000';
const RESOURCE = 'resource';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function absoluteHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined;
}

export function resourceObservationKey(accountId: string | undefined, resourceId: string): { key: string; source: string; storedKey: string } {
  const key = [RESOURCE, accountId ?? '', resourceId].join(SEP);
  return { key, source: resourceId, storedKey: `${key}${SEP}${resourceId}` };
}

export function resourceObjectDocuments(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  if (Array.isArray(value.orderedItems)) return value.orderedItems.filter(isRecord);
  if (Array.isArray(value.items)) return value.items.filter(isRecord);
  const documents: Record<string, unknown>[] = [];
  for (const key of ['assets', 'varieties', 'grants']) {
    const entries = value[key];
    if (Array.isArray(entries)) documents.push(...entries.filter(isRecord));
  }
  return documents;
}

export function resourceMediaUrls(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.media)) return [];
  return value.media.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const url = absoluteHttpUrl(entry.url);
    return url === undefined ? [] : [url];
  });
}

export async function packResourceObjects(
  observations: ObservationService,
  accountId: string | undefined,
  documents: readonly Record<string, unknown>[],
  observedAt: string
): Promise<void> {
  for (const document of documents) {
    const id = absoluteHttpUrl(document.id);
    if (id === undefined) continue;
    const { key, source } = resourceObservationKey(accountId, id);
    await observations.retain({ key, source, value: document, observedAt });
  }
}

export async function readResourceDocument(fetcher: typeof fetch, uri: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetcher(uri, {
    method: 'GET',
    headers: { Accept: 'text/plain, application/ld+json, application/json' },
    cache: 'no-store',
    signal
  });
  if (!response.ok) throw new Error(`Resource read failed: HTTP ${response.status}`);
  const contentType = response.headers.get('content-type') ?? '';
  return /^text\//i.test(contentType) ? await response.text() : await response.json();
}

export async function packResourceMedia(
  observations: ObservationService,
  fetcher: typeof fetch,
  accountId: string | undefined,
  documents: readonly Record<string, unknown>[],
  timeoutMs?: number
): Promise<void> {
  for (const document of documents) {
    for (const url of resourceMediaUrls(document)) {
      const { key, source } = resourceObservationKey(accountId, url);
      await observations.refresh({
        key,
        source,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        load: (signal) => readResourceDocument(fetcher, url, signal)
      });
    }
  }
}
