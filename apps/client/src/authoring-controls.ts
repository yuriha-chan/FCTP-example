import type { AuthoringDraft, AuthoringKind, LibraryData, LibraryEntry, SourcedObservation } from '@fctp/client-sdk';
import { createDraft, publishDraft, readDraft, readLibrary, refreshLibrary, saveDraft } from './application-api.js';
import { identityDisplay } from './identity-display.js';
import { setupProductionEditor } from './production-editor.js';
import type { ResourceInsertionTarget, ResourceReaderController, ResourceReference } from './resource-reader.js';

export interface AuthoringControlsOptions {
  selectedAccountId: () => string | undefined;
  reader?: ResourceReaderController;
}

export interface AuthoringControlsController {
  accountChanged(): void;
}

function element<T extends HTMLElement>(id: string): T | undefined {
  const found = document.getElementById(id);
  return found instanceof HTMLElement ? found as T : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function label(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const identity = identityDisplay.get(value);
  return identity?.name || identity?.handle || fallback;
}

function sourceLabel(key: string): string {
  if (key.includes(':catalog')) return 'Authoring catalog';
  if (key.includes(':creations')) return 'Published creations';
  if (key.includes(':advertisement')) return 'Player advertisement';
  return 'Library source';
}

function sourceLine(observation: SourcedObservation<unknown>): string {
  const observedAt = 'observedAt' in observation && observation.observedAt !== undefined ? ` · ${observation.observedAt}` : '';
  const error = 'error' in observation && observation.error !== undefined ? ` · ${observation.error}` : '';
  return `${observation.state}${observedAt}${error}`;
}

export function setupAuthoringControls(options: AuthoringControlsOptions): AuthoringControlsController | undefined {
  const section = element<HTMLElement>('authoring-controls');
  const refreshButton = element<HTMLButtonElement>('authoring-refresh-library');
  const status = element<HTMLElement>('authoring-status');
  const libraryPanel = element<HTMLElement>('authoring-library');
  const form = element<HTMLFormElement>('authoring-draft-form');
  if (!section || !refreshButton || !status || !libraryPanel || !form) return;
  const kindField = form.elements.namedItem('draftKind') as HTMLSelectElement;
  const nameField = form.elements.namedItem('draftName') as HTMLInputElement;
  const textField = form.elements.namedItem('draftText') as HTMLTextAreaElement;
  const massField = form.elements.namedItem('draftMass') as HTMLInputElement;
  const versionField = form.elements.namedItem('draftVersion') as HTMLInputElement;
  const assetField = form.elements.namedItem('draftAsset') as HTMLInputElement;
  const targetField = form.elements.namedItem('productionTarget') as HTMLSelectElement;
  const editor = setupProductionEditor(form);

  let operation = 0;
  let currentDraft: { id: string; kind: AuthoringKind } | undefined;
  let insertionTarget: ResourceInsertionTarget = 'asset';

  const setStatus = (message: string): void => { status.textContent = message; };

  const withBusy = async (action: () => Promise<void>): Promise<void> => {
    document.documentElement.dataset.clientBusy = 'true';
    try {
      await action();
    } catch (error) {
      setStatus(`Authoring error: ${errorText(error)}`);
    } finally {
      document.documentElement.dataset.clientBusy = 'false';
    }
  };

  const applyDraft = (draft: AuthoringDraft): void => {
    currentDraft = { id: draft.id, kind: draft.kind };
    kindField.value = draft.kind;
    nameField.value = typeof draft.fields.name === 'string' ? draft.fields.name : '';
    textField.value = typeof draft.fields.text === 'string' ? draft.fields.text : '';
    massField.value = typeof draft.fields.mass === 'number' ? String(draft.fields.mass) : '';
    versionField.value = typeof draft.fields.version === 'string' ? draft.fields.version : '';
    assetField.value = typeof draft.fields.asset === 'string' ? draft.fields.asset : '';
    editor.populate(Array.isArray(draft.fields.production) ? draft.fields.production : []);
  };

  const draftButton = (draft: AuthoringDraft): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Open saved draft';
    button.addEventListener('click', () => {
      void withBusy(async () => {
        const accountId = options.selectedAccountId();
        if (accountId === undefined) { setStatus('Select an account before opening a draft.'); return; }
        const startedOperation = operation;
        const response = await readDraft(draft.id, accountId);
        if (operation !== startedOperation || options.selectedAccountId() !== accountId) return;
        applyDraft(response.draft);
        setStatus(`Opened ${response.draft.kind} draft.`);
      });
    });
    return button;
  };

  const readButton = (entry: LibraryEntry, kind: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `Read ${entry.name ?? kind}`;
    button.addEventListener('click', () => {
      void withBusy(async () => {
        await options.reader?.open(entry.id);
      });
    });
    return button;
  };

  const renderEntries = (title: string, entries: LibraryEntry[], kind: string): void => {
    if (entries.length === 0) return;
    const heading = document.createElement('h4');
    heading.textContent = title;
    libraryPanel.append(heading);
    for (const entry of entries) {
      const card = document.createElement('article');
      const name = document.createElement('h3');
      name.textContent = entry.name ?? kind;
      const details = document.createElement('p');
      details.textContent = kind === 'Grant'
        ? `Grant: ${label(entry.asset, 'Asset')} to ${label(entry.variety, 'Variety')} for ${label(entry.grantee, 'Actor')}`
        : `${kind} · ${label(entry.id, kind)}`;
      card.append(name, details, readButton(entry, kind));
      libraryPanel.append(card);
    }
  };

  const renderLibrary = (data: LibraryData, observations: Record<string, SourcedObservation<unknown>>): void => {
    libraryPanel.replaceChildren();
    const sourceEntries = Object.entries(observations);
    if (sourceEntries.length > 0) {
      const heading = document.createElement('h4');
      heading.textContent = 'Library sources';
      libraryPanel.append(heading);
      for (const [key, observation] of sourceEntries) {
        const line = document.createElement('p');
        line.textContent = `${sourceLabel(key)} · ${sourceLine(observation)}`;
        libraryPanel.append(line);
      }
      const technical = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Library source technical details';
      const body = document.createElement('pre');
      body.textContent = sourceEntries.map(([key, observation]) => `${key}\n${observation.source}\n${sourceLine(observation)}`).join('\n\n');
      technical.append(summary, body);
      libraryPanel.append(technical);
    }
    if (data.drafts.length === 0 && data.assets.length === 0 && data.varieties.length === 0 && data.grants.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No retained Library content. Refresh the library to read authored resources.';
      libraryPanel.append(empty);
      return;
    }
    if (data.drafts.length > 0) {
      const heading = document.createElement('h4');
      heading.textContent = 'Drafts';
      libraryPanel.append(heading);
      for (const draft of data.drafts) {
        const card = document.createElement('article');
        const name = document.createElement('h3');
        name.textContent = typeof draft.fields.name === 'string' ? draft.fields.name : 'Untitled draft';
        const details = document.createElement('p');
        details.textContent = `${draft.kind} draft · saved ${draft.savedAt}`;
        card.append(name, details, draftButton(draft));
        libraryPanel.append(card);
      }
    }
    renderEntries('Assets', data.assets, 'Asset');
    renderEntries('Varieties', data.varieties, 'Variety');
    renderEntries('Grants', data.grants, 'Grant');
  };

  const loadLibrary = async (): Promise<void> => {
    const accountId = options.selectedAccountId();
    if (accountId === undefined) return;
    const startedOperation = operation;
    const response = await readLibrary(accountId);
    if (operation !== startedOperation || options.selectedAccountId() !== accountId) return;
    renderLibrary(response.data, response.observations);
  };

  const fieldsFor = (kind: AuthoringKind): Record<string, unknown> => {
    if (kind === 'asset') return { name: nameField.value, text: textField.value };
    const production = editor.collect();
    const fields: Record<string, unknown> = { name: nameField.value, mass: Number(massField.value), version: versionField.value };
    if (assetField.value.trim()) fields.asset = assetField.value.trim();
    if (production.length > 0) fields.production = production;
    return fields;
  };

  kindField.addEventListener('change', () => {
    currentDraft = undefined;
    setStatus(`Draft kind: ${kindField.value}.`);
  });

  targetField.addEventListener('change', () => {
    insertionTarget = targetField.value === 'tool' ? 'tool' : targetField.value === 'ingredient' ? 'ingredient' : 'asset';
    setStatus(`Production insertion target: ${insertionTarget}.`);
  });

  form.querySelector<HTMLButtonElement>('#authoring-new-draft')?.addEventListener('click', () => {
    operation += 1;
    currentDraft = undefined;
    form.reset();
    kindField.value = 'asset';
    targetField.value = 'asset';
    insertionTarget = 'asset';
    editor.reset();
    setStatus('New draft ready. Save to create it without changing the previous draft.');
  });

  refreshButton.addEventListener('click', () => {
    void withBusy(async () => {
      const accountId = options.selectedAccountId();
      if (accountId === undefined) { setStatus('Select an account before refreshing the library.'); return; }
      const startedOperation = operation;
      const response = await refreshLibrary(accountId);
      if (operation !== startedOperation || options.selectedAccountId() !== accountId) return;
      renderLibrary(response.data, response.observations);
      const sources = Object.values(response.observations).map(sourceLine).join('; ');
      setStatus(sources
        ? `Library refreshed with ${response.data.assets.length} asset(s), ${response.data.varieties.length} variety(ies), ${response.data.grants.length} grant(s) and ${response.data.drafts.length} draft(s). Sources: ${sources}.`
        : `Library refreshed with ${response.data.assets.length} asset(s), ${response.data.varieties.length} variety(ies), ${response.data.grants.length} grant(s) and ${response.data.drafts.length} draft(s).`);
    });
  });

  form.querySelector<HTMLButtonElement>('#authoring-save')?.addEventListener('click', () => {
    void withBusy(async () => {
      const accountId = options.selectedAccountId();
      if (accountId === undefined) { setStatus('Select an account before saving a draft.'); return; }
      const kind = (kindField.value === 'variety' ? 'variety' : 'asset') as AuthoringKind;
      const fields = fieldsFor(kind);
      const startedOperation = operation;
      const response = currentDraft !== undefined && currentDraft.kind === kind
        ? await saveDraft(currentDraft.id, { accountId, fields })
        : await createDraft({ accountId, kind, fields });
      if (operation !== startedOperation || options.selectedAccountId() !== accountId) return;
      applyDraft(response.draft);
      await loadLibrary();
      setStatus('Draft saved.');
    });
  });

  form.querySelector<HTMLButtonElement>('#authoring-publish')?.addEventListener('click', () => {
    void withBusy(async () => {
      const accountId = options.selectedAccountId();
      if (accountId === undefined) { setStatus('Select an account before publishing a draft.'); return; }
      if (currentDraft === undefined) { setStatus('Save or open a draft before publishing.'); return; }
      const startedOperation = operation;
      const response = await publishDraft(currentDraft.id, accountId);
      if (operation !== startedOperation || options.selectedAccountId() !== accountId) return;
      applyDraft(response.draft);
      await loadLibrary();
      setStatus(`Publication ${response.action.submission.status}.`);
    });
  });

  const insertReference = (reference: ResourceReference, target: ResourceInsertionTarget): void => {
    if (target === 'asset') {
      assetField.value = reference.id;
    } else if (target === 'tool') {
      const tools = [...form.querySelectorAll<HTMLInputElement>('[name="productionTool"]')];
      const field = tools.at(-1);
      if (field === undefined) { setStatus('Add a Production entry before inserting a tool reference.'); return; }
      field.value = reference.id;
    } else {
      const rows = [...form.querySelectorAll<HTMLElement>('[data-production-rows="ingredient"] [data-production-row]')];
      const field = rows.at(-1)?.querySelector<HTMLInputElement>('[name="ingredientVariety"]');
      if (field === undefined || field === null) { setStatus('Add an ingredient before inserting an ingredient reference.'); return; }
      field.value = reference.id;
    }
    setStatus(`${target === 'asset' ? 'Asset' : target === 'tool' ? 'Production tool' : 'Production ingredient'} reference selected: ${reference.id}`);
  };

  options.reader?.setUseReferenceHandler((reference, target) => {
    insertReference(reference, target ?? insertionTarget);
  });

  return {
    accountChanged(): void {
      operation += 1;
      currentDraft = undefined;
      libraryPanel.replaceChildren();
      form.reset();
      kindField.value = 'asset';
      targetField.value = 'asset';
      insertionTarget = 'asset';
      editor.reset();
      setStatus('Select an account, then refresh the library.');
      void withBusy(loadLibrary);
    }
  };
}
