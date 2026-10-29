import type {
  ActionRecord,
  LogisticsVesselData,
  ProductionData,
  ProductionJob,
  ProductionOperation,
  ProductionOperationInput
} from '@fctp/client-sdk';
import {
  executeProductionOperation,
  readProductionJob,
  refreshLogisticsVessel,
  refreshProduction,
  refreshProductionJob,
  submitLogisticsAdoption,
  submitLogisticsDeparture,
  submitLogisticsEntry,
  type ActionResponse
} from './application-api.js';
import { identityDisplay } from './identity-display.js';

export interface LogisticsControlsOptions {
  selectedAccountId: () => string | undefined;
  initialVesselId?: () => string | undefined;
}

export interface LogisticsControlsController {
  accountChanged(): void;
}

function element<T extends HTMLElement>(id: string): T | undefined {
  const found = document.getElementById(id);
  return found instanceof HTMLElement ? found as T : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function field<T extends HTMLElement>(root: HTMLElement, name: string): T | undefined {
  const found = root.querySelector<T>(`[name="${name}"]`);
  return found ?? undefined;
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

function observationLine(observation: { state: string; observedAt?: string; error?: string; source: string }): string {
  return `${observation.state}${observation.observedAt === undefined ? '' : ` · ${observation.observedAt}`}${observation.error === undefined ? '' : ` · ${observation.error}`}`;
}

function entries(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.entries)) return record.entries;
    return Object.entries(record).map(([id, count]) => ({ id, count }));
  }
  return undefined;
}

function quantitySummary(value: unknown, fallback: string): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const groups = [['warehouse', 'Warehouse'], ['port', 'Port'], ['raw', 'Raw stock'], ['products', 'Products']] as const;
    const present = groups.filter(([key]) => key in record);
    if (present.length > 0) return present.map(([key, label]) => `${label}: ${quantitySummary(record[key], fallback)}`).join('; ');
  }
  const items = entries(value);
  if (!items) return `${fallback} unavailable`;
  if (items.length === 0) return `${fallback} none recorded`;
  return items.map((item) => {
    if (typeof item !== 'object' || item === null) return `${fallback} quantity unavailable`;
    const record = item as Record<string, unknown>;
    const id = typeof record.variety === 'string' ? record.variety : typeof record.commodity === 'string' ? record.commodity : typeof record.id === 'string' ? record.id : typeof record.asset === 'string' ? record.asset : undefined;
    const name = id ? identityDisplay.get(id) : undefined;
    const label = name ? `${name.name || name.handle || fallback}${name.name && name.handle ? ` (${name.handle})` : ''}` : fallback;
    const count = record.count ?? record.quantity ?? (typeof record.id === 'string' && typeof record.variety === 'string' ? 1 : undefined);
    return `${label}: ${typeof count === 'number' ? count : 'quantity unavailable'}`;
  }).join(', ');
}

function neutralReferences(value: string): string {
  return value.replace(/(?:https?:\/\/|urn:)[^\s,;]+/gi, 'reference');
}

function actionSummary(action: ActionRecord): string {
  const outcome = action.outcome.status;
  if (action.outcome.evidence.length > 0) return `${outcome} · evidence ${action.outcome.evidence.length}`;
  return `${outcome}${action.submission.error === undefined ? '' : ` · ${action.submission.error}`}${action.outcome.error === undefined ? '' : ` · ${action.outcome.error}`}`;
}

