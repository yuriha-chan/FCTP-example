import type { AdministrationData, AdministrationRequestRecord, AdministrationTargetRecord } from '@fctp/client-sdk';
import { applyAdministrationControl, decideAdministrationEntry, readAdministration, refreshAdministration } from './application-api.js';
import { identityDisplay } from './identity-display.js';

export interface AdministrationControlsOptions {
  selectedAccountId: () => string | undefined;
}

export interface AdministrationControlsController {
  accountChanged(): void;
}

function element<T extends HTMLElement>(id: string): T | undefined {
  const found = document.getElementById(id);
  return found instanceof HTMLElement ? found as T : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function labelled(label: string, control: HTMLElement): HTMLLabelElement {
  const wrapper = document.createElement('label');
  wrapper.append(document.createTextNode(label), control);
  return wrapper;
}

function selectInput(value: string, choices: Array<{ value: string; label: string }>): HTMLSelectElement {
  const select = document.createElement('select');
  for (const choice of choices) {
    const option = document.createElement('option');
    option.value = choice.value;
    option.textContent = choice.label;
    select.append(option);
  }
  select.value = value;
  return select;
}

function textInput(value: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  return input;
}

function numberInput(value: number | undefined): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = value === undefined ? '' : String(value);
  return input;
}

function checkboxInput(value: boolean): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  return input;
}

