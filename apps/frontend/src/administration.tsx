import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from 'react-aria-components';
import type {
  ActionRecord,
  AdministrationControlInput,
  AdministrationControlRecord,
  AdministrationData,
  AdministrationRequestRecord,
  AdministrationTargetRecord
} from '@fctp/client-sdk';
import type { ResourceReference } from './resource-reader';
import {
  applyAdministrationControl,
  decideAdministrationEntry,
  readAdministration,
  refreshAdministration
} from './application-api';
import cssStyles from './administration.module.css';

type ClassName = 'administration' | 'heading' | 'status' | 'section' | 'subheading'
  | 'targetHeader' | 'meta' | 'failure' | 'warning' | 'controls' | 'controlForm'
  | 'field' | 'button' | 'rows' | 'row' | 'result' | 'readControls';

const styles = cssStyles as Record<ClassName, string>;

export interface AdministrationProps {
  accountId?: string;
  accountHandle?: string;
  authorityId?: string;
  selectionRevision?: number;
  onOpenAction?: (actionId: string) => void;
  onReadResource?: (reference: ResourceReference) => void;
}

interface DataView {
  accountId?: string;
  loading?: boolean;
  failure?: string;
  data?: AdministrationData;
}

interface SubmissionResult {
  key: string;
  accountId: string;
  authorityId: string;
  label: string;
  action?: ActionRecord;
  error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numberText(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return typeof value === 'string' ? value : '';
}

function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string').join(', ');
  return '';
}

function splitList(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function finiteNumber(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function targetKind(target: AdministrationTargetRecord, rawState: Record<string, unknown>): string | undefined {
  if (target.kind !== undefined) return target.kind;
  return typeof rawState.kind === 'string' ? rawState.kind : undefined;
}

function targetName(target: AdministrationTargetRecord, index: number): string {
  if (target.name !== undefined && target.name.length > 0) return target.name;
  const roles = target.roles.length > 0 ? target.roles.join(', ') : 'unpublished';
  return `${roles} authority ${index + 1}`;
}

function policyOf(rawState: Record<string, unknown>): Record<string, unknown> {
  return record(record(rawState.state).policy);
}

function admissionOf(rawState: Record<string, unknown>): Record<string, unknown> {
  return record(rawState.admission);
}

function facilitiesOf(rawState: Record<string, unknown>): Record<string, unknown> {
  return record(record(rawState.simulation).config);
}

function fleetOf(rawState: Record<string, unknown>): Record<string, unknown> {
  return record(rawState.fleet);
}

function accountsOf(rawState: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(rawState.accounts)) return [];
  return rawState.accounts.filter(isRecord);
}

function initialAdmissionValues(
  control: AdministrationControlRecord,
  observed: Record<string, unknown>
): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const input of control.inputs) {
    const raw = observed[input.name];
    if (input.type === 'boolean') values[input.name] = raw === true;
    else if (input.type === 'json') values[input.name] = raw === undefined ? '' : JSON.stringify(raw, null, 2);
    else if (input.type === 'choice') values[input.name] = typeof raw === 'string' ? raw : (input.choices?.[0] ?? '');
    else if (input.type === 'number') values[input.name] = numberText(raw);
    else values[input.name] = textValue(raw);
  }
  return values;
}

interface SendInputs {
  control: string;
  inputs: Record<string, unknown>;
}

interface AdmissionFormProps {
  control: AdministrationControlRecord;
  observed: Record<string, unknown>;
  onSend: (input: SendInputs) => Promise<void>;
}

function AdmissionForm({ control, observed, onSend }: AdmissionFormProps): ReactElement {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => initialAdmissionValues(control, observed));
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);

  const update = (name: string, value: string | boolean): void => {
    setValues((current) => ({ ...current, [name]: value }));
  };

  const submit = async (): Promise<void> => {
    if (lock.current) return;
    const inputs: Record<string, unknown> = {};
    for (const input of control.inputs) {
      const value = values[input.name] ?? '';
      if (input.type === 'boolean') {
        inputs[input.name] = value === true;
      } else if (input.type === 'number') {
        const parsed = finiteNumber(String(value));
        if (parsed === undefined) {
          setFailure(`${input.label} must be a finite number.`);
          return;
        }
        inputs[input.name] = parsed;
      } else if (input.type === 'json') {
        try {
          inputs[input.name] = JSON.parse(String(value)) as unknown;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          setFailure(`${input.label} must be valid JSON.`);
          return;
        }
      } else if (input.type === 'choice') {
        inputs[input.name] = String(value);
      } else if (/comma separated/i.test(input.label) || Array.isArray(observed[input.name])) {
        inputs[input.name] = splitList(String(value));
      } else {
        inputs[input.name] = String(value);
      }
    }
    setFailure(undefined);
    lock.current = true;
    setPending(true);
    try {
      await onSend({ control: control.name, inputs });
    } finally {
      lock.current = false;
      setPending(false);
    }
  };

  return (
    <div className={styles.controlForm} role="group" aria-label={control.label}>
      <h4 className={styles.subheading}>{control.label}</h4>
      {control.inputs.map((input) => (
        <Field
          key={input.name}
          input={input}
          value={values[input.name] ?? ''}
          onChange={(value) => update(input.name, value)}
        />
      ))}
      {failure === undefined ? null : <p className={styles.failure} role="alert">{failure}</p>}
      <Button className={styles.button} onPress={() => { void submit(); }} isPending={pending}>
        {`Apply ${control.name}`}
      </Button>
    </div>
  );
}

