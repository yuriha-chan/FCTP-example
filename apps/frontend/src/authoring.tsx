import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from 'react-aria-components';
import { actionIsComplete } from '@fctp/client-sdk';
import type {
  ActionEvidence,
  ActionRecord,
  AuthoringDraft,
  AuthoringKind,
  LibraryEntry,
  SourcedObservation
} from '@fctp/client-sdk';
import {
  createDraft,
  publishDraft,
  readAction,
  readDraft,
  readExplorePlaces,
  readLibrary,
  refreshAction,
  refreshExplorePlaces,
  refreshLibrary,
  saveDraft,
  type ExplorePlacesResponse,
  type LibraryResponse
} from './application-api';
import { ReferencePicker } from './reference-picker';
import type { ReferencePickerKind, ReferencePickerSelection, ReferencePickerSource } from './reference-picker';
import { ResourceReader } from './resource-reader';
import type { ResourceReference } from './resource-reader';
import { AssetEditor } from './asset-editor';
import { AssetCard } from './asset-card';
import { VarietyCard } from './variety-card';
import { HandleLabel } from './handle-label';
import { ObjectIdentifier } from './object-identifier';
import { VarietyEditor } from './variety-editor';
import type { VarietyAssetPickerTarget } from './variety-editor';
import type { ProductionPickerTarget } from './descriptive-production-editor';
import cssStyles from './authoring.module.css';

const styles = cssStyles as Record<'workspace' | 'heading' | 'controls' | 'button' | 'meta' | 'error' | 'section' | 'subheading' | 'list' | 'item' | 'label', string>;

export interface AuthoringProps {
  accountId?: string;
  onOpenAction?: (actionId: string) => void;
  onReadResource?: (reference: ResourceReference) => void;
}

interface EditorState {
  draftId: string | undefined;
  kind: AuthoringKind;
}

type AuthoringPickerTarget = VarietyAssetPickerTarget | ProductionPickerTarget;

interface PickerState {
  target: AuthoringPickerTarget;
  kind: ReferencePickerKind;
  fieldLabel: string;
  trigger: HTMLElement | undefined;
}

