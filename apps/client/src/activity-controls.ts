import type { ActionRecord, SourcedObservation } from '@fctp/client-sdk';
import { readAction, readActivity, refreshAction } from './application-api.js';
import { identityDisplay } from './identity-display.js';

function element<T extends HTMLElement>(id: string): T | undefined {
  const found = document.getElementById(id);
  return found instanceof HTMLElement ? found as T : undefined;
}

function paragraph(textValue: string): HTMLParagraphElement {
  const node = document.createElement('p');
  node.textContent = textValue;
  return node;
}

function details(summaryText: string, lines: readonly string[]): HTMLDetailsElement {
  const node = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = summaryText;
  node.append(summary);
  for (const line of lines) node.append(paragraph(line));
  return node;
}

function observationLines(observation: SourcedObservation<unknown>): string[] {
  const lines = [`Source: ${observation.source}`, `State: ${observation.state}`];
  if ('observedAt' in observation && observation.observedAt) lines.push(`Retrieved: ${observation.observedAt}`);
  if ('error' in observation && observation.error) lines.push(`Error: ${observation.error}`);
  if ('value' in observation) lines.push(`Value: ${JSON.stringify(observation.value)}`);
  return lines;
}

function renderObservations(container: HTMLElement, observations: Record<string, SourcedObservation<unknown>>): void {
  const entries = Object.values(observations);
  if (entries.length === 0) {
    container.append(paragraph('No retained observations.'));
    return;
  }
  const lines = entries.flatMap((observation) => observationLines(observation));
  for (const observation of entries) {
    container.append(paragraph(`Observation: ${observation.state}${'observedAt' in observation && observation.observedAt ? ` · Retrieved ${observation.observedAt}` : ''}${'error' in observation && observation.error ? ` · ${observation.error}` : ''}`));
  }
  container.append(details('Observation details', lines));
}

function targetLabel(id: string): string {
  const known = identityDisplay.get(id);
  return known?.name || known?.handle || 'Selected authority';
}

function referenceLines(action: ActionRecord): string[] {
  return action.resultReferences.map((reference) => `Result reference ${reference.kind}: ${reference.id}`);
}

function renderActionSummary(container: HTMLElement, action: ActionRecord, open: (actionId: string) => void): void {
  const article = document.createElement('article');
  const title = document.createElement('h3');
  title.textContent = `${action.intent.kind} action ${action.id}`;
  article.append(title);
  article.append(paragraph(`Target: ${targetLabel(action.targetId)}`));
  article.append(paragraph(`Submission: ${action.submission.status}`));
  article.append(paragraph(`Outcome: ${action.outcome.status}`));
  article.append(paragraph(`Result kinds: ${action.resultReferences.map((reference) => reference.kind).join(', ') || 'Not yet known'}`));
  article.append(details('Action result references', referenceLines(action)));
  if (action.submission.error) article.append(paragraph(`Submission error: ${action.submission.error}`));
  if (action.outcome.error) article.append(paragraph(`Outcome error: ${action.outcome.error}`));
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = `Open action ${action.id}`;
  button.addEventListener('click', () => open(action.id));
  article.append(button);
  container.append(article);
}

function renderActionDetail(container: HTMLElement, action: ActionRecord, observations: Record<string, SourcedObservation<unknown>>, refresh: () => void): void {
  container.replaceChildren();
  const article = document.createElement('article');
  const title = document.createElement('h3');
  title.textContent = `Action ${action.id}`;
  article.append(title);
  article.append(paragraph(`Intent: ${action.intent.kind}`));
  article.append(paragraph(`Inputs: ${JSON.stringify(action.intent.inputs)}`));
  article.append(paragraph(`Target: ${targetLabel(action.targetId)}`));
  article.append(paragraph(`Submission: ${action.submission.status}`));
  article.append(paragraph(`Outcome: ${action.outcome.status}`));
  article.append(paragraph(`Result kinds: ${action.resultReferences.map((reference) => reference.kind).join(', ') || 'Not yet known'}`));
  if (action.submission.error) article.append(paragraph(`Submission error: ${action.submission.error}`));
  if (action.outcome.error) article.append(paragraph(`Outcome error: ${action.outcome.error}`));
  const detailLines = [
    `Action: ${action.id}`,
    `Account: ${action.accountId}`,
    `Target: ${action.targetId}`,
    `Expected kind: ${action.intent.kind}`,
    `Submitted: ${action.submittedAt}`,
    ...(action.submission.result ? [`Submission result: ${action.submission.result}`] : []),
    `Inputs: ${JSON.stringify(action.intent.inputs)}`,
    ...referenceLines(action),
    ...action.outcome.evidence.map((evidence) => `Evidence: ${evidence.source} at ${evidence.observedAt}`)
  ];
  article.append(details(`Action ${action.id} details`, detailLines));
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Refresh selected action';
  button.addEventListener('click', refresh);
  article.append(button);
  const observationContainer = document.createElement('div');
  renderObservations(observationContainer, observations);
  article.append(observationContainer);
  container.append(article);
}

export interface ActivityControlsOptions {
  selectedAccountId: () => string | undefined;
}

export function setupActivityControls(options: ActivityControlsOptions): void {
  const refreshButton = element<HTMLButtonElement>('activity-refresh');
  const list = element<HTMLElement>('activity-list');
  const detail = element<HTMLElement>('activity-detail');
  const status = element<HTMLElement>('activity-status');
  if (!refreshButton || !list || !detail || !status) return;

  let selectedActionId: string | undefined;

  const accountId = (): string | undefined => options.selectedAccountId();

  const open = (actionId: string): void => {
    const current = accountId();
    if (!current) {
      status.textContent = 'Select an account before opening an action.';
      return;
    }
    selectedActionId = actionId;
    void (async () => {
      try {
        const response = await readAction(current, actionId);
        status.textContent = `Opened action ${actionId}.`;
        renderActionDetail(detail, response.data.action, response.observations, () => { void refreshSelected(); });
      } catch (error) {
        status.textContent = `Action read failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    })();
  };

  const refreshSelected = async (): Promise<void> => {
    const current = accountId();
    if (!current || !selectedActionId) {
      status.textContent = 'Open an action before refreshing it.';
      return;
    }
    try {
      const response = await refreshAction(current, selectedActionId);
      status.textContent = `Reconciled action ${selectedActionId}.`;
      renderActionDetail(detail, response.data.action, response.observations, () => { void refreshSelected(); });
    } catch (error) {
      status.textContent = `Action refresh failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const refreshList = async (): Promise<void> => {
    const current = accountId();
    list.replaceChildren();
    detail.replaceChildren();
    selectedActionId = undefined;
    if (!current) {
      status.textContent = 'Select an account to view Activity.';
      return;
    }
    try {
      const response = await readActivity(current);
      const actions = response.data.actions;
      status.textContent = actions.length === 0 ? 'No retained actions for the selected account.' : `Retained actions: ${actions.length}.`;
      if (actions.length === 0) list.append(paragraph('No retained actions.'));
      for (const action of actions) renderActionSummary(list, action, open);
    } catch (error) {
      status.textContent = `Activity read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  refreshButton.addEventListener('click', () => { void refreshList(); });
}
