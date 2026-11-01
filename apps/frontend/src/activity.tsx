import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from 'react-aria-components';
import { actionIsComplete } from '@fctp/client-sdk';
import type { ActionRecord, SourcedObservation } from '@fctp/client-sdk';
import { HandleLabel } from './handle-label';
import type { ResourceReference } from './resource-reader';
import {
  readAction,
  readActivity,
  refreshAction,
  type ActivityDetailResponse,
  type ActivityListResponse
} from './application-api';
import cssStyles from './activity.module.css';

type ClassName = 'activity' | 'heading' | 'status' | 'section' | 'subheading' | 'detail'
  | 'detailHeader' | 'controls' | 'button' | 'failure' | 'list' | 'item' | 'kind'
  | 'target' | 'meta' | 'inputs' | 'input' | 'details' | 'technical';

const styles = cssStyles as Record<ClassName, string>;

export type ActivityContext =
  | { kind: 'vessel'; vesselId: string }
  | { kind: 'journey'; vesselId: string; routePlanId: string }
  | { kind: 'job'; jobId: string; vesselId?: string; authorityId?: string }
  | { kind: 'administration'; authorityId: string };

export interface ActivityProps {
  accountId?: string;
  actionId?: string;
  selectionRevision?: number;
  onReadResource?: (reference: ResourceReference) => void;
  onOpenContext?: (context: ActivityContext) => void;
  supportedContexts?: readonly ActivityContext['kind'][];
}

interface ListView {
  accountId?: string;
  loading?: boolean;
  failure?: string;
  actions?: ActionRecord[];
}

interface DetailView {
  key?: string;
  loading?: boolean;
  failure?: string;
  record?: ActionRecord;
  observations?: Record<string, SourcedObservation<unknown>>;
  refreshing?: boolean;
  refreshError?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const encoded = JSON.stringify(value);
  return encoded ?? '';
}

function changesText(changes: Record<string, unknown> | undefined): string {
  if (changes === undefined) return '';
  return Object.entries(changes)
    .map(([key, value]) => `${key}: ${inputText(value)}`)
    .join(', ');
}

function listActions(response: ActivityListResponse, accountId: string): ActionRecord[] | undefined {
  if (!isRecord(response.data)) return undefined;
  const actions = response.data.actions;
  if (!Array.isArray(actions)) return undefined;
  return actions.filter((entry): entry is ActionRecord =>
    isRecord(entry) && typeof entry.id === 'string' && entry.accountId === accountId
  );
}

function outcomeLabel(record: ActionRecord): string {
  if (record.outcome.status === 'completed' && !actionIsComplete(record)) {
    return 'unverified (completion is not confirmed without matching evidence)';
  }
  return record.outcome.status;
}

function observationTime(observation: SourcedObservation<unknown>): string | undefined {
  return 'observedAt' in observation ? observation.observedAt : undefined;
}

function observationError(observation: SourcedObservation<unknown>): string | undefined {
  return 'error' in observation ? observation.error : undefined;
}

