import type {
  AccountRecord,
  ActionRecord,
  AdministrationControlRecord,
  AdministrationData,
  AdministrationRequestRecord,
  AdministrationTargetRecord,
  PageResponse,
  SourcedObservation
} from '@fctp/client-sdk';
import { withDeadline } from './deadline.js';
import type { ActionHandler, ActionService } from './actions.js';
import type { ObservationService } from './observations.js';
import type { ClientApplicationState } from './store.js';
import {
  administrationControlPath,
  administrationTargetKind,
  readAdministrationTarget,
  submitAdministrationPost,
  type AdministrationTarget,
  type AdministrationTargetKind
} from './adapters/administration.js';

export class AdministrationRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export interface AdministrationBinding {
  accountId: string;
  authorityActorIds: readonly string[];
  credentialSource: string;
}

export interface AdministrationServiceOptions {
  bindings: readonly AdministrationBinding[];
  resolveCredential: (accountId: string, authorityId: string) => Promise<string>;
  timeoutMs?: number;
}

export interface AdministrationRefreshInput {
  accountId: string;
  authorityId: string;
}

export interface AdministrationControlInput {
  accountId: string;
  authorityId: string;
  control: string;
  inputs: Record<string, unknown>;
}

export interface AdministrationDecisionInput {
  accountId: string;
  authorityId: string;
  requestId: string;
  decision: 'approve' | 'reject';
  reason?: string;
}

