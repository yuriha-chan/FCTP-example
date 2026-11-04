import { randomUUID } from 'node:crypto';
import { FctpClient } from '@fctp/client-sdk';
import type { AccountRecord, ActionEvidence, ActionRecord, AuthoringDraft, AuthoringKind, LibraryData, LibraryEntry, PageResponse, SourcedObservation } from '@fctp/client-sdk';
import type { URI } from '@fctp/protocol';
import { catalogData, catalogEntries, authoringOrigin, guardedImageUrl, imageUploadEndpoint, isImageMediaType, publicationBody, publicationEndpoint, publicationObjects, publicationReferences, sanitizeDraftFields, type ImageMediaType } from './adapters/authoring.js';
import type { ActionHandler, ActionService } from './actions.js';
import { withDeadline } from './deadline.js';
import type { ObservationService } from './observations.js';
import { packResourceMedia, packResourceObjects, resourceObjectDocuments, resourceObservationKey } from './resource-observations.js';
import type { ClientApplicationState } from './store.js';

export class AuthoringRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export interface AuthoringServiceOptions {
  timeoutMs?: number;
}

export interface DraftInput {
  accountId: string;
  kind: AuthoringKind;
  fields: unknown;
}

export interface DraftSaveInput {
  accountId: string;
  fields: unknown;
}

export interface ImageUploadInput {
  accountId: string;
  mediaType: unknown;
  data: unknown;
}

export interface ImageReadInput {
  accountId: string;
  url: unknown;
}

export interface ImageDescriptor {
  url: string;
  mediaType: ImageMediaType;
}

export interface AuthoringService {
  library(accountId: string): Promise<PageResponse<LibraryData>>;
  refreshLibrary(accountId: string): Promise<PageResponse<LibraryData>>;
  createDraft(input: DraftInput): Promise<{ draft: AuthoringDraft }>;
  getDraft(draftId: string, accountId: string): Promise<{ draft: AuthoringDraft }>;
  saveDraft(draftId: string, input: DraftSaveInput): Promise<{ draft: AuthoringDraft }>;
  uploadImage(draftId: string, input: ImageUploadInput): Promise<ImageDescriptor>;
  readImage(draftId: string, input: ImageReadInput): Promise<{ mediaType: ImageMediaType; data: string }>;
  publishDraft(draftId: string, accountId: string): Promise<{ action: ActionRecord; draft: AuthoringDraft }>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is AuthoringKind {
  return value === 'asset' || value === 'variety';
}

function isCanonicalBase64(data: string): boolean {
  if (data.length === 0 || data.length % 4 !== 0) return false;
  if (data.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4) return false;
  return Buffer.from(data, 'base64').toString('base64') === data;
}

function validateImageUploadData(mediaType: unknown, data: unknown): { mediaType: ImageMediaType; data: string } {
  if (!isImageMediaType(mediaType)) throw new AuthoringRequestError(415, 'unsupported-image-media-type');
  if (typeof data !== 'string' || !isCanonicalBase64(data)) throw new AuthoringRequestError(400, 'invalid-image-data');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0) throw new AuthoringRequestError(400, 'image-data-empty');
  if (bytes.length > IMAGE_MAX_BYTES) throw new AuthoringRequestError(413, 'image-data-too-large');
  return { mediaType, data };
}

async function readBoundedImage(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AuthoringRequestError(413, 'image-preview-too-large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function retainedValue<T>(observation: SourcedObservation<T>): T | undefined {
  return observation.state === 'available' || observation.state === 'stale' || observation.state === 'empty' ? observation.value : undefined;
}

function catalogKey(accountId: string): string {
  return `authoring:${accountId}:catalog`;
}

function creationsKey(accountId: string): string {
  return `authoring:${accountId}:creations`;
}

function catalogSource(account: AccountRecord): string {
  return new URL('/local/repository/authoring', publicationEndpoint(account, 'asset')).href;
}

function draftFromStored(value: Record<string, unknown> | undefined): AuthoringDraft | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== 'string' || typeof value.accountId !== 'string' || !isKind(value.kind) || !isRecord(value.fields) || typeof value.savedAt !== 'string') return undefined;
  return value as unknown as AuthoringDraft;
}

