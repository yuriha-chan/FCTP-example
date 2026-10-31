import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from 'react-aria-components';
import type {
  ExploreCapabilityRecord,
  ExploreConnectionRecord,
  ExploreEndpointRecord,
  ExplorePlaceRecord,
  ExploreResourceRecord,
  RoutePlanRecord,
  SourcedObservation
} from '@fctp/client-sdk';
import type { VesselWorkflowContext } from './workflow-context';
import type { ResourceReference } from './resource-reader';
import { ReferencePicker, type ReferencePickerPosition } from './reference-picker';
import {
  createRoutePlan,
  readExplorePlace,
  readExplorePlaces,
  readRoutePlan,
  refreshExplorePlace,
  refreshExplorePlaces,
  type ExplorePlaceDetailResponse,
  type ExplorePlacesResponse,
  type RoutePlanResponse
} from './application-api';
import cssStyles from './explore.module.css';

type ClassName = 'explore' | 'heading' | 'section' | 'subheading' | 'controls' | 'button'
  | 'status' | 'failure' | 'list' | 'item' | 'name' | 'meta' | 'source' | 'error'
  | 'details' | 'technical' | 'group' | 'incoming' | 'outgoing';

const styles = cssStyles as Record<ClassName, string>;

export interface ExploreProps {
  accountId?: string;
  context?: VesselWorkflowContext;
  selectionRevision?: number;
  onOpenLogistics?: (context: VesselWorkflowContext) => void;
  onOpenProduction?: (context: VesselWorkflowContext) => void;
  onReadResource?: (reference: ResourceReference) => void;
}

interface ListView {
  key?: string;
  loading?: boolean;
  failure?: string;
  response?: ExplorePlacesResponse;
  refreshing?: boolean;
  refreshError?: string;
}

interface DetailView {
  key?: string;
  loading?: boolean;
  failure?: string;
  response?: ExplorePlaceDetailResponse;
  refreshing?: boolean;
  refreshError?: string;
}

interface PlanView {
  scopeKey?: string;
  key?: string;
  loading?: boolean;
  failure?: string;
  plan?: RoutePlanRecord;
}

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

function observationTime(observation: SourcedObservation<unknown>): string | undefined {
  return 'observedAt' in observation ? observation.observedAt : undefined;
}

function observationError(observation: SourcedObservation<unknown>): string | undefined {
  return 'error' in observation ? observation.error : undefined;
}

function valueText(value: unknown): string {
  if (value === undefined) return 'unknown';
  if (value === null) return 'none';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((entry) => valueText(entry)).join(', ');
  if (isRecord(value)) {
    return Object.entries(value).map(([key, entry]) => `${key} ${valueText(entry)}`).join('; ');
  }
  return String(value);
}

function recordName(record: ExplorePlaceRecord | ExploreResourceRecord | undefined): string | undefined {
  if (record === undefined) return undefined;
  return record.name !== undefined && record.name !== '' ? record.name : record.id;
}

function connectionName(connection: ExploreConnectionRecord, places: readonly ExplorePlaceRecord[]): string | undefined {
  if (connection.name !== undefined && connection.name !== '') return connection.name;
  return places.find((place) => place.id === connection.from)?.name;
}

function endpointName(
  endpoint: ExploreEndpointRecord | undefined,
  id: string,
  places: readonly ExplorePlaceRecord[]
): string {
  if (endpoint?.name !== undefined && endpoint.name !== '') return endpoint.name;
  return places.find((place) => place.id === id)?.name ?? id;
}

function placeName(id: string, places: readonly ExplorePlaceRecord[]): string {
  return places.find((place) => place.id === id)?.name ?? id;
}

