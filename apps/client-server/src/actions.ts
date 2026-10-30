import { randomUUID } from 'node:crypto';
import type { ActionEvidence, ActionRecord, JourneyProgress } from '@fctp/client-sdk';
import type { ClientApplicationState } from './store.js';
import { withDeadline } from './deadline.js';

export interface ActionReference {
  kind: 'request' | 'resource' | 'job' | 'event';
  id: string;
}

export interface ActionIntent {
  kind: string;
  inputs: Record<string, unknown>;
}

export interface ActionPrepareInput {
  accountId: string;
  targetId: string;
  intent: ActionIntent;
  signal: AbortSignal;
}

export interface ActionPreparation {
  accepted: boolean;
  reason?: string;
}

export interface ActionSubmitInput {
  accountId: string;
  targetId: string;
  intent: ActionIntent;
  signal: AbortSignal;
}

export interface ActionSubmission {
  result?: string;
  references?: readonly ActionReference[];
  evidenceBaseline?: readonly ActionEvidence[];
  journey?: JourneyProgress;
}

export interface ActionReconcileInput {
  accountId: string;
  targetId: string;
  intent: ActionIntent;
  action: ActionRecord;
  references: readonly ActionReference[];
  signal: AbortSignal;
}

export interface ActionReconciliation {
  status: 'pending' | 'completed' | 'failed' | 'unverified';
  evidence?: readonly ActionEvidence[];
  error?: string;
  references?: readonly ActionReference[];
  result?: string;
  journey?: JourneyProgress;
}

export interface ActionHandler {
  prepare?(input: ActionPrepareInput): Promise<ActionPreparation>;
  submit(input: ActionSubmitInput): Promise<ActionSubmission>;
  reconcile?(input: ActionReconcileInput): Promise<ActionReconciliation>;
}

export interface ActionSubmitRequest {
  accountId: string;
  targetId: string;
  intent: ActionIntent;
}

export interface ActionService {
  submit(input: ActionSubmitRequest): Promise<ActionRecord>;
  reconcile(actionId: string, accountId: string): Promise<ActionRecord>;
  get(actionId: string, accountId: string): Promise<ActionRecord | undefined>;
  list(accountId: string): Promise<ActionRecord[]>;
}