export function setupLogisticsControls(options: LogisticsControlsOptions): LogisticsControlsController | undefined {
  const section = element<HTMLElement>('logistics-production');
  const vesselField = element<HTMLInputElement>('logistics-vessel');
  const refreshVesselButton = element<HTMLButtonElement>('logistics-refresh-vessel');
  const refreshProductionButton = element<HTMLButtonElement>('logistics-refresh-production');
  const status = element<HTMLElement>('logistics-status');
  const summary = element<HTMLElement>('logistics-summary');
  const actionForms = element<HTMLElement>('logistics-actions');
  const authorityPanel = element<HTMLElement>('production-authority-panel');
  const operationsPanel = element<HTMLElement>('production-operations');
  const jobsPanel = element<HTMLElement>('production-jobs');
  const logisticsTechnical = element<HTMLElement>('logistics-technical');
  const productionTechnical = element<HTMLElement>('production-technical');
  if (!section || !vesselField || !refreshVesselButton || !refreshProductionButton || !status || !summary || !actionForms || !authorityPanel || !operationsPanel || !jobsPanel || !logisticsTechnical || !productionTechnical) return;

  let logistics: LogisticsVesselData | undefined;
  let production: ProductionData | undefined;
  let selectedAuthority: string | undefined;
  let selectedJob: ProductionJob | undefined;
  let lastAction: ActionRecord | undefined;
  let operation = 0;
  let busy = false;

  const setStatus = (message: string): void => { status.textContent = message; };

  const withBusy = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    document.documentElement.dataset.clientBusy = 'true';
    try {
      await action();
    } catch (error) {
      setStatus(`Logistics error: ${errorText(error)}`);
    } finally {
      busy = false;
      document.documentElement.dataset.clientBusy = 'false';
    }
  };

  const accountId = (): string | undefined => options.selectedAccountId();
  const vesselId = (): string => vesselField.value.trim();

  const renderLogistics = (): void => {
    summary.replaceChildren();
    logisticsTechnical.replaceChildren();
    if (!logistics) {
      const none = document.createElement('p');
      none.textContent = 'No retained vessel logistics. Enter a vessel URI and refresh.';
      summary.append(none);
      return;
    }
    const registry = logistics.registry;
    const heading = document.createElement('h3');
    heading.textContent = 'Registry';
    const registryLine = document.createElement('p');
    registryLine.textContent = `Registry · ${observationLine(registry)}`;
    const cargo = document.createElement('p');
    cargo.textContent = `Registry cargo: ${quantitySummary(registry.cargo, 'Variety')}`;
    const adoption = document.createElement('p');
    adoption.textContent = `Registry adoption: ${registry.adoption === true ? 'enabled' : registry.adoption === false ? 'disabled' : 'not retrieved'}`;
    const location = document.createElement('p');
    location.textContent = `Registry location: ${registry.location && typeof registry.location === 'object' && 'status' in registry.location ? String(registry.location.status) : 'not retrieved'}`;
    summary.append(heading, registryLine, cargo, adoption, location);
    if (registry.pendingRequests !== undefined && registry.pendingRequests.length > 0) {
      const pending = document.createElement('p');
      pending.textContent = `Pending Registry requests: ${registry.pendingRequests.length}`;
      summary.append(pending);
    }
    for (const territory of logistics.territories) {
      const territoryHeading = document.createElement('h3');
      territoryHeading.textContent = territory.kind === 'simulation' ? 'Territory shared stock and visit' : 'Territory shared stock';
      const stateLine = document.createElement('p');
      stateLine.textContent = `Territory · ${observationLine(territory)}`;
      const stock = document.createElement('p');
      stock.textContent = `Shared stock: ${quantitySummary(territory.sharedStock, 'Variety')}`;
      const visit = document.createElement('p');
      const localVisit = territory.visit;
      const visitStatus = localVisit === undefined ? 'not retrieved' : localVisit === null ? 'none recorded' : typeof localVisit === 'object' && 'status' in localVisit ? String(localVisit.status) : typeof localVisit === 'object' && 'departed' in localVisit ? localVisit.departed ? 'departed' : 'active' : 'recorded';
      visit.textContent = `Territory visit: ${visitStatus} · Cargo: ${quantitySummary(territory.cargo, 'Variety')}`;
      summary.append(territoryHeading, stateLine, stock, visit);
    }
    logisticsTechnical.append(detailsBlock('Logistics technical details', JSON.stringify(logistics, null, 2)));
  };

  const renderActions = (): void => {
    actionForms.replaceChildren();
    const heading = document.createElement('h3');
    heading.textContent = 'Registry actions';
    const form = document.createElement('form');
    form.setAttribute('aria-label', 'Registry logistics actions');
    const territory = document.createElement('input');
    territory.name = 'territoryId';
    territory.placeholder = 'Territory Actor ID';
    const port = document.createElement('input');
    port.name = 'portId';
    port.placeholder = 'Port ID';
    const route = document.createElement('input');
    route.name = 'routeId';
    route.placeholder = 'Route ID';
    const adoption = document.createElement('select');
    adoption.name = 'adoption';
    for (const [label, value] of [['Enable adoption', 'true'], ['Disable adoption', 'false']] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      adoption.append(option);
    }
    const entryButton = document.createElement('button');
    entryButton.type = 'button';
    entryButton.textContent = 'Request entry';
    const departureButton = document.createElement('button');
    departureButton.type = 'button';
    departureButton.textContent = 'Request departure';
    const adoptionButton = document.createElement('button');
    adoptionButton.type = 'button';
    adoptionButton.textContent = 'Update adoption';
    const run = async (kind: 'entry' | 'departure' | 'adoption'): Promise<void> => {
      const selected = accountId();
      const vessel = vesselId();
      if (!selected || !vessel) throw new Error('Select an account and vessel first');
      const started = operation;
      let response: ActionResponse;
      if (kind === 'adoption') response = await submitLogisticsAdoption({ accountId: selected, vesselId: vessel, adoption: adoption.value === 'true' });
      else {
        const input = { accountId: selected, vesselId: vessel, territoryId: territory.value.trim(), portId: port.value.trim(), routeId: route.value.trim() };
        response = kind === 'entry' ? await submitLogisticsEntry(input) : await submitLogisticsDeparture(input);
      }
      if (selected !== accountId() || started !== operation) return;
      lastAction = response.action;
      setStatus(`${kind === 'adoption' ? 'Adoption' : `Registry ${kind}`} ${actionSummary(response.action)}`);
      renderTechnical();
    };
    entryButton.addEventListener('click', () => { void withBusy(() => run('entry')); });
    departureButton.addEventListener('click', () => { void withBusy(() => run('departure')); });
    adoptionButton.addEventListener('click', () => { void withBusy(() => run('adoption')); });
    for (const [label, input] of [['Territory ID', territory], ['Port ID', port], ['Route ID', route]] as const) {
      const wrapper = document.createElement('label');
      wrapper.textContent = label;
      wrapper.append(input);
      form.append(wrapper);
    }
    const adoptionLabel = document.createElement('label');
    adoptionLabel.textContent = 'Adoption selection';
    adoptionLabel.append(adoption);
    form.append(adoptionLabel, entryButton, departureButton, adoptionButton);
    actionForms.append(heading, form);
  };

  const renderAuthorities = (): void => {
    authorityPanel.replaceChildren();
    if (!production) return;
    if (production.authorities.length === 0) {
      const none = document.createElement('p');
      none.textContent = 'No production authorities retained. Refresh production to discover them.';
      authorityPanel.append(none);
      return;
    }
    const label = document.createElement('label');
    label.textContent = 'Production authority';
    const select = document.createElement('select');
    select.name = 'productionAuthority';
    select.id = 'production-authority-select';
    if (production.authorities.some((authority) => authority.authorityId === selectedAuthority)) {
      // retain the explicit selection
    } else {
      selectedAuthority = production.authorities[0]?.authorityId;
    }
    for (const authority of production.authorities) {
      const option = document.createElement('option');
      option.value = authority.authorityId;
      option.textContent = `${authority.name ?? authority.kind} · ${authority.kind}${authority.state === 'available' ? '' : ` · ${authority.state}`}`;
      option.selected = authority.authorityId === selectedAuthority;
      select.append(option);
    }
    select.addEventListener('change', () => {
      selectedAuthority = select.value;
      renderOperations();
    });
    label.append(select);
    authorityPanel.append(label);
  };

  const inputControl = (op: ProductionOperation, input: ProductionOperationInput): HTMLElement => {
    const wrapper = document.createElement('label');
    wrapper.textContent = `${op.label} ${input.label}`;
    let control: HTMLInputElement | HTMLSelectElement;
    if (input.type === 'choice') {
      control = document.createElement('select');
      for (const choice of input.choices ?? []) {
        const option = document.createElement('option');
        option.value = choice.value;
        option.textContent = /(?:https?:\/\/|urn:)/i.test(choice.label) ? identityDisplay.get(choice.value)?.name || 'Variety' : choice.label;
        if (input.default !== undefined && String(input.default) === choice.value) option.selected = true;
        control.append(option);
      }
    } else {
      control = document.createElement('input');
      control.type = 'number';
      control.min = String(input.minimum ?? 1);
      control.step = '1';
      control.value = String(input.default ?? input.minimum ?? 1);
    }
    control.name = input.name;
    wrapper.append(control);
    return wrapper;
  };

  const renderOperations = (): void => {
    operationsPanel.replaceChildren();
    if (!production) return;
    const operations = production.operations.filter((candidate) => candidate.authorityId === selectedAuthority);
    if (operations.length === 0) {
      const none = document.createElement('p');
      none.textContent = 'No production operations retained for this authority.';
      operationsPanel.append(none);
      return;
    }
    for (const op of operations) {
      const article = document.createElement('article');
      const heading = document.createElement('h3');
      heading.textContent = op.label;
      const effect = document.createElement('p');
      effect.textContent = neutralReferences(op.effect);
      article.append(heading, effect);
      if (op.outputDestination) {
        const destination = document.createElement('p');
        destination.textContent = `Output destination: ${op.outputDestination}`;
        article.append(destination);
      }
      if (op.blockers.length > 0) {
        const blocked = document.createElement('p');
        blocked.textContent = `Blocked: ${op.blockers.map(neutralReferences).join('; ')}`;
        article.append(blocked);
      }
      const form = document.createElement('form');
      form.setAttribute('aria-label', op.label);
      for (const input of op.inputs) form.append(inputControl(op, input));
      const execute = document.createElement('button');
      execute.type = 'button';
      execute.textContent = `Execute ${op.label}`;
      execute.addEventListener('click', () => {
        void withBusy(async () => {
          const selected = accountId();
          const vessel = vesselId();
          if (!selected || !vessel) throw new Error('Select an account and vessel first');
          const started = operation;
          const inputs: Record<string, unknown> = {};
          for (const input of op.inputs) {
            const control = field<HTMLInputElement | HTMLSelectElement>(form, input.name);
            if (!control) continue;
            inputs[input.name] = input.type === 'count' ? Number(control.value) : control.value;
          }
          const response = await executeProductionOperation({ operationId: op.operationId, accountId: selected, vesselId: vessel, inputs });
          if (selected !== accountId() || started !== operation) return;
          lastAction = response.action;
          const jobReference = response.action.resultReferences.find((reference) => reference.kind === 'job');
          if (jobReference) {
            const page = await readProductionJob(jobReference.id, selected, vessel);
            if (selected !== accountId() || started !== operation) return;
            selectedJob = page.data.job;
          }
          setStatus(`Result · ${actionSummary(response.action)}`);
          const activity = document.createElement('a');
          activity.href = '#activity-controls';
          activity.textContent = 'Open Activity';
          status.append(' · ', activity);
          renderJobs();
          renderTechnical();
        });
      });
      form.append(execute);
      article.append(form, detailsBlock(`${op.label} technical details`, JSON.stringify(op, null, 2)));
      operationsPanel.append(article);
    }
  };

  const renderJobs = (): void => {
    jobsPanel.replaceChildren();
    if (!selectedJob) {
      const jobs = production?.jobs ?? [];
      if (jobs.length === 0) return;
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Select production job');
      for (const job of jobs) {
        const option = document.createElement('option');
        option.value = job.jobId;
        option.textContent = `${job.operation} · ${job.status}`;
        select.append(option);
      }
      select.addEventListener('change', () => {
        const job = jobs.find((candidate) => candidate.jobId === select.value);
        if (job) { selectedJob = job; renderJobs(); }
      });
      jobsPanel.append(select);
      return;
    }
    const heading = document.createElement('h3');
    heading.textContent = 'Selected job';
    const line = document.createElement('p');
    line.textContent = `Job · ${selectedJob.status}${selectedJob.progress?.remainingTicks === undefined ? '' : ` · ${selectedJob.progress.remainingTicks} ticks remaining`}${selectedJob.progress?.count === undefined ? '' : ` · quantity ${selectedJob.progress.count}`}${selectedJob.error === undefined ? '' : ` · ${selectedJob.error}`}`;
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = 'Refresh selected job';
    refresh.addEventListener('click', () => {
      void withBusy(async () => {
        const selected = accountId();
        const vessel = vesselId();
        if (!selected || !vessel || !selectedJob) throw new Error('Select an account, vessel, and job first');
        const started = operation;
        const response = await refreshProductionJob(selectedJob.jobId, selected, vessel);
        if (selected !== accountId() || started !== operation) return;
        selectedJob = response.data.job;
        setStatus(`Job · ${selectedJob.status}${selectedJob.evidence === undefined ? '' : ` · evidence ${selectedJob.evidence.length}`}`);
        renderJobs();
        renderTechnical();
      });
    });
    jobsPanel.append(heading, line, refresh);
  };

  const renderTechnical = (): void => {
    productionTechnical.replaceChildren();
    productionTechnical.append(detailsBlock('Production technical details', JSON.stringify({
      production,
      selectedAuthority,
      selectedJob,
      lastAction
    }, null, 2)));
  };

  const renderProduction = (): void => {
    renderAuthorities();
    renderOperations();
    renderJobs();
    renderTechnical();
  };

  const refreshVessel = async (): Promise<void> => {
    const selected = accountId();
    const vessel = vesselId();
    if (!selected) throw new Error('Select an account before refreshing a vessel');
    if (!vessel) throw new Error('Enter a vessel URI');
    const started = operation;
    const response = await refreshLogisticsVessel(selected, vessel);
    if (selected !== accountId() || started !== operation) return;
    logistics = response.data;
    setStatus(`Retained ${response.data.territories.length} territory source(s) and Registry observations.`);
    renderLogistics();
  };

  const refreshProductionData = async (): Promise<void> => {
    const selected = accountId();
    const vessel = vesselId();
    if (!selected) throw new Error('Select an account before refreshing production');
    if (!vessel) throw new Error('Enter a vessel URI');
    const started = operation;
    const response = await refreshProduction(selected, vessel);
    if (selected !== accountId() || started !== operation) return;
    production = response.data;
    setStatus(`Retained ${response.data.operations.length} production operation(s).`);
    renderProduction();
  };

  refreshVesselButton.addEventListener('click', () => { void withBusy(refreshVessel); });
  refreshProductionButton.addEventListener('click', () => { void withBusy(refreshProductionData); });

  renderLogistics();
  renderActions();
  renderProduction();

  const initial = options.initialVesselId?.();
  if (initial) vesselField.value = initial;

  return {
    accountChanged(): void {
      operation += 1;
      logistics = undefined;
      production = undefined;
      selectedAuthority = undefined;
      selectedJob = undefined;
      lastAction = undefined;
      vesselField.value = options.initialVesselId?.() ?? '';
      summary.replaceChildren();
      actionForms.replaceChildren();
      authorityPanel.replaceChildren();
      operationsPanel.replaceChildren();
      jobsPanel.replaceChildren();
      logisticsTechnical.replaceChildren();
      productionTechnical.replaceChildren();
      setStatus('Select an account, enter a vessel URI, then refresh.');
      renderLogistics();
      renderActions();
      renderProduction();
    }
  };
}