function button(label: string): HTMLButtonElement {
  const control = document.createElement('button');
  control.type = 'button';
  control.textContent = label;
  return control;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function stateLabel(state: string, error: string | undefined): string {
  return error === undefined ? state : `${state}: ${error}`;
}

function knownLabel(id: unknown, fallback: string): string {
  const identity = typeof id === 'string' ? identityDisplay.get(id) : undefined;
  return identity?.name || identity?.handle || fallback;
}

function technicalDetails(label: string, value: unknown): HTMLDetailsElement {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = label;
  const text = document.createElement('pre');
  text.textContent = JSON.stringify(value, null, 2);
  details.append(summary, text);
  return details;
}

export function setupAdministrationControls(options: AdministrationControlsOptions): AdministrationControlsController | undefined {
  const section = element<HTMLElement>('administration-controls');
  const targetSelect = element<HTMLSelectElement>('administration-target');
  const refreshButton = element<HTMLButtonElement>('administration-refresh');
  const status = element<HTMLElement>('administration-status');
  const content = element<HTMLElement>('administration-content');
  if (!section || !targetSelect || !refreshButton || !status || !content) return;

  let operation = 0;
  let data: AdministrationData | undefined;
  let selectedAuthority: string | undefined;

  const setStatus = (message: string): void => { status.textContent = message; };

  const withBusy = async (action: () => Promise<void>): Promise<void> => {
    document.documentElement.dataset.clientBusy = 'true';
    try {
      await action();
    } catch (error) {
      setStatus(`Administration error: ${errorText(error)}`);
    } finally {
      document.documentElement.dataset.clientBusy = 'false';
    }
  };

  const current = (): AdministrationTargetRecord | undefined => data?.targets.find((target) => target.authorityId === selectedAuthority);

  const renderTargets = (next: AdministrationData): void => {
    targetSelect.replaceChildren();
    for (const [index, target] of next.targets.entries()) {
      const option = document.createElement('option');
      option.value = target.authorityId;
      option.textContent = target.name ?? knownLabel(target.authorityId, `${target.roles.join(', ')} authority ${index + 1}`);
      targetSelect.append(option);
    }
    if (selectedAuthority === undefined || !next.targets.some((target) => target.authorityId === selectedAuthority)) {
      selectedAuthority = next.targets[0]?.authorityId;
    }
    if (selectedAuthority !== undefined) targetSelect.value = selectedAuthority;
  };

  const apply = async (control: string, inputs: Record<string, unknown>, label: string): Promise<void> => {
    const accountId = options.selectedAccountId();
    if (accountId === undefined || selectedAuthority === undefined) { setStatus('Select an account and administration target first.'); return; }
    const started = operation;
    const authorityId = selectedAuthority;
    const response = await applyAdministrationControl(accountId, authorityId, control, inputs);
    if (operation !== started || options.selectedAccountId() !== accountId || selectedAuthority !== authorityId) return;
    setStatus(`${label} Submission ${response.action.submission.status}; outcome ${response.action.outcome.status}.`);
    await loadRetained();
    content.append(technicalDetails('Submitted control and result', { inputs, action: response.action }));
    const activity = document.createElement('a');
    activity.href = '#activity-controls';
    activity.textContent = 'Open Activity to inspect action evidence';
    content.append(activity);
  };

  const renderAdmission = (target: AdministrationTargetRecord, state: Record<string, unknown>): void => {
    const admission = record(state.admission);
    const form = document.createElement('form');
    form.className = 'grid-form';
    const reviewMode = selectInput(typeof admission.reviewMode === 'string' ? admission.reviewMode : 'automatic', [
      { value: 'automatic', label: 'Automatic' }, { value: 'manual', label: 'Manual' }
    ]);
    const registries = textInput(list(target.kind === 'simulation' ? admission.acceptedRegistries : admission.registryAcceptance).join(', '));
    const territories = textInput(list(target.kind === 'simulation' ? admission.acceptedTerritories : admission.territoryAcceptance).join(', '));
    const mismatch = selectInput(typeof admission.mismatchPolicy === 'string' ? admission.mismatchPolicy : 'reject', [
      { value: 'reject', label: 'Reject' }, { value: 'declared', label: 'Declared' }, { value: 'evidence', label: 'Evidence' }
    ]);
    const manifest = selectInput(typeof admission.manifestPolicy === 'string' ? admission.manifestPolicy : 'reject-difference', [
      { value: 'reject-difference', label: 'Reject difference' }, { value: 'request', label: 'Request' }, { value: 'evidence', label: 'Evidence' }
    ]);
    const requireEvidence = checkboxInput(admission.requireExitEvidence === true);
    const ports = textInput(list(admission.publicPorts).join(', '));
    const applyButton = button('Apply admission');
    applyButton.addEventListener('click', () => {
      const inputs: Record<string, unknown> = { reviewMode: reviewMode.value };
      if (target.kind === 'simulation') {
        inputs.acceptedRegistries = registries.value.split(',').map((entry) => entry.trim()).filter(Boolean);
        inputs.acceptedTerritories = territories.value.split(',').map((entry) => entry.trim()).filter(Boolean);
        inputs.manifestPolicy = manifest.value;
        inputs.requireExitEvidence = requireEvidence.checked;
      } else {
        inputs.registryAcceptance = registries.value.split(',').map((entry) => entry.trim()).filter(Boolean);
        inputs.territoryAcceptance = territories.value.split(',').map((entry) => entry.trim()).filter(Boolean);
        inputs.mismatchPolicy = mismatch.value;
        inputs.publicPorts = ports.value.split(',').map((entry) => entry.trim()).filter(Boolean);
      }
      void withBusy(() => apply('admission', inputs, `Admission applied (${String(inputs.reviewMode)}):`));
    });
    form.append(labelled('Review mode', reviewMode), labelled('Accepted Registries', registries), labelled('Accepted Territories', territories));
    if (target.kind === 'simulation') form.append(labelled('Manifest policy', manifest), labelled('Require exit evidence', requireEvidence));
    else form.append(labelled('Mismatch policy', mismatch), labelled('Public ports', ports));
    form.append(applyButton);
    content.append(form);
  };

  const renderPolicy = (state: Record<string, unknown>): void => {
    const policy = record(state.policy);
    const form = document.createElement('form');
    const permitted = checkboxInput(policy.miningPermitted === true);
    const quota = numberInput(typeof policy.miningQuota === 'number' ? policy.miningQuota : undefined);
    const reserve = numberInput(typeof policy.oreReserve === 'number' ? policy.oreReserve : undefined);
    const permits = textInput(list(policy.manufacturePermits).join(', '));
    const advancedValues = {
      recipes: Array.isArray(policy.recipes) ? policy.recipes : [],
      warehouseLimits: record(policy.warehouseLimits),
      portLimits: record(policy.portLimits),
      decisions: record(policy.decisions),
      ...(policy.varietyPortPolicy === undefined ? {} : { varietyPortPolicy: record(policy.varietyPortPolicy) })
    };
    const advanced = document.createElement('textarea');
    advanced.rows = 4;
    advanced.value = JSON.stringify(advancedValues, null, 2);
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Advanced policy collections';
    details.append(summary, advanced);
    const applyButton = button('Apply policy');
    applyButton.addEventListener('click', () => {
      try {
        const parsed = JSON.parse(advanced.value) as Record<string, unknown>;
        const inputs: Record<string, unknown> = {
          ...parsed,
          miningPermitted: permitted.checked,
          miningQuota: Number(quota.value),
          oreReserve: Number(reserve.value),
          manufacturePermits: permits.value.split(',').map((entry) => entry.trim()).filter(Boolean)
        };
        void withBusy(() => apply('policy', inputs, 'Policy applied:'));
      } catch (error) {
        setStatus(`Policy error: ${errorText(error)}`);
      }
    });
    form.append(
      labelled('Mining permitted', permitted), labelled('Mining quota', quota), labelled('Ore reserve', reserve),
      labelled('Manufacture permits', permits), details, applyButton
    );
    content.append(form);
  };

  const renderFacilities = (state: Record<string, unknown>): void => {
    const simulation = record(state.simulation);
    const config = record(simulation.config);
    const form = document.createElement('form');
    const enabled = checkboxInput(config.miningEnabled !== false);
    const miningCapacity = numberInput(typeof config.miningCapacity === 'number' ? config.miningCapacity : undefined);
    const slots = numberInput(typeof config.manufacturingSlots === 'number' ? config.manufacturingSlots : undefined);
    const time = numberInput(typeof config.manufacturingTime === 'number' ? config.manufacturingTime : undefined);
    const portCapacity = numberInput(typeof config.portCapacity === 'number' ? config.portCapacity : undefined);
    const berths = numberInput(typeof config.berthCapacity === 'number' ? config.berthCapacity : undefined);
    const applyButton = button('Apply facilities');
    applyButton.addEventListener('click', () => {
      const inputs: Record<string, unknown> = {
        mining: { enabled: enabled.checked, capacity: Number(miningCapacity.value) },
        manufacturing: { slots: Number(slots.value), time: Number(time.value) },
        port: { capacity: Number(portCapacity.value), berths: Number(berths.value) }
      };
      void withBusy(() => apply('facilities', inputs, 'Facilities applied:'));
    });
    const tick = button('Advance tick');
    tick.addEventListener('click', () => { void withBusy(() => apply('tick', {}, 'Simulation tick:')); });
    form.append(
      labelled('Mining enabled', enabled), labelled('Mining capacity', miningCapacity),
      labelled('Manufacturing slots', slots), labelled('Manufacturing time', time),
      labelled('Port capacity', portCapacity), labelled('Berth capacity', berths),
      applyButton, tick
    );
    content.append(form);
  };

  const renderRegistry = (state: Record<string, unknown>): void => {
    const form = document.createElement('form');
    const fleet = record(state.fleet);
    const vessel = selectInput('', Object.entries(fleet).map(([id, entry], index) => ({ value: id, label: knownLabel(record(entry).vessel && record(record(entry).vessel).id, `Vessel ${index + 1}`) })));
    const adoption = selectInput('true', [{ value: 'true', label: 'Enable adoption' }, { value: 'false', label: 'Disable adoption' }]);
    const currentValue = document.createElement('p');
    const update = (): void => {
      const selected = record(fleet[vessel.value]);
      adoption.value = selected.adoption === false ? 'false' : 'true';
      currentValue.textContent = `Current adoption: ${selected.adoption === undefined ? 'not observed' : selected.adoption ? 'enabled' : 'disabled'}`;
    };
    if (vessel.options.length > 0) vessel.selectedIndex = 0;
    update();
    vessel.addEventListener('change', update);
    const applyButton = button('Apply adoption');
    applyButton.addEventListener('click', () => {
      void withBusy(() => apply('adoption', { vesselId: vessel.value.trim(), adoption: adoption.value === 'true' }, 'Adoption applied:'));
    });
    form.append(labelled('Fleet vessel', vessel), currentValue, labelled('Adoption', adoption), applyButton);
    content.append(form);
  };

  const renderHome = (state: Record<string, unknown>): void => {
    const accounts = Array.isArray(state.accounts) ? state.accounts : [];
    for (const entry of accounts) {
      const account = record(entry);
      if (typeof account.handle !== 'string') continue;
      const form = document.createElement('form');
      const available = selectInput(account.available === false ? 'false' : 'true', [{ value: 'true', label: 'Available' }, { value: 'false', label: 'Unavailable' }]);
      const applyButton = button('Apply availability');
      applyButton.addEventListener('click', () => {
        void withBusy(() => apply('availability', { handle: account.handle, available: available.value === 'true' }, 'Availability applied:'));
      });
      const identity = document.createElement('p');
      identity.textContent = account.handle;
      form.append(identity, labelled('Available', available), applyButton);
      content.append(form);
    }
  };

  const decide = async (request: AdministrationRequestRecord, decision: 'approve' | 'reject', reason: string): Promise<void> => {
    const accountId = options.selectedAccountId();
    const authorityId = request.authorityId ?? selectedAuthority;
    if (accountId === undefined || authorityId === undefined) { setStatus('Select an account and administration target first.'); return; }
    const started = operation;
    const response = await decideAdministrationEntry(accountId, authorityId, request.requestId, decision, reason || undefined);
    if (operation !== started || options.selectedAccountId() !== accountId) return;
    setStatus(`Decision submission ${response.action.submission.status}; observed outcome ${response.action.outcome.status}. Approval is not berthing evidence.`);
    await loadRetained();
  };

  const renderRequests = (next: AdministrationData): void => {
    if (next.requests.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No pending or decided entry requests.';
      content.append(empty);
      return;
    }
    const heading = document.createElement('h3');
    heading.textContent = 'Entry requests';
    content.append(heading);
    for (const request of next.requests.filter((entry) => entry.authorityId === selectedAuthority)) {
      const article = document.createElement('article');
      const original = record(request.request);
      const vessel = record(original.vessel);
      const destination = record(original.destination);
      const identity = document.createElement('p');
      identity.textContent = `Entry request · ${request.status}`;
      const details = document.createElement('p');
      details.textContent = `${knownLabel(vessel.id, 'Requesting vessel')} · ${knownLabel(destination.port, 'Destination port')} · ${knownLabel(vessel.registry, 'Issuing Registry')}`;
      article.append(identity, details, technicalDetails('Entry request technical details', request));
      if (request.receivedAt !== undefined) {
        const received = document.createElement('p');
        received.textContent = `Received ${request.receivedAt}`;
        article.append(received);
      }
      if (request.decision !== undefined) {
        const decision = document.createElement('p');
        decision.textContent = `Decision ${request.decision.accepted === true ? 'accepted' : 'rejected'}${typeof request.decision.reason === 'string' ? `: ${request.decision.reason}` : ''}`;
        article.append(decision);
      }
      if (request.event !== undefined) {
        const event = document.createElement('p');
        event.textContent = `Event ${typeof request.event.type === 'string' ? request.event.type : 'recorded'}`;
        article.append(event);
      }
      if (request.status === 'pending') {
        const reason = textInput('');
        const approve = button('Approve');
        const reject = button('Reject');
        approve.addEventListener('click', () => { void withBusy(() => decide(request, 'approve', reason.value)); });
        reject.addEventListener('click', () => { void withBusy(() => decide(request, 'reject', reason.value)); });
        article.append(labelled('Rejection reason', reason), approve, reject);
      }
      content.append(article);
    }
  };

  const render = (next: AdministrationData): void => {
    data = next;
    renderTargets(next);
    content.replaceChildren();
    const target = current();
    if (target === undefined) {
      const empty = document.createElement('p');
      empty.textContent = 'No administration targets are available for this account.';
      content.append(empty);
      return;
    }
    const summary = document.createElement('p');
    summary.textContent = `${target.name ?? knownLabel(target.authorityId, target.roles.join(', '))} · ${stateLabel(target.state, target.error)}${target.observedAt === undefined ? '' : ` · ${target.observedAt}`}`;
    content.append(summary);
    const state = next.states[target.authorityId] ?? {};
    content.append(technicalDetails('Administration technical details', { target, state }));
    if (target.state !== 'available' && target.state !== 'stale' && target.state !== 'empty') return;
    const kind = target.kind ?? (typeof state.kind === 'string' ? state.kind : undefined);
    if (kind === 'home') renderHome(state);
    else if (kind === 'registry') renderRegistry(state);
    else {
      renderAdmission(target, state);
      if (kind === 'policy') renderPolicy(record(state.state));
      if (kind === 'simulation') renderFacilities(state);
    }
    renderRequests(next);
  };

  const loadRetained = async (): Promise<void> => {
    const accountId = options.selectedAccountId();
    if (accountId === undefined) return;
    const started = operation;
    const response = await readAdministration(accountId);
    if (operation !== started || options.selectedAccountId() !== accountId) return;
    render(response.data);
  };

  targetSelect.addEventListener('change', () => {
    selectedAuthority = targetSelect.value;
    if (data === undefined) return;
    const started = operation;
    void withBusy(async () => {
      const next = data;
      if (next === undefined || operation !== started) return;
      render(next);
    });
  });

  refreshButton.addEventListener('click', () => {
    void withBusy(async () => {
      const accountId = options.selectedAccountId();
      if (accountId === undefined) { setStatus('Select an account before refreshing administration.'); return; }
      if (selectedAuthority === undefined) { setStatus('Select an administration target before refreshing.'); return; }
      const started = operation;
      const authorityId = selectedAuthority;
      const response = await refreshAdministration(accountId, authorityId);
      if (operation !== started || options.selectedAccountId() !== accountId || selectedAuthority !== authorityId) return;
      render(response.data);
      const target = response.data.targets.find((candidate) => candidate.authorityId === authorityId);
      setStatus(target === undefined ? 'Administration refreshed.' : `Administration refreshed: ${stateLabel(target.state, target.error)}.`);
    });
  });

  return {
    accountChanged(): void {
      operation += 1;
      data = undefined;
      selectedAuthority = undefined;
      content.replaceChildren();
      targetSelect.replaceChildren();
      setStatus('Select an account, then refresh Administration.');
      void withBusy(loadRetained);
    }
  };
}