function mergeEntries(primary: ReturnType<typeof catalogEntries>, secondary: ReturnType<typeof catalogEntries>): ReturnType<typeof catalogEntries> {
  const merged = new Map<string, ReturnType<typeof catalogEntries>[number]>();
  for (const entry of [...primary, ...secondary]) merged.set(entry.id, entry);
  return [...merged.values()];
}

export function createAuthoringPublicationHandler(state: ClientApplicationState, fetcher: typeof fetch, observations: ObservationService): ActionHandler {
  return {
    async submit({ accountId, intent, signal }) {
      const draftId = typeof intent.inputs.draftId === 'string' ? intent.inputs.draftId : '';
      const { account, draft } = await state.read((current) => {
        const stored = current.accounts[accountId];
        const candidate = draftFromStored(current.drafts[draftId]);
        return { account: stored, draft: candidate };
      });
      if (!account || account.login.status !== 'signed-in') throw new Error('A signed-in account is required to publish a draft');
      if (!draft || draft.accountId !== accountId) throw new Error('Draft not found for this account');
      const endpoint = publicationEndpoint(account, draft.kind);
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${account.login.nativeToken}`
        },
        body: JSON.stringify(publicationBody(draft.kind, draft.fields)),
        cache: 'no-store',
        signal
      });
      if (!response.ok) throw new Error(`Publication failed: HTTP ${response.status}`);
      const payload: unknown = await response.json();
      const references = publicationReferences(payload);
      if (references.length === 0) throw new Error('Publication response did not identify a resource');
      const documents = publicationObjects(payload);
      await packResourceObjects(observations, accountId, documents, new Date().toISOString());
      await packResourceMedia(observations, fetcher, accountId, documents);
      return { references, result: references[0]!.id };
    },
    async reconcile({ accountId, references, action, signal }) {
      if (action.submission.status !== 'accepted') return { status: 'unverified' };
      const sdk = new FctpClient({ fetcher: (input, init) => fetcher(input, { ...init, signal }) });
      const evidence: ActionEvidence[] = [];
      const resources = references.filter((reference) => reference.kind === 'resource');
      for (const reference of resources) {
        const observation = await observations.refresh({
          key: ['resource', accountId, reference.id].join('\u0000'),
          source: reference.id,
          load: () => sdk.getPublicFirst<Record<string, unknown>>(reference.id as URI)
        });
        if (observation.state !== 'available' || observation.value.id !== reference.id) return { status: 'unverified', evidence, error: 'Published resource read-back is unavailable or mismatched' };
        evidence.push({ source: reference.id, observedAt: observation.observedAt, changes: { id: reference.id, type: observation.value.type } });
      }
      return resources.length ? { status: 'completed', evidence } : { status: 'unverified' };
    }
  };
}

export function createAuthoringService(
  state: ClientApplicationState,
  fetcher: typeof fetch,
  observations: ObservationService,
  actions: ActionService,
  options: AuthoringServiceOptions = {}
): AuthoringService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sdk = new FctpClient({ fetcher: (input, init) => fetcher(input, { ...init, cache: 'no-store' }) });
  const call = <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => withDeadline(timeoutMs, operation);

  const readAccount = async (accountId: string): Promise<AccountRecord> => {
    const account = await state.read((current) => current.accounts[accountId]);
    if (!account) throw new AuthoringRequestError(404, 'account-not-found');
    return account;
  };

  const requireSignedIn = async (accountId: string): Promise<AccountRecord> => {
    const account = await readAccount(accountId);
    if (account.login.status !== 'signed-in') throw new AuthoringRequestError(401, 'sign-in-required');
    return account;
  };

  const requireOwnedAssetDraft = async (draftId: string, accountId: string): Promise<AuthoringDraft> => {
    const draft = await state.read((current) => draftFromStored(current.drafts[draftId]));
    if (!draft || draft.accountId !== accountId) throw new AuthoringRequestError(404, 'draft-not-found');
    if (draft.kind !== 'asset') throw new AuthoringRequestError(400, 'image-requires-asset-draft');
    return draft;
  };

  const readDrafts = async (accountId: string): Promise<AuthoringDraft[]> => state.read((current) => Object.values(current.drafts)
    .flatMap((value) => {
      const draft = draftFromStored(value);
      return draft && draft.accountId === accountId ? [draft] : [];
    })
    .sort((left, right) => left.savedAt.localeCompare(right.savedAt)));

  const readObservations = async (accountId: string): Promise<{ catalog?: SourcedObservation<unknown>; creations?: SourcedObservation<unknown> }> => {
    const account = await readAccount(accountId);
    const source = catalogSource(account);
    const catalog = await observations.readOne(catalogKey(accountId), source);
    const creations = await state.read((current) => Object.entries(current.observations)
      .filter(([key, observation]) => key.startsWith(`${creationsKey(accountId)}\u0000`) && observation.source !== source)
      .map(([, observation]) => observation)[0]);
    return {
      catalog,
      ...(creations === undefined ? {} : { creations })
    };
  };

  const packObservation = async (accountId: string, observation: SourcedObservation<unknown> | undefined): Promise<void> => {
    if (observation === undefined) return;
    const value = retainedValue(observation);
    if (value === undefined) return;
    const observedAt = 'observedAt' in observation && typeof observation.observedAt === 'string'
      ? observation.observedAt
      : new Date().toISOString();
    await packResourceObjects(observations, accountId, resourceObjectDocuments(value), observedAt);
  };

  const enrichEntryMedia = async (accountId: string, entry: LibraryEntry): Promise<LibraryEntry> => {
    if (!Array.isArray(entry.media) || entry.media.length === 0) return entry;
    const media = await Promise.all(entry.media.map(async (descriptor) => {
      if (!isRecord(descriptor) || typeof descriptor.url !== 'string') return descriptor;
      const { key, source } = resourceObservationKey(accountId, descriptor.url);
      const observation = await observations.readOne(key, source);
      return {
        ...descriptor,
        state: observation.state,
        ...('value' in observation ? { value: observation.value } : {}),
        ...('observedAt' in observation && typeof observation.observedAt === 'string' ? { observedAt: observation.observedAt } : {}),
        ...('error' in observation && typeof observation.error === 'string' ? { error: observation.error } : {})
      };
    }));
    return { ...entry, media };
  };

  const page = async (accountId: string, observeMedia = false): Promise<PageResponse<LibraryData>> => {
    const { catalog, creations } = await readObservations(accountId);
    const base = catalogData(catalog === undefined ? undefined : retainedValue(catalog));
    const extra = catalogEntries(creations === undefined ? undefined : retainedValue(creations));
    await packObservation(accountId, catalog);
    await packObservation(accountId, creations);
    if (observeMedia) {
      const documents = [catalog, creations].flatMap((observation) => {
        const value = observation === undefined ? undefined : retainedValue(observation);
        return value === undefined ? [] : resourceObjectDocuments(value);
      });
      await packResourceMedia(observations, fetcher, accountId, documents, timeoutMs);
    }
    const pageObservations: Record<string, SourcedObservation<unknown>> = {};
    if (catalog !== undefined) pageObservations[`${catalogKey(accountId)}:${catalog.source}`] = catalog;
    if (creations !== undefined) pageObservations[`${creationsKey(accountId)}:${creations.source}`] = creations;
    const account = await readAccount(accountId);
    if (account.actorId !== undefined) {
      const advertisement = await observations.readOne(`authoring:${accountId}:advertisement`, account.actorId);
      pageObservations[`authoring:${accountId}:advertisement`] = advertisement;
    }
    const byType = (type: string): typeof base.assets => extra.filter((entry) => entry.type === type);
    const assets = mergeEntries(base.assets, byType('Asset')) as LibraryData['assets'];
    const varieties = mergeEntries(base.varieties, byType('Variety')) as LibraryData['varieties'];
    return {
      context: { accountId },
      data: {
        assets: await Promise.all(assets.map((entry) => enrichEntryMedia(accountId, entry))),
        varieties: await Promise.all(varieties.map((entry) => enrichEntryMedia(accountId, entry))),
        grants: mergeEntries(base.grants, byType('AssetGrant')) as LibraryData['grants'],
        drafts: await readDrafts(accountId)
      },
      observations: pageObservations,
      actions: []
    };
  };

  const readCreationsSource = async (account: AccountRecord, signal: AbortSignal): Promise<string> => {
    if (account.actorId === undefined) throw new Error('Player Actor identity is unavailable');
    const actor = await new FctpClient({ fetcher: (input, init) => fetcher(input, { ...init, signal }) }).getPublicFirst<Record<string, unknown>>(account.actorId as URI, { accept: 'application/activity+json, application/json' });
    if (typeof actor.creations !== 'string') throw new Error('Player actor does not advertise a creations collection');
    return actor.creations;
  };

  const readCreations = async (source: string): Promise<unknown> => sdk.getPublicFirst(source as URI);

  return {
    library: page,
    async refreshLibrary(accountId) {
      const account = await requireSignedIn(accountId);
      const source = catalogSource(account);
      await observations.refresh<unknown>({
        key: catalogKey(accountId),
        source,
        timeoutMs,
        load: async (signal) => {
          const response = await fetcher(source, {
            method: 'GET',
            headers: { Accept: 'application/json', Authorization: `Bearer ${account.login.status === 'signed-in' ? account.login.nativeToken : ''}` },
            cache: 'no-store',
            signal
          });
          if (!response.ok) throw new Error(`Authoring catalog unavailable: HTTP ${response.status}`);
          return await response.json();
        }
      });
      const actorReference = account.actorId;
      if (actorReference !== undefined) {
        const priorSource = await state.read((current) => Object.entries(current.observations)
          .filter(([key]) => key.startsWith(`${creationsKey(accountId)}\u0000`))
          .map(([, observation]) => observation.source)[0]);
        // An unavailable creations advertisement must not discard the authenticated catalog.
        const advertisement = await observations.refresh({ key: `authoring:${accountId}:advertisement`, source: actorReference, timeoutMs, load: (signal) => readCreationsSource(account, signal) });
        const creationsSource = retainedValue(advertisement) ?? priorSource;
        if (creationsSource !== undefined) {
          await observations.refresh<unknown>({
            key: creationsKey(accountId),
            source: creationsSource,
            timeoutMs,
            load: () => readCreations(creationsSource!)
          });
        }
      }
      return page(accountId, true);
    },
    async createDraft(input) {
      if (!isKind(input.kind)) throw new AuthoringRequestError(400, 'invalid-draft-kind');
      await requireSignedIn(input.accountId);
      const draft: AuthoringDraft = {
        id: `draft:${randomUUID()}`,
        accountId: input.accountId,
        kind: input.kind,
        fields: sanitizeDraftFields(input.fields),
        savedAt: new Date().toISOString()
      };
      await state.transaction((current) => { current.drafts[draft.id] = draft as unknown as Record<string, unknown>; });
      return { draft };
    },
    async getDraft(draftId, accountId) {
      await readAccount(accountId);
      const draft = await state.read((current) => draftFromStored(current.drafts[draftId]));
      if (!draft || draft.accountId !== accountId) throw new AuthoringRequestError(404, 'draft-not-found');
      return { draft };
    },
    async saveDraft(draftId, input) {
      await requireSignedIn(input.accountId);
      const fields = sanitizeDraftFields(input.fields);
      const draft = await state.transaction((current) => {
        const stored = draftFromStored(current.drafts[draftId]);
        if (!stored || stored.accountId !== input.accountId) return undefined;
        const saved: AuthoringDraft = { ...stored, fields, savedAt: new Date().toISOString() };
        current.drafts[draftId] = saved as unknown as Record<string, unknown>;
        return saved;
      });
      if (!draft) throw new AuthoringRequestError(404, 'draft-not-found');
      return { draft };
    },
    async uploadImage(draftId, input) {
      const account = await requireSignedIn(input.accountId);
      await requireOwnedAssetDraft(draftId, input.accountId);
      const upload = validateImageUploadData(input.mediaType, input.data);
      const endpoint = imageUploadEndpoint(account);
      let payload: unknown;
      try {
        payload = await call(async (signal) => {
          const response = await fetcher(endpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${account.login.status === 'signed-in' ? account.login.nativeToken : ''}`
          },
          body: JSON.stringify({ mediaType: upload.mediaType, data: upload.data }),
          cache: 'no-store',
          redirect: 'error',
          signal
          });
          if (!response.ok) throw new Error('image-upload-failed');
          return response.json();
        });
      } catch {
        throw new AuthoringRequestError(502, 'image-upload-failed');
      }
      if (!isRecord(payload)) throw new AuthoringRequestError(502, 'invalid-image-descriptor');
      const url = guardedImageUrl(payload.url, authoringOrigin(account));
      if (url === undefined || payload.mediaType !== upload.mediaType) throw new AuthoringRequestError(502, 'invalid-image-descriptor');
      return { url, mediaType: upload.mediaType };
    },
    async readImage(draftId, input) {
      const account = await requireSignedIn(input.accountId);
      await requireOwnedAssetDraft(draftId, input.accountId);
      const url = guardedImageUrl(input.url, authoringOrigin(account));
      if (url === undefined) throw new AuthoringRequestError(400, 'invalid-image-url');
      try {
        return await call(async (signal) => {
          const response = await fetcher(url, {
          method: 'GET',
          headers: {
            Accept: 'image/png, image/jpeg, image/gif, image/webp',
            Authorization: `Bearer ${account.login.status === 'signed-in' ? account.login.nativeToken : ''}`
          },
          cache: 'no-store',
          redirect: 'error',
          signal
          });
          if (!response.ok) throw new AuthoringRequestError(502, 'image-preview-failed');
          const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
          if (!isImageMediaType(contentType)) throw new AuthoringRequestError(502, 'invalid-image-response');
          const bytes = await readBoundedImage(response, IMAGE_MAX_BYTES);
          if (bytes.byteLength === 0) throw new AuthoringRequestError(502, 'invalid-image-response');
          return { mediaType: contentType, data: Buffer.from(bytes).toString('base64') };
        });
      } catch (error) {
        if (error instanceof AuthoringRequestError) throw error;
        throw new AuthoringRequestError(502, 'image-preview-failed');
      }
    },
    async publishDraft(draftId, accountId) {
      const account = await requireSignedIn(accountId);
      const draft = await state.read((current) => draftFromStored(current.drafts[draftId]));
      if (!draft || draft.accountId !== accountId) throw new AuthoringRequestError(404, 'draft-not-found');
      const action = await actions.submit({
        accountId,
        targetId: account.actorId ?? account.id,
        intent: { kind: 'authoring-publication', inputs: { draftId } }
      });
      if (action.submission.status !== 'accepted') return { action, draft };
      const resourceIds = action.resultReferences.filter((reference) => reference.kind === 'resource').map((reference) => reference.id);
      const updated = await state.transaction((current) => {
        const stored = draftFromStored(current.drafts[draftId]);
        if (!stored) return draft;
        const published: AuthoringDraft = {
          ...stored,
          publication: { actionId: action.id, resourceIds, publishedFields: structuredClone(stored.fields) }
        };
        current.drafts[draftId] = published as unknown as Record<string, unknown>;
        return published;
      });
      return { action, draft: updated };
    }
  };
}