export interface ActionServiceOptions {
  handlers?: Readonly<Record<string, ActionHandler>>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusUrl(actionId: string): string {
  return `/api/activity/${encodeURIComponent(actionId)}`;
}

function followedEntry(ref: ActionReference, record: ActionRecord): Record<string, unknown> {
  return {
    id: ref.id,
    kind: ref.kind,
    actionId: record.id,
    accountId: record.accountId,
    targetId: record.targetId,
    intentKind: record.intent.kind
  };
}

export function createActionService(state: ClientApplicationState, options: ActionServiceOptions = {}): ActionService {
  const handlers = options.handlers ?? {};
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const recovered = state.transaction((current) => {
    for (const action of Object.values(current.actions)) {
      if (action.submission.status !== 'sending') continue;
      const error = 'Submission outcome is unknown after interruption; reconcile explicitly';
      action.submission = { status: 'unverified', error };
      action.outcome = { ...action.outcome, status: 'unverified', error };
    }
  });

  const requireAccount = async (accountId: string): Promise<void> => {
    const account = await state.read((current) => current.accounts[accountId]);
    if (!account || account.login.status !== 'signed-in') throw new Error('A signed-in account is required to submit an action');
  };

  const requireAction = async (actionId: string, accountId: string): Promise<ActionRecord | undefined> => {
    return state.read((current) => {
      const action = current.actions[actionId];
      return action && action.accountId === accountId ? action : undefined;
    });
  };

  const reconcileLocks = new Map<string, Promise<ActionRecord>>();

  const reconcileInternal = async (actionId: string, accountId: string): Promise<ActionRecord> => {
    await recovered;
    const action = await requireAction(actionId, accountId);
    if (!action) throw new Error('Action not found for this account');
    if (action.submission.status === 'sending' || action.submission.status === 'rejected') return action;
    const handler = handlers[action.intent.kind];
    if (!handler?.reconcile) return action;

    let reconciliation: ActionReconciliation;
    try {
      reconciliation = await withDeadline(timeoutMs, (signal) => handler.reconcile!({
        accountId: action.accountId,
        targetId: action.targetId,
        intent: action.intent,
        action,
        references: action.resultReferences,
        signal
      }));
    } catch (error) {
      const failure = errorMessage(error);
      const current = await requireAction(actionId, accountId) ?? action;
      const uncertain: ActionRecord = {
        ...current,
        submission: current.submission,
        outcome: { status: 'unverified', evidence: [], error: failure }
      };
      await state.transaction((store) => { store.actions[uncertain.id] = uncertain; });
      return uncertain;
    }

    const evidence = [...(reconciliation.evidence ?? [])];
    const completedWithoutEvidence = reconciliation.status === 'completed' && evidence.length === 0;
    const status = completedWithoutEvidence ? 'unverified' : reconciliation.status;
    const failure = completedWithoutEvidence ? 'Completion requires nonempty evidence' : reconciliation.error;
    const base = await requireAction(actionId, accountId) ?? action;
    const reconciled: ActionRecord = {
      ...base,
      resultReferences: [...base.resultReferences, ...(reconciliation.references ?? [])]
        .filter((reference, index, references) => references.findIndex((candidate) => candidate.kind === reference.kind && candidate.id === reference.id) === index),
      outcome: {
        status,
        evidence,
        ...(failure === undefined ? {} : { error: failure })
      },
      ...(reconciliation.journey === undefined ? (base.journey === undefined ? {} : { journey: base.journey }) : { journey: reconciliation.journey })
    };
    await state.transaction((current) => {
      current.actions[reconciled.id] = reconciled;
      for (const reference of reconciled.resultReferences) {
        if (reference.kind === 'request') current.followedRequests[`${reconciled.id}:${reference.kind}:${reference.id}`] = followedEntry(reference, reconciled);
        if (reference.kind === 'job') current.followedJobs[`${reconciled.id}:${reference.kind}:${reference.id}`] = followedEntry(reference, reconciled);
      }
    });
    return reconciled;
  };

  return {
    async submit(input) {
      await recovered;
      await requireAccount(input.accountId);
      const handler = handlers[input.intent.kind];
      if (!handler) throw new Error(`No action handler is registered for ${input.intent.kind}`);

      const actionId = `action:${randomUUID()}`;
      const base: Omit<ActionRecord, 'submission' | 'outcome' | 'resultReferences'> = {
        id: actionId,
        statusUrl: statusUrl(actionId),
        accountId: input.accountId,
        targetId: input.targetId,
        intent: input.intent,
        submittedAt: new Date().toISOString()
      };

      let preparation: ActionPreparation;
      try {
        preparation = handler.prepare
          ? await withDeadline(timeoutMs, (signal) => handler.prepare!({ accountId: input.accountId, targetId: input.targetId, intent: input.intent, signal }))
          : { accepted: true };
      } catch (error) {
        const reason = errorMessage(error);
        const record: ActionRecord = {
          ...base,
          resultReferences: [],
          submission: { status: 'rejected', error: reason },
          outcome: { status: 'failed', evidence: [], error: reason }
        };
        await state.transaction((current) => { current.actions[record.id] = record; });
        return record;
      }

      if (!preparation.accepted) {
        const reason = preparation.reason ?? 'Action preparation was rejected';
        const record: ActionRecord = {
          ...base,
          resultReferences: [],
          submission: { status: 'rejected', error: reason },
          outcome: { status: 'failed', evidence: [], error: reason }
        };
        await state.transaction((current) => { current.actions[record.id] = record; });
        return record;
      }

      const sending: ActionRecord = {
        ...base,
        resultReferences: [],
        submission: { status: 'sending' },
        outcome: { status: 'pending', evidence: [] }
      };
      await state.transaction((current) => { current.actions[sending.id] = sending; });

      let submission: ActionSubmission;
      try {
        submission = await withDeadline(timeoutMs, (signal) => handler.submit({ accountId: input.accountId, targetId: input.targetId, intent: input.intent, signal }));
      } catch (error) {
        const failure = errorMessage(error);
        const record: ActionRecord = {
          ...sending,
          submission: { status: 'unverified', error: failure },
          outcome: { status: 'unverified', evidence: [], error: failure }
        };
        await state.transaction((current) => { current.actions[record.id] = record; });
        return record;
      }

      const references = [...(submission.references ?? [])];
      const accepted: ActionRecord = {
        ...sending,
        resultReferences: references,
        submission: {
          status: 'accepted',
          ...(submission.result === undefined ? {} : { result: submission.result }),
          ...(submission.evidenceBaseline === undefined ? {} : { evidenceBaseline: [...submission.evidenceBaseline] })
        },
        outcome: { status: 'pending', evidence: [] },
        ...(submission.journey === undefined ? {} : { journey: submission.journey })
      };
      await state.transaction((current) => {
        current.actions[accepted.id] = accepted;
        for (const reference of references) {
          if (reference.kind === 'request') current.followedRequests[`${accepted.id}:${reference.kind}:${reference.id}`] = followedEntry(reference, accepted);
          if (reference.kind === 'job') current.followedJobs[`${accepted.id}:${reference.kind}:${reference.id}`] = followedEntry(reference, accepted);
        }
      });
      return accepted;
    },
    async reconcile(actionId, accountId) {
      const previous = reconcileLocks.get(actionId) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => reconcileInternal(actionId, accountId));
      reconcileLocks.set(actionId, next);
      try {
        return await next;
      } finally {
        if (reconcileLocks.get(actionId) === next) reconcileLocks.delete(actionId);
      }
    },
    async get(actionId, accountId) {
      await recovered;
      return requireAction(actionId, accountId);
    },
    async list(accountId) {
      await recovered;
      return state.read((current) => Object.values(current.actions)
        .filter((action) => action.accountId === accountId)
        .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt)));
    }
  };
}
