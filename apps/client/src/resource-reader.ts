import type { ResourceReaderData, SourcedObservation } from '@fctp/client-sdk';
import { refreshResourceReader, type ResourceReaderResponse } from './application-api.js';
import { identityDisplay } from './identity-display.js';
import { formatResource } from './presentation.js';

export interface ResourceReaderOptions {
  selectedAccountId: () => string | undefined;
}

export interface ResourceReference {
  id: string;
  name?: string;
  type?: string;
}

export type ResourceInsertionTarget = 'asset' | 'tool' | 'ingredient';

export interface ResourceReaderController {
  open(resourceId: string, authorityId?: string): Promise<void>;
  accountChanged(): void;
  setUseReferenceHandler(handler: ((reference: ResourceReference, target?: ResourceInsertionTarget) => void) | undefined): void;
}

function element<T extends HTMLElement>(id: string): T | undefined {
  const found = document.getElementById(id);
  return found instanceof HTMLElement ? found as T : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function detailsBlock(label: string, content: string): HTMLDetailsElement {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = label;
  const body = document.createElement('pre');
  body.textContent = content;
  details.append(summary, body);
  return details;
}

function stringValue(observation: SourcedObservation<unknown>): string | undefined {
  return 'value' in observation && typeof observation.value === 'string' ? observation.value : undefined;
}

function referenceLabel(id: string, fallback: string): string {
  const identity = identityDisplay.get(id);
  return identity?.name || identity?.handle || fallback;
}

function observationLine(observation: SourcedObservation<unknown>): string {
  const observedAt = 'observedAt' in observation && observation.observedAt !== undefined ? ` · ${observation.observedAt}` : '';
  const error = 'error' in observation && observation.error !== undefined ? ` · ${observation.error}` : '';
  return `${observation.state}${observedAt}${error}`;
}

export function setupResourceReader(options: ResourceReaderOptions): ResourceReaderController | undefined {
  const panel = element<HTMLElement>('resource-reader-result');
  if (!panel) return;

  let operation = 0;
  let useReferenceHandler: ((reference: ResourceReference, target?: ResourceInsertionTarget) => void) | undefined;

  const renderError = (resourceId: string, error: unknown): void => {
    panel.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = 'Resource';
    const message = document.createElement('p');
    message.textContent = `Resource reader error: ${errorText(error)}`;
    panel.append(heading, message, detailsBlock('Resource technical details', `Source ${resourceId}\nError ${errorText(error)}`));
  };

  const render = (resourceId: string, response: ResourceReaderResponse): void => {
    panel.replaceChildren();
    const value = response.data.value;
    const record = isRecord(value) ? value : undefined;
    const name = record !== undefined && typeof record.name === 'string' ? record.name : undefined;
    const type = record !== undefined && typeof record.type === 'string' ? record.type : undefined;
    const heading = document.createElement('h3');
    heading.textContent = name ?? (typeof value === 'string' ? 'Resource text' : 'Resource');
    panel.append(heading);
    const observation = Object.values(response.observations).find((candidate) => candidate.source === resourceId);
    const source = observation?.source ?? resourceId;
    const observedAt = observation !== undefined && 'observedAt' in observation ? observation.observedAt : 'not retrieved';
    const state = observation?.state ?? 'not-retrieved';
    const summary = document.createElement('p');
    summary.textContent = `${state}${observedAt === 'not retrieved' ? '' : ` · ${observedAt}`}${observation !== undefined && 'error' in observation && observation.error ? ` · ${observation.error}` : ''}`;
    panel.append(summary);
    if (typeof value === 'string') {
      const text = document.createElement('pre');
      text.textContent = value;
      panel.append(text);
    } else if (value !== undefined) {
      const readable = document.createElement('pre');
      readable.textContent = formatResource(value);
      panel.append(readable);
    }
    const mediaObservations = Object.values(response.observations).filter((candidate) => candidate.source !== response.data.resourceId);
    if (mediaObservations.length > 0) {
      const mediaHeading = document.createElement('h4');
      mediaHeading.textContent = 'Media observations';
      panel.append(mediaHeading);
      for (const observationValue of mediaObservations) {
        const line = document.createElement('p');
        line.textContent = `Media · ${observationLine(observationValue)}`;
        panel.append(line);
        const textValue = stringValue(observationValue);
        if (textValue !== undefined) {
          const body = document.createElement('pre');
          body.textContent = textValue;
          panel.append(body);
        }
        panel.append(detailsBlock('Media technical details', `Source ${observationValue.source}\n${observationLine(observationValue)}`));
      }
    }
    if (record !== undefined) {
      const references: Array<{ label: string; id: string }> = [];
      for (const key of ['creator', 'holder', 'asset', 'assets', 'varieties', 'media', 'resources', 'variety', 'grantee']) {
        const reference = record[key];
        const values = Array.isArray(reference) ? reference : reference !== null && typeof reference === 'object' ? Object.values(reference) : [reference];
        for (const entry of values) {
          const id = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>).url ?? (entry as Record<string, unknown>).id : undefined;
          if (typeof id === 'string' && /^https?:\/\//.test(id)) references.push({ label: key, id });
        }
      }
      const unique = references.filter((reference, index) => references.findIndex((candidate) => candidate.label === reference.label && candidate.id === reference.id) === index);
      for (const reference of unique) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `Read linked ${reference.label} ${referenceLabel(reference.id, 'reference')}`;
        button.addEventListener('click', () => { void open(reference.id, response.data.authorityId); });
        panel.append(button);
      }
      const reference: ResourceReference = { id: resourceId, ...(name === undefined ? {} : { name }), ...(type === undefined ? {} : { type }) };
      if (type === 'Asset' && name !== undefined) {
        const use = document.createElement('button');
        use.type = 'button';
        use.textContent = `Use ${name} as asset reference`;
        use.addEventListener('click', () => { useReferenceHandler?.(reference, 'asset'); });
        panel.append(use);
      }
      if (useReferenceHandler !== undefined) {
        const insert = document.createElement('button');
        insert.type = 'button';
        insert.textContent = `Use ${name ?? referenceLabel(resourceId, 'resource')} as reference`;
        insert.addEventListener('click', () => { useReferenceHandler?.(reference); });
        panel.append(insert);
      }
    }
    const technical = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    panel.append(detailsBlock('Resource technical details', `Source ${source}\nAuthority ${response.data.authorityId ?? ''}\nObserved ${observedAt}\nState ${state}\n${technical}`));
  };

  const open = async (resourceId: string, authorityId?: string): Promise<void> => {
    const startedAccount = options.selectedAccountId();
    operation += 1;
    const startedOperation = operation;
    try {
      const response = await refreshResourceReader(resourceId, {
        ...(startedAccount === undefined ? {} : { accountId: startedAccount }),
        ...(authorityId === undefined ? {} : { authorityId })
      });
      if (options.selectedAccountId() !== startedAccount || operation !== startedOperation) return;
      render(resourceId, response);
    } catch (error) {
      if (options.selectedAccountId() !== startedAccount || operation !== startedOperation) return;
      renderError(resourceId, error);
    }
  };

  return {
    open,
    accountChanged(): void {
      operation += 1;
      panel.replaceChildren();
    },
    setUseReferenceHandler(handler): void {
      useReferenceHandler = handler;
    }
  };
}

export type { ResourceReaderData };
