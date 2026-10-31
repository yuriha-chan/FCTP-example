import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from 'react-aria-components';
import type {
  ActionEvidence,
  ActionRecord,
  ProductionJob,
  ProductionOperation,
  ProductionOperationInput
} from '@fctp/client-sdk';
import {
  executeProductionOperation,
  readLibrary,
  readProduction,
  readProductionJob,
  refreshAction,
  refreshLibrary,
  refreshProduction,
  refreshProductionJob,
  type LibraryResponse,
  type ProductionResponse
} from './application-api';
import { ReferencePicker } from './reference-picker';
import type { ReferencePickerSelection, ReferencePickerSource } from './reference-picker';
import { ResourceReader } from './resource-reader';
import type { ResourceReference } from './resource-reader';
import type { VesselWorkflowContext } from './workflow-context';
import cssStyles from './production.module.css';

type ClassName = 'production' | 'heading' | 'subheading' | 'section' | 'meta' | 'error' | 'info'
  | 'controls' | 'button' | 'list' | 'item' | 'field' | 'label' | 'input' | 'select'
  | 'authority' | 'operation' | 'destination' | 'form' | 'actions' | 'evidence';

const styles = cssStyles as Record<ClassName, string>;

export interface ProductionProps {
  accountId?: string;
  context?: VesselWorkflowContext;
  selectionRevision?: number;
  onOpenAction?: (actionId: string) => void;
  onReadResource?: (reference: ResourceReference) => void;
}

interface PageView {
  key: string;
  loading?: boolean | undefined;
  response?: ProductionResponse | undefined;
  failure?: string | undefined;
  refreshing?: boolean | undefined;
  refreshError?: string | undefined;
}

interface FormState {
  key: string;
  values: Record<string, string>;
}

interface SubmissionState {
  targetKey: string;
  operationKey: string;
  accountId: string;
  vesselId: string;
  operationId: string;
  authorityId: string;
  action?: ActionRecord | undefined;
  sendError?: string | undefined;
  refreshError?: string | undefined;
}

interface JobLookup {
  jobId: string;
  loading?: boolean | undefined;
  job?: ProductionJob | undefined;
  failure?: string | undefined;
}

interface SelectedJobState {
  key: string;
  job: ProductionJob;
  loading?: boolean | undefined;
  failure?: string | undefined;
  refreshing?: boolean | undefined;
  refreshError?: string | undefined;
}

interface LibraryView {
  accountId: string;
  loading?: boolean | undefined;
  response?: LibraryResponse | undefined;
  failure?: string | undefined;
  refreshing?: boolean | undefined;
  refreshError?: string | undefined;
}

interface PickerState {
  operationKey: string;
  fieldName: string;
  fieldLabel: string;
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

function operationKey(operation: ProductionOperation): string {
  return `${operation.authorityId}\u0000${operation.operationId}`;
}

function jobKey(job: ProductionJob): string {
  return `${job.authorityId}\u0000${job.jobId}`;
}

function initialValues(operation: ProductionOperation): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of operation.inputs) {
    if (input.default !== undefined) {
      values[input.name] = String(input.default);
      continue;
    }
    const onlyChoice = input.type === 'choice' && input.choices?.length === 1 ? input.choices[0] : undefined;
    values[input.name] = onlyChoice === undefined ? '' : onlyChoice.value;
  }
  return values;
}

function validateValues(operation: ProductionOperation, values: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const input of operation.inputs) {
    const value = values[input.name] ?? '';
    if (input.type === 'count') {
      const numeric = Number(value);
      const minimum = Math.max(1, input.minimum ?? 1);
      if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(numeric) || numeric < minimum) {
        errors.push(`${input.label} must be a positive integer of at least ${minimum}.`);
      }
      continue;
    }
    if (value === '') {
      if (input.required) errors.push(`${input.label} is required.`);
      continue;
    }
    const advertised = input.choices?.some((choice) => choice.value === value) ?? false;
    if (!advertised) errors.push(`${input.label} must be one of the advertised choices.`);
  }
  return errors;
}

function payloadValues(operation: ProductionOperation, values: Record<string, string>): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const input of operation.inputs) {
    const value = values[input.name] ?? '';
    inputs[input.name] = input.type === 'count' ? Number(value) : value;
  }
  return inputs;
}

function isProductionFor(data: ProductionResponse['data'], accountId: string, vesselId: string): boolean {
  return data.accountId === accountId
    && data.vesselId === vesselId
    && Array.isArray(data.operations)
    && Array.isArray(data.authorities)
    && Array.isArray(data.jobs);
}

function isActionFor(action: ActionRecord, accountId: string, actionId?: string): boolean {
  return typeof action.id === 'string' && action.id.length > 0
    && action.accountId === accountId
    && Array.isArray(action.resultReferences)
    && isRecord(action.submission)
    && isRecord(action.outcome)
    && (actionId === undefined || action.id === actionId);
}

function isJobFor(
  job: ProductionJob,
  accountId: string,
  vesselId: string,
  jobId: string,
  authorityId?: string
): boolean {
  return job.jobId === jobId
    && job.accountId === accountId
    && job.vesselId === vesselId
    && (authorityId === undefined || job.authorityId === authorityId);
}