export interface AdministrationService {
  page(accountId: string): Promise<PageResponse<AdministrationData>>;
  refresh(input: AdministrationRefreshInput): Promise<PageResponse<AdministrationData>>;
  control(input: AdministrationControlInput): Promise<{ action: ActionRecord }>;
  decide(input: AdministrationDecisionInput): Promise<{ action: ActionRecord }>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const CONTROL_NAMES = ['policy', 'admission', 'facilities', 'tick', 'adoption', 'availability'] as const;
const ADMIN_CONTROL_KIND = 'administration-control';
const ADMIN_DECISION_KIND = 'administration-entry-request';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function administrationKey(accountId: string): string {
  return `administration:${accountId}`;
}

function retainedValue<T>(observation: SourcedObservation<T>): T | undefined {
  return observation.state === 'available' || observation.state === 'stale' || observation.state === 'empty' ? observation.value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function includesValues(observed: unknown, submitted: unknown): boolean {
  if (Array.isArray(submitted)) return Array.isArray(observed) && submitted.length === observed.length && submitted.every((value, index) => includesValues(observed[index], value));
  if (isRecord(submitted)) return isRecord(observed) && Object.entries(submitted).every(([key, value]) => includesValues(observed[key], value));
  return observed === submitted;
}

function controlIsObserved(control: string, inputs: Record<string, unknown>, value: Record<string, unknown>): boolean {
  if (control === 'admission') return includesValues(value.admission, inputs);
  if (control === 'policy') return includesValues(record(value.state).policy, inputs);
  if (control === 'facilities') {
    const config = record(record(value.simulation).config);
    const mining = record(inputs.mining);
    const manufacturing = record(inputs.manufacturing);
    const port = record(inputs.port);
    return (inputs.mining === undefined || includesValues(config, { miningEnabled: mining.enabled, miningCapacity: mining.capacity }))
      && (inputs.manufacturing === undefined || includesValues(config, { manufacturingSlots: manufacturing.slots, manufacturingTime: manufacturing.time }))
      && (inputs.port === undefined || includesValues(config, { portCapacity: port.capacity, berthCapacity: port.berths }));
  }
  if (control === 'adoption') return record(record(value.fleet)[String(inputs.vesselId ?? inputs.vessel)]).adoption === inputs.adoption;
  if (control === 'availability') return Array.isArray(value.accounts) && value.accounts.some((entry) => isRecord(entry) && entry.handle === inputs.handle && entry.available === inputs.available);
  return false;
}

export function createAdministrationActionHandlers(
  state: ClientApplicationState,
  fetcher: typeof fetch,
  options: AdministrationServiceOptions
): Record<string, ActionHandler> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const call = <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => withDeadline(timeoutMs, operation);
  const accountFor = async (accountId: string): Promise<AccountRecord & { login: { status: 'signed-in'; nativeToken: string } }> => {
    const account = await state.read((current) => current.accounts[accountId]);
    if (!account || account.login.status !== 'signed-in') throw new Error('A signed-in account is required');
    return account as AccountRecord & { login: { status: 'signed-in'; nativeToken: string } };
  };
  const targetFor = (authorityId: string): Promise<AdministrationTarget | undefined> => state.read((current) => {
    const authority = current.authorities[authorityId];
    if (!authority) return undefined;
    return { authorityId: authority.actorId, server: authority.server, roles: [...authority.roles], ...(authority.name === undefined ? {} : { name: authority.name }) };
  });
  const tokenFor = async (accountId: string, authorityId: string, kind: AdministrationTargetKind): Promise<string> => {
    const account = await accountFor(accountId);
    if (kind === 'home') {
      if (account.homeAuthority !== authorityId) throw new Error('Home governance requires the issuing Home authority');
      if (new URL(authorityId).host !== account.login.homeServer) throw new Error('Home governance requires the issuing Home server');
      return account.login.nativeToken;
    }
    return options.resolveCredential(accountId, authorityId);
  };

  return {
    [ADMIN_CONTROL_KIND]: {
      async submit(input) {
        const authorityId = typeof input.intent.inputs.authorityId === 'string' ? input.intent.inputs.authorityId : '';
        const control = typeof input.intent.inputs.control === 'string' ? input.intent.inputs.control : '';
        const kind = typeof input.intent.inputs.authorityKind === 'string' ? input.intent.inputs.authorityKind as AdministrationTargetKind : 'policy';
        const body = isRecord(input.intent.inputs.inputs) ? input.intent.inputs.inputs : {};
        const path = administrationControlPath(kind, control);
        if (!authorityId || !path) throw new Error('Unsupported administration control');
        const token = await tokenFor(input.accountId, authorityId, kind);
        let evidenceBaseline: Array<{ source: string; observedAt: string; changes: Record<string, unknown> }> | undefined;
        if (control === 'tick') {
          const target = await targetFor(authorityId);
          if (target) {
            const before = await call((signal) => readAdministrationTarget(fetcher, target, token, signal));
            const tick = record(before.value.simulation).tick;
            if (typeof tick === 'number') evidenceBaseline = [{ source: before.value.authorityId as string, observedAt: new Date().toISOString(), changes: { tick } }];
          }
        }
        const payload = control === 'adoption' ? { vessel: body.vesselId, adoption: body.adoption } : body;
        const submission = await call((signal) => submitAdministrationPost(fetcher, authorityId, path, token, payload, signal));
        return { result: submission.value === undefined ? 'accepted' : JSON.stringify(submission.value), ...(evidenceBaseline === undefined ? {} : { evidenceBaseline }) };
      },
      async reconcile(input) {
        if (input.action.submission.status !== 'accepted') return { status: 'unverified', error: 'Administration submission was not confirmed' };
        const authorityId = typeof input.intent.inputs.authorityId === 'string' ? input.intent.inputs.authorityId : '';
        const control = typeof input.intent.inputs.control === 'string' ? input.intent.inputs.control : '';
        const kind = typeof input.intent.inputs.authorityKind === 'string' ? input.intent.inputs.authorityKind as AdministrationTargetKind : 'policy';
        if (!authorityId) return { status: 'unverified', error: 'Administration target is missing' };
        const token = await tokenFor(input.accountId, authorityId, kind);
        const target = await targetFor(authorityId);
        if (!target) return { status: 'unverified', error: 'Administration target is no longer known' };
        const read = await call((signal) => readAdministrationTarget(fetcher, target, token, signal));
        const source = read.value.authorityId as string;
        if (control === 'tick') {
          const tick = record(read.value.simulation).tick;
          const baseline = input.action.submission.evidenceBaseline?.find((evidence) => evidence.source === source)?.changes?.tick;
          if (typeof tick === 'number' && typeof baseline === 'number' && tick > baseline) return { status: 'completed', evidence: [{ source, observedAt: new Date().toISOString(), changes: { tick } }] };
          return { status: 'pending', evidence: [] };
        }
        const inputs = record(input.intent.inputs.inputs);
        if (!controlIsObserved(control, inputs, read.value)) return { status: 'unverified', error: 'Submitted control values have not been observed' };
        return { status: 'completed', evidence: [{ source: read.source, observedAt: new Date().toISOString(), changes: { control, inputs } }] };
      }
    },
    [ADMIN_DECISION_KIND]: {
      async submit(input) {
        const authorityId = typeof input.intent.inputs.authorityId === 'string' ? input.intent.inputs.authorityId : '';
        const requestId = typeof input.intent.inputs.requestId === 'string' ? input.intent.inputs.requestId : '';
        const decision = input.intent.inputs.decision === 'reject' ? 'reject' : 'approve';
        if (!authorityId || !requestId) throw new Error('Administration decision scope is missing');
        const token = await options.resolveCredential(input.accountId, authorityId);
        const path = `/local/admin/entry-requests/${encodeURIComponent(requestId)}/${decision}`;
        const reason = typeof input.intent.inputs.reason === 'string' ? input.intent.inputs.reason : undefined;
        const submission = await call((signal) => submitAdministrationPost(fetcher, authorityId, path, token, reason === undefined ? {} : { reason }, signal));
        const event = record(record(submission.value).event);
        return { result: submission.value === undefined ? 'accepted' : JSON.stringify(submission.value), references: [{ kind: 'request', id: requestId }, ...(typeof event.id === 'string' ? [{ kind: 'event' as const, id: event.id }] : [])] };
      },
      async reconcile(input) {
        if (input.action.submission.status !== 'accepted') return { status: 'unverified', error: 'Administration decision was not confirmed' };
        const requestId = typeof input.intent.inputs.requestId === 'string' ? input.intent.inputs.requestId : '';
        const authorityId = typeof input.intent.inputs.authorityId === 'string' ? input.intent.inputs.authorityId : '';
        const target = await targetFor(authorityId);
        if (!requestId || !target) return { status: 'unverified', error: 'Territory or request reference is missing' };
        const token = await options.resolveCredential(input.accountId, authorityId);
        const read = await call((signal) => readAdministrationTarget(fetcher, target, token, signal));
        const entries = Array.isArray(read.value.requests) ? read.value.requests : [];
        const entry = entries.find((value) => isRecord(value) && (value.requestId === requestId || record(value.request).id === requestId));
        const event = record(record(entry).event);
        if (typeof event.id !== 'string' || !['BerthingEvent', 'EntryRejected'].includes(String(event.type))) return { status: 'pending', evidence: [] };
        return {
          status: event.type === 'EntryRejected' ? 'failed' : 'completed',
          references: [{ kind: 'event', id: event.id }],
          evidence: [{ source: read.source, observedAt: new Date().toISOString(), changes: { requestId, event } }],
          ...(event.type === 'EntryRejected' ? { error: String(record(record(entry).decision).reason ?? 'Entry rejected') } : {})
        };
      }
    }
  };
}

export function createAdministrationService(
  state: ClientApplicationState,
  fetcher: typeof fetch,
  observations: ObservationService,
  actions: ActionService,
  options: AdministrationServiceOptions
): AdministrationService {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const call = <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => withDeadline(timeoutMs, operation);

  const signedInAccount = async (accountId: string): Promise<AccountRecord & { login: { status: 'signed-in'; nativeToken: string } }> => {
    const account = await state.read((current) => current.accounts[accountId]);
    if (!account) throw new AdministrationRequestError(404, 'account-not-found');
    if (account.login.status !== 'signed-in') throw new AdministrationRequestError(403, 'account-not-signed-in');
    return account as AccountRecord & { login: { status: 'signed-in'; nativeToken: string } };
  };

  const targetsFor = async (account: AccountRecord): Promise<AdministrationTarget[]> => state.read((current) => {
    const targets = new Map<string, AdministrationTarget>();
    for (const authority of Object.values(current.authorities)) {
      const bound = options.bindings.some((binding) => binding.accountId === account.id && binding.authorityActorIds.includes(authority.actorId));
      const home = authority.roles.includes('home') && authority.actorId === account.homeAuthority;
      if (!bound && !home) continue;
      targets.set(authority.actorId, {
        authorityId: authority.actorId, server: authority.server, roles: [...authority.roles],
        ...(authority.name === undefined ? {} : { name: authority.name })
      });
    }
    for (const binding of options.bindings) {
      if (binding.accountId !== account.id) continue;
      for (const authorityId of binding.authorityActorIds) {
        if (targets.has(authorityId)) continue;
        try {
          const url = new URL(authorityId);
          targets.set(authorityId, { authorityId, server: url.host, roles: ['territory'] });
        } catch {
          continue;
        }
      }
    }
    return [...targets.values()];
  });

  const retained = async (accountId: string): Promise<Record<string, SourcedObservation<Record<string, unknown>>>> => {
    const entries = await observations.read(administrationKey(accountId));
    const mapped: Record<string, SourcedObservation<Record<string, unknown>>> = {};
    for (const observation of entries) mapped[observation.source] = observation as SourcedObservation<Record<string, unknown>>;
    return mapped;
  };

  const kindFor = async (accountId: string, target: AdministrationTarget, control?: string): Promise<AdministrationTargetKind> => {
    const source = administrationTargetKind(target.roles);
    if (source !== 'policy') return source;
    const observation = (await retained(accountId))[target.authorityId];
    const value = observation === undefined ? undefined : retainedValue(observation);
    if (value?.kind === 'simulation' || value?.kind === 'policy') return value.kind;
    if (control === 'facilities' || control === 'tick') return 'simulation';
    return 'policy';
  };

  const tokenFor = async (account: AccountRecord & { login: { status: 'signed-in'; nativeToken: string } }, target: AdministrationTarget, kind: AdministrationTargetKind): Promise<string> => {
    if (kind === 'home') {
      if (account.homeAuthority !== target.authorityId) throw new AdministrationRequestError(403, 'home-authority-mismatch');
      const targetHost = new URL(target.authorityId).host;
      if (account.login.homeServer !== targetHost) throw new AdministrationRequestError(403, 'home-origin-mismatch');
      return account.login.nativeToken;
    }
    try {
      return await options.resolveCredential(account.id, target.authorityId);
    } catch (error) {
      throw new AdministrationRequestError(403, errorMessage(error));
    }
  };

  const controlsFor = (target: AdministrationTarget, kind: AdministrationTargetKind): AdministrationControlRecord[] => {
    const controls: AdministrationControlRecord[] = [];
    const add = (name: typeof CONTROL_NAMES[number], label: string, inputs: AdministrationControlRecord['inputs']): void => {
      controls.push({ name, authorityId: target.authorityId, label, inputs });
    };
    if (kind === 'policy') {
      add('policy', 'Policy', [{ name: 'policy', label: 'Policy values (JSON)', type: 'json', required: true }]);
      add('admission', 'Admission', [
        { name: 'reviewMode', label: 'Review mode', type: 'choice', choices: ['automatic', 'manual'] },
        { name: 'registryAcceptance', label: 'Accepted Registries (comma separated)', type: 'text' },
        { name: 'territoryAcceptance', label: 'Accepted Territories (comma separated)', type: 'text' },
        { name: 'mismatchPolicy', label: 'Mismatch policy', type: 'choice', choices: ['declared', 'evidence', 'reject'] },
        { name: 'publicPorts', label: 'Public ports (comma separated)', type: 'text' }
      ]);
    } else if (kind === 'simulation') {
      add('admission', 'Admission', [
        { name: 'reviewMode', label: 'Review mode', type: 'choice', choices: ['automatic', 'manual'] },
        { name: 'acceptedRegistries', label: 'Accepted Registries (comma separated)', type: 'text' },
        { name: 'acceptedTerritories', label: 'Accepted Territories (comma separated)', type: 'text' },
        { name: 'manifestPolicy', label: 'Manifest policy', type: 'choice', choices: ['request', 'evidence', 'reject-difference'] },
        { name: 'requireExitEvidence', label: 'Require exit evidence', type: 'boolean' }
      ]);
      add('facilities', 'Facilities', [
        { name: 'miningEnabled', label: 'Mining enabled', type: 'boolean' },
        { name: 'miningCapacity', label: 'Mining capacity', type: 'number' },
        { name: 'manufacturingSlots', label: 'Manufacturing slots', type: 'number' },
        { name: 'manufacturingTime', label: 'Manufacturing time', type: 'number' },
        { name: 'portCapacity', label: 'Port capacity', type: 'number' },
        { name: 'berthCapacity', label: 'Berth capacity', type: 'number' }
      ]);
      add('tick', 'Advance simulation tick', []);
    } else if (kind === 'registry') {
      add('adoption', 'Adoption', [
        { name: 'vesselId', label: 'Vessel URI', type: 'text', required: true },
        { name: 'adoption', label: 'Adoption', type: 'boolean', required: true }
      ]);
    } else if (kind === 'home') {
      add('availability', 'Account availability', [
        { name: 'handle', label: 'Account handle', type: 'text', required: true },
        { name: 'available', label: 'Available', type: 'boolean', required: true }
      ]);
    }
    return controls;
  };

  const buildPage = async (accountId: string): Promise<PageResponse<AdministrationData>> => {
    const account = await signedInAccount(accountId);
    const targets = await targetsFor(account);
    const observations = await retained(accountId);
    const records: AdministrationTargetRecord[] = [];
    const states: Record<string, Record<string, unknown>> = {};
    const requests: AdministrationRequestRecord[] = [];
    const controls: AdministrationControlRecord[] = [];
    for (const target of targets) {
      const observation = observations[target.authorityId];
      const value = observation === undefined ? undefined : retainedValue(observation);
      const kind = value?.kind === 'simulation' || value?.kind === 'policy' || value?.kind === 'registry' || value?.kind === 'home'
        ? value.kind as AdministrationTargetKind
        : administrationTargetKind(target.roles);
      records.push({
        authorityId: target.authorityId, server: target.server, roles: target.roles, kind,
        ...(target.name === undefined ? {} : { name: target.name }),
        state: observation?.state ?? 'not-retrieved',
        ...(observation?.source === undefined ? {} : { source: observation.source }),
        ...(observation && 'observedAt' in observation && observation.observedAt !== undefined ? { observedAt: observation.observedAt } : {}),
        ...(observation && 'error' in observation && observation.error !== undefined ? { error: observation.error } : {})
      });
      if (value) states[target.authorityId] = value;
      controls.push(...controlsFor(target, kind));
      const listed = Array.isArray(value?.requests) ? value.requests : [];
      for (const entry of listed) {
        if (!isRecord(entry)) continue;
        const request = record(entry.request);
        const requestId = typeof entry.requestId === 'string' ? entry.requestId : typeof request.id === 'string' ? request.id : undefined;
        if (!requestId) continue;
        requests.push({
          requestId, request, status: typeof entry.status === 'string' ? entry.status : 'pending', authorityId: target.authorityId,
          ...(typeof entry.sender === 'string' ? { sender: entry.sender } : {}),
          ...(typeof entry.receivedAt === 'string' ? { receivedAt: entry.receivedAt } : {}),
          ...(isRecord(entry.decision) ? { decision: entry.decision } : {}),
          ...(isRecord(entry.event) ? { event: entry.event } : {})
        } as AdministrationRequestRecord);
      }
    }
    return {
      context: { accountId },
      data: { accountId, targets: records, controls, requests, states },
      observations: Object.fromEntries(Object.entries(observations).map(([source, observation]) => [source, observation])),
      actions: []
    };
  };

  return {
    page: (accountId) => buildPage(accountId),
    async refresh(input) {
      const account = await signedInAccount(input.accountId);
      const targets = await targetsFor(account);
      const target = targets.find((candidate) => candidate.authorityId === input.authorityId);
      if (!target) throw new AdministrationRequestError(403, 'unknown-target');
      const kind = await kindFor(account.id, target);
      const token = await tokenFor(account, target, kind);
      await observations.refresh<Record<string, unknown>>({
        key: administrationKey(account.id),
        source: target.authorityId,
        load: (signal) => call(async () => (await readAdministrationTarget(fetcher, target, token, signal)).value)
      });
      return buildPage(account.id);
    },
    async control(input) {
      const account = await signedInAccount(input.accountId);
      const targets = await targetsFor(account);
      const target = targets.find((candidate) => candidate.authorityId === input.authorityId);
      if (!target) throw new AdministrationRequestError(403, 'unknown-target');
      if (!(CONTROL_NAMES as readonly string[]).includes(input.control)) throw new AdministrationRequestError(400, 'unsupported-control');
      const kind = await kindFor(account.id, target, input.control);
      if (!administrationControlPath(kind, input.control)) throw new AdministrationRequestError(400, 'unsupported-control');
      if (input.control === 'adoption' && (typeof input.inputs.vesselId !== 'string' || !input.inputs.vesselId || typeof input.inputs.adoption !== 'boolean')) throw new AdministrationRequestError(400, 'vessel-and-adoption-required');
      await tokenFor(account, target, kind);
      const action = await actions.submit({
        accountId: account.id,
        targetId: target.authorityId,
        intent: {
          kind: ADMIN_CONTROL_KIND,
          inputs: { control: input.control, authorityId: target.authorityId, authorityKind: kind, inputs: input.inputs }
        }
      });
      return { action };
    },
    async decide(input) {
      const account = await signedInAccount(input.accountId);
      const targets = await targetsFor(account);
      const target = targets.find((candidate) => candidate.authorityId === input.authorityId);
      if (!target) throw new AdministrationRequestError(403, 'unknown-target');
      const observation = (await retained(account.id))[target.authorityId];
      const value = observation === undefined ? undefined : retainedValue(observation);
      const kind = value?.kind === 'simulation' || value?.kind === 'policy' ? value.kind : await kindFor(account.id, target);
      if (kind !== 'policy' && kind !== 'simulation') throw new AdministrationRequestError(400, 'unsupported-target');
      const listed = Array.isArray(value?.requests) ? value.requests : [];
      const retainedRequest = listed.find((entry) => isRecord(entry) && (entry.requestId === input.requestId || record(entry.request).id === input.requestId));
      if (!isRecord(retainedRequest)) throw new AdministrationRequestError(404, 'request-not-found');
      const original = record(retainedRequest.request);
      const vessel = record(original.vessel);
      const vesselId = typeof vessel.id === 'string' ? vessel.id : '';
      const registryId = typeof vessel.registry === 'string' ? vessel.registry : '';
      if (!vesselId || !registryId) throw new AdministrationRequestError(400, 'request-scope-missing');
      await tokenFor(account, target, kind);
      const action = await actions.submit({
        accountId: account.id,
        targetId: target.authorityId,
        intent: {
          kind: ADMIN_DECISION_KIND,
          inputs: {
            requestId: input.requestId, decision: input.decision, authorityId: target.authorityId, authorityKind: kind,
            vesselId, registryId, ...(input.reason === undefined ? {} : { reason: input.reason })
          }
        }
      });
      return { action };
    }
  };
}
