import { randomUUID } from 'node:crypto';
import { FctpClient } from '@fctp/client-sdk';
import type { AccountRecord, ActionEvidence, ActionRecord, AuthoringDraft, AuthoringKind, LibraryData, PageResponse, SourcedObservation } from '@fctp/client-sdk';
import type { URI } from '@fctp/protocol';
import { catalogData, catalogEntries, publicationBody, publicationEndpoint, publicationReferences, sanitizeDraftFields } from './adapters/authoring.js';
import type { ActionHandler, ActionService } from './actions.js';
import type { ObservationService } from './observations.js';
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

export interface AuthoringService {
  library(accountId: string): Promise<PageResponse<LibraryData>>;
  refreshLibrary(accountId: string): Promise<PageResponse<LibraryData>>;
  createDraft(input: DraftInput): Promise<{ draft: AuthoringDraft }>;
  getDraft(draftId: string, accountId: string): Promise<{ draft: AuthoringDraft }>;
  saveDraft(draftId: string, input: DraftSaveInput): Promise<{ draft: AuthoringDraft }>;
  publishDraft(draftId: string, accountId: string): Promise<{ action: ActionRecord; draft: AuthoringDraft }>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is AuthoringKind {
  return value === 'asset' || value === 'variety';
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
  return new URL('/local/authoring', publicationEndpoint(account, 'asset')).href;
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

  const page = async (accountId: string): Promise<PageResponse<LibraryData>> => {
    const { catalog, creations } = await readObservations(accountId);
    const base = catalogData(catalog === undefined ? undefined : retainedValue(catalog));
    const extra = catalogEntries(creations === undefined ? undefined : retainedValue(creations));
    const pageObservations: Record<string, SourcedObservation<unknown>> = {};
    if (catalog !== undefined) pageObservations[`${catalogKey(accountId)}:${catalog.source}`] = catalog;
    if (creations !== undefined) pageObservations[`${creationsKey(accountId)}:${creations.source}`] = creations;
    const account = await readAccount(accountId);
    if (account.actorId !== undefined) {
      const advertisement = await observations.readOne(`authoring:${accountId}:advertisement`, account.actorId);
      pageObservations[`authoring:${accountId}:advertisement`] = advertisement;
    }
    const byType = (type: string): typeof base.assets => extra.filter((entry) => entry.type === type);
    return {
      context: { accountId },
      data: {
        assets: mergeEntries(base.assets, byType('Asset')) as LibraryData['assets'],
        varieties: mergeEntries(base.varieties, byType('Variety')) as LibraryData['varieties'],
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
      return page(accountId);
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
        const published: AuthoringDraft = { ...stored, publication: { actionId: action.id, resourceIds } };
        current.drafts[draftId] = published as unknown as Record<string, unknown>;
        return published;
      });
      return { action, draft: updated };
    }
  };
}
