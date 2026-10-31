import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button, Input, Label, TextField } from 'react-aria-components';
import { actionIsComplete } from '@fctp/client-sdk';
import type {
  ActionRecord,
  ExploreConnectionRecord,
  JourneyStep,
  LogisticsRegistryObservation,
  LogisticsTerritoryObservation,
  LogisticsVesselCandidate,
  PublicAccountRecord,
  RoutePlanRecord
} from '@fctp/client-sdk';
import type { VesselWorkflowContext } from './workflow-context';
import type { ResourceReference } from './resource-reader';
import {
  readExplorePlaces,
  readLogisticsVessel,
  readLogisticsVesselCandidates,
  readRoutePlan,
  refreshAction,
  refreshLogisticsVessel,
  refreshLogisticsVesselCandidates,
  submitLogisticsAdoption,
  submitLogisticsDeparture,
  submitLogisticsEntry,
  submitLogisticsTraverse,
  type ExplorePlacesResponse,
  type LogisticsVesselCandidatesResponse,
  type LogisticsVesselResponse
} from './application-api';
import cssStyles from './vessel-travel.module.css';

type ClassName = 'travel' | 'heading' | 'section' | 'subheading' | 'controls' | 'button'
  | 'status' | 'failure' | 'list' | 'item' | 'name' | 'meta' | 'source' | 'details'
  | 'technical' | 'field' | 'label' | 'input' | 'select' | 'checkbox' | 'group' | 'leg';

const styles = cssStyles as Record<ClassName, string>;

export interface VesselTravelProps {
  account?: PublicAccountRecord;
  context?: VesselWorkflowContext;
  selectionRevision?: number;
  onContextChange?: (context: VesselWorkflowContext) => void;
  onOpenExplore?: (context: VesselWorkflowContext) => void;
  onOpenAction?: (actionId: string) => void;
  onReadResource?: (reference: ResourceReference) => void;
}

interface CandidateView {
  accountId?: string;
  loading?: boolean;
  failure?: string;
  response?: LogisticsVesselCandidatesResponse;
  refreshing?: boolean;
  refreshError?: string;
}

interface VesselView {
  key?: string;
  loading?: boolean;
  failure?: string;
  response?: LogisticsVesselResponse;
  refreshing?: boolean;
  refreshError?: string;
}

interface PlanView {
  key?: string;
  loading?: boolean;
  failure?: string;
  plan?: RoutePlanRecord;
}

interface BrowseView {
  accountId?: string;
  vesselId?: string;
  loading?: boolean;
  failure?: string;
  response?: ExplorePlacesResponse;
}

interface ActionView {
  scopeKey?: string;
  key?: string;
  action?: ActionRecord;
  failure?: string;
  refreshing?: boolean;
  refreshError?: string;
}

interface Draft {
  territoryId: string;
  portId: string;
  routeId: string;
}