interface FieldProps {
  input: AdministrationControlInput;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
}

function Field({ input, value, onChange }: FieldProps): ReactElement {
  if (input.type === 'boolean') {
    return (
      <label className={styles.field}>
        <input
          type="checkbox"
          aria-label={input.label}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        {input.label}
      </label>
    );
  }
  if (input.type === 'choice') {
    return (
      <label className={styles.field}>
        {input.label}
        <select
          aria-label={input.label}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {(input.choices ?? []).map((choice) => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      </label>
    );
  }
  if (input.type === 'json') {
    return (
      <label className={styles.field}>
        {input.label}
        <textarea
          aria-label={input.label}
          rows={4}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }
  return (
    <label className={styles.field}>
      {input.label}
      <input
        type={input.type === 'number' ? 'number' : 'text'}
        aria-label={input.label}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

const POLICY_CORE = new Set(['miningPermitted', 'miningQuota', 'oreReserve', 'manufacturePermits']);

function policyExtensions(policy: Record<string, unknown>): Record<string, unknown> {
  const extensions: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(policy)) {
    if (!POLICY_CORE.has(name)) extensions[name] = value;
  }
  return extensions;
}

interface PolicyFormProps {
  observed: Record<string, unknown>;
  onSend: (input: SendInputs) => Promise<void>;
}

function PolicyForm({ observed, onSend }: PolicyFormProps): ReactElement {
  const [permitted, setPermitted] = useState(observed.miningPermitted === true);
  const [quota, setQuota] = useState(numberText(observed.miningQuota));
  const [reserve, setReserve] = useState(numberText(observed.oreReserve));
  const [permits, setPermits] = useState(textValue(observed.manufacturePermits));
  const [advanced, setAdvanced] = useState(() => JSON.stringify(policyExtensions(observed), null, 2));
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);

  const submit = async (): Promise<void> => {
    if (lock.current) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(advanced) as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      setFailure('The advanced policy JSON is invalid.');
      return;
    }
    if (!isRecord(parsed)) {
      setFailure('The advanced policy JSON must be an object.');
      return;
    }
    const miningQuota = finiteNumber(quota);
    if (miningQuota === undefined) {
      setFailure('Mining quota must be a finite number.');
      return;
    }
    const oreReserve = finiteNumber(reserve);
    if (oreReserve === undefined) {
      setFailure('Ore reserve must be a finite number.');
      return;
    }
    const inputs: Record<string, unknown> = {
      ...parsed,
      miningPermitted: permitted,
      miningQuota,
      oreReserve,
      manufacturePermits: splitList(permits)
    };
    setFailure(undefined);
    lock.current = true;
    setPending(true);
    try {
      await onSend({ control: 'policy', inputs });
    } finally {
      lock.current = false;
      setPending(false);
    }
  };

  return (
    <div className={styles.controlForm} role="group" aria-label="Policy">
      <h4 className={styles.subheading}>Policy</h4>
      <label className={styles.field}>
        <input
          type="checkbox"
          aria-label="Mining permitted"
          checked={permitted}
          onChange={(event) => setPermitted(event.target.checked)}
        />
        Mining permitted
      </label>
      <label className={styles.field}>
        Mining quota
        <input
          type="number"
          aria-label="Mining quota"
          value={quota}
          onChange={(event) => setQuota(event.target.value)}
        />
      </label>
      <label className={styles.field}>
        Ore reserve
        <input
          type="number"
          aria-label="Ore reserve"
          value={reserve}
          onChange={(event) => setReserve(event.target.value)}
        />
      </label>
      <label className={styles.field}>
        Manufacture permits
        <input
          type="text"
          aria-label="Manufacture permits"
          value={permits}
          onChange={(event) => setPermits(event.target.value)}
        />
      </label>
      <label className={styles.field}>
        Advanced policy JSON
        <textarea
          aria-label="Advanced policy JSON"
          rows={6}
          value={advanced}
          onChange={(event) => setAdvanced(event.target.value)}
        />
      </label>
      {failure === undefined ? null : <p className={styles.failure} role="alert">{failure}</p>}
      <Button className={styles.button} onPress={() => { void submit(); }} isPending={pending}>
        Apply policy
      </Button>
    </div>
  );
}

function initialFacilitiesValues(
  control: AdministrationControlRecord,
  observed: Record<string, unknown>
): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  for (const input of control.inputs) {
    if (input.type === 'boolean') values[input.name] = observed[input.name] !== false;
    else values[input.name] = numberText(observed[input.name]);
  }
  return values;
}

interface FacilitiesFormProps {
  control: AdministrationControlRecord;
  observed: Record<string, unknown>;
  onSend: (input: SendInputs) => Promise<void>;
}

function FacilitiesForm({ control, observed, onSend }: FacilitiesFormProps): ReactElement {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => initialFacilitiesValues(control, observed));
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);

  const update = (name: string, value: string | boolean): void => {
    setValues((current) => ({ ...current, [name]: value }));
  };

  const submit = async (): Promise<void> => {
    if (lock.current) return;
    const miningCapacity = finiteNumber(String(values.miningCapacity ?? ''));
    const manufacturingSlots = finiteNumber(String(values.manufacturingSlots ?? ''));
    const manufacturingTime = finiteNumber(String(values.manufacturingTime ?? ''));
    const portCapacity = finiteNumber(String(values.portCapacity ?? ''));
    const berthCapacity = finiteNumber(String(values.berthCapacity ?? ''));
    if (miningCapacity === undefined || manufacturingSlots === undefined || manufacturingTime === undefined
      || portCapacity === undefined || berthCapacity === undefined) {
      setFailure('Facility capacities must be finite numbers.');
      return;
    }
    const inputs: Record<string, unknown> = {
      mining: { enabled: values.miningEnabled === true, capacity: miningCapacity },
      manufacturing: { slots: manufacturingSlots, time: manufacturingTime },
      port: { capacity: portCapacity, berths: berthCapacity }
    };
    setFailure(undefined);
    lock.current = true;
    setPending(true);
    try {
      await onSend({ control: 'facilities', inputs });
    } finally {
      lock.current = false;
      setPending(false);
    }
  };

  return (
    <div className={styles.controlForm} role="group" aria-label="Facilities">
      <h4 className={styles.subheading}>Facilities</h4>
      {control.inputs.map((input) => (
        <Field
          key={input.name}
          input={input}
          value={values[input.name] ?? (input.type === 'boolean' ? false : '')}
          onChange={(value) => update(input.name, value)}
        />
      ))}
      {failure === undefined ? null : <p className={styles.failure} role="alert">{failure}</p>}
      <Button className={styles.button} onPress={() => { void submit(); }} isPending={pending}>
        Apply facilities
      </Button>
    </div>
  );
}