function jobStatusText(job: ProductionJob): string {
  if (job.status === 'completed' && (job.evidence?.length ?? 0) === 0) return 'completed (unverified)';
  return job.status;
}

function newerJob(first: ProductionJob, second: ProductionJob | undefined): ProductionJob {
  return second !== undefined && Date.parse(second.observedAt) > Date.parse(first.observedAt) ? second : first;
}

function outcomeText(action: ActionRecord): string {
  if (action.outcome.status === 'completed' && action.outcome.evidence.length === 0) return 'unverified';
  return action.outcome.status;
}

function EvidenceList({ evidence }: { evidence: readonly ActionEvidence[] }): ReactElement | null {
  if (evidence.length === 0) return null;
  return (
    <ul className={styles.list}>
      {evidence.map((entry, index) => (
        <li key={`${entry.source}\u0000${entry.observedAt}\u0000${index}`} className={styles.evidence}>
          <p className={styles.meta}>Evidence {entry.source} · {entry.observedAt}</p>
          {entry.changes === undefined ? null : (
            <p className={styles.meta}>{JSON.stringify(entry.changes)}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function JobSummary({ job }: { job: ProductionJob }): ReactElement {
  return (
    <>
      <p className={styles.label}>Job {job.jobId}</p>
      <p className={styles.meta}>Authority {job.authorityId}</p>
      <p className={styles.meta}>Operation {job.operation}</p>
      {job.progress?.remainingTicks === undefined ? null : (
        <p className={styles.meta}>Remaining ticks: {job.progress.remainingTicks}</p>
      )}
      {job.progress?.tick === undefined ? null : <p className={styles.meta}>Tick: {job.progress.tick}</p>}
      {job.progress?.count === undefined ? null : <p className={styles.meta}>Count: {job.progress.count}</p>}
      <p className={styles.meta}>Status {jobStatusText(job)}</p>
      <p className={styles.meta}>Source {job.source} · Observed {job.observedAt}</p>
      {job.output === undefined ? null : <p className={styles.meta}>Output {job.output}</p>}
      {job.error === undefined ? null : <p className={styles.error} role="alert">Job error: {job.error}</p>}
      {job.evidence === undefined ? null : <EvidenceList evidence={job.evidence} />}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }): ReactElement {
  return <p className={styles.meta}>{label}: {value}</p>;
}

export function Production(props: ProductionProps): ReactElement {
  const { accountId, context, selectionRevision, onOpenAction, onReadResource } = props;
  const [view, setView] = useState<PageView>({ key: '' });
  const [selectedAuthority, setSelectedAuthority] = useState<string | undefined>();
  const [selectedOperationKey, setSelectedOperationKey] = useState<string | undefined>();
  const [form, setForm] = useState<FormState | undefined>();
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [operationError, setOperationError] = useState<string | undefined>();
  const [submission, setSubmission] = useState<SubmissionState | undefined>();
  const [sending, setSending] = useState(false);
  const [actionRefreshing, setActionRefreshing] = useState(false);
  const [jobs, setJobs] = useState<Record<string, ProductionJob>>({});
  const [selectedJob, setSelectedJob] = useState<SelectedJobState | undefined>();
  const [jobLookup, setJobLookup] = useState<JobLookup | undefined>();
  const [library, setLibrary] = useState<LibraryView | undefined>();
  const [picker, setPicker] = useState<PickerState | undefined>();
  const [pickerError, setPickerError] = useState<string | undefined>();
  const [reader, setReader] = useState<ResourceReference | undefined>();

  const pageGeneration = useRef(0);
  const targetGeneration = useRef(0);
  const jobLookupGeneration = useRef(0);
  const jobDetailGeneration = useRef(0);
  const libraryGeneration = useRef(0);
  const submissionGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const sendingRef = useRef(false);
  const refreshingActionRef = useRef(false);
  const refreshingJobRef = useRef<number | undefined>(undefined);
  const varietySelect = useRef<HTMLSelectElement | null>(null);
  const targetKeyRef = useRef('');
  const appliedHandoff = useRef('');

  const clearSubmission = useCallback((): void => {
    submissionGeneration.current += 1;
    actionGeneration.current += 1;
    sendingRef.current = false;
    refreshingActionRef.current = false;
    setSending(false);
    setActionRefreshing(false);
    setSubmission(undefined);
  }, []);

  const vesselId = context?.vesselId;
  const contextMatches = context !== undefined && accountId !== undefined && context.accountId === accountId;
  const ready = accountId !== undefined && vesselId !== undefined && vesselId.length > 0 && contextMatches;
  const targetKey = ready ? `${accountId}\u0000${vesselId}` : '';
  targetKeyRef.current = targetKey;

  const data = view.key === targetKey ? view.response?.data : undefined;
  const selectedOperation = data?.operations.find((operation) => operationKey(operation) === selectedOperationKey);
  const visibleOperations = data === undefined
    ? []
    : data.operations.filter((operation) => selectedAuthority === undefined || operation.authorityId === selectedAuthority);
  const requestedAuthority = context?.authorityId;
  const requestedAuthorityRecord = requestedAuthority === undefined
    ? undefined
    : data?.authorities.find((authority) => authority.authorityId === requestedAuthority);
  const requestedAuthorityUnavailable = data !== undefined
    && requestedAuthority !== undefined
    && selectedAuthority === requestedAuthority
    && requestedAuthorityRecord === undefined;

  useEffect(() => {
    appliedHandoff.current = '';
    setSelectedAuthority(undefined);
    setSelectedOperationKey(undefined);
    setForm(undefined);
    setValidationErrors([]);
    setOperationError(undefined);
    clearSubmission();
    jobDetailGeneration.current += 1;
    refreshingJobRef.current = undefined;
    setJobs({});
    setSelectedJob(undefined);
    setJobLookup(undefined);
    setPicker(undefined);
    setPickerError(undefined);
    setReader(undefined);
  }, [targetKey, clearSubmission]);

  useEffect(() => {
    libraryGeneration.current += 1;
    setLibrary(undefined);
  }, [accountId]);

  useEffect(() => {
    targetGeneration.current += 1;
    return () => { targetGeneration.current += 1; };
  }, [targetKey]);

  useEffect(() => () => { libraryGeneration.current += 1; }, []);

  useEffect(() => {
    const generation = ++pageGeneration.current;
    const requestAccount = accountId;
    const requestVessel = vesselId;
    if (!ready || requestAccount === undefined || requestVessel === undefined) {
      setView({ key: '' });
      return () => { pageGeneration.current += 1; };
    }
    const key = `${requestAccount}\u0000${requestVessel}`;
    setView({ key, loading: true });
    readProduction(requestAccount, requestVessel).then(
      (response) => {
        if (generation !== pageGeneration.current) return;
        if (!isProductionFor(response.data, requestAccount, requestVessel)) {
          setView({ key, failure: 'The retained production read returned unexpected account or vessel identity.' });
          return;
        }
        setView({ key, response });
      },
      (error: unknown) => {
        if (generation !== pageGeneration.current) return;
        setView({ key, failure: errorText(error) });
      }
    );
    return () => { pageGeneration.current += 1; };
  }, [ready, targetKey, accountId, vesselId]);

  useEffect(() => {
    if (!ready || context?.authorityId === undefined) return;
    setSelectedAuthority(context.authorityId);
    setSelectedOperationKey(undefined);
    setForm(undefined);
    setValidationErrors([]);
    setOperationError(undefined);
    clearSubmission();
  }, [ready, targetKey, context?.authorityId, selectionRevision, clearSubmission]);

  useEffect(() => {
    if (!ready || data === undefined) return;
    const requested = context?.operationId;
    if (requested === undefined) return;
    const handoff = `${targetKey}\u0000${selectionRevision ?? 0}\u0000${requested}\u0000${context?.authorityId ?? ''}`;
    if (appliedHandoff.current === handoff) return;
    const matches = data.operations.filter((operation) => (
      operation.operationId === requested
      && (context?.authorityId === undefined || operation.authorityId === context.authorityId)
    ));
    if (matches.length === 0) {
      setSelectedOperationKey(undefined);
      setForm(undefined);
      setOperationError(`Operation ${requested} is unavailable for the requested authority.`);
      return;
    }
    if (matches.length > 1) {
      setSelectedOperationKey(undefined);
      setForm(undefined);
      setOperationError(`Operation ${requested} is ambiguous without an exact authority.`);
      return;
    }
    const match = matches[0];
    if (match === undefined) return;
    appliedHandoff.current = handoff;
    const key = operationKey(match);
    setSelectedOperationKey(key);
    setForm({ key, values: initialValues(match) });
    setValidationErrors([]);
    setOperationError(undefined);
    clearSubmission();
  }, [ready, targetKey, data, context?.operationId, context?.authorityId, selectionRevision, clearSubmission]);

  useEffect(() => {
    const requested = context?.jobId;
    const requestAccount = accountId;
    const requestVessel = vesselId;
    if (!ready || requested === undefined || requestAccount === undefined || requestVessel === undefined) {
      setJobLookup(undefined);
      return () => { jobLookupGeneration.current += 1; };
    }
    const generation = ++jobLookupGeneration.current;
    const targetGenerationAtStart = targetGeneration.current;
    setJobLookup({ jobId: requested, loading: true });
    readProductionJob(requested, requestAccount, requestVessel).then(
      (response) => {
        if (generation !== jobLookupGeneration.current) return;
        if (targetGenerationAtStart !== targetGeneration.current) return;
        const job = response.data.job;
        if (!isJobFor(job, requestAccount, requestVessel, requested, context?.authorityId)) {
          setJobLookup({ jobId: requested, failure: 'The requested job returned unexpected account, vessel, or authority identity.' });
          return;
        }
        setJobLookup({ jobId: requested, job });
      },
      (error: unknown) => {
        if (generation !== jobLookupGeneration.current) return;
        if (targetGenerationAtStart !== targetGeneration.current) return;
        setJobLookup({ jobId: requested, failure: errorText(error) });
      }
    );
    return () => { jobLookupGeneration.current += 1; };
  }, [ready, targetKey, context?.jobId, context?.authorityId, selectionRevision, accountId, vesselId]);

  useEffect(() => {
    if (picker === undefined || accountId === undefined) return;
    if (library?.accountId === accountId) return;
    const generation = ++libraryGeneration.current;
    setLibrary({ accountId, loading: true });
    readLibrary(accountId).then(
      (response) => {
        if (generation !== libraryGeneration.current) return;
        setLibrary({ accountId, response });
      },
      (error: unknown) => {
        if (generation !== libraryGeneration.current) return;
        setLibrary({ accountId, failure: errorText(error) });
      }
    );
  }, [picker, accountId, library?.accountId]);

  const chooseAuthority = (authorityId: string | undefined): void => {
    setSelectedAuthority(authorityId);
    setSelectedOperationKey(undefined);
    setForm(undefined);
    setValidationErrors([]);
    setOperationError(undefined);
    clearSubmission();
    setPicker(undefined);
  };

  const selectOperation = (operation: ProductionOperation): void => {
    const key = operationKey(operation);
    setSelectedOperationKey(key);
    setForm({ key, values: initialValues(operation) });
    setValidationErrors([]);
    setOperationError(undefined);
    clearSubmission();
    setPicker(undefined);
  };

  const updateValue = (name: string, value: string): void => {
    setForm((previous) => previous === undefined
      ? previous
      : { ...previous, values: { ...previous.values, [name]: value } });
  };

  const submitOperation = (): void => {
    const requestAccount = accountId;
    const requestVessel = vesselId;
    const operation = selectedOperation;
    if (!ready || requestAccount === undefined || requestVessel === undefined || operation === undefined || form === undefined) return;
    if (sendingRef.current) return;
    const errors = validateValues(operation, form.values);
    if (errors.length > 0) {
      setValidationErrors(errors);
      return;
    }
    setValidationErrors([]);
    const inputs = payloadValues(operation, form.values);
    const targetAtStart = targetKey;
    const targetGenerationAtStart = targetGeneration.current;
    const operationAtStart = form.key;
    const generation = ++submissionGeneration.current;
    actionGeneration.current += 1;
    refreshingActionRef.current = false;
    setActionRefreshing(false);
    setSubmission(undefined);
    sendingRef.current = true;
    setSending(true);
    executeProductionOperation({
      operationId: operation.operationId,
      accountId: requestAccount,
      vesselId: requestVessel,
      inputs
    }).then(
      (response) => {
        if (generation !== submissionGeneration.current) return;
        if (targetGenerationAtStart !== targetGeneration.current || targetKeyRef.current !== targetAtStart) return;
        sendingRef.current = false;
        setSending(false);
        if (!isActionFor(response.action, requestAccount)) {
          setSubmission({
            targetKey: targetAtStart,
            operationKey: operationAtStart,
            accountId: requestAccount,
            vesselId: requestVessel,
            operationId: operation.operationId,
            authorityId: operation.authorityId,
            sendError: 'The server returned an unexpected production action.'
          });
          return;
        }
        setSubmission({
          targetKey: targetAtStart,
          operationKey: operationAtStart,
          accountId: requestAccount,
          vesselId: requestVessel,
          operationId: operation.operationId,
          authorityId: operation.authorityId,
          action: response.action
        });
      },
      (error: unknown) => {
        if (generation !== submissionGeneration.current) return;
        if (targetGenerationAtStart !== targetGeneration.current || targetKeyRef.current !== targetAtStart) return;
        sendingRef.current = false;
        setSending(false);
        setSubmission({
          targetKey: targetAtStart,
          operationKey: operationAtStart,
          accountId: requestAccount,
          vesselId: requestVessel,
          operationId: operation.operationId,
          authorityId: operation.authorityId,
          sendError: errorText(error)
        });
      }
    );
  };

  const refreshSubmission = (): void => {
    const current = submission;
    if (current === undefined || current.action === undefined || refreshingActionRef.current) return;
    const targetAtStart = targetKey;
    const targetGenerationAtStart = targetGeneration.current;
    const actionId = current.action.id;
    const actionAccount = current.accountId;
    const generation = ++actionGeneration.current;
    refreshingActionRef.current = true;
    setActionRefreshing(true);
    refreshAction(actionAccount, actionId).then(
      (response) => {
        if (generation !== actionGeneration.current) return;
        if (targetGenerationAtStart !== targetGeneration.current || targetKeyRef.current !== targetAtStart) return;
        refreshingActionRef.current = false;
        setActionRefreshing(false);
        if (!isActionFor(response.data.action, actionAccount, actionId)) {
          setSubmission((previous) => previous?.action?.id !== actionId
            ? previous
            : { ...previous, refreshError: 'The action readback returned unexpected ownership or identity.' });
          return;
        }
        setSubmission((previous) => previous?.action?.id !== actionId
          ? previous
          : { ...previous, action: response.data.action, refreshError: undefined });
      },
      (error: unknown) => {
        if (generation !== actionGeneration.current) return;
        if (targetGenerationAtStart !== targetGeneration.current || targetKeyRef.current !== targetAtStart) return;
        refreshingActionRef.current = false;
        setActionRefreshing(false);
        setSubmission((previous) => previous?.action?.id !== actionId
          ? previous
          : { ...previous, refreshError: errorText(error) });
      }
    );
  };

  const openResource = (reference: ResourceReference): void => {
    if (onReadResource !== undefined) onReadResource(reference);
    else setReader(reference);
  };

  const selectJob = (job: ProductionJob): void => {
    const requestAccount = accountId;
    const requestVessel = vesselId;
    if (!ready || requestAccount === undefined || requestVessel === undefined) return;
    const key = jobKey(job);
    const generation = ++jobDetailGeneration.current;
    refreshingJobRef.current = undefined;
    const targetGenerationAtStart = targetGeneration.current;
    setSelectedJob({ key, job, loading: true });
    readProductionJob(job.jobId, requestAccount, requestVessel).then(
      (response) => {
        if (generation !== jobDetailGeneration.current) return;
        if (targetGenerationAtStart !== targetGeneration.current) return;
        const next = response.data.job;
        if (!isJobFor(next, requestAccount, requestVessel, job.jobId, job.authorityId)) {
          setSelectedJob({ key, job, failure: 'The selected job returned unexpected account, vessel, or authority identity.' });
          return;
        }
        setSelectedJob({ key, job: next });
        setJobs((previous) => ({ ...previous, [key]: next }));
      },
      (error: unknown) => {
        if (generation !== jobDetailGeneration.current) return;
        if (targetGenerationAtStart !== targetGeneration.current) return;
        setSelectedJob({ key, job, failure: errorText(error) });
      }
    );
  };

  const refreshSelectedJob = (): void => {
    const current = selectedJob;
    const requestAccount = accountId;
    const requestVessel = vesselId;
    if (current === undefined || !ready || requestAccount === undefined || requestVessel === undefined) return;
    if (refreshingJobRef.current !== undefined) return;
    const generation = ++jobDetailGeneration.current;
    const targetGenerationAtStart = targetGeneration.current;
    refreshingJobRef.current = generation;
    setSelectedJob((previous) => previous === undefined
      ? previous
      : { ...previous, refreshing: true, refreshError: undefined });
    refreshProductionJob(current.job.jobId, requestAccount, requestVessel).then(
      (response) => {
        if (generation !== jobDetailGeneration.current) return;
        if (targetGenerationAtStart !== targetGeneration.current) return;
        refreshingJobRef.current = undefined;
        const next = response.data.job;
        if (!isJobFor(next, requestAccount, requestVessel, current.job.jobId, current.job.authorityId)) {
          setSelectedJob((previous) => previous === undefined
            ? previous
            : { ...previous, refreshing: false, refreshError: 'The job refresh returned unexpected account, vessel, or authority identity.' });
          return;
        }
        setSelectedJob({ key: current.key, job: next });
        setJobs((previous) => ({ ...previous, [current.key]: next }));
      },
      (error: unknown) => {
        if (generation !== jobDetailGeneration.current) return;
        if (targetGenerationAtStart !== targetGeneration.current) return;
        refreshingJobRef.current = undefined;
        setSelectedJob((previous) => previous === undefined
          ? previous
          : { ...previous, refreshing: false, refreshError: errorText(error) });
      }
    );
  };

  const refreshProductionPage = (): void => {
    const requestAccount = accountId;
    const requestVessel = vesselId;
    if (!ready || requestAccount === undefined || requestVessel === undefined || view.refreshing === true) return;
    const key = `${requestAccount}\u0000${requestVessel}`;
    const generation = ++pageGeneration.current;
    setView((previous) => previous.key === key
      ? { ...previous, refreshing: true, refreshError: undefined }
      : { key, loading: true });
    refreshProduction(requestAccount, requestVessel).then(
      (response) => {
        if (generation !== pageGeneration.current) return;
        if (!isProductionFor(response.data, requestAccount, requestVessel)) {
          setView((previous) => previous.key === key
            ? { ...previous, refreshing: false, refreshError: 'The production refresh returned unexpected account or vessel identity.' }
            : previous);
          return;
        }
        setView({ key, response });
      },
      (error: unknown) => {
        if (generation !== pageGeneration.current) return;
        setView((previous) => previous.key === key
          ? { ...previous, refreshing: false, refreshError: errorText(error) }
          : previous);
      }
    );
  };

  const openPicker = (operation: ProductionOperation, input: ProductionOperationInput): void => {
    setPickerError(undefined);
    setPicker({ operationKey: operationKey(operation), fieldName: input.name, fieldLabel: input.label });
  };

  const closePicker = (focusField: boolean): void => {
    setPicker(undefined);
    if (focusField) requestAnimationFrame(() => { varietySelect.current?.focus(); });
  };

  const selectPickerReference = (id: string): void => {
    const current = picker;
    if (current === undefined) return;
    const operation = data?.operations.find((candidate) => operationKey(candidate) === current.operationKey);
    const input = operation?.inputs.find((candidate) => candidate.name === current.fieldName);
    if (input === undefined || !(input.choices?.some((choice) => choice.value === id) ?? false)) {
      setPickerError('The selected reference is not an advertised choice for this operation.');
      return;
    }
    updateValue(current.fieldName, id);
    closePicker(true);
  };

  const refreshLibrarySnapshot = (): void => {
    if (accountId === undefined || library?.refreshing === true) return;
    const generation = ++libraryGeneration.current;
    const accountAtStart = accountId;
    setLibrary((previous) => previous === undefined
      ? { accountId: accountAtStart, loading: true, refreshing: true }
      : { ...previous, refreshing: true, refreshError: undefined });
    refreshLibrary(accountAtStart).then(
      (response) => {
        if (generation !== libraryGeneration.current) return;
        setLibrary({ accountId: accountAtStart, response });
      },
      (error: unknown) => {
        if (generation !== libraryGeneration.current) return;
        setLibrary((previous) => previous === undefined
          ? previous
          : { ...previous, refreshing: false, refreshError: errorText(error) });
      }
    );
  };

  const advertisedChoices = picker === undefined
    ? []
    : data?.operations.find((operation) => operationKey(operation) === picker.operationKey)
      ?.inputs.find((input) => input.name === picker.fieldName)?.choices ?? [];
  const libraryResponse = library !== undefined && library.accountId === accountId ? library.response : undefined;
  const filteredLibrary: LibraryResponse | undefined = libraryResponse === undefined
    ? undefined
    : {
      ...libraryResponse,
      data: {
        ...libraryResponse.data,
        varieties: libraryResponse.data.varieties.filter((entry) => (
          advertisedChoices.some((choice) => choice.value === entry.id)
        ))
      }
    };
  const pickerSource: ReferencePickerSource = {
    kind: 'library',
    ...(filteredLibrary === undefined ? {} : { response: filteredLibrary }),
    ...(library?.loading === true ? { loading: true } : {}),
    ...(library?.failure === undefined ? {} : { error: library.failure })
  };
  const pickerSelection: ReferencePickerSelection | undefined = picker === undefined
    ? undefined
    : { kind: 'variety', fieldLabel: picker.fieldLabel };

  const activeSubmission = submission !== undefined && submission.targetKey === targetKey ? submission : undefined;
  const action = activeSubmission?.action;
  const pageJobs = (data?.jobs ?? []).map((job) => newerJob(jobs[jobKey(job)] ?? job, job));
  const selectedJobObservation = selectedJob === undefined ? undefined : newerJob(
    selectedJob.job,
    pageJobs.find((job) => jobKey(job) === selectedJob.key)
  );

  return (
    <section aria-label="Production" className={styles.production}>
      <h2 className={styles.heading}>Production</h2>

      {accountId === undefined ? (
        <p className={styles.info}>Select an account to use Production.</p>
      ) : context === undefined || vesselId === undefined || vesselId.length === 0 ? (
        <p className={styles.info}>Select a vessel to load Production; no private observations are read without one.</p>
      ) : !contextMatches ? (
        <p className={styles.info}>
          The context account does not match the selected account; no private observations are read for a mismatched context.
        </p>
      ) : (
        <>
          <div className={styles.controls}>
            <Button
              className={styles.button}
              onPress={refreshProductionPage}
              isPending={view.refreshing === true}
              isDisabled={view.refreshing === true}
            >
              Refresh production
            </Button>
          </div>

          {view.loading === true ? <p className={styles.meta}>Loading retained production observations…</p> : null}
          {view.failure === undefined ? null : (
            <p className={styles.error} role="alert">Production could not be read: {view.failure}</p>
          )}
          {view.refreshError === undefined ? null : (
            <p className={styles.error} role="alert">Production refresh failed; the previous observations are retained: {view.refreshError}</p>
          )}

          {data?.authorities.length === 0 ? (
            <p className={styles.meta}>No production authorities are advertised for this vessel.</p>
          ) : null}

          {data === undefined || data.authorities.length === 0 ? null : (
            <section className={styles.section} aria-label="Production authorities">
              <h3 className={styles.subheading}>Authorities</h3>
              <ul className={styles.list}>
                {data.authorities.map((authority) => (
                  <li key={authority.authorityId} className={styles.authority}>
                    <p className={styles.label}>{authority.name ?? authority.authorityId}</p>
                    <p className={styles.meta}>Authority {authority.authorityId}</p>
                    <p className={styles.meta}>Source {authority.source}</p>
                    <p className={styles.meta}>
                      State {stateLabel(authority.state)}
                      {authority.observedAt === undefined ? '' : ` · Observed ${authority.observedAt}`}
                    </p>
                    {authority.error === undefined ? null : (
                      <p className={styles.error} role="alert">{authority.error}</p>
                    )}
                    <div className={styles.controls}>
                      <Button
                        className={styles.button}
                        onPress={() => chooseAuthority(authority.authorityId)}
                        isDisabled={selectedAuthority === authority.authorityId}
                      >
                        {authority.name ?? authority.authorityId}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {requestedAuthorityUnavailable ? (
            <p className={styles.error} role="alert">
              Requested authority {requestedAuthority} is not advertised for this vessel; no fallback authority is substituted.
            </p>
          ) : null}

          {operationError === undefined ? null : (
            <p className={styles.error} role="alert">{operationError}</p>
          )}

          {data === undefined ? null : (
            <section className={styles.section} aria-label="Production operations">
              <h3 className={styles.subheading}>Operations</h3>
              {visibleOperations.length === 0 ? (
                <p className={styles.meta}>
                  {selectedAuthority === undefined
                    ? 'No production operations are advertised.'
                    : `No production operations are advertised for ${selectedAuthority}.`}
                </p>
              ) : (
                <ul className={styles.list}>
                  {visibleOperations.map((operation) => (
                    <li key={operationKey(operation)} className={styles.operation}>
                      <p className={styles.label}>{operation.label}</p>
                      <Fact label="Effect" value={operation.effect} />
                      <Fact label="Authority" value={operation.authorityId} />
                      {operation.outputDestination === undefined ? null : (
                        <p className={styles.destination}>Destination: {operation.outputDestination}</p>
                      )}
                      <p className={styles.meta}>
                        Source {operation.source} · Observed {operation.observedAt} · {operation.available ? 'Available' : 'Unavailable'}
                      </p>
                      {operation.blockers.length === 0 ? null : (
                        <ul className={styles.list}>
                          {operation.blockers.map((blocker, index) => (
                            <li key={`${operation.operationId}\u0000${index}`} className={styles.error}>{blocker}</li>
                          ))}
                        </ul>
                      )}
                      <div className={styles.controls}>
                        <Button
                          className={styles.button}
                          onPress={() => selectOperation(operation)}
                          isDisabled={selectedOperationKey === operationKey(operation)}
                        >
                          {`Select ${operation.label}`}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {selectedOperation === undefined || form === undefined ? null : (
            <section className={styles.form} aria-label="Operation form">
              <h3 className={styles.subheading}>{selectedOperation.label}</h3>
              <Fact label="Effect" value={selectedOperation.effect} />
              <Fact label="Authority" value={selectedOperation.authorityId} />
              {selectedOperation.outputDestination === undefined ? null : (
                <p className={styles.destination}>Destination: {selectedOperation.outputDestination}</p>
              )}
              {selectedOperation.blockers.length === 0 ? null : (
                <ul className={styles.list}>
                  {selectedOperation.blockers.map((blocker, index) => (
                    <li key={`${selectedOperation.operationId}\u0000${index}`} className={styles.error}>{blocker}</li>
                  ))}
                </ul>
              )}
              {selectedOperation.inputs.length === 0 ? (
                <p className={styles.meta}>This operation advertises no inputs.</p>
              ) : (
                selectedOperation.inputs.map((input) => (
                  <div key={input.name} className={styles.field}>
                    <label className={styles.label}>
                      {input.label}
                      {input.type === 'choice' ? (
                        <select
                          className={styles.select}
                          aria-label={input.label}
                          value={form.values[input.name] ?? ''}
                          onChange={(event) => { updateValue(input.name, event.target.value); }}
                          ref={input.name === 'variety' ? varietySelect : undefined}
                          disabled={(input.choices?.length ?? 0) === 0 || (input.name === 'variety' && (input.choices?.length ?? 0) === 1)}
                        >
                          {input.required ? null : <option value="">None</option>}
                          {(input.choices ?? []).map((choice) => (
                            <option key={choice.value} value={choice.value}>{choice.label}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className={styles.input}
                          aria-label={input.label}
                          type="number"
                          min={input.minimum ?? 1}
                          step={1}
                          value={form.values[input.name] ?? ''}
                          onChange={(event) => { updateValue(input.name, event.target.value); }}
                        />
                      )}
                    </label>
                    {(input.choices?.length ?? 0) === 0 && input.type === 'choice' ? (
                      <p className={styles.meta}>No advertised choices are available for {input.label}.</p>
                    ) : null}
                    {input.name === 'variety' && input.type === 'choice' ? (
                      <Button
                        className={styles.button}
                        onPress={() => openPicker(selectedOperation, input)}
                      >
                        {`Choose ${input.label} from Library`}
                      </Button>
                    ) : null}
                  </div>
                ))
              )}

              {validationErrors.length === 0 ? null : (
                <ul className={styles.list}>
                  {validationErrors.map((error) => (
                    <li key={error} className={styles.error} role="alert">{error}</li>
                  ))}
                </ul>
              )}
              {pickerError === undefined ? null : <p className={styles.error} role="alert">{pickerError}</p>}

              <div className={styles.controls}>
                <Button
                  className={styles.button}
                  onPress={submitOperation}
                  isPending={sending}
                  isDisabled={sending || !selectedOperation.available || selectedOperation.blockers.length > 0}
                >
                  {`Execute ${selectedOperation.label}`}
                </Button>
              </div>
            </section>
          )}

          {activeSubmission === undefined ? null : (
            <section className={styles.section} aria-label="Submission">
              <h3 className={styles.subheading}>Submission</h3>
              {sending ? <p className={styles.meta}>Sending the operation submission…</p> : null}
              {activeSubmission.sendError === undefined ? null : (
                <p className={styles.error} role="alert">Submission failed: {activeSubmission.sendError}</p>
              )}
              {action === undefined ? null : (
                <>
                  <p className={styles.label}>Action {action.id}</p>
                  <p className={styles.meta}>Submission status: {action.submission.status}</p>
                  {action.submission.error === undefined ? null : (
                    <p className={styles.error} role="alert">Submission error: {action.submission.error}</p>
                  )}
                  <p className={styles.meta}>Outcome: {outcomeText(action)}</p>
                  {action.outcome.error === undefined ? null : (
                    <p className={styles.error} role="alert">Outcome error: {action.outcome.error}</p>
                  )}
                  {action.outcome.status === 'completed' && action.outcome.evidence.length === 0 ? (
                    <p className={styles.meta}>Completed without evidence: outcome remains unverified.</p>
                  ) : null}
                  {action.resultReferences.length === 0 ? null : (
                    <ul className={styles.list}>
                      {action.resultReferences.map((reference, index) => (
                        <li key={`${reference.kind}\u0000${reference.id}\u0000${index}`} className={styles.meta}>
                          Result {reference.kind}: {reference.id} (authority {action.targetId})
                        </li>
                      ))}
                    </ul>
                  )}
                  <EvidenceList evidence={action.outcome.evidence} />
                  {activeSubmission.refreshError === undefined ? null : (
                    <p className={styles.error} role="alert">
                      Action readback failed; the accepted submission is retained: {activeSubmission.refreshError}
                    </p>
                  )}
                  <div className={styles.controls}>
                    <Button
                      className={styles.button}
                      onPress={refreshSubmission}
                      isPending={actionRefreshing}
                      isDisabled={actionRefreshing}
                    >
                      Refresh action
                    </Button>
                    {onOpenAction === undefined ? null : (
                      <Button className={styles.button} onPress={() => onOpenAction(action.id)}>
                        Open Activity
                      </Button>
                    )}
                    {action.resultReferences
                      .filter((reference) => reference.kind === 'resource')
                      .map((reference, index) => (
                        <Button
                          key={`${reference.id}\u0000${index}`}
                          className={styles.button}
                          onPress={() => openResource({ id: reference.id, authorityId: action.targetId })}
                        >
                          {`Read resource ${reference.id}`}
                        </Button>
                      ))}
                  </div>
                </>
              )}
            </section>
          )}

          {data === undefined ? null : (
            <section className={styles.section} aria-label="Production jobs">
              <h3 className={styles.subheading}>Jobs</h3>
              {pageJobs.length === 0 ? (
                <p className={styles.meta}>No retained production jobs are advertised for this vessel.</p>
              ) : (
                <ul className={styles.list}>
                  {pageJobs.map((job) => {
                    const key = jobKey(job);
                    return (
                      <li key={key} className={styles.item}>
                        <JobSummary job={job} />
                        <div className={styles.controls}>
                          <Button
                            className={styles.button}
                            onPress={() => selectJob(job)}
                            isDisabled={selectedJob?.key === key && selectedJob.loading === true}
                          >
                            {`Select job ${job.jobId}`}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {selectedJob === undefined ? null : (
            <section className={styles.section} aria-label="Selected job">
              <h3 className={styles.subheading}>Selected job</h3>
               <JobSummary job={selectedJobObservation ?? selectedJob.job} />
              {selectedJob.loading === true ? <p className={styles.meta}>Reading the selected job…</p> : null}
              {selectedJob.failure === undefined ? null : (
                <p className={styles.error} role="alert">
                  The selected job could not be read; it is not treated as complete: {selectedJob.failure}
                </p>
              )}
              {selectedJob.refreshError === undefined ? null : (
                <p className={styles.error} role="alert">
                  Job refresh failed; the retained job observation is retained: {selectedJob.refreshError}
                </p>
              )}
              <div className={styles.controls}>
                <Button
                  className={styles.button}
                  onPress={refreshSelectedJob}
                  isPending={selectedJob.refreshing === true}
                  isDisabled={selectedJob.refreshing === true}
                >
                  Refresh selected job
                </Button>
              </div>
            </section>
          )}

          {jobLookup === undefined ? null : (
            <section className={styles.section} aria-label="Requested job">
              <h3 className={styles.subheading}>Requested job</h3>
              {jobLookup.job === undefined ? <p className={styles.label}>Job {jobLookup.jobId}</p> : null}
              {jobLookup.loading === true ? <p className={styles.meta}>Reading the requested job…</p> : null}
              {jobLookup.failure === undefined ? null : (
                <p className={styles.error} role="alert">
                  Job {jobLookup.jobId} is missing, not found, or not retained: {jobLookup.failure}
                </p>
              )}
              {jobLookup.job === undefined ? null : <JobSummary job={jobLookup.job} />}
            </section>
          )}
        </>
      )}

      <ReferencePicker
        {...(accountId === undefined ? {} : { accountId })}
        selection={pickerSelection}
        source={pickerSource}
        refreshing={library?.refreshing === true}
        onRefresh={refreshLibrarySnapshot}
        onSelect={selectPickerReference}
        onClose={() => { closePicker(true); }}
      />

      <ResourceReader
        resource={reader}
        {...(accountId === undefined ? {} : { accountId })}
        onClose={() => { setReader(undefined); }}
      />
    </section>
  );
}