const emptyDraft: Draft = { territoryId: '', portId: '', routeId: '' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stateLabel(state: string | undefined): string {
  if (state === undefined) return 'Unknown';
  if (state === 'not-retrieved') return 'Not retrieved';
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function ownershipLabel(ownership: LogisticsVesselCandidate['ownership']): string {
  if (ownership === 'verified-owned') return 'Verified owned';
  if (ownership === 'not-owned') return 'Not owned by this account';
  return 'Unverified; ownership cannot be verified';
}

function valueText(value: unknown): string {
  if (value === undefined) return 'unknown';
  if (value === null) return 'none';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.map((entry) => valueText(entry)).join(', ');
  if (isRecord(value)) {
    return Object.entries(value).map(([key, entry]) => `${key} ${valueText(entry)}`).join('; ');
  }
  return String(value);
}

function locationText(location: unknown): string {
  if (location === undefined) return 'unknown';
  if (isRecord(location)) {
    const status = typeof location.status === 'string' ? location.status : undefined;
    const port = typeof location.port === 'string' ? location.port : undefined;
    const territory = typeof location.territory === 'string' ? location.territory : undefined;
    if (status !== undefined || port !== undefined || territory !== undefined) {
      return [
        status === undefined ? 'status unknown' : status,
        port === undefined ? undefined : `at ${port}`,
        territory === undefined ? undefined : `in ${territory}`
      ].filter((part): part is string => part !== undefined).join(' ');
    }
  }
  return valueText(location);
}

function visitText(visit: unknown): string {
  if (visit === undefined) return 'unknown';
  if (!isRecord(visit)) return valueText(visit);
  if (visit.departed === true) return 'departed; no active port';
  const port = typeof visit.port === 'string' ? visit.port : undefined;
  if (port !== undefined) return `active at ${port}`;
  return 'unknown';
}

function candidatePorts(data: ExplorePlacesResponse | undefined): Set<string> {
  const ports = new Set<string>();
  for (const place of data?.data.places ?? []) {
    if (place.type === 'Port') ports.add(place.id);
  }
  return ports;
}

function connectionLabel(connection: ExploreConnectionRecord): string {
  return `${connection.name ?? connection.id} (${connection.from} → ${connection.to})`;
}

function chargeText(records: unknown[] | undefined): string {
  if (records === undefined) return 'unknown';
  if (records.length === 0) return 'none';
  return records.map((record) => valueText(record)).join(', ');
}

function evidenceChanges(changes: Record<string, unknown> | undefined): string | undefined {
  if (changes === undefined) return undefined;
  const event = changes.event;
  return typeof event === 'string' ? event : isRecord(event) && typeof event.type === 'string' ? event.type : undefined;
}

function exitEvidenced(action: ActionRecord): boolean {
  return action.outcome.evidence.some((evidence) => {
    const event = evidenceChanges(evidence.changes);
    return event === 'ExitEvent';
  });
}

function legStatusLabel(status: JourneyStep['status']): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function VesselTravel(props: VesselTravelProps): ReactElement {
  const { account, context, selectionRevision, onContextChange, onOpenExplore, onOpenAction } = props;
  const accountId = account?.id;
  const contextMatches = context !== undefined && context.accountId === accountId;
  const contextVesselId = contextMatches ? context.vesselId : undefined;
  const contextRoutePlanId = contextMatches ? context.routePlanId : undefined;

  const [selection, setSelection] = useState<{ accountId: string; vesselId: string } | undefined>(() =>
    accountId !== undefined && contextVesselId !== undefined ? { accountId, vesselId: contextVesselId } : undefined);
  const [candidateView, setCandidateView] = useState<CandidateView>({});
  const [vesselView, setVesselView] = useState<VesselView>({});
  const [planView, setPlanView] = useState<PlanView>({});
  const [browseView, setBrowseView] = useState<BrowseView>({});
  const [actionView, setActionView] = useState<ActionView>({});
  const [knownVesselId, setKnownVesselId] = useState('');
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [adoption, setAdoption] = useState(false);
  const [sending, setSending] = useState(false);
  const candidateGeneration = useRef(0);
  const vesselGeneration = useRef(0);
  const planGeneration = useRef(0);
  const browseGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const sendLock = useRef(false);
  const scopeRef = useRef<{ accountId: string | undefined; vesselId: string | undefined }>({ accountId: undefined, vesselId: undefined });

  const selectedVesselId = selection !== undefined && selection.accountId === accountId ? selection.vesselId : undefined;
  const vesselId = selectedVesselId;
  const routePlanId = vesselId === contextVesselId ? contextRoutePlanId : undefined;
  const vesselKey = accountId === undefined || vesselId === undefined ? undefined : `${accountId}\u0000${vesselId}`;
  scopeRef.current = { accountId, vesselId };

  useEffect(() => {
    setSelection((previous) => previous?.accountId === accountId ? previous : undefined);
    setKnownVesselId('');
  }, [accountId]);

  useEffect(() => {
    if (accountId !== undefined && contextVesselId !== undefined) setSelection({ accountId, vesselId: contextVesselId });
  }, [accountId, contextVesselId, selectionRevision]);

  useEffect(() => () => {
    candidateGeneration.current += 1;
    vesselGeneration.current += 1;
    planGeneration.current += 1;
    browseGeneration.current += 1;
    actionGeneration.current += 1;
  }, []);

  useEffect(() => {
    const generation = ++candidateGeneration.current;
    if (accountId === undefined) {
      setCandidateView({});
      return;
    }
    setCandidateView({ accountId, loading: true });
    readLogisticsVesselCandidates(accountId).then(
      (response) => {
        if (candidateGeneration.current !== generation) return;
        setCandidateView(response.data.accountId === accountId ? { accountId, response } : { accountId, failure: 'The candidate page returned another account.' });
      },
      (error: unknown) => {
        if (candidateGeneration.current !== generation) return;
        setCandidateView({ accountId, failure: errorText(error) });
      }
    );
    return () => {
      candidateGeneration.current += 1;
    };
  }, [accountId]);

  useEffect(() => {
    const generation = ++vesselGeneration.current;
    if (accountId === undefined || vesselId === undefined) {
      setVesselView({});
      return;
    }
    const key = `${accountId}\u0000${vesselId}`;
    setVesselView({ key, loading: true });
    readLogisticsVessel(accountId, vesselId).then(
      (response) => {
        if (vesselGeneration.current !== generation) return;
        setVesselView(response.data.accountId === accountId && response.data.vesselId === vesselId
          ? { key, response } : { key, failure: 'The vessel page returned unexpected account or vessel identity.' });
      },
      (error: unknown) => {
        if (vesselGeneration.current !== generation) return;
        setVesselView({ key, failure: errorText(error) });
      }
    );
    return () => {
      vesselGeneration.current += 1;
    };
  }, [accountId, vesselId]);

  useEffect(() => {
    const generation = ++planGeneration.current;
    if (accountId === undefined || routePlanId === undefined) {
      setPlanView({});
      return;
    }
    const key = `${accountId}\u0000${vesselId}\u0000${routePlanId}`;
    setPlanView({ key, loading: true });
    readRoutePlan(routePlanId, accountId).then(
      (response) => {
        if (planGeneration.current !== generation) return;
        setPlanView(response.data.plan.accountId === accountId && response.data.plan.id === routePlanId
          ? { key, plan: response.data.plan } : { key, failure: 'The retained plan returned unexpected ownership or identity.' });
      },
      (error: unknown) => {
        if (planGeneration.current !== generation) return;
        setPlanView({ key, failure: errorText(error) });
      }
    );
    return () => {
      planGeneration.current += 1;
    };
  }, [accountId, vesselId, routePlanId, selectionRevision]);

  useEffect(() => {
    actionGeneration.current += 1;
    sendLock.current = false;
    setSending(false);
    setActionView({});
  }, [accountId, vesselId]);

  useEffect(() => {
    setDraft(emptyDraft);
    setBrowseView({});
    browseGeneration.current += 1;
  }, [accountId, vesselId]);

  const vessel = vesselKey !== undefined && vesselView.key === vesselKey ? vesselView : undefined;
  const vesselData = vessel?.response?.data;
  useEffect(() => {
    setAdoption(vesselData?.registry.adoption === true);
  }, [vesselData]);

  const candidates = candidateView.accountId === accountId ? candidateView : undefined;
  const currentBrowse = browseView.accountId === accountId && browseView.vesselId === vesselId ? browseView : undefined;
  const browseData = currentBrowse?.response;
  const ports = candidatePorts(browseData);
  const entryRoutes = (browseData?.data.connections ?? []).filter((connection) => ports.has(connection.to) && connection.from !== connection.to);
  const departureRoutes = (browseData?.data.connections ?? []).filter((connection) => ports.has(connection.from) && connection.from !== connection.to);
  const routePlan = routePlanId !== undefined && planView.key === `${accountId}\u0000${vesselId}\u0000${routePlanId}` ? planView : undefined;
  const scopedAction = actionView.scopeKey === vesselKey ? actionView : undefined;
  const currentAction = scopedAction?.action?.accountId === accountId ? scopedAction?.action : undefined;
  const actionRefresh = scopedAction;

  const selectVessel = (id: string): void => {
    if (accountId === undefined) return;
    setSelection({ accountId, vesselId: id });
    onContextChange?.({ accountId, vesselId: id });
  };

  const openKnownVessel = (): void => {
    const id = knownVesselId.trim();
    if (id === '' || accountId === undefined) return;
    selectVessel(id);
  };

  const refreshCandidates = (): void => {
    if (accountId === undefined || candidateView.refreshing === true) return;
    const generation = ++candidateGeneration.current;
    setCandidateView((current) => ({ ...current, accountId, refreshing: true }));
    refreshLogisticsVesselCandidates(accountId).then(
      (response) => {
        if (candidateGeneration.current !== generation) return;
        setCandidateView(response.data.accountId === accountId ? { accountId, response } : { accountId, failure: 'The candidate page returned another account.' });
      },
      (error: unknown) => {
        if (candidateGeneration.current !== generation) return;
        setCandidateView((current) => ({ ...current, accountId, refreshing: false, refreshError: errorText(error) }));
      }
    );
  };

  const refreshVessel = (): void => {
    if (accountId === undefined || vesselId === undefined || vessel?.refreshing === true) return;
    const generation = ++vesselGeneration.current;
    const key = `${accountId}\u0000${vesselId}`;
    setVesselView((current) => current.key === key ? { ...current, refreshing: true } : { key, refreshing: true });
    refreshLogisticsVessel(accountId, vesselId).then(
      (response) => {
        if (vesselGeneration.current !== generation) return;
        setVesselView(response.data.accountId === accountId && response.data.vesselId === vesselId
          ? { key, response } : { key, failure: 'The vessel page returned unexpected account or vessel identity.' });
      },
      (error: unknown) => {
        if (vesselGeneration.current !== generation) return;
        setVesselView((current) => current.key === key
          ? { ...current, refreshing: false, refreshError: errorText(error) }
          : { key, refreshing: false, refreshError: errorText(error) });
      }
    );
  };

  const browseRoutes = (): void => {
    if (accountId === undefined || vesselId === undefined || currentBrowse?.loading === true) return;
    const generation = ++browseGeneration.current;
    setBrowseView({ accountId, vesselId, loading: true });
    readExplorePlaces(accountId, vesselId).then(
      (response) => {
        if (browseGeneration.current !== generation) return;
        setBrowseView({ accountId, vesselId, response });
      },
      (error: unknown) => {
        if (browseGeneration.current !== generation) return;
        setBrowseView({ accountId, vesselId, failure: errorText(error) });
      }
    );
  };

  const selectEntryRoute = (id: string): void => {
    const connection = entryRoutes.find((route) => route.id === id);
    if (connection === undefined) return;
    setDraft({ territoryId: connection.territoryId, portId: connection.to, routeId: connection.id });
  };

  const selectDepartureRoute = (id: string): void => {
    const connection = departureRoutes.find((route) => route.id === id);
    if (connection === undefined) return;
    setDraft({ territoryId: connection.territoryId, portId: connection.from, routeId: connection.id });
  };

  const send = (submit: () => Promise<{ action: ActionRecord }>): void => {
    if (sendLock.current || vesselKey === undefined) return;
    const targetAccount = accountId;
    const targetVessel = vesselId;
    const generation = ++actionGeneration.current;
    sendLock.current = true;
    setSending(true);
    submit().then(
      (response) => {
        if (actionGeneration.current !== generation) return;
        if (scopeRef.current.accountId !== targetAccount || scopeRef.current.vesselId !== targetVessel) return;
        sendLock.current = false;
        setSending(false);
        setActionView(response.action.accountId === targetAccount
          ? { scopeKey: vesselKey, key: `${response.action.accountId}\u0000${response.action.id}`, action: response.action }
          : { scopeKey: vesselKey, failure: 'The action returned another account.' });
      },
      (error: unknown) => {
        if (actionGeneration.current !== generation) return;
        if (scopeRef.current.accountId !== targetAccount || scopeRef.current.vesselId !== targetVessel) return;
        sendLock.current = false;
        setSending(false);
        setActionView({ scopeKey: vesselKey, failure: errorText(error) });
      }
    );
  };

  const draftComplete = draft.territoryId.trim() !== '' && draft.portId.trim() !== '' && draft.routeId.trim() !== '';

  const requestEntry = (): void => {
    if (accountId === undefined || vesselId === undefined || !draftComplete) return;
    send(() => submitLogisticsEntry({
      accountId,
      vesselId,
      territoryId: draft.territoryId.trim(),
      portId: draft.portId.trim(),
      routeId: draft.routeId.trim()
    }));
  };

  const requestDeparture = (): void => {
    if (accountId === undefined || vesselId === undefined || !draftComplete) return;
    send(() => submitLogisticsDeparture({
      accountId,
      vesselId,
      territoryId: draft.territoryId.trim(),
      portId: draft.portId.trim(),
      routeId: draft.routeId.trim()
    }));
  };

  const traverse = (): void => {
    if (accountId === undefined || vesselId === undefined || routePlanId === undefined) return;
    send(() => submitLogisticsTraverse({ accountId, vesselId, routePlanId }));
  };

  const updateAdoption = (): void => {
    if (accountId === undefined || vesselId === undefined) return;
    send(() => submitLogisticsAdoption({ accountId, vesselId, adoption }));
  };

  const refreshStatus = (): void => {
    if (accountId === undefined || vesselKey === undefined || currentAction === undefined || actionRefresh?.refreshing === true) return;
    const generation = ++actionGeneration.current;
    const key = `${accountId}\u0000${currentAction.id}`;
    setActionView((current) => ({ ...current, key, refreshing: true }));
    refreshAction(accountId, currentAction.id).then(
      (response) => {
        if (actionGeneration.current !== generation) return;
        setActionView(response.data.action.accountId === accountId && response.data.action.id === currentAction.id
          ? { scopeKey: vesselKey, key, action: response.data.action }
          : { ...actionView, refreshing: false, refreshError: 'The action readback returned unexpected ownership or identity.' });
      },
      (error: unknown) => {
        if (actionGeneration.current !== generation) return;
        setActionView((current) => current.key === key
          ? { ...current, refreshing: false, refreshError: errorText(error) }
          : { key, refreshing: false, refreshError: errorText(error) });
      }
    );
  };

  const registry: LogisticsRegistryObservation | undefined = vesselData?.registry;
  const territories: LogisticsTerritoryObservation[] = vesselData?.territories ?? [];

  return (
    <section aria-label="Vessel travel" className={styles.travel}>
      <h2 className={styles.heading}>Vessel travel</h2>

      <section className={styles.section} aria-label="Known vessel reference">
        <h3 className={styles.subheading}>Known vessel reference</h3>
        <p className={styles.meta}>
          A publication failure is not the same as owning no vessels. This reference opens the retained vessel page independently of candidate publication.
        </p>
        <div className={styles.controls}>
          <TextField className={styles.field} value={knownVesselId} onChange={setKnownVesselId}>
            <Label className={styles.label}>Known vessel ID</Label>
            <Input className={styles.input} />
          </TextField>
          <Button className={styles.button} onPress={openKnownVessel} isDisabled={knownVesselId.trim() === '' || accountId === undefined}>
            Open known vessel reference
          </Button>
        </div>
      </section>

      {vesselId === undefined || accountId === undefined ? null : (
        <section className={styles.section} aria-label="Selected vessel state">
          <header className={styles.controls}>
            <h3 className={styles.subheading}>Selected vessel</h3>
            <Button className={styles.button} onPress={refreshVessel} isPending={vessel?.refreshing === true}>
              Refresh vessel
            </Button>
            {onOpenExplore === undefined ? null : (
              <Button
                className={styles.button}
                onPress={() => onOpenExplore({ accountId, vesselId })}
              >
                Open Explore
              </Button>
            )}
          </header>
          {vessel === undefined || vessel.loading === true ? <p className={styles.status}>Reading retained vessel state…</p> : null}
          {vessel?.failure === undefined ? null : (
            <p className={styles.failure} role="alert">Vessel state unavailable: {vessel.failure}</p>
          )}
          {vessel?.refreshError === undefined ? null : (
            <p className={styles.failure} role="alert">
              Vessel refresh failed: {vessel.refreshError}. Retained observations are unchanged and may be stale.
            </p>
          )}
          {vesselData === undefined ? null : (
            <>
              {vesselData.vessel === undefined ? null : (
                <p className={styles.name}>
                  {vesselData.vessel.name ?? vesselData.vessel.id}
                  <span className={styles.meta}> · exact ID {vesselData.vessel.id}</span>
                </p>
              )}
              {registry === undefined ? null : (
                <section className={styles.section} aria-label="Registry observation">
                  <h4 className={styles.subheading}>Registry</h4>
                  <p className={styles.meta}>Registry cargo: {registry.cargo === undefined ? 'unknown' : valueText(registry.cargo)}</p>
                  <p className={styles.meta}>Registry location: {locationText(registry.location)}</p>
                  <p className={styles.meta}>Adoption: {registry.adoption === undefined ? 'unknown' : String(registry.adoption)}</p>
                  <p className={styles.meta}>Pending requests: {chargeText(registry.pendingRequests)}</p>
                  <p className={styles.meta}>Registry state: {stateLabel(registry.state)}{registry.observedAt === undefined ? '' : ` · ${registry.observedAt}`}</p>
                  <p className={styles.source}>{registry.source}</p>
                  {registry.error === undefined ? null : <p className={styles.failure}>{registry.error}</p>}
                </section>
              )}
              {territories.length === 0 ? null : (
                <section className={styles.section} aria-label="Territory observations">
                  <h4 className={styles.subheading}>Territories</h4>
                  <ul className={styles.list}>
                    {territories.map((territory) => (
                      <li key={`${territory.authorityId}\u0000${territory.source}`} className={styles.item}>
                        <p className={styles.name}>{territory.authorityId}</p>
                        <p className={styles.meta}>Territory visit: {visitText(territory.visit)}</p>
                        <p className={styles.meta}>Territory cargo: {territory.cargo === undefined ? 'unknown' : valueText(territory.cargo)}</p>
                        <p className={styles.meta}>Shared stock: {territory.sharedStock === undefined ? 'unknown' : valueText(territory.sharedStock)}</p>
                        <p className={styles.meta}>
                          Territory state: {stateLabel(territory.state)}
                          {territory.observedAt === undefined ? '' : ` · ${territory.observedAt}`}
                        </p>
                        <p className={styles.source}>{territory.source}</p>
                        {territory.error === undefined ? null : <p className={styles.failure}>{territory.error}</p>}
                        <details className={styles.details}>
                          <summary>Territory details</summary>
                          <p className={styles.meta}>Kind: {territory.kind}</p>
                          <p className={styles.meta}>Authority: {territory.authorityId}</p>
                        </details>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <section className={styles.section} aria-label="Cargo adoption">
                <h4 className={styles.subheading}>Cargo adoption</h4>
                <div className={styles.controls}>
                  <label className={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={adoption}
                      onChange={(event) => setAdoption(event.currentTarget.checked)}
                    />
                    <span>Cargo adoption</span>
                  </label>
                  <Button className={styles.button} onPress={updateAdoption} isPending={sending}>
                    Update adoption
                  </Button>
                </div>
              </section>
            </>
          )}
        </section>
      )}

      {vesselId === undefined || accountId === undefined ? null : (
        <section className={styles.section} aria-label="Published entry and departure routes">
          <header className={styles.controls}>
            <h3 className={styles.subheading}>Published entry and departure routes</h3>
            <Button className={styles.button} onPress={browseRoutes} isPending={currentBrowse?.loading === true}>
              Browse published routes
            </Button>
          </header>
          {currentBrowse?.failure === undefined ? null : (
            <p className={styles.failure} role="alert">Published routes unavailable: {currentBrowse.failure}</p>
          )}
          {browseData === undefined ? null : (
            <>
              <div className={styles.controls}>
                <label className={styles.field}>
                  <span className={styles.label}>Published entry route</span>
                  <select
                    className={styles.select}
                    aria-label="Published entry route"
                    value={entryRoutes.some((route) => route.id === draft.routeId) ? draft.routeId : ''}
                    onChange={(event) => selectEntryRoute(event.currentTarget.value)}
                  >
                    <option value="">Select a published entry route</option>
                    {entryRoutes.map((route) => (
                      <option key={route.id} value={route.id}>{connectionLabel(route)}</option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span className={styles.label}>Published departure route</span>
                  <select
                    className={styles.select}
                    aria-label="Published departure route"
                    value={departureRoutes.some((route) => route.id === draft.routeId) ? draft.routeId : ''}
                    onChange={(event) => selectDepartureRoute(event.currentTarget.value)}
                  >
                    <option value="">Select a published departure route</option>
                    {departureRoutes.map((route) => (
                      <option key={route.id} value={route.id}>{connectionLabel(route)}</option>
                    ))}
                  </select>
                </label>
              </div>
              {entryRoutes.length === 0 ? <p className={styles.status}>No published directed entry route reaches a known Port.</p> : null}
              {departureRoutes.length === 0 ? <p className={styles.status}>No published directed departure route leaves a known Port.</p> : null}
            </>
          )}
          <div className={styles.group}>
            <TextField className={styles.field} value={draft.territoryId} onChange={(value) => setDraft((current) => ({ ...current, territoryId: value }))}>
              <Label className={styles.label}>Territory ID</Label>
              <Input className={styles.input} />
            </TextField>
            <TextField className={styles.field} value={draft.portId} onChange={(value) => setDraft((current) => ({ ...current, portId: value }))}>
              <Label className={styles.label}>Port ID</Label>
              <Input className={styles.input} />
            </TextField>
            <TextField className={styles.field} value={draft.routeId} onChange={(value) => setDraft((current) => ({ ...current, routeId: value }))}>
              <Label className={styles.label}>Route ID</Label>
              <Input className={styles.input} />
            </TextField>
          </div>
          <div className={styles.controls}>
            <Button className={styles.button} onPress={requestEntry} isDisabled={!draftComplete} isPending={sending}>
              Request entry
            </Button>
            <Button className={styles.button} onPress={requestDeparture} isDisabled={!draftComplete} isPending={sending}>
              Request departure
            </Button>
          </div>
        </section>
      )}

      {routePlanId === undefined || accountId === undefined ? null : (
        <section className={styles.section} aria-label="Selected route plan">
          <h3 className={styles.subheading}>Selected route plan</h3>
          {routePlan === undefined || routePlan.loading === true ? <p className={styles.status}>Reading the retained route plan…</p> : null}
          {routePlan?.failure === undefined ? null : (
            <p className={styles.failure} role="alert">Route plan unavailable: {routePlan.failure}</p>
          )}
          {routePlan?.plan === undefined ? null : (
            <>
              <p className={styles.meta}>Plan ID: {routePlan.plan.id}</p>
              <p className={styles.meta}>{`${routePlan.plan.from} → ${routePlan.plan.to}`}</p>
              <ul className={styles.list}>
                {routePlan.plan.legs.map((leg) => {
                  const connection = browseData?.data.connections.find((entry) => entry.id === leg.routeId);
                  return (
                    <li key={`${leg.routeId}\u0000${leg.from}\u0000${leg.to}`} className={styles.leg}>
                      <p className={styles.name}>{connection?.name ?? leg.routeId}</p>
                      <p className={styles.meta}>{`${leg.from} → ${leg.to}`}</p>
                      <details className={styles.details}>
                        <summary>Leg details</summary>
                        <p className={styles.meta}>Route: {leg.routeId}</p>
                        <p className={styles.meta}>From: {leg.from}</p>
                        <p className={styles.meta}>To: {leg.to}</p>
                        <p className={styles.meta}>Territory: {leg.territoryId}</p>
                      </details>
                    </li>
                  );
                })}
              </ul>
              {routePlan.plan.blockers.length === 0 ? null : (
                <ul className={styles.list}>
                  {routePlan.plan.blockers.map((blocker) => (
                    <li key={`${blocker.id}\u0000${blocker.source}`} className={styles.item}>
                      <p className={styles.meta}>{blocker.message}</p>
                      <p className={styles.meta}>{stateLabel(blocker.state)}</p>
                    </li>
                  ))}
                </ul>
              )}
              <Button className={styles.button} onPress={traverse} isPending={sending}>
                Traverse selected route
              </Button>
            </>
          )}
        </section>
      )}

      {currentAction === undefined && scopedAction?.failure === undefined ? null : (
        <section className={styles.section} aria-label="Submitted action">
          <h3 className={styles.subheading}>Submitted action</h3>
          {scopedAction?.failure === undefined ? null : (
            <p className={styles.failure} role="alert">Action submission failed: {scopedAction.failure}. The send is not treated as completed.</p>
          )}
          {actionRefresh?.refreshError === undefined ? null : (
            <p className={styles.failure} role="alert">
              Status refresh failed: {actionRefresh.refreshError}. The last known action evidence is retained.
            </p>
          )}
          {currentAction === undefined ? null : (
            <>
              <p className={styles.meta}>Submission: {stateLabel(currentAction.submission.status)}</p>
              <p className={styles.meta}>Outcome: {currentAction.outcome.status === 'completed' && (!actionIsComplete(currentAction) || (currentAction.intent.kind === 'departure' && !exitEvidenced(currentAction))) ? 'Unverified (completion is not confirmed without matching evidence)' : stateLabel(currentAction.outcome.status)}</p>
              {currentAction.submission.error === undefined ? null : <p className={styles.failure}>Submission error: {currentAction.submission.error}</p>}
              {currentAction.outcome.error === undefined ? null : <p className={styles.failure}>Outcome error: {currentAction.outcome.error}</p>}
              <div className={styles.controls}>
                {onOpenAction === undefined ? null : <Button className={styles.button} onPress={() => onOpenAction(currentAction.id)}>
                  Open Activity
                </Button>}
                <Button className={styles.button} onPress={refreshStatus} isPending={actionRefresh?.refreshing === true}>
                  Refresh status
                </Button>
              </div>
              <ul className={styles.list}>
                {currentAction.resultReferences.map((reference, index) => (
                  <li key={`${reference.kind}\u0000${reference.id}\u0000${index}`} className={styles.meta}>{reference.kind}: {reference.id}</li>
                ))}
              </ul>
              {currentAction.outcome.evidence.length === 0 ? null : (
                <section className={styles.section} aria-label="Action evidence">
                  <h4 className={styles.subheading}>Evidence</h4>
                  <ul className={styles.list}>
                    {currentAction.outcome.evidence.map((evidence, index) => (
                      <li key={`${evidence.source}\u0000${index}`} className={styles.item}>
                        <p className={styles.source}>{evidence.source}</p>
                        <p className={styles.meta}>Observed: {evidence.observedAt}</p>
                        {evidenceChanges(evidence.changes) === undefined ? null : (
                          <p className={styles.name}>{evidenceChanges(evidence.changes)}</p>
                        )}
                        {evidence.changes === undefined ? null : <p className={styles.meta}>{JSON.stringify(evidence.changes)}</p>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {currentAction.intent.kind === 'departure' && !exitEvidenced(currentAction) ? (
                <p className={styles.status}>Signed exit: not evidenced. A departure acknowledgment is not a signed exit.</p>
              ) : null}
              {currentAction.journey === undefined ? null : (
                <section className={styles.section} aria-label="Journey progress">
                  <h4 className={styles.subheading}>Journey</h4>
                  <p className={styles.meta}>Journey status: {stateLabel(currentAction.journey.status)}</p>
                  {currentAction.journey.error === undefined ? null : <p className={styles.failure}>Journey error: {currentAction.journey.error}</p>}
                  <ul className={styles.list}>
                    {currentAction.journey.legs.map((leg) => (
                      <li key={`${leg.routeId}\u0000${leg.from}\u0000${leg.to}`} className={styles.item}>
                        <p className={styles.meta}>{`${leg.kind ?? 'leg'}: ${leg.from} → ${leg.to}`}</p>
                        <p className={styles.meta}>Route: {leg.routeId} · Territory: {leg.territoryId}</p>
                        <p className={styles.meta}>Leg status: {legStatusLabel(leg.status)}</p>
                        {leg.requestId === undefined ? null : <p className={styles.meta}>Request: {leg.requestId}</p>}
                        {leg.eventId === undefined ? null : <p className={styles.meta}>Event: {leg.eventId}</p>}
                        {leg.error === undefined ? null : <p className={styles.failure}>{leg.error}</p>}
                        {leg.observedAt === undefined ? null : <p className={styles.meta}>Observed: {leg.observedAt}</p>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {currentAction.outcome.evidence.length === 0 && currentAction.submission.status === 'unverified' ? (
                <p className={styles.status}>The send outcome could not be verified. Use Refresh status to reconcile; the request is never replayed automatically.</p>
              ) : null}
            </>
          )}
        </section>
      )}

      {accountId === undefined ? null : (
        <section className={styles.section} aria-label="Published vessel candidates">
          <header className={styles.controls}>
            <h3 className={styles.subheading}>Published vessel candidates</h3>
            <Button className={styles.button} onPress={refreshCandidates} isPending={candidates?.refreshing === true}>
              Refresh vessel candidates
            </Button>
          </header>
          {candidates?.loading === true ? <p className={styles.status}>Reading retained vessel candidates…</p> : null}
          {candidates?.failure === undefined ? null : (
            <p className={styles.failure} role="alert">Vessel candidates unavailable: {candidates.failure}</p>
          )}
          {candidates?.refreshError === undefined ? null : (
            <p className={styles.failure} role="alert">Candidate refresh failed: {candidates.refreshError}. Retained candidates are unchanged.</p>
          )}
          {candidates?.response === undefined ? null : (
            <>
              {candidates.response.data.blockers.map((blocker) => (
                <p key={blocker} className={styles.failure}>{blocker}</p>
              ))}
              {candidates.response.data.candidates.length === 0 ? (
                <p className={styles.status}>No published vessel candidates are retained. This is not a statement that the account owns no vessels.</p>
              ) : (
                <ul className={styles.list}>
                  {candidates.response.data.candidates.map((candidate) => (
                    <li key={candidate.id} className={styles.item}>
                      <p className={styles.name}>{candidate.name ?? candidate.id}</p>
                      <p className={styles.meta}>
                        {ownershipLabel(candidate.ownership)} · {stateLabel(candidate.state)}
                        {candidate.registrySupported === undefined ? '' : ` · Registry ${candidate.registrySupported ? 'supported' : 'unsupported'}`}
                      </p>
                      {candidate.observedAt === undefined ? null : <p className={styles.meta}>Observed: {candidate.observedAt}</p>}
                      {candidate.error === undefined ? null : <p className={styles.failure}>{candidate.error}</p>}
                      {candidate.ownership === 'verified-owned' ? (
                        <Button className={styles.button} onPress={() => selectVessel(candidate.id)}>
                          {`Select ${candidate.name ?? candidate.id}`}
                        </Button>
                      ) : null}
                      <details className={styles.details}>
                        <summary>Candidate details</summary>
                        <p className={styles.meta}>Exact ID: {candidate.id}</p>
                        <p className={styles.meta}>Source: {candidate.source}</p>
                        {candidate.registry === undefined ? null : <p className={styles.meta}>Registry: {candidate.registry}</p>}
                        {candidate.possessor === undefined ? null : <p className={styles.meta}>Possessor: {candidate.possessor}</p>}
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}
    </section>
  );
}