interface TickFormProps {
  onSend: (input: SendInputs) => Promise<void>;
}

function TickForm({ onSend }: TickFormProps): ReactElement {
  const [pending, setPending] = useState(false);
  const lock = useRef(false);

  const submit = async (): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    try {
      await onSend({ control: 'tick', inputs: {} });
    } finally {
      lock.current = false;
      setPending(false);
    }
  };

  return (
    <div className={styles.controlForm} role="group" aria-label="Simulation tick">
      <Button className={styles.button} onPress={() => { void submit(); }} isPending={pending}>
        Advance tick
      </Button>
    </div>
  );
}

interface FleetEntry {
  id: string;
  name: string;
  adoption: boolean;
}

function fleetEntries(fleet: Record<string, unknown>): FleetEntry[] {
  return Object.entries(fleet).map(([id, entry]) => {
    const item = record(entry);
    const vessel = record(item.vessel);
    return {
      id,
      name: typeof vessel.name === 'string' ? vessel.name : (typeof vessel.id === 'string' ? vessel.id : id),
      adoption: item.adoption !== false
    };
  });
}

interface AdoptionFormProps {
  observed: Record<string, unknown>;
  onSend: (input: SendInputs) => Promise<void>;
}

function AdoptionForm({ observed, onSend }: AdoptionFormProps): ReactElement {
  const entries = fleetEntries(fleetOf(observed));
  const [vesselId, setVesselId] = useState(entries[0]?.id ?? '');
  const initial = entries.find((entry) => entry.id === vesselId);
  const [adoption, setAdoption] = useState(initial?.adoption ?? true);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const lock = useRef(false);

  const selectVessel = (id: string): void => {
    setVesselId(id);
    const next = entries.find((entry) => entry.id === id);
    setAdoption(next?.adoption ?? true);
  };

  const submit = async (): Promise<void> => {
    if (lock.current) return;
    if (vesselId.trim() === '') {
      setFailure('Select an observed fleet vessel first.');
      return;
    }
    setFailure(undefined);
    lock.current = true;
    setPending(true);
    try {
      await onSend({ control: 'adoption', inputs: { vesselId, adoption } });
    } finally {
      lock.current = false;
      setPending(false);
    }
  };

  if (entries.length === 0) {
    return <p className={styles.status}>No fleet vessels are observed for this target.</p>;
  }

  return (
    <div className={styles.controlForm} role="group" aria-label="Registry fleet">
      <h4 className={styles.subheading}>Adoption</h4>
      <label className={styles.field}>
        Fleet vessel
        <select aria-label="Fleet vessel" value={vesselId} onChange={(event) => selectVessel(event.target.value)}>
          {entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </label>
      <label className={styles.field}>
        Adoption
        <select
          aria-label="Adoption"
          value={adoption ? 'true' : 'false'}
          onChange={(event) => setAdoption(event.target.value === 'true')}
        >
          <option value="true">Enable adoption</option>
          <option value="false">Disable adoption</option>
        </select>
      </label>
      {failure === undefined ? null : <p className={styles.failure} role="alert">{failure}</p>}
      <Button className={styles.button} onPress={() => { void submit(); }} isPending={pending}>
        Apply adoption
      </Button>
    </div>
  );
}

interface HomeAccount {
  handle: string;
  actorId?: string;
  available: boolean;
}

function homeAccounts(observed: Record<string, unknown>): HomeAccount[] {
  const accounts: HomeAccount[] = [];
  for (const entry of accountsOf(observed)) {
    if (typeof entry.handle !== 'string' || entry.handle.length === 0) continue;
    accounts.push({
      handle: entry.handle,
      ...(typeof entry.actorId === 'string' ? { actorId: entry.actorId } : {}),
      available: entry.available !== false
    });
  }
  return accounts;
}

interface HomeRowProps {
  account: HomeAccount;
  own: boolean;
  onSend: (input: SendInputs) => Promise<void>;
}

function HomeRow({ account, own, onSend }: HomeRowProps): ReactElement {
  const [available, setAvailable] = useState(account.available);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const lock = useRef(false);

  const submit = async (): Promise<void> => {
    if (lock.current) return;
    if (own) {
      setFailure('Your own account cannot be disabled from Administration.');
      return;
    }
    setFailure(undefined);
    lock.current = true;
    setPending(true);
    try {
      await onSend({ control: 'availability', inputs: { handle: account.handle, available } });
    } finally {
      lock.current = false;
      setPending(false);
    }
  };

  return (
    <li className={styles.row}>
      <p className={styles.targetHeader}>
        {account.handle}
        {own ? <span className={styles.warning}> · Your account</span> : null}
      </p>
      {account.actorId === undefined ? null : <p className={styles.meta}>Actor: {account.actorId}</p>}
      <label className={styles.field}>
        <input
          type="checkbox"
          aria-label={`Available for ${account.handle}`}
          checked={available}
          disabled={own}
          onChange={(event) => setAvailable(event.target.checked)}
        />
        {`Available for ${account.handle}`}
      </label>
      {failure === undefined ? null : <p className={styles.failure} role="alert">{failure}</p>}
      <Button className={styles.button} onPress={() => { void submit(); }} isPending={pending}>
        {`Apply availability for ${account.handle}`}
      </Button>
    </li>
  );
}

interface AvailabilityListProps {
  observed: Record<string, unknown>;
  accountHandle?: string;
  onSend: (input: SendInputs) => Promise<void>;
}

function AvailabilityList({ observed, accountHandle, onSend }: AvailabilityListProps): ReactElement {
  const accounts = homeAccounts(observed);
  if (accounts.length === 0) {
    return <p className={styles.status}>No Home accounts are observed for this target.</p>;
  }
  return (
    <div className={styles.controlForm} role="group" aria-label="Account availability">
      <h4 className={styles.subheading}>Account availability</h4>
      <ul className={styles.rows}>
        {accounts.map((account) => (
          <HomeRow
            key={account.handle}
            account={account}
            own={accountHandle !== undefined && account.handle === accountHandle}
            onSend={onSend}
          />
        ))}
      </ul>
    </div>
  );
}

function requestPart(original: Record<string, unknown>, section: string, key: string): string | undefined {
  const value = record(original[section])[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

interface EntryRequestCardProps {
  request: AdministrationRequestRecord;
  onReadResource?: (reference: ResourceReference) => void;
  onDecide: (request: AdministrationRequestRecord, decision: 'approve' | 'reject', reason?: string) => Promise<boolean>;
}

function EntryRequestCard({ request, onReadResource, onDecide }: EntryRequestCardProps): ReactElement {
  const original = record(request.request);
  const vessel = record(original.vessel);
  const vesselId = typeof vessel.id === 'string' ? vessel.id : undefined;
  const registryId = typeof vessel.registry === 'string' ? vessel.registry : undefined;
  const routeId = typeof original.route === 'string' ? original.route : undefined;
  const portId = requestPart(original, 'destination', 'port');
  const [reason, setReason] = useState('');
  const [decided, setDecided] = useState(false);
  const [pendingDecision, setPendingDecision] = useState<'approve' | 'reject' | undefined>(undefined);
  const lock = useRef(false);

  const terminal = request.status !== 'pending' || request.decision !== undefined || request.event !== undefined;
  const canDecide = !terminal && !decided;

  const decide = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setPendingDecision(decision);
    try {
      const accepted = await onDecide(request, decision, reason.trim() === '' ? undefined : reason.trim());
      if (accepted) setDecided(true);
    } finally {
      lock.current = false;
      setPendingDecision(undefined);
    }
  };

  const readButton = (label: string, id: string | undefined): ReactElement | null => {
    if (id === undefined || onReadResource === undefined) return null;
    return (
      <Button className={styles.button} onPress={() => onReadResource({ id })}>
        {label}
      </Button>
    );
  };

  return (
    <article className={styles.row}>
      <p className={styles.targetHeader}>{`Entry request · ${request.status}`}</p>
      {vesselId === undefined ? null : <p className={styles.meta}>Vessel: {vesselId}</p>}
      {registryId === undefined ? null : <p className={styles.meta}>Registry: {registryId}</p>}
      {routeId === undefined ? null : <p className={styles.meta}>Route: {routeId}</p>}
      {portId === undefined ? null : <p className={styles.meta}>Port: {portId}</p>}
      {request.receivedAt === undefined ? null : <p className={styles.meta}>Received: {request.receivedAt}</p>}
      {request.decision === undefined ? null : (
        <p className={styles.meta}>
          {`Decision: ${request.decision.accepted === true ? 'accepted' : 'rejected'}`}
          {typeof request.decision.reason === 'string' ? `: ${request.decision.reason}` : ''}
        </p>
      )}
      {request.event === undefined ? null : (
        <p className={styles.meta}>{`Event: ${typeof request.event.type === 'string' ? request.event.type : 'recorded'}`}</p>
      )}

      <div className={styles.readControls}>
        {readButton('Read vessel', vesselId)}
        {readButton('Read registry', registryId)}
        {readButton('Read route', routeId)}
        {readButton('Read port', portId)}
      </div>

      {canDecide ? (
        <>
          <label className={styles.field}>
            Reason
            <input
              type="text"
              aria-label="Reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className={styles.controls}>
            <Button
              className={styles.button}
              onPress={() => { void decide('approve'); }}
              isPending={pendingDecision === 'approve'}
            >
              Approve
            </Button>
            <Button
              className={styles.button}
              onPress={() => { void decide('reject'); }}
              isPending={pendingDecision === 'reject'}
            >
              Reject
            </Button>
          </div>
        </>
      ) : (
        <p className={styles.meta}>
          {terminal ? 'This decision is retained and cannot be replayed.' : 'Decision submitted; awaiting verified outcome evidence.'}
        </p>
      )}
    </article>
  );
}

interface EntryRequestsProps {
  requests: AdministrationRequestRecord[];
  onReadResource?: (reference: ResourceReference) => void;
  onDecide: (request: AdministrationRequestRecord, decision: 'approve' | 'reject', reason?: string) => Promise<boolean>;
}

function EntryRequests({ requests, onReadResource, onDecide }: EntryRequestsProps): ReactElement {
  if (requests.length === 0) {
    return <p className={styles.status}>No entry requests are retained for this target.</p>;
  }
  return (
    <section className={styles.section} aria-label="Entry requests">
      <h3 className={styles.subheading}>Entry requests</h3>
      {requests.map((request, index) => (
        <EntryRequestCard
          key={`${request.requestId}\u0000${index}`}
          request={request}
          {...(onReadResource === undefined ? {} : { onReadResource })}
          onDecide={onDecide}
        />
      ))}
    </section>
  );
}

function ResultView({ result, onOpenAction }: {
  result: SubmissionResult;
  onOpenAction?: (actionId: string) => void;
}): ReactElement {
  const action = result.action;
  return (
    <section className={styles.result} aria-label="Submission result">
      <h3 className={styles.subheading}>Submission result</h3>
      <p className={styles.meta}>{result.label}</p>
      {result.error === undefined ? null : <p className={styles.failure} role="alert">Submission error: {result.error}</p>}
      {action === undefined ? null : (
        <>
          <p className={styles.meta}>Submission: {action.submission.status}</p>
          <p className={styles.meta}>Outcome: {action.outcome.status}</p>
          {action.submission.error === undefined ? null : (
            <p className={styles.failure}>Submission error: {action.submission.error}</p>
          )}
          {action.outcome.error === undefined ? null : (
            <p className={styles.failure}>Outcome error: {action.outcome.error}</p>
          )}
          {action.intent.kind === 'administration-entry-request' ? (
            <p className={styles.meta}>Approval is not a berthing event; only the responsible Territory's event can establish berthing.</p>
          ) : null}
          <details>
            <summary>Submitted inputs</summary>
            <pre className={styles.meta}>{JSON.stringify(action.intent.inputs, null, 2)}</pre>
          </details>
          {action.resultReferences.length === 0 ? null : (
            <p className={styles.meta}>
              References: {action.resultReferences.map((reference) => `${reference.kind}: ${reference.id}`).join(', ')}
            </p>
          )}
          {onOpenAction === undefined ? null : (
            <Button className={styles.button} onPress={() => onOpenAction(action.id)}>
              Open Activity
            </Button>
          )}
        </>
      )}
    </section>
  );
}

export function Administration(props: AdministrationProps): ReactElement {
  const { accountId, accountHandle, authorityId, selectionRevision, onOpenAction, onReadResource } = props;
  const [viewState, setViewState] = useState<DataView>({});
  const [selectedAuthority, setSelectedAuthority] = useState<string | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  const [results, setResults] = useState<SubmissionResult[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | undefined>(undefined);

  const accountRef = useRef(accountId);
  accountRef.current = accountId;
  const requestedAuthority = useRef(authorityId);
  requestedAuthority.current = authorityId;
  const authorityRef = useRef<string | undefined>(selectedAuthority);
  authorityRef.current = selectedAuthority;
  const readGeneration = useRef(0);
  const refreshGeneration = useRef(0);
  const refreshLock = useRef(false);
  const resultSequence = useRef(0);

  useEffect(() => {
    const generation = ++readGeneration.current;
    refreshGeneration.current += 1;
    refreshLock.current = false;
    authorityRef.current = requestedAuthority.current;
    setSelectedAuthority(requestedAuthority.current);
    setResults([]);
    setRevision(0);
    setRefreshing(false);
    setRefreshError(undefined);
    if (accountId === undefined) {
      setViewState({});
      return;
    }
    setViewState({ accountId, loading: true });
    readAdministration(accountId).then(
      (response) => {
        if (readGeneration.current !== generation) return;
        const data = response.data;
        if (!isRecord(data) || !Array.isArray(data.targets)) {
          setViewState({ accountId, failure: 'The retained administration response was malformed.' });
          return;
        }
        const preferred = authorityRef.current;
        const selected = preferred ?? data.targets[0]?.authorityId;
        authorityRef.current = selected;
        setSelectedAuthority(selected);
        setViewState({ accountId, data });
      },
      (error: unknown) => {
        if (readGeneration.current !== generation) return;
        setViewState({ accountId, failure: errorText(error) });
      }
    );
    return () => {
      if (readGeneration.current === generation) readGeneration.current += 1;
    };
  }, [accountId]);

  useEffect(() => {
    if (authorityId === undefined) return;
    refreshGeneration.current += 1;
    refreshLock.current = false;
    authorityRef.current = authorityId;
    setSelectedAuthority(authorityId);
    setRefreshing(false);
    setRefreshError(undefined);
  }, [authorityId, selectionRevision]);

  useEffect(() => () => {
    readGeneration.current += 1;
    refreshGeneration.current += 1;
  }, []);

  const addResult = (
    account: string,
    authority: string,
    label: string,
    action?: ActionRecord,
    failure?: string
  ): void => {
    resultSequence.current += 1;
    const key = `${account}\u0000${authority}\u0000${resultSequence.current}`;
    setResults((current) => [...current, {
      key,
      accountId: account,
      authorityId: authority,
      label,
      ...(action === undefined ? {} : { action }),
      ...(failure === undefined ? {} : { error: failure })
    }]);
  };

  const sendControl = async (input: SendInputs): Promise<void> => {
    const account = accountRef.current;
    const authority = authorityRef.current;
    if (account === undefined || authority === undefined) return;
    const generation = readGeneration.current;
    try {
      const response = await applyAdministrationControl(account, authority, input.control, input.inputs);
      if (accountRef.current !== account || readGeneration.current !== generation) return;
      addResult(account, authority, `${input.control} control`, response.action);
    } catch (error) {
      if (accountRef.current !== account || readGeneration.current !== generation) return;
      addResult(account, authority, `${input.control} control`, undefined, errorText(error));
    }
  };

  const decide = async (
    request: AdministrationRequestRecord,
    decision: 'approve' | 'reject',
    reason?: string
  ): Promise<boolean> => {
    const account = accountRef.current;
    const authority = request.authorityId ?? authorityRef.current;
    if (account === undefined || authority === undefined) return false;
    const generation = readGeneration.current;
    try {
      const response = await decideAdministrationEntry(account, authority, request.requestId, decision, reason);
      if (accountRef.current !== account || readGeneration.current !== generation) return false;
      addResult(account, authority, `${decision} entry request ${request.requestId}`, response.action);
      return true;
    } catch (error) {
      if (accountRef.current !== account || readGeneration.current !== generation) return false;
      addResult(account, authority, `${decision} entry request ${request.requestId}`, undefined, errorText(error));
      return false;
    }
  };

  const refresh = (): void => {
    const account = accountRef.current;
    const authority = authorityRef.current;
    if (account === undefined || authority === undefined || refreshLock.current) return;
    refreshLock.current = true;
    const generation = ++refreshGeneration.current;
    setRefreshing(true);
    setRefreshError(undefined);
    refreshAdministration(account, authority).then(
      (response) => {
        if (accountRef.current !== account || refreshGeneration.current !== generation
          || authorityRef.current !== authority) return;
        const data = response.data;
        if (!isRecord(data) || !Array.isArray(data.targets)) {
          setRefreshing(false);
          setRefreshError('The refreshed administration response was malformed.');
          return;
        }
        setRefreshing(false);
        setRevision((current) => current + 1);
        setViewState({ accountId: account, data });
        if (!data.targets.some((target) => target.authorityId === authority)) {
          const next = data.targets[0]?.authorityId;
          authorityRef.current = next;
          setSelectedAuthority(next);
        }
      },
      (error: unknown) => {
        if (accountRef.current !== account || refreshGeneration.current !== generation
          || authorityRef.current !== authority) return;
        setRefreshing(false);
        setRefreshError(errorText(error));
      }
    ).finally(() => {
      if (refreshGeneration.current === generation) refreshLock.current = false;
    });
  };

  const selectTarget = (value: string): void => {
    refreshGeneration.current += 1;
    refreshLock.current = false;
    authorityRef.current = value;
    setSelectedAuthority(value);
    setRefreshing(false);
    setRefreshError(undefined);
  };

  const activeView = accountId !== undefined && viewState.accountId === accountId ? viewState : undefined;
  const data = activeView?.data;
  const loading = accountId !== undefined && (activeView === undefined || activeView.loading === true);
  const failure = activeView?.failure;

  const targets = data?.targets ?? [];
  const selectedTarget = targets.find((target) => target.authorityId === selectedAuthority);
  const rawState = selectedTarget === undefined ? {} : record(data?.states[selectedTarget.authorityId]);
  const kind = selectedTarget === undefined ? undefined : targetKind(selectedTarget, rawState);
  const observed = selectedTarget !== undefined
    && Object.keys(rawState).length > 0
    && (selectedTarget.state === 'available' || selectedTarget.state === 'stale' || selectedTarget.state === 'empty');
  const controls = selectedTarget === undefined
    ? []
    : (data?.controls ?? []).filter((control) => control.authorityId === selectedTarget.authorityId);
  const requests = selectedTarget === undefined
    ? []
    : (data?.requests ?? []).filter((request) => request.authorityId === selectedTarget.authorityId);

  const visibleResults = results.filter((result) =>
    result.accountId === accountId && result.authorityId === selectedAuthority
  );

  return (
    <section aria-label="Administration" className={styles.administration}>
      <h2 className={styles.heading}>Administration</h2>

      {accountId === undefined ? (
        <p className={styles.status}>Select an account to view Administration. Sign in to an account to continue.</p>
      ) : (
        <>
          {loading ? <p className={styles.status}>Reading retained administration…</p> : null}
          {failure === undefined ? null : (
            <p className={styles.failure} role="alert">Administration unavailable: {failure}</p>
          )}

          {data === undefined ? null : (
            <div className={styles.section}>
              <label className={styles.field}>
                Administration target
                <select
                  aria-label="Administration target"
                  value={selectedAuthority ?? ''}
                  disabled={targets.length === 0}
                  onChange={(event) => selectTarget(event.target.value)}
                >
                  {targets.length === 0
                    ? <option value="">No targets</option>
                    : targets.map((target, index) => (
                      <option key={target.authorityId} value={target.authorityId}>{targetName(target, index)} · {target.server} · {target.authorityId}</option>
                    ))}
                </select>
              </label>
              <div className={styles.controls}>
                <Button
                  className={styles.button}
                  onPress={refresh}
                  isPending={refreshing}
                  isDisabled={selectedTarget === undefined}
                >
                  Refresh administration
                </Button>
              </div>
              {refreshError === undefined ? null : (
                <p className={styles.failure} role="alert">
                  Refresh failed: {refreshError}. The last observed values are retained and may be stale.
                </p>
              )}

              {selectedTarget === undefined ? (
                <p className={styles.status}>No administration targets are available for this account.</p>
              ) : (
                <>
                  <header className={styles.targetHeader}>
                    <h3 className={styles.subheading}>
                      {targetName(selectedTarget, targets.findIndex((target) => target.authorityId === selectedTarget.authorityId))}
                    </h3>
                  </header>
                  <p className={styles.meta}>Actor: {selectedTarget.authorityId}</p>
                  <p className={styles.meta}>Server: {selectedTarget.server}</p>
                  <p className={styles.meta}>Roles: {selectedTarget.roles.length === 0 ? 'none' : selectedTarget.roles.join(', ')}</p>
                  {kind === undefined ? null : <p className={styles.meta}>Kind: {kind}</p>}
                  <p className={styles.meta}>State: {selectedTarget.state}</p>
                  {selectedTarget.observedAt === undefined ? null : (
                    <p className={styles.meta}>Observed: {selectedTarget.observedAt}</p>
                  )}
                  {selectedTarget.source === undefined ? null : (
                    <p className={styles.meta}>Source: {selectedTarget.source}</p>
                  )}
                  {selectedTarget.error === undefined ? null : (
                    <p className={styles.failure} role="alert">Observation error: {selectedTarget.error}</p>
                  )}
                  {selectedTarget.state === 'stale' ? (
                    <p className={styles.warning}>These observed values are stale; refresh to request newer state.</p>
                  ) : null}
                  {selectedTarget.state === 'not-retrieved' ? (
                    <p className={styles.warning}>This target has not been retrieved; refresh to observe it.</p>
                  ) : null}
                  {selectedTarget.state === 'unavailable' ? (
                    <p className={styles.warning}>This target is unavailable; refresh may restore observation.</p>
                  ) : null}
                  {selectedTarget.state === 'empty' ? (
                    <p className={styles.warning}>This target reported an empty state.</p>
                  ) : null}

                  {observed ? (
                    <div className={styles.controls} key={`controls\u0000${accountId}\u0000${selectedTarget.authorityId}`}>
                      <details>
                        <summary>Observed settings</summary>
                        <pre className={styles.meta}>{JSON.stringify(rawState, null, 2)}</pre>
                      </details>
                      {controls.map((control) => {
                        const key = `${control.name}\u0000${revision}`;
                        if (control.name === 'policy') {
                          return <PolicyForm key={key} observed={policyOf(rawState)} onSend={sendControl} />;
                        }
                        if (control.name === 'admission') {
                          return (
                            <AdmissionForm
                              key={key}
                              control={control}
                              observed={admissionOf(rawState)}
                              onSend={sendControl}
                            />
                          );
                        }
                        if (control.name === 'facilities') {
                          return (
                            <FacilitiesForm
                              key={key}
                              control={control}
                              observed={facilitiesOf(rawState)}
                              onSend={sendControl}
                            />
                          );
                        }
                        if (control.name === 'tick') {
                          return <TickForm key={key} onSend={sendControl} />;
                        }
                        if (control.name === 'adoption') {
                          return <AdoptionForm key={key} observed={rawState} onSend={sendControl} />;
                        }
                        if (control.name === 'availability') {
                          return (
                            <AvailabilityList
                              key={key}
                              observed={rawState}
                              {...(accountHandle === undefined ? {} : { accountHandle })}
                              onSend={sendControl}
                            />
                          );
                        }
                        return <p key={key} className={styles.status}>Unsupported control: {control.name}</p>;
                      })}
                    </div>
                  ) : null}

                  <EntryRequests
                    key={`${accountId}\u0000${selectedTarget.authorityId}`}
                    requests={requests}
                    {...(onReadResource === undefined ? {} : { onReadResource })}
                    onDecide={decide}
                  />

                  {visibleResults.map((result) => (
                    <ResultView
                      key={result.key}
                      result={result}
                      {...(onOpenAction === undefined ? {} : { onOpenAction })}
                    />
                  ))}
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