function intentInput(record: ActionRecord, key: string): string | undefined {
  const value = record.intent.inputs[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isAdministrationIntent(record: ActionRecord): boolean {
  return record.intent.kind === 'administration-control' || record.intent.kind === 'administration-entry-request';
}

interface RecoveryControlsProps {
  record: ActionRecord;
  onReadResource?: ActivityProps['onReadResource'];
  onOpenContext?: ActivityProps['onOpenContext'];
  supportedContexts?: ActivityProps['supportedContexts'];
}

function RecoveryControls({ record, onReadResource, onOpenContext, supportedContexts }: RecoveryControlsProps): ReactElement | null {
  const vesselId = record.journey?.vesselId ?? intentInput(record, 'vesselId');
  const routePlanId = record.journey?.routePlanId;
  const authorityId = intentInput(record, 'authorityId');
  const resourceReferences = record.resultReferences.filter((reference) => reference.kind === 'resource');
  const jobReferences = record.resultReferences.filter((reference) => reference.kind === 'job');
  const administration = isAdministrationIntent(record) && authorityId !== undefined;

  const controls: ReactElement[] = [];
  const supports = (kind: ActivityContext['kind']): boolean => supportedContexts === undefined || supportedContexts.includes(kind);
  if (onReadResource !== undefined) {
    for (const reference of resourceReferences) {
      controls.push(
        <Button key={`resource\u0000${reference.id}`} className={styles.button} onPress={() => onReadResource({ id: reference.id })}>
          Read resource
        </Button>
      );
    }
  }
  if (onOpenContext !== undefined) {
    if (vesselId !== undefined && supports('vessel')) {
      controls.push(
        <Button key="vessel" className={styles.button} onPress={() => onOpenContext({ kind: 'vessel', vesselId })}>
          Open vessel
        </Button>
      );
    }
    if (vesselId !== undefined && routePlanId !== undefined && supports('journey')) {
      controls.push(
        <Button key="journey" className={styles.button} onPress={() => onOpenContext({ kind: 'journey', vesselId, routePlanId })}>
          Open journey
        </Button>
      );
    }
    for (const reference of jobReferences) {
      if (!supports('job') || vesselId === undefined) continue;
      controls.push(
        <Button
          key={`job\u0000${reference.id}`}
          className={styles.button}
          onPress={() => onOpenContext({
            kind: 'job',
            jobId: reference.id,
            ...(vesselId === undefined ? {} : { vesselId }),
            ...(authorityId === undefined ? {} : { authorityId })
          })}
        >
          Open job
        </Button>
      );
    }
    if (administration && supports('administration')) {
      controls.push(
        <Button key="administration" className={styles.button} onPress={() => onOpenContext({ kind: 'administration', authorityId })}>
          Open administration
        </Button>
      );
    }
  }

  return controls.length === 0 ? null : <div className={styles.controls}>{controls}</div>;
}

export function Activity(props: ActivityProps): ReactElement {
  const { accountId, actionId, selectionRevision, onReadResource, onOpenContext, supportedContexts } = props;
  const [listView, setList] = useState<ListView>({});
  const [activeActionId, setActiveActionId] = useState<string | undefined>(actionId);
  const [detail, setDetail] = useState<DetailView>({});
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const detailAccount = useRef(accountId);
  const previousAccount = useRef(accountId);

  useEffect(() => {
    setActiveActionId(actionId);
  }, [actionId, selectionRevision]);

  useEffect(() => {
    const generation = ++listGeneration.current;
    if (accountId === undefined) {
      setList({});
      return;
    }
    setList({ accountId, loading: true });
    readActivity(accountId).then(
      (response) => {
        if (listGeneration.current !== generation) return;
        const actions = listActions(response, accountId);
        setList(actions === undefined
          ? { accountId, failure: 'The retained Activity response was malformed.' }
          : { accountId, actions });
      },
      (error: unknown) => {
        if (listGeneration.current !== generation) return;
        setList({ accountId, failure: errorText(error) });
      }
    );
    return () => {
      if (listGeneration.current === generation) listGeneration.current += 1;
    };
  }, [accountId]);

  useEffect(() => {
    const changedAccount = detailAccount.current !== accountId;
    detailAccount.current = accountId;
    if (accountId === undefined || activeActionId === undefined) {
      detailGeneration.current += 1;
      setDetail({});
      return;
    }
    if (changedAccount) {
      detailGeneration.current += 1;
      setDetail({});
      return;
    }
    const generation = ++detailGeneration.current;
    const key = `${accountId}\u0000${activeActionId}`;
    setDetail((current) => {
      if (current.key !== key) return { key, loading: true };
      const next: DetailView = { ...current, loading: true };
      delete next.failure;
      return next;
    });
    readAction(accountId, activeActionId).then(
      (response: ActivityDetailResponse) => {
        if (detailGeneration.current !== generation) return;
        const action = response.data.action;
        if (action === undefined || action.accountId !== accountId || action.id !== activeActionId) {
          setDetail({ key, loading: false, failure: 'This action is not available for the selected account.' });
          return;
        }
        setDetail({
          key,
          loading: false,
          record: action,
          observations: response.observations ?? {}
        });
      },
      (error: unknown) => {
        if (detailGeneration.current !== generation) return;
        setDetail({ key, loading: false, failure: errorText(error) });
      }
    );
    return () => {
      if (detailGeneration.current === generation) detailGeneration.current += 1;
    };
  }, [accountId, activeActionId]);

  useEffect(() => () => {
    listGeneration.current += 1;
    detailGeneration.current += 1;
  }, []);

  useEffect(() => {
    if (previousAccount.current === accountId) return;
    previousAccount.current = accountId;
    setActiveActionId(undefined);
  }, [accountId]);

  const openAction = (id: string): void => {
    setActiveActionId(id);
  };

  const refresh = (): void => {
    if (accountId === undefined || activeActionId === undefined || detail.refreshing === true) return;
    const generation = ++detailGeneration.current;
    const key = `${accountId}\u0000${activeActionId}`;
    setDetail((current) => {
      if (current.key !== key) return { key, loading: true, refreshing: true };
      const next: DetailView = { ...current, refreshing: true };
      delete next.refreshError;
      return next;
    });
    refreshAction(accountId, activeActionId).then(
      (response) => {
        if (detailGeneration.current !== generation) return;
        const action = response.data.action;
        if (action === undefined || action.accountId !== accountId || action.id !== activeActionId) {
          setDetail((current) => current.key === key
            ? { ...current, refreshing: false, refreshError: 'The refreshed action was not available for this account.' }
            : current);
          return;
        }
        setDetail({
          key,
          loading: false,
          record: action,
          observations: response.observations ?? {}
        });
      },
      (error: unknown) => {
        if (detailGeneration.current !== generation) return;
        setDetail((current) => current.key === key
          ? { ...current, refreshing: false, refreshError: errorText(error) }
          : current);
      }
    );
  };

  if (accountId === undefined) {
    return (
      <section aria-label="Activity" className={styles.activity}>
        <h2 className={styles.heading}>Activity</h2>
        <p className={styles.status}>Select an account to view Activity.</p>
      </section>
    );
  }

  const detailKey = activeActionId === undefined ? undefined : `${accountId}\u0000${activeActionId}`;
  const list = listView.accountId === accountId ? listView : { loading: true };
  const current = detail.key === detailKey ? detail : undefined;
  const record = current?.record;
  const loadingDetail = activeActionId !== undefined && record === undefined && current?.failure === undefined;

  return (
    <section aria-label="Activity" className={styles.activity}>
      <h2 className={styles.heading}>Activity</h2>

      <section className={styles.section}>
        <h3 className={styles.subheading}>Retained activity</h3>
        {list.loading === true ? <p className={styles.status}>Reading retained activity…</p> : null}
        {list.failure === undefined ? null : (
          <p className={styles.failure} role="alert">Activity unavailable: {list.failure}</p>
        )}
        {list.failure === undefined && list.loading !== true && list.actions !== undefined ? (
          list.actions.length === 0 ? (
            <p className={styles.status}>No activity is recorded for this account.</p>
          ) : (
            <ul className={styles.list}>
              {list.actions.map((entry) => (
                <li key={entry.id} className={styles.item}>
                  <p className={styles.kind}>{entry.intent.kind}</p>
                  <p className={styles.target}><HandleLabel actorId={entry.targetId} /></p>
                  <details className={styles.details} open>
                    <summary>Target identity</summary>
                    <p className={styles.meta}>Target: {entry.targetId}</p>
                  </details>
                  <p className={styles.meta}>Submitted {entry.submittedAt}</p>
                  <p className={styles.meta}>Submission: {entry.submission.status}</p>
                  <p className={styles.meta}>Outcome: {outcomeLabel(entry)}</p>
                  <Button className={styles.button} onPress={() => openAction(entry.id)}>
                    View details
                  </Button>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>

      {activeActionId === undefined ? null : (
        <section aria-label="Action details" className={styles.detail}>
          <header className={styles.detailHeader}>
            <h3 className={styles.subheading}>Action details</h3>
            <Button className={styles.button} onPress={refresh} isPending={current?.refreshing === true}>
              Refresh
            </Button>
          </header>

          {current?.refreshError === undefined ? null : (
            <p className={styles.failure} role="alert">
              Refresh failed: {current.refreshError}. The last known detail is retained and may be stale.
            </p>
          )}

          {current?.failure === undefined ? null : (
            <p className={styles.failure} role="alert">Action details unavailable: {current.failure}</p>
          )}

          {loadingDetail ? <p className={styles.status}>Reading the retained action…</p> : null}

          {record === undefined ? null : (
            <>
              <p className={styles.target}>Target: <HandleLabel actorId={record.targetId} /></p>
              <details className={styles.details} open>
                <summary>Target identity</summary>
                <p className={styles.meta}>Target: {record.targetId}</p>
              </details>
              <p className={styles.meta}>Submitted {record.submittedAt}</p>
              <p className={styles.meta}>Submission: {record.submission.status}</p>
              <p className={styles.meta}>Outcome: {outcomeLabel(record)}</p>
              {record.submission.error === undefined ? null : (
                <p className={styles.failure}>Submission error: {record.submission.error}</p>
              )}
              {record.outcome.error === undefined ? null : (
                <p className={styles.failure}>Outcome error: {record.outcome.error}</p>
              )}

              <section className={styles.section}>
                <h4 className={styles.subheading}>Intent</h4>
                <p className={styles.meta}>Kind: {record.intent.kind}</p>
                {Object.keys(record.intent.inputs).length === 0 ? null : (
                  <dl className={styles.inputs}>
                    {Object.entries(record.intent.inputs).map(([key, value]) => (
                      <div key={key} className={styles.input}>
                        <dt>{key}</dt>
                        <dd>{inputText(value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>

              {record.outcome.evidence.length === 0 ? null : (
                <section className={styles.section}>
                  <h4 className={styles.subheading}>Evidence</h4>
                  <ul className={styles.list}>
                    {record.outcome.evidence.map((evidence, index) => (
                      <li key={`${evidence.source}\u0000${index}`} className={styles.item}>
                        <p className={styles.meta}>Source: {evidence.source}</p>
                        <p className={styles.meta}>Observed: {evidence.observedAt}</p>
                        {evidence.changes === undefined ? null : (
                          <p className={styles.meta}>Changes: {changesText(evidence.changes)}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {current?.observations === undefined || Object.keys(current.observations).length === 0 ? null : (
                <section className={styles.section}>
                  <h4 className={styles.subheading}>Independent observations</h4>
                  <ul className={styles.list}>
                    {Object.entries(current.observations).map(([key, observation]) => {
                      const observedAt = observationTime(observation);
                      const observationFailure = observationError(observation);
                      return (
                        <li key={key} className={styles.item}>
                          <p className={styles.meta}>State: {observation.state}</p>
                          <p className={styles.meta}>Source: {observation.source}</p>
                          {observedAt === undefined ? null : <p className={styles.meta}>Observed: {observedAt}</p>}
                          {observationFailure === undefined ? null : (
                            <p className={styles.failure}>Observation error: {observationFailure}</p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {record.journey === undefined ? null : (
                <section className={styles.section}>
                  <h4 className={styles.subheading}>Journey</h4>
                  <p className={styles.meta}>Status: {record.journey.status}</p>
                  <p className={styles.meta}>Vessel: {record.journey.vesselId}</p>
                  <p className={styles.meta}>Route plan: {record.journey.routePlanId}</p>
                  <p className={styles.meta}>Updated: {record.journey.updatedAt}</p>
                  {record.journey.error === undefined ? null : (
                    <p className={styles.failure}>Journey error: {record.journey.error}</p>
                  )}
                  <ul className={styles.list}>
                    {record.journey.legs.map((leg) => (
                      <li key={leg.routeId} className={styles.item}>
                        <p className={styles.meta}>Leg: {leg.from} → {leg.to}</p>
                        <p className={styles.meta}>Operation: {leg.kind ?? 'unknown'}</p>
                        <p className={styles.meta}>Status: {leg.status}</p>
                        {leg.requestId === undefined ? null : <p className={styles.meta}>Request: {leg.requestId}</p>}
                        {leg.eventId === undefined ? null : <p className={styles.meta}>Event: {leg.eventId}</p>}
                        {leg.error === undefined ? null : <p className={styles.failure}>Leg error: {leg.error}</p>}
                        {leg.observedAt === undefined ? null : <p className={styles.meta}>Observed: {leg.observedAt}</p>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <RecoveryControls
                record={record}
                {...(onReadResource === undefined ? {} : { onReadResource })}
                {...(onOpenContext === undefined ? {} : { onOpenContext })}
                {...(supportedContexts === undefined ? {} : { supportedContexts })}
              />

              <details className={styles.details}>
                <summary>Technical details</summary>
                <dl className={styles.technical}>
                  <dt>Action ID</dt>
                  <dd>{record.id}</dd>
                  <dt>Target</dt>
                  <dd>{record.targetId}</dd>
                  <dt>Status URL</dt>
                  <dd>{record.statusUrl}</dd>
                  <dt>Result references</dt>
                  <dd>
                    {record.resultReferences.length === 0 ? 'None' : (
                      <ul className={styles.list}>
                        {record.resultReferences.map((reference) => (
                          <li key={`${reference.kind}\u0000${reference.id}`}>{reference.kind}: {reference.id}</li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </dl>
              </details>
            </>
          )}
        </section>
      )}
    </section>
  );
}