interface PublicationState {
  draftId: string;
  action: ActionRecord;
  resourceIds: string[];
  status: 'accepted' | 'unverified' | 'completed';
  evidence: ActionEvidence[];
  checkError: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateLabel(state: string): string {
  if (state === 'not-retrieved') return 'Not retrieved';
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function draftName(draft: AuthoringDraft): string {
  const name = draft.fields.name;
  return typeof name === 'string' && name ? name : 'Untitled draft';
}

function isLibraryResponse(response: LibraryResponse): boolean {
  const data = response.data as unknown;
  if (!isRecord(data)) return false;
  return ['assets', 'varieties', 'grants', 'drafts'].every((key) => Array.isArray(data[key]));
}

function isOwnedDraft(draft: AuthoringDraft, accountId: string, kind: AuthoringKind, expectedId: string | undefined): boolean {
  return typeof draft.id === 'string' && draft.id.length > 0
    && draft.accountId === accountId
    && draft.kind === kind
    && isRecord(draft.fields)
    && (expectedId === undefined || draft.id === expectedId);
}

function isActionFor(value: unknown, accountId: string, actionId: string | undefined): value is ActionRecord {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (value.accountId !== accountId) return false;
  if (!Array.isArray(value.resultReferences)) return false;
  if (!isRecord(value.submission) || !isRecord(value.outcome)) return false;
  return actionId === undefined || value.id === actionId;
}

function resourceIdsFromAction(action: ActionRecord): string[] {
  return action.resultReferences
    .filter((reference) => isRecord(reference) && reference.kind === 'resource' && typeof reference.id === 'string')
    .map((reference) => reference.id);
}

function mergeIds(existing: readonly string[], incoming: readonly string[]): string[] {
  return [...new Set([...existing, ...incoming])];
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isAbsoluteUri(value: unknown): boolean {
  return typeof value === 'string' && URL.canParse(value);
}

function validateProduction(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return ['Production must be an array of entries.'];
  const errors: string[] = [];
  value.forEach((entryValue, entryIndex) => {
    if (!isRecord(entryValue)) {
      errors.push(`Production entry ${entryIndex + 1} must be an object.`);
      return;
    }
    if (entryValue.type !== 'mine' && entryValue.type !== 'manufacture') {
      errors.push(`Production entry ${entryIndex + 1} Type must be mine or manufacture.`);
    }
    if (!isNonNegativeInteger(entryValue.duration)) {
      errors.push(`Production entry ${entryIndex + 1} Duration must be a non-negative integer.`);
    }
    if (Object.hasOwn(entryValue, 'tool') && !isAbsoluteUri(entryValue.tool)) {
      errors.push(`Production entry ${entryIndex + 1} Tool must be an absolute URI.`);
    }
    for (const field of ['ingredients', 'location', 'yield']) {
      if ((field === 'yield' || Object.hasOwn(entryValue, field)) && !Array.isArray(entryValue[field])) {
        errors.push(`Production entry ${entryIndex + 1} ${field} must be an array.`);
      }
    }
    const ingredients = Array.isArray(entryValue.ingredients) ? entryValue.ingredients : [];
    ingredients.forEach((ingredientValue, ingredientIndex) => {
      const ingredient = isRecord(ingredientValue) ? ingredientValue : {};
      const item = Object.hasOwn(ingredient, 'id');
      const label = item ? `Item ingredient ${ingredientIndex + 1}` : `Stack ingredient ${ingredientIndex + 1}`;
      if (!isAbsoluteUri(ingredient.variety)) {
        errors.push(`${label} Variety must be an exact URI.`);
      }
      if (item) {
        if (!isAbsoluteUri(ingredient.id)) {
          errors.push(`${label} Item ID must be an exact URI.`);
        }
        if (Object.hasOwn(ingredient, 'count') && !isNonNegativeInteger(ingredient.count)) {
          errors.push(`${label} Count extension must be a non-negative integer.`);
        }
      } else if (!isNonNegativeInteger(ingredient.count)) {
        errors.push(`${label} Count must be a non-negative integer.`);
      }
      if (!isRecord(ingredient.data)) errors.push(`${label} Data must be a JSON object.`);
    });
    const locations = Array.isArray(entryValue.location) ? entryValue.location : [];
    locations.forEach((locationValue, locationIndex) => {
      const location = isRecord(locationValue) ? locationValue : {};
      if (!isAbsoluteUri(location.id)) {
        errors.push(`Location ${locationIndex + 1} Area ID must be an exact URI.`);
      }
      if (typeof location.name !== 'string') errors.push(`Location ${locationIndex + 1} Area name must be a string.`);
      if (!isAbsoluteUri(location.territory)) errors.push(`Location ${locationIndex + 1} Territory must be an absolute URI.`);
    });
    const yields = Array.isArray(entryValue.yield) ? entryValue.yield : [];
    yields.forEach((yieldValue, yieldIndex) => {
      const yieldEntry = isRecord(yieldValue) ? yieldValue : {};
      if (typeof yieldEntry.probability !== 'number' || !Number.isFinite(yieldEntry.probability)) {
        errors.push(`Yield ${yieldIndex + 1} Probability must be a finite number.`);
      }
      if (!isNonNegativeInteger(yieldEntry.count)) {
        errors.push(`Yield ${yieldIndex + 1} Count must be a non-negative integer.`);
      }
      if (!isRecord(yieldEntry.data)) errors.push(`Yield ${yieldIndex + 1} Data must be a JSON object.`);
    });
  });
  return errors;
}

function pickerSpec(target: AuthoringPickerTarget): { kind: ReferencePickerKind; fieldLabel: string } {
  switch (target.section) {
    case 'asset':
      return { kind: 'asset', fieldLabel: 'Variety asset' };
    case 'tool':
      return { kind: 'asset', fieldLabel: 'Tool asset' };
    case 'ingredient':
      return { kind: 'variety', fieldLabel: 'Ingredient variety' };
    case 'area':
      return { kind: 'area', fieldLabel: 'Location area' };
  }
}

function entriesOf(fields: Record<string, unknown>): unknown[] {
  return Array.isArray(fields.production) ? fields.production : [];
}

function updateEntry(
  fields: Record<string, unknown>,
  entryIndex: number,
  update: (entry: Record<string, unknown>) => Record<string, unknown>
): Record<string, unknown> {
  const production = entriesOf(fields).slice();
  const entry = isRecord(production[entryIndex]) ? production[entryIndex] : {};
  production[entryIndex] = update({ ...entry });
  return { ...fields, production };
}

function applyPickerSelection(
  fields: Record<string, unknown>,
  target: AuthoringPickerTarget,
  id: string,
  explore: ExplorePlacesResponse | undefined
): Record<string, unknown> {
  switch (target.section) {
    case 'asset':
      return { ...fields, asset: id };
    case 'tool':
      return updateEntry(fields, target.entryIndex, (entry) => ({ ...entry, tool: id }));
    case 'ingredient':
      return updateEntry(fields, target.entryIndex, (entry) => {
        const ingredients = Array.isArray(entry.ingredients) ? entry.ingredients.slice() : [];
        const current = isRecord(ingredients[target.ingredientIndex]) ? ingredients[target.ingredientIndex] : {};
        ingredients[target.ingredientIndex] = { ...current, variety: id };
        return { ...entry, ingredients };
      });
    case 'area': {
      const area = explore?.data.areas.find((candidate) => candidate.id === id);
      const name = typeof area?.name === 'string' ? area.name : '';
      const territory = typeof area?.territoryId === 'string' ? area.territoryId : '';
      return updateEntry(fields, target.entryIndex, (entry) => {
        const locations = Array.isArray(entry.location) ? entry.location.slice() : [];
        const current = isRecord(locations[target.areaIndex]) ? locations[target.areaIndex] : {};
        locations[target.areaIndex] = { ...current, id, name, territory };
        return { ...entry, location: locations };
      });
    }
  }
}

function ObservationList({ observations }: { observations: Record<string, SourcedObservation<unknown>> }): ReactElement | null {
  const entries = Object.entries(observations);
  if (entries.length === 0) return null;
  return (
    <section aria-label="Library source observations" className={styles.section}>
      <h3 className={styles.subheading}>Source observations</h3>
      <ul className={styles.list}>
        {entries.map(([key, observation]) => {
          const observedAt = 'observedAt' in observation ? observation.observedAt : undefined;
          const error = 'error' in observation ? observation.error : undefined;
          return (
            <li key={key} className={styles.item}>
              <p className={styles.meta}>
                {stateLabel(observation.state)}
                {observedAt === undefined ? '' : ` · ${observedAt}`}
                {error === undefined ? '' : ` · ${error}`}
              </p>
              <p className={styles.meta}>{observation.source}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function EntryList(props: {
  title: string;
  entries: readonly LibraryEntry[];
  onOpen: (reference: ResourceReference) => void;
}): ReactElement | null {
  const { title, entries, onOpen } = props;
  if (entries.length === 0) return null;
  return (
    <section className={styles.section}>
      <h3 className={styles.subheading}>{title}</h3>
      <ul className={styles.list}>
        {entries.map((entry) => {
          const owner = entry.holder;
          return (
            <li key={entry.id} className={styles.item}>
              <p className={styles.label}>
                {entry.name ?? <ObjectIdentifier uri={entry.id} {...(owner === undefined ? {} : { owner })} />}
              </p>
              <p className={styles.meta}>{entry.type ?? title}</p>
              <p className={styles.meta}><ObjectIdentifier uri={entry.id} {...(owner === undefined ? {} : { owner })} /></p>
              {entry.holder === undefined ? null : <p className={styles.meta}>Holder <HandleLabel actorId={entry.holder} /></p>}
              {entry.grantee === undefined ? null : <p className={styles.meta}>Grantee <HandleLabel actorId={entry.grantee} /></p>}
              {entry.asset === undefined ? null : <p className={styles.meta}>Asset <ObjectIdentifier uri={entry.asset} {...(owner === undefined ? {} : { owner })} /></p>}
              <div className={styles.controls}>
                <Button className={styles.button} onPress={() => onOpen({ id: entry.id })}>
                  {`Open resource ${entry.id}`}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function VarietyList(props: {
  title: string;
  entries: readonly LibraryEntry[];
  onOpen: (reference: ResourceReference) => void;
}): ReactElement | null {
  const { title, entries, onOpen } = props;
  if (entries.length === 0) return null;
  return (
    <section className={styles.section}>
      <h3 className={styles.subheading}>{title}</h3>
      <ul className={styles.list}>
        {entries.map((entry) => (
          <li key={entry.id}>
            <VarietyCard
              {...(entry.name === undefined ? {} : { name: entry.name })}
              {...(entry.creator === undefined ? {} : { creator: entry.creator })}
              {...(entry.holder === undefined ? {} : { holder: entry.holder })}
              {...(entry.mass === undefined ? {} : { mass: entry.mass })}
              {...(entry.version === undefined ? {} : { version: entry.version })}
              {...(entry.media === undefined ? {} : { media: entry.media })}
              onPress={() => onOpen({ id: entry.id })}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function AssetList(props: {
  title: string;
  entries: readonly LibraryEntry[];
  onOpen: (reference: ResourceReference) => void;
}): ReactElement | null {
  const { title, entries, onOpen } = props;
  if (entries.length === 0) return null;
  return (
    <section className={styles.section}>
      <h3 className={styles.subheading}>{title}</h3>
      <ul className={styles.list}>
        {entries.map((entry) => (
          <li key={entry.id}>
            <AssetCard
              {...(entry.name === undefined ? {} : { name: entry.name })}
              {...(entry.creator === undefined ? {} : { creator: entry.creator })}
              {...(entry.holder === undefined ? {} : { holder: entry.holder })}
              {...(entry.media === undefined ? {} : { media: entry.media })}
              onPress={() => onOpen({ id: entry.id })}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Authoring(props: AuthoringProps): ReactElement {
  const { accountId, onOpenAction, onReadResource } = props;
  const [library, setLibrary] = useState<LibraryResponse | undefined>();
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryFailure, setLibraryFailure] = useState<string | undefined>();
  const [libraryRefreshError, setLibraryRefreshError] = useState<string | undefined>();
  const [refreshingLibrary, setRefreshingLibrary] = useState(false);
  const [explore, setExplore] = useState<ExplorePlacesResponse | undefined>();
  const [exploreLoading, setExploreLoading] = useState(false);
  const [exploreError, setExploreError] = useState<string | undefined>();
  const [refreshingExplore, setRefreshingExplore] = useState(false);
  const [editor, setEditor] = useState<EditorState | undefined>();
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [baseline, setBaseline] = useState<Record<string, unknown>>({});
  const [editorError, setEditorError] = useState<string | undefined>();
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [, setProductionValid] = useState(true);
  const [picker, setPicker] = useState<PickerState | undefined>();
  const [publication, setPublication] = useState<PublicationState | undefined>();
  const [checking, setChecking] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>();
  const [reader, setReader] = useState<ResourceReference | undefined>();

  const accountRef = useRef(accountId);
  const scopeGeneration = useRef(0);
  const openGeneration = useRef(0);
  const libraryGeneration = useRef(0);
  const exploreGeneration = useRef(0);
  const publicationGeneration = useRef(0);
  const libraryRef = useRef<LibraryResponse | undefined>(undefined);
  const exploreRef = useRef<ExplorePlacesResponse | undefined>(undefined);
  const editorRef = useRef<EditorState | undefined>(undefined);
  const fieldsRef = useRef<Record<string, unknown>>({});
  const baselineRef = useRef<Record<string, unknown>>({});
  const productionValidRef = useRef(true);
  const dirtySinceOpen = useRef(false);
  const savingRef = useRef(false);
  const publishingRef = useRef(false);
  const checkingRef = useRef(false);
  const refreshingLibraryRef = useRef(false);
  const exploreLoadingRef = useRef(false);
  const exploreAttempted = useRef(false);
  const refreshingExploreRef = useRef(false);
  const pickerRef = useRef<PickerState | undefined>(undefined);

  const applyLibrary = (value: LibraryResponse | undefined): void => {
    libraryRef.current = value;
    setLibrary(value);
  };

  const applyExplore = (value: ExplorePlacesResponse | undefined): void => {
    exploreRef.current = value;
    setExplore(value);
  };

  const applyEditor = (value: EditorState | undefined): void => {
    editorRef.current = value;
    setEditor(value);
  };

  const applyFields = (value: Record<string, unknown>): void => {
    fieldsRef.current = value;
    setFields(value);
  };

  const applyBaseline = (value: Record<string, unknown>): void => {
    baselineRef.current = value;
    setBaseline(value);
  };

  const setProductionValidity = (valid: boolean): void => {
    if (!valid) dirtySinceOpen.current = true;
    productionValidRef.current = valid;
    setProductionValid(valid);
  };

  const updateLibrary = (update: (current: LibraryResponse) => LibraryResponse): void => {
    const current = libraryRef.current;
    if (current === undefined) return;
    applyLibrary(update(current));
  };

  const upsertDraft = (draft: AuthoringDraft): void => {
    updateLibrary((current) => {
      const drafts = current.data.drafts.some((candidate) => candidate.id === draft.id)
        ? current.data.drafts.map((candidate) => (candidate.id === draft.id ? draft : candidate))
        : [...current.data.drafts, draft];
      return { ...current, data: { ...current.data, drafts } };
    });
  };

  useEffect(() => {
    const scope = ++scopeGeneration.current;
    const libraryRequest = ++libraryGeneration.current;
    exploreGeneration.current += 1;
    publicationGeneration.current += 1;
    accountRef.current = accountId;
    openGeneration.current += 1;
    savingRef.current = false;
    publishingRef.current = false;
    checkingRef.current = false;
    refreshingLibraryRef.current = false;
    exploreLoadingRef.current = false;
    exploreAttempted.current = false;
    refreshingExploreRef.current = false;
    dirtySinceOpen.current = false;
    pickerRef.current = undefined;
    setPicker(undefined);
    applyEditor(undefined);
    applyFields({});
    applyBaseline({});
    setEditorError(undefined);
    setValidationErrors([]);
    productionValidRef.current = true;
    setProductionValid(true);
    setSaving(false);
    setPublishing(false);
    setChecking(false);
    setPublication(undefined);
    setActionError(undefined);
    setReader(undefined);
    setExploreLoading(false);
    setExploreError(undefined);
    setRefreshingExplore(false);
    applyExplore(undefined);
    setLibraryRefreshError(undefined);
    setRefreshingLibrary(false);
    applyLibrary(undefined);
    setLibraryFailure(undefined);

    if (accountId === undefined) {
      setLibraryLoading(false);
      return;
    }

    setLibraryLoading(true);
    readLibrary(accountId).then(
      (response) => {
        if (scope !== scopeGeneration.current || accountRef.current !== accountId || libraryRequest !== libraryGeneration.current) return;
        setLibraryLoading(false);
        if (!isLibraryResponse(response)) {
          setLibraryFailure('The retained Library response was malformed.');
          return;
        }
        applyLibrary(response);
      },
      (error: unknown) => {
        if (scope !== scopeGeneration.current || accountRef.current !== accountId || libraryRequest !== libraryGeneration.current) return;
        setLibraryLoading(false);
        setLibraryFailure(errorText(error));
      }
    );
    return () => {
      if (scopeGeneration.current === scope) scopeGeneration.current += 1;
    };
  }, [accountId]);

  const closePicker = (): void => {
    const current = pickerRef.current;
    pickerRef.current = undefined;
    setPicker(undefined);
    if (current === undefined) return;
    const element = current.trigger;
    if (element === undefined) return;
    requestAnimationFrame(() => {
      if (element.isConnected) element.focus();
    });
  };

  const loadExplore = (account: string): void => {
    if (exploreAttempted.current || exploreLoadingRef.current) return;
    exploreAttempted.current = true;
    exploreLoadingRef.current = true;
    setExploreLoading(true);
    setExploreError(undefined);
    const scope = scopeGeneration.current;
    const request = ++exploreGeneration.current;
    readExplorePlaces(account).then(
      (response) => {
        if (scope !== scopeGeneration.current || accountRef.current !== account || request !== exploreGeneration.current) return;
        exploreLoadingRef.current = false;
        setExploreLoading(false);
        applyExplore(response);
      },
      (error: unknown) => {
        if (scope !== scopeGeneration.current || accountRef.current !== account || request !== exploreGeneration.current) return;
        exploreLoadingRef.current = false;
        setExploreLoading(false);
        setExploreError(errorText(error));
      }
    );
  };

  const openPicker = (target: AuthoringPickerTarget): void => {
    const spec = pickerSpec(target);
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const next = { target, ...spec, trigger };
    pickerRef.current = next;
    setPicker(next);
    if (spec.kind === 'area' && accountId !== undefined && exploreRef.current === undefined) {
      loadExplore(accountId);
    }
  };

  const selectReference = (id: string): void => {
    const current = pickerRef.current;
    if (current === undefined) return;
    const next = applyPickerSelection(fieldsRef.current, current.target, id, exploreRef.current);
    dirtySinceOpen.current = true;
    fieldsRef.current = next;
    setFields(next);
    setEditorError(undefined);
    setValidationErrors([]);
    closePicker();
  };

  const refreshCurrentLibrary = (): void => {
    const account = accountId;
    if (account === undefined || refreshingLibraryRef.current) return;
    refreshingLibraryRef.current = true;
    setRefreshingLibrary(true);
    setLibraryRefreshError(undefined);
    const scope = scopeGeneration.current;
    const request = ++libraryGeneration.current;
    setLibraryLoading(false);
    const finish = (): void => {
      if (scope !== scopeGeneration.current) return;
      refreshingLibraryRef.current = false;
      setRefreshingLibrary(false);
    };
    refreshLibrary(account).then(
      (response) => {
        if (scope !== scopeGeneration.current || accountRef.current !== account || request !== libraryGeneration.current) return;
        if (!isLibraryResponse(response)) {
          setLibraryRefreshError('The refreshed Library response was malformed.');
          finish();
          return;
        }
        applyLibrary(response);
        setLibraryFailure(undefined);
        finish();
      },
      (error: unknown) => {
        if (scope !== scopeGeneration.current || accountRef.current !== account || request !== libraryGeneration.current) return;
        setLibraryRefreshError(errorText(error));
        finish();
      }
    );
  };

  const refreshCurrentExplore = (): void => {
    const account = accountId;
    if (account === undefined || refreshingExploreRef.current) return;
    refreshingExploreRef.current = true;
    setRefreshingExplore(true);
    setExploreError(undefined);
    const scope = scopeGeneration.current;
    const request = ++exploreGeneration.current;
    exploreLoadingRef.current = false;
    setExploreLoading(false);
    const finish = (): void => {
      if (scope !== scopeGeneration.current) return;
      refreshingExploreRef.current = false;
      setRefreshingExplore(false);
    };
    refreshExplorePlaces({ accountId: account }).then(
      (response) => {
        if (scope !== scopeGeneration.current || accountRef.current !== account || request !== exploreGeneration.current) return;
        applyExplore(response);
        finish();
      },
      (error: unknown) => {
        if (scope !== scopeGeneration.current || accountRef.current !== account || request !== exploreGeneration.current) return;
        setExploreError(errorText(error));
        finish();
      }
    );
  };

  const startNew = (kind: AuthoringKind): void => {
    closePicker();
    openGeneration.current += 1;
    const next = kind === 'asset'
      ? { name: '', text: '' }
      : { name: '', mass: 0, version: '' };
    applyEditor({ draftId: undefined, kind });
    applyFields(next);
    applyBaseline(next);
    dirtySinceOpen.current = false;
    setEditorError(undefined);
    setValidationErrors([]);
    setProductionValidity(true);
  };

  const applyDraft = (draft: AuthoringDraft): void => {
    const next = { ...draft.fields };
    applyEditor({ draftId: draft.id, kind: draft.kind });
    applyFields(next);
    applyBaseline(next);
    dirtySinceOpen.current = false;
    setEditorError(undefined);
    setValidationErrors([]);
    setProductionValidity(true);
  };

  const closeEditor = (): void => {
    closePicker();
    openGeneration.current += 1;
    applyEditor(undefined);
    applyFields({});
    applyBaseline({});
    dirtySinceOpen.current = false;
    setEditorError(undefined);
    setValidationErrors([]);
    setProductionValidity(true);
  };

  const openDraft = (draftId: string): void => {
    const account = accountId;
    if (account === undefined) return;
    closePicker();
    const retained = libraryRef.current?.data.drafts.find((draft) => draft.id === draftId);
    if (retained !== undefined) applyDraft(retained);
    const generation = ++openGeneration.current;
    const scope = scopeGeneration.current;
    readDraft(draftId, account).then(
      (response) => {
        if (scope !== scopeGeneration.current || openGeneration.current !== generation) return;
        if (accountRef.current !== account) return;
        if (dirtySinceOpen.current) return;
        if (!isOwnedDraft(response.draft, account, response.draft.kind, draftId)) {
          setEditorError('The retained draft response had unexpected ownership or identity.');
          return;
        }
        applyDraft(response.draft);
      },
      (error: unknown) => {
        if (scope !== scopeGeneration.current || openGeneration.current !== generation) return;
        if (accountRef.current !== account) return;
        setEditorError(errorText(error));
      }
    );
  };

  const handleFieldsChange = (next: Record<string, unknown>): void => {
    dirtySinceOpen.current = true;
    fieldsRef.current = next;
    setFields(next);
    setEditorError(undefined);
    setValidationErrors([]);
  };

  const applySavedDraft = (draft: AuthoringDraft): void => {
    applyEditor({ draftId: draft.id, kind: draft.kind });
    applyFields({ ...draft.fields });
    applyBaseline({ ...draft.fields });
    dirtySinceOpen.current = false;
    setEditorError(undefined);
    setValidationErrors([]);
  };

  const saveCurrent = (): void => {
    const current = editorRef.current;
    const account = accountId;
    if (current === undefined || account === undefined || savingRef.current) return;
    if (!productionValidRef.current) {
      setEditorError('Production JSON is invalid; fix it before saving.');
      return;
    }
    const expectedId = current.draftId;
    const currentFields = fieldsRef.current;
    const scope = scopeGeneration.current;
    const selection = openGeneration.current;
    savingRef.current = true;
    setSaving(true);
    setEditorError(undefined);
    setValidationErrors([]);
    const request = expectedId === undefined
      ? createDraft({ accountId: account, kind: current.kind, fields: currentFields })
      : saveDraft(expectedId, { accountId: account, fields: currentFields });
    request.then(
      (response) => {
        if (scope !== scopeGeneration.current || accountRef.current !== account) return;
        savingRef.current = false;
        setSaving(false);
        if (!isOwnedDraft(response.draft, account, current.kind, expectedId)) {
          setEditorError('The server returned a draft with unexpected ownership or identity; it was not adopted.');
          return;
        }
        upsertDraft(response.draft);
        if (selection !== openGeneration.current) return;
        const active = editorRef.current;
        if (active === undefined || active.draftId !== expectedId || active.kind !== current.kind) return;
        if (fieldsRef.current === currentFields) applySavedDraft(response.draft);
        else {
          applyEditor({ draftId: response.draft.id, kind: response.draft.kind });
          applyBaseline({ ...response.draft.fields });
        }
      },
      (error: unknown) => {
        if (scope !== scopeGeneration.current || accountRef.current !== account) return;
        savingRef.current = false;
        setSaving(false);
        if (selection !== openGeneration.current) return;
        setEditorError(errorText(error));
      }
    );
  };

  const publishCurrent = (): void => {
    const current = editorRef.current;
    const account = accountId;
    if (current === undefined || account === undefined || current.draftId === undefined) return;
    if (publishingRef.current || savingRef.current) return;
    if (JSON.stringify(fieldsRef.current) !== JSON.stringify(baselineRef.current)) {
      setEditorError('Save the draft before publishing; unsaved changes are not published.');
      return;
    }
    if (!productionValidRef.current) {
      setEditorError('Production JSON is invalid; fix it before publishing.');
      return;
    }
    if (current.kind === 'variety') {
      const errors = validateProduction(fieldsRef.current.production);
      if (errors.length > 0) {
        setValidationErrors(errors);
        return;
      }
    }
    const draftId = current.draftId;
    const scope = scopeGeneration.current;
    const selection = openGeneration.current;
    const submittedFields = fieldsRef.current;
    const publicationRequest = ++publicationGeneration.current;
    checkingRef.current = false;
    setChecking(false);
    publishingRef.current = true;
    setPublishing(true);
    setEditorError(undefined);
    setValidationErrors([]);
    publishDraft(draftId, account).then(
      (response) => {
        if (scope !== scopeGeneration.current || accountRef.current !== account) return;
        publishingRef.current = false;
        setPublishing(false);
        if (selection !== openGeneration.current || publicationRequest !== publicationGeneration.current) return;
        const active = editorRef.current;
        if (active === undefined || active.draftId !== draftId || active.kind !== current.kind) return;
        if (!isActionFor(response.action, account, undefined) || !isOwnedDraft(response.draft, account, current.kind, draftId)) {
          setEditorError('The server returned an unexpected draft or action; publication was not applied.');
          return;
        }
        if (fieldsRef.current === submittedFields) applySavedDraft(response.draft);
        else applyBaseline({ ...response.draft.fields });
        upsertDraft(response.draft);
        const action = response.action;
        const resourceIds = mergeIds(resourceIdsFromAction(action), response.draft.publication?.resourceIds ?? []);
        setPublication({ draftId, action, resourceIds, status: action.submission.status === 'accepted' ? 'accepted' : 'unverified', evidence: [], checkError: undefined });
        setActionError(undefined);
      },
      (error: unknown) => {
        if (scope !== scopeGeneration.current || accountRef.current !== account) return;
        publishingRef.current = false;
        setPublishing(false);
        if (selection !== openGeneration.current || publicationRequest !== publicationGeneration.current) return;
        setEditorError(errorText(error));
      }
    );
  };

  const checkPublication = (): void => {
    const account = accountId;
    const current = publication;
    if (account === undefined || current === undefined || checkingRef.current) return;
    const actionId = current.action.id;
    const scope = scopeGeneration.current;
    const selection = publicationGeneration.current;
    checkingRef.current = true;
    setChecking(true);
    const finish = (): void => {
      if (scope !== scopeGeneration.current) return;
      checkingRef.current = false;
      setChecking(false);
    };
    refreshAction(account, actionId).then(
      (response) => {
        if (scope !== scopeGeneration.current || accountRef.current !== account || selection !== publicationGeneration.current) return;
        if (!isActionFor(response.data.action, account, actionId)) {
          setPublication((previous) => previous === undefined
            ? previous
            : { ...previous, checkError: 'The server returned an unexpected publication action.' });
          finish();
          return;
        }
        const action = response.data.action;
        const complete = actionIsComplete(action);
        setPublication((previous) => previous === undefined ? previous : {
          ...previous,
          action,
          resourceIds: mergeIds(previous.resourceIds, resourceIdsFromAction(action)),
          status: complete ? 'completed' : 'unverified',
          evidence: action.outcome.evidence,
          checkError: undefined
        });
        finish();
      },
      (error: unknown) => {
        if (scope !== scopeGeneration.current || accountRef.current !== account || selection !== publicationGeneration.current) return;
        setPublication((previous) => previous === undefined
          ? previous
          : { ...previous, checkError: errorText(error) });
        finish();
      }
    );
  };

  const openPublicationAction = (draftId: string, actionId: string): void => {
    const account = accountId;
    if (account === undefined) return;
    const scope = scopeGeneration.current;
    const selection = ++publicationGeneration.current;
    checkingRef.current = false;
    setChecking(false);
    setActionError(undefined);
    readAction(account, actionId).then(
      (response) => {
        if (scope !== scopeGeneration.current || accountRef.current !== account || selection !== publicationGeneration.current) return;
        if (!isActionFor(response.data.action, account, actionId)) {
          setActionError('The retained publication action had unexpected ownership or identity.');
          return;
        }
        const action = response.data.action;
        setPublication((previous) => {
          const resourceIds = previous !== undefined && previous.draftId === draftId
            ? mergeIds(previous.resourceIds, resourceIdsFromAction(action))
            : resourceIdsFromAction(action);
          const complete = actionIsComplete(action);
          return {
            draftId,
            action,
            resourceIds,
            status: complete ? 'completed' : 'unverified',
            evidence: action.outcome.evidence,
            checkError: undefined
          };
        });
      },
      (error: unknown) => {
        if (scope !== scopeGeneration.current || accountRef.current !== account || selection !== publicationGeneration.current) return;
        setActionError(errorText(error));
      }
    );
  };

  const openResource = (reference: ResourceReference): void => {
    if (onReadResource !== undefined) onReadResource(reference);
    else setReader(reference);
  };

  const dirty = editor !== undefined && JSON.stringify(fields) !== JSON.stringify(baseline);
  const canPublish = editor !== undefined && editor.draftId !== undefined && !dirty && !saving && !publishing;
  const editorErrors = [editorError, ...validationErrors].filter((message): message is string => message !== undefined);

  const libraryPickerError = libraryRefreshError ?? libraryFailure;
  const pickerSource: ReferencePickerSource = picker?.kind === 'area'
    ? {
      kind: 'explore',
      ...(explore === undefined ? {} : { response: explore }),
      ...(exploreLoading ? { loading: true } : {}),
      ...(exploreError === undefined ? {} : { error: exploreError })
    }
    : {
      kind: 'library',
      ...(library === undefined ? {} : { response: library }),
      ...(libraryLoading ? { loading: true } : {}),
      ...(libraryPickerError === undefined ? {} : { error: libraryPickerError })
    };

  const pickerSelection: ReferencePickerSelection | undefined = picker === undefined
    ? undefined
    : { kind: picker.kind, fieldLabel: picker.fieldLabel };

  const libraryEmpty = library !== undefined
    && library.data.assets.length === 0
    && library.data.varieties.length === 0
    && library.data.grants.length === 0
    && library.data.drafts.length === 0;

  if (accountRef.current !== accountId) return <section aria-label="Author & Publish" className={styles.workspace}><h2>Author &amp; Publish</h2></section>;

  return (
    <section aria-label="Author & Publish" className={styles.workspace}>
      <h2 className={styles.heading}>Author &amp; Publish</h2>

      <div className={styles.controls}>
        <Button className={styles.button} onPress={() => startNew('asset')}>New Asset</Button>
        <Button className={styles.button} onPress={() => startNew('variety')}>New Variety</Button>
        <Button
          className={styles.button}
          onPress={refreshCurrentLibrary}
          isPending={refreshingLibrary}
          isDisabled={accountId === undefined || refreshingLibrary}
        >
          Refresh Library
        </Button>
      </div>

      {accountId === undefined ? <p className={styles.meta}>No account is selected for Author &amp; Publish.</p> : null}
      {libraryLoading ? <p className={styles.meta}>Loading the retained Library…</p> : null}
      {libraryFailure === undefined ? null : (
        <p className={styles.error} role="alert">The Library could not be read: {libraryFailure}</p>
      )}
      {libraryRefreshError === undefined ? null : (
        <p className={styles.error} role="alert">The Library refresh failed: {libraryRefreshError}</p>
      )}

      {library !== undefined ? (
        <>
          {libraryEmpty ? (
            <p className={styles.meta}>The Library is empty: no assets, varieties, grants, or drafts are available.</p>
          ) : null}
          <AssetList title="Library assets" entries={library.data.assets} onOpen={openResource} />
          <VarietyList title="Library varieties" entries={library.data.varieties} onOpen={openResource} />
          <EntryList title="Library grants" entries={library.data.grants} onOpen={openResource} />
          {library.data.drafts.length === 0 ? null : (
            <section className={styles.section}>
              <h3 className={styles.subheading}>Saved drafts</h3>
              <ul className={styles.list}>
                {library.data.drafts.map((draft) => (
                  <li key={draft.id} className={styles.item}>
                    <p className={styles.label}>{draftName(draft)}</p>
                    <p className={styles.meta}>{draft.kind} · {draft.id} · saved {draft.savedAt}</p>
                    <div className={styles.controls}>
                      <Button className={styles.button} onPress={() => openDraft(draft.id)}>
                        {`Open draft ${draft.id}`}
                      </Button>
                      {draft.publication?.actionId === undefined ? null : (
                        <Button
                          className={styles.button}
                          onPress={() => openPublicationAction(draft.id, draft.publication!.actionId!)}
                        >
                          {`Open publication action ${draft.publication.actionId}`}
                        </Button>
                      )}
                    </div>
                    {draft.publication?.resourceIds === undefined || draft.publication.resourceIds.length === 0 ? null : (
                      <div className={styles.controls}>
                        {draft.publication.resourceIds.map((id) => (
                          <Button key={id} className={styles.button} onPress={() => openResource({ id })}>
                            {`Open resource ${id}`}
                          </Button>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <ObservationList observations={library.observations} />
        </>
      ) : null}

      {publication === undefined ? null : (
        <section aria-label="Publication" className={styles.section}>
          <h3 className={styles.subheading}>Publication</h3>
          <p className={styles.meta}>Action {publication.action.id}</p>
          <p className={styles.meta}>Submission: {publication.action.submission.status} · Outcome: {publication.action.outcome.status}</p>
          {publication.action.submission.error === undefined ? null : <p className={styles.error}>{publication.action.submission.error}</p>}
          {publication.action.outcome.error === undefined ? null : <p className={styles.error}>{publication.action.outcome.error}</p>}
          <p className={styles.meta}>
            {publication.status === 'completed'
              ? 'Publication completed and verified by evidence.'
              : publication.status === 'unverified'
                ? 'Publication action read back; completion remains unverified.'
                : 'Publication accepted. Acceptance is not completion; use Check publication for evidenced readback.'}
          </p>
          {publication.resourceIds.length === 0 ? null : (
            <div className={styles.controls}>
              {publication.resourceIds.map((id) => (
                <Button key={id} className={styles.button} onPress={() => openResource({ id })}>
                  {`Open resource ${id}`}
                </Button>
              ))}
            </div>
          )}
          {publication.evidence.length === 0 ? null : (
            <ul className={styles.list}>
              {publication.evidence.map((evidence) => (
                <li key={evidence.source} className={styles.item}>
                  <p className={styles.meta}>Evidence {evidence.source} · {evidence.observedAt}</p>
                </li>
              ))}
            </ul>
          )}
          {publication.checkError === undefined ? null : (
            <p className={styles.error} role="alert">The publication check failed: {publication.checkError}</p>
          )}
          <div className={styles.controls}>
            <Button className={styles.button} onPress={checkPublication} isPending={checking} isDisabled={checking}>
              Check publication
            </Button>
            {onOpenAction === undefined ? null : (
              <Button className={styles.button} onPress={() => onOpenAction(publication.action.id)}>
                Open Activity
              </Button>
            )}
          </div>
        </section>
      )}

      {actionError === undefined ? null : (
        <p className={styles.error} role="alert">The publication action could not be read: {actionError}</p>
      )}

      {editor === undefined ? null : editor.kind === 'asset' ? (
        <AssetEditor
          key={`asset:${openGeneration.current}`}
          fields={fields}
          onChange={handleFieldsChange}
          dirty={dirty}
          saving={saving}
          publishing={publishing}
          canPublish={canPublish}
          errors={editorErrors}
          onSave={saveCurrent}
          onPublish={publishCurrent}
          onClose={closeEditor}
        />
      ) : (
        <VarietyEditor
          key={`variety:${openGeneration.current}`}
          fields={fields}
          onChange={handleFieldsChange}
          dirty={dirty}
          saving={saving}
          publishing={publishing}
          canPublish={canPublish}
          errors={editorErrors}
          onSave={saveCurrent}
          onPublish={publishCurrent}
          onClose={closeEditor}
          onChooseAsset={openPicker}
          onChooseVariety={openPicker}
          onChooseArea={openPicker}
          onProductionValidityChange={setProductionValidity}
        />
      )}

      <ReferencePicker
        {...(accountId === undefined ? {} : { accountId })}
        selection={pickerSelection}
        source={pickerSource}
        refreshing={picker?.kind === 'area' ? refreshingExplore : refreshingLibrary}
        onRefresh={picker?.kind === 'area' ? refreshCurrentExplore : refreshCurrentLibrary}
        onSelect={selectReference}
        onClose={closePicker}
      />

      <ResourceReader
        resource={reader}
        {...(accountId === undefined ? {} : { accountId })}
        onClose={() => setReader(undefined)}
      />
    </section>
  );
}