function positionFrom(
  response: ExplorePlacesResponse | undefined,
  accountId: string | undefined,
  vesselId: string | undefined
): ReferencePickerPosition | undefined {
  if (response === undefined || accountId === undefined || vesselId === undefined) return undefined;
  const active = new Set<string>();
  for (const position of response.data.positions ?? []) {
    if (position.accountId !== accountId || position.vesselId !== vesselId) continue;
    if (position.state !== 'available' || position.status !== 'active') continue;
    if (position.portId === undefined || position.portId === '') continue;
    active.add(position.portId);
  }
  if (active.size !== 1) return undefined;
  const portId = active.values().next().value;
  if (typeof portId !== 'string') return undefined;
  return { vesselId, portId };
}

function Sources({ observations }: { observations: Record<string, SourcedObservation<unknown>> }): ReactElement | null {
  const entries = Object.entries(observations);
  if (entries.length === 0) return null;
  return (
    <section className={styles.section} aria-label="Recorded sources">
      <h4 className={styles.subheading}>Recorded sources</h4>
      <ul className={styles.list}>
        {entries.map(([key, observation]) => {
          const observedAt = observationTime(observation);
          const failure = observationError(observation);
          return (
            <li key={key} className={styles.item}>
              <p className={styles.name}>{key}</p>
              <p className={styles.meta}>
                {stateLabel(observation.state)}
                {observedAt === undefined ? '' : ` · ${observedAt}`}
              </p>
              <p className={styles.source}>{observation.source}</p>
              {failure === undefined ? null : <p className={styles.failure}>{failure}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ResourceList({
  label,
  records,
  onReadResource
}: {
  label: string;
  records: readonly ExploreResourceRecord[];
  onReadResource?: ExploreProps['onReadResource'];
}): ReactElement | null {
  if (records.length === 0) return null;
  return (
    <section className={styles.section} aria-label={label}>
      <h4 className={styles.subheading}>{label}</h4>
      <ul className={styles.list}>
        {records.map((record) => (
          <li key={record.id} className={styles.item}>
            <p className={styles.name}>{recordName(record)}</p>
            <p className={styles.meta}>
              {record.type} · {stateLabel(record.state)}
              {record.territoryId === undefined ? '' : ` · Territory ${record.territoryId}`}
            </p>
            {record.error === undefined ? null : <p className={styles.failure}>{record.error}</p>}
            {onReadResource === undefined ? null : (
              <Button
                className={styles.button}
                onPress={() => onReadResource({ id: record.id, authorityId: record.authorityId })}
              >
                {`Read ${recordName(record)}`}
              </Button>
            )}
            <details className={styles.details}>
              <summary>{`${label} details`}</summary>
              <p className={styles.meta}>Exact ID: {record.id}</p>
              <p className={styles.meta}>Authority: {record.authorityId}</p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface ConnectionProps {
  connection: ExploreConnectionRecord;
  places: readonly ExplorePlaceRecord[];
}

function ConnectionLine({ connection, places }: ConnectionProps): ReactElement {
  const from = endpointName(
    connection.endpoints?.find((endpoint) => endpoint.id === connection.from),
    connection.from,
    places
  );
  const to = endpointName(
    connection.endpoints?.find((endpoint) => endpoint.id === connection.to),
    connection.to,
    places
  );
  const unresolved = connection.state === 'not-retrieved' || connection.state === 'unavailable'
    || (connection.endpoints?.some((endpoint) => endpoint.state === 'not-retrieved' || endpoint.state === 'unavailable') ?? false);
  return (
    <li className={styles.item}>
      <p className={styles.name}>{connectionName(connection, places) ?? connection.id}</p>
      <p className={styles.meta}>{`${from} → ${to}`}</p>
      <p className={styles.meta}>
        {stateLabel(connection.state)}
        {connection.error === undefined ? '' : ` · ${connection.error}`}
      </p>
      {unresolved ? <p className={styles.status}>Endpoint unresolved or not retrieved; this connection is not established.</p> : null}
      <details className={styles.details}>
        <summary>Connection details</summary>
        <dl className={styles.technical}>
          <dt>Exact ID</dt>
          <dd>{connection.id}</dd>
          <dt>From</dt>
          <dd>{connection.from}</dd>
          <dt>To</dt>
          <dd>{connection.to}</dd>
          <dt>Territory</dt>
          <dd>{connection.territoryId}</dd>
          <dt>Authority</dt>
          <dd>{connection.authorityId}</dd>
        </dl>
        {connection.endpoints === undefined ? null : (
          <ul className={styles.list}>
            {connection.endpoints.map((endpoint) => (
              <li key={endpoint.id} className={styles.item}>
                <p className={styles.meta}>{stateLabel(endpoint.state)}</p>
                <p className={styles.meta}>Endpoint exact ID: {endpoint.id}</p>
                {endpoint.name === undefined ? null : <p className={styles.meta}>Endpoint name: {endpoint.name}</p>}
                {endpoint.error === undefined ? null : <p className={styles.failure}>{endpoint.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </details>
    </li>
  );
}

function CapabilityList({
  capabilities,
  accountId,
  vesselId,
  place,
  onOpenProduction
}: {
  capabilities: readonly ExploreCapabilityRecord[];
  accountId?: string | undefined;
  vesselId?: string | undefined;
  place: ExplorePlaceRecord;
  onOpenProduction?: ExploreProps['onOpenProduction'];
}): ReactElement | null {
  if (capabilities.length === 0) return null;
  return (
    <section className={styles.section} aria-label="Place capabilities">
      <h4 className={styles.subheading}>Place capabilities</h4>
      <ul className={styles.list}>
        {capabilities.map((capability) => (
          <li key={capability.id} className={styles.item}>
            <p className={styles.name}>{capability.label}</p>
            <p className={styles.meta}>{capability.effect}</p>
            <p className={styles.meta}>{capability.available ? 'Advertised as available' : 'Advertised as unavailable'}</p>
            {capability.reason === undefined ? null : <p className={styles.status}>{capability.reason}</p>}
            {capability.request === undefined ? null : (
              <p className={styles.meta}>
                Request: {capability.request.method}
                {capability.request.body === undefined ? '' : ` · body ${valueText(capability.request.body)}`}
              </p>
            )}
            {onOpenProduction === undefined || accountId === undefined || vesselId === undefined ? null : (
              <Button
                className={styles.button}
                onPress={() => onOpenProduction({
                  accountId,
                  vesselId,
                  placeId: place.id,
                  authorityId: place.authorityId,
                  capabilityId: capability.id
                })}
              >
                {`Continue to operations: ${capability.label}`}
              </Button>
            )}
            <details className={styles.details}>
              <summary>Capability details</summary>
              <p className={styles.meta}>Capability ID: {capability.id}</p>
              <p className={styles.meta}>Place authority: {place.authorityId}</p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Explore(props: ExploreProps): ReactElement {
  const { accountId, context, selectionRevision, onOpenLogistics, onOpenProduction, onReadResource } = props;
  const contextMatches = context !== undefined && context.accountId === accountId;
  const vesselId = contextMatches ? context.vesselId : undefined;
  const contextRoutePlanId = contextMatches ? context.routePlanId : undefined;
  const scopeKey = JSON.stringify([accountId ?? null, vesselId ?? null]);

  const [listView, setListView] = useState<ListView>({});
  const [detailView, setDetailView] = useState<DetailView>({});
  const [planState, setPlanView] = useState<PlanView>({});
  const [openPlaceId, setOpenPlaceId] = useState<string | undefined>();
  const [origin, setOrigin] = useState<string | undefined>();
  const [destination, setDestination] = useState<string | undefined>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const detailRefreshLock = useRef<number | undefined>(undefined);
  const planGeneration = useRef(0);
  const createLock = useRef<number | undefined>(undefined);
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const planView = planState.scopeKey === scopeKey ? planState : {};

  useEffect(() => {
    setOpenPlaceId(undefined);
    setOrigin(undefined);
    setDestination(undefined);
    setPickerOpen(false);
    setPlanView({});
    setCreating(false);
    createLock.current = undefined;
    planGeneration.current += 1;
    return () => {
      listGeneration.current += 1;
      detailGeneration.current += 1;
      planGeneration.current += 1;
    };
  }, [scopeKey]);

  useEffect(() => {
    if (contextMatches && context.placeId !== undefined) setOpenPlaceId(context.placeId);
  }, [scopeKey, contextMatches, context?.placeId, selectionRevision]);

  useEffect(() => {
    const generation = ++listGeneration.current;
    const key = scopeKey;
    setListView({ key, loading: true });
    readExplorePlaces(accountId, vesselId).then(
      (response) => {
        if (listGeneration.current !== generation) return;
        setListView({ key, response });
      },
      (error: unknown) => {
        if (listGeneration.current !== generation) return;
        setListView({ key, failure: errorText(error) });
      }
    );
    return () => {
      listGeneration.current += 1;
    };
  }, [accountId, vesselId, scopeKey]);

  useEffect(() => {
    const generation = ++detailGeneration.current;
    detailRefreshLock.current = undefined;
    if (openPlaceId === undefined) {
      setDetailView({});
      return;
    }
    const key = `${scopeKey}\u0000${openPlaceId}`;
    setDetailView({ key, loading: true });
    readExplorePlace(openPlaceId, accountId, vesselId).then(
      (response) => {
        if (detailGeneration.current !== generation) return;
        setDetailView({ key, response });
      },
      (error: unknown) => {
        if (detailGeneration.current !== generation) return;
        setDetailView({ key, failure: errorText(error) });
      }
    );
    return () => {
      detailGeneration.current += 1;
    };
  }, [accountId, vesselId, openPlaceId, scopeKey]);

  useEffect(() => {
    const generation = ++planGeneration.current;
    if (accountId === undefined || contextRoutePlanId === undefined) {
      setPlanView({});
      return;
    }
    setCreating(false);
    createLock.current = undefined;
    setPlanView({ scopeKey, key: contextRoutePlanId, loading: true });
    readRoutePlan(contextRoutePlanId, accountId).then(
      (response: RoutePlanResponse) => {
        if (planGeneration.current !== generation) return;
        const plan = response.data.plan;
        setPlanView(plan.accountId === accountId && plan.id === contextRoutePlanId
          ? { scopeKey, key: contextRoutePlanId, plan }
          : { scopeKey, failure: 'The retained plan returned unexpected ownership or identity.' });
      },
      (error: unknown) => {
        if (planGeneration.current !== generation) return;
        setPlanView({ scopeKey, key: contextRoutePlanId, failure: errorText(error) });
      }
    );
    return () => {
      planGeneration.current += 1;
    };
  }, [accountId, contextRoutePlanId, selectionRevision, scopeKey]);

  const list = listView.key === scopeKey ? listView : undefined;
  const detailKey = openPlaceId === undefined ? undefined : `${scopeKey}\u0000${openPlaceId}`;
  const detail = detailKey !== undefined && detailView.key === detailKey ? detailView : undefined;
  const response = list?.response;
  const places = response?.data.places ?? [];
  const connections = response?.data.connections ?? [];

  const refreshPlaces = (): void => {
    if (list?.refreshing === true) return;
    const generation = ++listGeneration.current;
    const key = scopeKey;
    setListView((current) => current.key === key ? { ...current, refreshing: true } : { key, refreshing: true });
    refreshExplorePlaces({
      ...(accountId === undefined ? {} : { accountId }),
      ...(vesselId === undefined ? {} : { vesselId })
    }).then(
      (next) => {
        if (listGeneration.current !== generation) return;
        setListView({ key, response: next });
      },
      (error: unknown) => {
        if (listGeneration.current !== generation) return;
        setListView((current) => current.key === key
          ? { ...current, refreshing: false, refreshError: errorText(error) }
          : { key, refreshing: false, refreshError: errorText(error) });
      }
    );
  };

  const refreshPlace = (): void => {
    if (openPlaceId === undefined || detailKey === undefined || detailRefreshLock.current !== undefined) return;
    const generation = ++detailGeneration.current;
    const key = detailKey;
    detailRefreshLock.current = generation;
    setDetailView((current) => ({
      key,
      refreshing: true,
      ...(current.key !== key || current.response === undefined ? {} : { response: current.response })
    }));
    refreshExplorePlace(openPlaceId, {
      ...(accountId === undefined ? {} : { accountId }),
      ...(vesselId === undefined ? {} : { vesselId })
    }).then(
      (next) => {
        if (detailGeneration.current !== generation) return;
        detailRefreshLock.current = undefined;
        setDetailView({ key, response: next });
      },
      (error: unknown) => {
        if (detailGeneration.current !== generation) return;
        detailRefreshLock.current = undefined;
        setDetailView((current) => current.key === key
          ? { ...current, refreshing: false, refreshError: errorText(error) }
          : { key, refreshing: false, refreshError: errorText(error) });
      }
    );
  };

  const createPlan = (): void => {
    if (accountId === undefined || origin === undefined || destination === undefined || createLock.current !== undefined) return;
    const generation = ++planGeneration.current;
    const scope = scopeKey;
    createLock.current = generation;
    setCreating(true);
    createRoutePlan({ accountId, from: origin, to: destination }).then(
      (result) => {
        if (planGeneration.current !== generation || scopeRef.current !== scope) return;
        setCreating(false);
        createLock.current = undefined;
        const plan = result.data.plan;
        setPlanView(plan.accountId === accountId && plan.from === origin && plan.to === destination
          ? { scopeKey: scope, key: `created\u0000${plan.id}`, plan }
          : { scopeKey: scope, failure: 'The created plan returned unexpected ownership or endpoints.' });
      },
      (error: unknown) => {
        if (planGeneration.current !== generation || scopeRef.current !== scope) return;
        setCreating(false);
        createLock.current = undefined;
        setPlanView({ scopeKey: scope, key: 'created', failure: errorText(error) });
      }
    );
  };

  const usePlan = (): void => {
    if (accountId === undefined || vesselId === undefined || planView.plan === undefined) return;
    onOpenLogistics?.({
      accountId,
      vesselId,
      routePlanId: planView.plan.id
    });
  };

  const detailPlaces = detail?.response === undefined
    ? places
    : [detail.response.data.place, ...detail.response.data.onward, ...places];
  const currentPlace = detail?.response?.data.place
    ?? (openPlaceId === undefined ? undefined : places.find((place) => place.id === openPlaceId));

  const incomingConnections = detail?.response === undefined || currentPlace === undefined
    ? []
    : detail.response.data.connections.filter((connection) => connection.to === currentPlace.id && connection.from !== currentPlace.id);
  const outgoingConnections = detail?.response === undefined || currentPlace === undefined
    ? []
    : detail.response.data.connections.filter((connection) => connection.from === currentPlace.id && connection.to !== currentPlace.id);

  const boundaryOrigins = connections
    .map((connection) => connection.from)
    .filter((id, index, values) => values.indexOf(id) === index && !places.some((place) => place.id === id));
  const position = positionFrom(response, accountId, vesselId);
  const positions = (response?.data.positions ?? []).filter((entry) => entry.accountId === accountId && entry.vesselId === vesselId);
  const currentPorts = new Set(positions.filter((entry) => entry.state === 'available' && entry.status === 'active' && entry.portId).map((entry) => entry.portId));
  const geographyEmpty = response !== undefined
    && response.data.places.length === 0
    && response.data.connections.length === 0
    && response.data.areas.length === 0
    && response.data.maps.length === 0
    && response.data.listings.length === 0
    && response.data.capabilities.length === 0
    && response.data.blockers.length === 0;

  return (
    <section aria-label="Explore" className={styles.explore}>
      <h2 className={styles.heading}>Explore</h2>

      <section className={styles.section} aria-label="Retained geography">
        <header className={styles.controls}>
          <h3 className={styles.subheading}>Retained geography</h3>
          <Button className={styles.button} onPress={refreshPlaces} isPending={list?.refreshing === true}>
            Refresh places
          </Button>
        </header>
        {list === undefined || list.loading === true ? <p className={styles.status}>Reading retained places…</p> : null}
        {list?.failure === undefined ? null : (
          <p className={styles.failure} role="alert">Retained places unavailable: {list.failure}</p>
        )}
        {list?.refreshError === undefined ? null : (
          <p className={styles.failure} role="alert">
            Places refresh failed: {list.refreshError}. Retained geography is unchanged.
          </p>
        )}
        {response === undefined ? null : (
          <>
            {geographyEmpty ? <p className={styles.status}>No retained places are published for this scope.</p> : null}
            {response.data.places.length === 0 ? null : (
              <section className={styles.section} aria-label="Places">
                <h4 className={styles.subheading}>Places</h4>
                <ul className={styles.list}>
                  {response.data.places.map((place) => (
                    <li key={place.id} className={styles.item}>
                      <p className={styles.name}>{recordName(place)}</p>
                      <p className={styles.meta}>
                        {place.type} · {stateLabel(place.state)}
                        {place.territoryId === undefined ? '' : ` · Territory ${place.territoryId}`}
                      </p>
                      {place.error === undefined ? null : <p className={styles.failure}>{place.error}</p>}
                      <div className={styles.controls}>
                        <Button className={styles.button} onPress={() => setOpenPlaceId(place.id)}>
                          {`Open ${recordName(place)}`}
                        </Button>
                        {place.type !== 'Port' ? null : (
                          <Button className={styles.button} onPress={() => setOrigin(place.id)}>
                            {`Set ${recordName(place)} as origin`}
                          </Button>
                        )}
                      </div>
                      <details className={styles.details}>
                        <summary>Place details</summary>
                        <p className={styles.meta}>Exact ID: {place.id}</p>
                        <p className={styles.meta}>Authority: {place.authorityId}</p>
                      </details>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {connections.length === 0 ? null : (
              <section className={styles.section} aria-label="Directed connections">
                <h4 className={styles.subheading}>Directed connections</h4>
                <ul className={styles.list}>
                  {connections.map((connection) => (
                    <ConnectionLine key={connection.id} connection={connection} places={places} />
                  ))}
                </ul>
              </section>
            )}
            <ResourceList label="Areas" records={response.data.areas} onReadResource={onReadResource} />
            <ResourceList label="Maps" records={response.data.maps} onReadResource={onReadResource} />
            <ResourceList label="Listings" records={response.data.listings} onReadResource={onReadResource} />
            <Sources observations={response.observations} />
          </>
        )}
      </section>

      {vesselId === undefined ? null : (
        <section className={styles.section} aria-label="Vessel position evidence">
          <h3 className={styles.subheading}>Vessel position evidence</h3>
          <p className={styles.meta}>Vessel: {vesselId}</p>
          {currentPorts.size > 1 ? (
            <p className={styles.status}>Conflicting current port observations; Nearby has no confirmed origin.</p>
          ) : position === undefined ? (
            <p className={styles.status}>No current active port is confirmed for Nearby. Missing or stale position is not evidence of an empty fleet or permission to travel.</p>
          ) : null}
          <ul className={styles.list}>
            {positions.map((entry, index) => (
              <li key={`${entry.authorityId}\u0000${entry.source}\u0000${index}`} className={styles.item}>
                <p className={styles.meta}>{stateLabel(entry.state)} · {entry.status}{entry.observedAt === undefined ? '' : ` · ${entry.observedAt}`}</p>
                <p className={styles.meta}>Authority: {entry.authorityId}</p>
                <p className={styles.source}>{entry.source}</p>
                {entry.portId === undefined ? null : <p className={styles.meta}>Port: {entry.portId}</p>}
                {entry.error === undefined ? null : <p className={styles.failure}>{entry.error}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className={styles.section} aria-label="Route planning">
        <header className={styles.controls}>
          <h3 className={styles.subheading}>Plan a directed route</h3>
          <Button className={styles.button} onPress={() => setPickerOpen(true)}>
            Choose destination
          </Button>
           <Button className={styles.button} onPress={createPlan} isDisabled={accountId === undefined || origin === undefined || destination === undefined} isPending={creating}>
            Create route plan
          </Button>
        </header>
        <p className={styles.meta}>Origin: {origin === undefined ? 'not chosen' : placeName(origin, places)}</p>
        <p className={styles.meta}>Destination: {destination === undefined ? 'not chosen' : placeName(destination, places)}</p>
        {boundaryOrigins.length === 0 ? null : (
          <div className={styles.controls}>
            {boundaryOrigins.map((id) => (
              <Button key={id} className={styles.button} onPress={() => setOrigin(id)}>
                {`Set ${id} as origin`}
              </Button>
            ))}
          </div>
        )}
        {planView.loading === true ? <p className={styles.status}>Reading the retained route plan…</p> : null}
        {planView.failure === undefined ? null : (
          <p className={styles.failure} role="alert">Route plan unavailable: {planView.failure}</p>
        )}
        {planView.plan === undefined ? null : (
          <section className={styles.section} aria-label="Proposed route">
            <h4 className={styles.subheading}>Proposed route</h4>
            <p className={styles.meta}>{`${planView.plan.from} → ${planView.plan.to}`}</p>
            <p className={styles.meta}>Plan ID: {planView.plan.id}</p>
            <ul className={styles.list}>
              {planView.plan.legs.map((leg) => (
                <li key={`${leg.routeId}\u0000${leg.from}\u0000${leg.to}`} className={styles.item}>
                  <p className={styles.name}>{connections.find((connection) => connection.id === leg.routeId)?.name ?? leg.routeId}</p>
                  <p className={styles.meta}>{`${placeName(leg.from, places)} → ${placeName(leg.to, places)}`}</p>
                  <details className={styles.details}>
                    <summary>Leg details</summary>
                    <p className={styles.meta}>Route: {leg.routeId}</p>
                    <p className={styles.meta}>From: {leg.from}</p>
                    <p className={styles.meta}>To: {leg.to}</p>
                    <p className={styles.meta}>Territory: {leg.territoryId}</p>
                  </details>
                </li>
              ))}
            </ul>
            {planView.plan.blockers.length === 0 ? null : (
              <ul className={styles.list}>
                {planView.plan.blockers.map((blocker) => (
                  <li key={`${blocker.id}\u0000${blocker.source}`} className={styles.item}>
                    <p className={styles.meta}>{blocker.message}</p>
                    <p className={styles.meta}>{stateLabel(blocker.state)}</p>
                  </li>
                ))}
              </ul>
            )}
             <Button className={styles.button} onPress={usePlan} isDisabled={vesselId === undefined || onOpenLogistics === undefined}>
              Use this plan
            </Button>
          </section>
        )}
      </section>

      {detail === undefined ? null : (
        <section className={styles.section} aria-label="Place detail">
          <Button className={styles.button} onPress={refreshPlace} isPending={detail.refreshing === true}>
            Refresh selected place
          </Button>
          {detail.loading === true ? <p className={styles.status}>Reading the retained place…</p> : null}
          {detail.failure === undefined ? null : (
            <p className={styles.failure} role="alert">Place detail unavailable: {detail.failure}</p>
          )}
          {detail.refreshError === undefined ? null : (
            <p className={styles.failure} role="alert">Place refresh failed: {detail.refreshError}. Retained detail is unchanged.</p>
          )}
          {detail.response === undefined || currentPlace === undefined ? null : (
            <>
              <header className={styles.controls}>
                <h3 className={styles.subheading}>{recordName(currentPlace)}</h3>
                {onReadResource === undefined ? null : (
                  <Button
                    className={styles.button}
                    onPress={() => onReadResource({ id: currentPlace.authorityId, authorityId: currentPlace.authorityId })}
                  >
                    {`Open authority for ${recordName(currentPlace)}`}
                  </Button>
                )}
              </header>
              {currentPlace.error === undefined ? null : <p className={styles.failure}>{currentPlace.error}</p>}
              <details className={styles.details}>
                <summary>Place identity</summary>
                <p className={styles.meta}>Exact ID: {currentPlace.id}</p>
                <p className={styles.meta}>Authority: {currentPlace.authorityId}</p>
              </details>
              {detail.response.data.onward.length === 0 ? null : (
                <section className={styles.section} aria-label="Onward places">
                  <h4 className={styles.subheading}>Onward places</h4>
                  <ul className={styles.list}>
                    {detail.response.data.onward.map((place) => (
                      <li key={place.id} className={styles.item}>
                        <p className={styles.name}>{recordName(place)}</p>
                        <p className={styles.meta}>{place.type} · {stateLabel(place.state)}</p>
                        <details className={styles.details}>
                          <summary>Onward details</summary>
                          <p className={styles.meta}>Exact ID: {place.id}</p>
                          <p className={styles.meta}>Authority: {place.authorityId}</p>
                        </details>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <section className={styles.section} aria-label="Incoming connections">
                <h4 className={styles.subheading}>Incoming connections</h4>
                {incomingConnections.length === 0 ? (
                  <p className={styles.status}>No incoming directed connection is retained.</p>
                ) : (
                  <ul className={styles.list}>
                    {incomingConnections.map((connection) => (
                      <ConnectionLine key={connection.id} connection={connection} places={detailPlaces} />
                    ))}
                  </ul>
                )}
              </section>
              <section className={styles.section} aria-label="Outgoing connections">
                <h4 className={styles.subheading}>Outgoing connections</h4>
                {outgoingConnections.length === 0 ? (
                  <p className={styles.status}>No outgoing directed connection is retained.</p>
                ) : (
                  <ul className={styles.list}>
                    {outgoingConnections.map((connection) => (
                      <ConnectionLine key={connection.id} connection={connection} places={detailPlaces} />
                    ))}
                  </ul>
                )}
              </section>
              <ResourceList label="Areas" records={detail.response.data.areas} onReadResource={onReadResource} />
              <ResourceList label="Maps" records={detail.response.data.maps} onReadResource={onReadResource} />
              <ResourceList label="Listings" records={detail.response.data.listings} onReadResource={onReadResource} />
              <CapabilityList
                capabilities={detail.response.data.capabilities}
                accountId={accountId}
                vesselId={vesselId}
                place={currentPlace}
                onOpenProduction={onOpenProduction}
              />
              {detail.response.data.blockers.length === 0 ? null : (
                <section className={styles.section} aria-label="Place blockers">
                  <h4 className={styles.subheading}>Known blockers</h4>
                  <ul className={styles.list}>
                    {detail.response.data.blockers.map((blocker) => (
                      <li key={`${blocker.id}\u0000${blocker.source}`} className={styles.item}>
                        <p className={styles.meta}>{blocker.message}</p>
                        <p className={styles.source}>{blocker.source}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <Sources observations={detail.response.observations} />
            </>
          )}
        </section>
      )}

      {pickerOpen ? (
        <ReferencePicker
          {...(accountId === undefined ? {} : { accountId })}
          selection={{ kind: 'port', fieldLabel: 'Destination Port' }}
          source={{ kind: 'explore', ...(response === undefined ? {} : { response }), ...(list?.loading === true ? { loading: true } : {}), ...(list?.failure === undefined ? {} : { error: list.failure }) }}
          refreshing={list?.refreshing === true}
          onRefresh={refreshPlaces}
          onSelect={(id) => { setDestination(id); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
          {...(position === undefined ? {} : { position })}
        />
      ) : null}
    </section>
  );
}
