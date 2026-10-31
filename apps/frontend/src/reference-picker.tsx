import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import {
  Button,
  Dialog,
  Heading,
  Input,
  Label,
  Modal,
  ModalOverlay,
  TextField
} from 'react-aria-components';
import type {
  ExploreConnectionRecord,
  ExploreResourceRecord,
  LibraryEntry,
  SourcedObservation
} from '@fctp/client-sdk';
import type { ExplorePlacesResponse, LibraryResponse } from './application-api';
import { ResourceReader } from './resource-reader';
import cssStyles from './reference-picker.module.css';

export type ReferencePickerKind = 'asset' | 'variety' | 'port' | 'area';

export interface ReferencePickerSelection {
  kind: ReferencePickerKind;
  fieldLabel: string;
}

export interface ReferencePickerPosition {
  vesselId: string;
  portId: string;
}

export type ReferencePickerSource =
  | { kind: 'library'; response?: LibraryResponse; loading?: boolean; error?: string }
  | { kind: 'explore'; response?: ExplorePlacesResponse; loading?: boolean; error?: string };

export interface ReferencePickerProps {
  accountId?: string;
  selection: ReferencePickerSelection | undefined;
  source: ReferencePickerSource;
  refreshing?: boolean;
  onRefresh: () => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  position?: ReferencePickerPosition;
}

type ClassName = 'overlay' | 'modal' | 'dialog' | 'header' | 'heading' | 'controls' | 'button'
  | 'meta' | 'error' | 'info' | 'field' | 'label' | 'input' | 'list' | 'candidate'
  | 'candidateHeader' | 'identity' | 'name' | 'actions' | 'provenance' | 'provenanceItem'
  | 'source' | 'details' | 'section' | 'sectionTitle' | 'nearbyItem';

const styles = cssStyles as Record<ClassName, string>;

interface Candidate {
  id: string;
  name: string;
  summary: string[];
  searchText: string;
}

interface ObservationEntry {
  key: string;
  observation: SourcedObservation<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}

function searchable(values: ReadonlyArray<string | undefined>): string {
  return values.filter((value): value is string => value !== undefined).join(' ').toLowerCase();
}

function stateLabel(state: string): string {
  if (state === 'not-retrieved') return 'Not retrieved';
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function observationTime(observation: SourcedObservation<unknown>): string | undefined {
  return 'observedAt' in observation ? observation.observedAt : undefined;
}

function observationError(observation: SourcedObservation<unknown>): string | undefined {
  return 'error' in observation ? observation.error : undefined;
}

function collectionIds(value: unknown): string[] {
  const lists: unknown[][] = [];
  if (Array.isArray(value)) {
    lists.push(value);
  } else if (isRecord(value)) {
    for (const key of ['assets', 'varieties', 'items', 'orderedItems']) {
      const list = value[key];
      if (Array.isArray(list)) lists.push(list);
    }
  }
  const ids: string[] = [];
  for (const list of lists) {
    for (const entry of list) {
      if (isRecord(entry) && typeof entry.id === 'string') ids.push(entry.id);
    }
  }
  return ids;
}

function observationMatchesId(observation: SourcedObservation<unknown>, id: string): boolean {
  if (observation.source === id) return true;
  if (!('value' in observation) || observation.value === undefined) return false;
  return collectionIds(observation.value).includes(id);
}

function libraryCandidates(kind: 'asset' | 'variety', entries: LibraryEntry[]): Candidate[] {
  return entries.map((entry) => {
    const record = entry as unknown as Record<string, unknown>;
    const name = entry.name ?? entry.id;
    const type = entry.type ?? (kind === 'asset' ? 'Asset' : 'Variety');
    const summary = [type];
    if (kind === 'asset' && entry.holder !== undefined) summary.push(`Holder ${entry.holder}`);
    if (kind === 'variety' && entry.asset !== undefined) summary.push(`Asset ${entry.asset}`);
    return {
      id: entry.id,
      name,
      summary,
      searchText: searchable([
        entry.id,
        entry.name,
        entry.type,
        entry.holder,
        entry.asset,
        entry.variety,
        entry.grantee,
        stringField(record, 'territoryId'),
        stringField(record, 'areaId'),
        stringField(record, 'authorityId')
      ])
    };
  });
}

function exploreCandidate(record: ExploreResourceRecord | LibraryEntry, fallbackType: string): Candidate {
  const values = record as unknown as Record<string, unknown>;
  const type = stringField(values, 'type') ?? fallbackType;
  const territoryId = stringField(values, 'territoryId');
  const authorityId = stringField(values, 'authorityId');
  const name = stringField(values, 'name') ?? record.id;
  const summary = [type];
  if (territoryId !== undefined) summary.push(`Territory ${territoryId}`);
  if (authorityId !== undefined) summary.push(`Authority ${authorityId}`);
  return {
    id: record.id,
    name,
    summary,
    searchText: searchable([
      record.id,
      name,
      type,
      territoryId,
      authorityId,
      stringField(values, 'areaId'),
      stringField(values, 'listingsId'),
      stringField(values, 'state')
    ])
  };
}

function observationsOf(response: LibraryResponse | ExplorePlacesResponse | undefined): ObservationEntry[] {
  if (response === undefined) return [];
  return Object.entries(response.observations).map(([key, observation]) => ({ key, observation }));
}

function Provenance({ id, observations }: { id: string; observations: ObservationEntry[] }): ReactElement {
  const matched = observations.filter(({ observation }) => observationMatchesId(observation, id));
  if (matched.length === 0) {
    return <p className={styles.meta}>Provenance unknown: no matching observation names this reference.</p>;
  }
  return (
    <div className={styles.provenance}>
      {matched.map(({ key, observation }) => {
        const time = observationTime(observation);
        const error = observationError(observation);
        return (
          <div key={key} className={styles.provenanceItem}>
            <p className={styles.meta}>
              {stateLabel(observation.state)}
              {time === undefined ? '' : ` · ${time}`}
              {error === undefined ? '' : ` · ${error}`}
            </p>
            <p className={styles.source}>{observation.source}</p>
          </div>
        );
      })}
    </div>
  );
}

function IndependentSources({ observations }: { observations: ObservationEntry[] }): ReactElement | null {
  const independent = observations.filter(({ observation }) => (
    observation.state === 'unavailable' || observation.state === 'not-retrieved'
  ));
  if (independent.length === 0) return null;
  return (
    <section className={styles.section} aria-label="Independent source observations">
      <h3 className={styles.sectionTitle}>Independent source observations</h3>
      <ul className={styles.list}>
        {independent.map(({ key, observation }) => {
          const time = observationTime(observation);
          const error = observationError(observation);
          return (
            <li key={key} className={styles.provenanceItem}>
              <p className={styles.meta}>
                {stateLabel(observation.state)}
                {time === undefined ? '' : ` · ${time}`}
                {error === undefined ? '' : ` · ${error}`}
              </p>
              <p className={styles.source}>{observation.source}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PortConnectivity({
  id,
  position,
  connections
}: {
  id: string;
  position: ReferencePickerPosition | undefined;
  connections: ExploreConnectionRecord[];
}): ReactElement {
  if (position === undefined) {
    return <p className={styles.meta}>Connectivity unknown: no vessel position is available.</p>;
  }
  if (id === position.portId) {
    return <p className={styles.meta}>Current vessel position.</p>;
  }
  const outgoing = connections.filter((connection) => (
    connection.from === position.portId && connection.to === id
  ));
  if (outgoing.length === 0) {
    return <p className={styles.meta}>Connectivity unknown: no directed outgoing connection from the current position is known.</p>;
  }
  return (
    <>
      {outgoing.map((connection) => (
        <p key={connection.id} className={styles.meta}>
          {`Directed connection from ${connection.from} to ${connection.to}. Admission is unknown. ${stateLabel(connection.state ?? 'not-retrieved')}`}
          {connection.error === undefined ? '' : ` · ${connection.error}`}
        </p>
      ))}
    </>
  );
}

function NearbySection({
  places,
  connections,
  position
}: {
  places: Candidate[];
  connections: ExploreConnectionRecord[];
  position: ReferencePickerPosition;
}): ReactElement {
  const destinations = new Map(places.map((candidate) => [candidate.id, candidate] as const));
  const outgoing = connections.filter((connection) => (
    connection.from === position.portId && destinations.has(connection.to)
  ));
  return (
    <section className={styles.section} aria-label="Nearby ports">
      <h3 className={styles.sectionTitle}>Nearby ports for {position.vesselId}</h3>
      {outgoing.length === 0 ? (
        <p className={styles.meta}>No directed outgoing connections are known from the current position.</p>
      ) : (
        <ul className={styles.list}>
          {outgoing.map((connection) => {
            const destination = destinations.get(connection.to);
            return (
              <li key={connection.id} className={styles.nearbyItem}>
                <p className={styles.name}>{destination?.name ?? connection.to}</p>
                <p className={styles.meta}>
                  Directed connection from {connection.from} to {connection.to}. Admission is unknown.
                </p>
                <p className={styles.meta}>
                  {stateLabel(connection.state ?? 'not-retrieved')}
                  {connection.error === undefined ? '' : ` · ${connection.error}`}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function ReferencePicker(props: ReferencePickerProps): ReactElement | null {
  const { accountId, selection, source, refreshing, onRefresh, onSelect, onClose, position } = props;
  const [query, setQuery] = useState('');
  const [inspectTarget, setInspectTarget] = useState<Candidate | undefined>();
  const inspectButtons = useRef(new Map<string, HTMLButtonElement>());
  const previousAccount = useRef(accountId);
  const open = useRef(selection !== undefined);
  open.current = selection !== undefined;
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;

  useEffect(() => {
    if (previousAccount.current === accountId) return;
    previousAccount.current = accountId;
    if (open.current) closeCallback.current();
  }, [accountId]);

  const selectionKind = selection?.kind;
  const fieldLabel = selection?.fieldLabel;
  useEffect(() => {
    setQuery('');
    setInspectTarget(undefined);
  }, [selectionKind, fieldLabel]);

  if (selection === undefined || previousAccount.current !== accountId) return null;

  const expectedSource = selection.kind === 'asset' || selection.kind === 'variety' ? 'library' : 'explore';
  const mismatched = source.kind !== expectedSource;
  const observations = observationsOf(source.response);
  let candidates: Candidate[] = [];
  if (!mismatched && source.response !== undefined) {
    if (source.kind === 'library' && (selection.kind === 'asset' || selection.kind === 'variety')) {
      candidates = libraryCandidates(
        selection.kind,
        selection.kind === 'asset' ? source.response.data.assets : source.response.data.varieties
      );
    } else if (source.kind === 'explore' && (selection.kind === 'port' || selection.kind === 'area')) {
      candidates = selection.kind === 'port'
        ? source.response.data.places.map((place) => exploreCandidate(place, 'Port'))
        : source.response.data.areas.map((area) => exploreCandidate(area, 'Area'));
    }
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visible = normalizedQuery === ''
    ? candidates
    : candidates.filter((candidate) => candidate.searchText.includes(normalizedQuery));

  const handleReaderClose = (): void => {
    const id = inspectTarget?.id;
    setInspectTarget(undefined);
    if (id === undefined) return;
    const button = inspectButtons.current.get(id);
    if (button !== undefined) requestAnimationFrame(() => { button.focus(); });
  };

  return (
    <>
      <ModalOverlay
        isOpen
        isDismissable
        onOpenChange={(next) => { if (!next) onClose(); }}
        className={styles.overlay}
      >
        <Modal className={styles.modal}>
          <Dialog className={styles.dialog}>
            <header className={styles.header}>
              <Heading slot="title" level={2} className={styles.heading}>{selection.fieldLabel}</Heading>
              <div className={styles.controls}>
                <Button
                  className={styles.button}
                  onPress={onRefresh}
                  isDisabled={source.loading === true}
                  isPending={refreshing === true}
                >
                  Refresh
                </Button>
                <Button className={styles.button} onPress={onClose}>Cancel</Button>
              </div>
            </header>

            {mismatched ? (
              <p className={styles.error}>
                This {source.kind} source does not provide {selection.kind} candidates.
              </p>
            ) : (
              <>
                <p className={styles.info}>
                  Local filtering over retained candidate data. Searching does not contact the server.
                </p>
                {source.loading === true ? <p className={styles.meta}>Loading retained candidates…</p> : null}
                {source.error === undefined ? null : (
                  <p className={styles.error} role="alert">
                    The retained candidates could not be read: {source.error}
                  </p>
                )}
                {source.loading !== true && source.error === undefined && source.response === undefined ? (
                  <p className={styles.meta}>No retained candidate data is available.</p>
                ) : null}
                {source.loading !== true && source.response !== undefined ? (
                  <>
                    <TextField className={styles.field} value={query} onChange={setQuery}>
                      <Label className={styles.label}>Search retained candidates</Label>
                      <Input className={styles.input} />
                    </TextField>
                    {visible.length === 0 ? (
                      <p className={styles.meta}>No candidates match the local filter.</p>
                    ) : (
                      <ul className={styles.list}>
                        {visible.map((candidate) => (
                          <li key={candidate.id} className={styles.candidate}>
                            <div className={styles.candidateHeader}>
                              <div className={styles.identity}>
                                <p className={styles.name}>{candidate.name}</p>
                                <p className={styles.meta}>{candidate.summary.join(' · ')}</p>
                              </div>
                              <div className={styles.actions}>
                                <Button className={styles.button} onPress={() => onSelect(candidate.id)}>
                                  {`Select ${candidate.name}`}
                                </Button>
                                <Button
                                  className={styles.button}
                                  ref={(node) => {
                                    if (node === null) {
                                      inspectButtons.current.delete(candidate.id);
                                    } else {
                                      inspectButtons.current.set(candidate.id, node);
                                    }
                                  }}
                                  onPress={() => setInspectTarget(candidate)}
                                >
                                  {`Inspect ${candidate.name}`}
                                </Button>
                              </div>
                            </div>
                            {selection.kind === 'port' && source.kind === 'explore' ? (
                              <PortConnectivity
                                id={candidate.id}
                                position={position}
                                connections={source.response?.data.connections ?? []}
                              />
                            ) : null}
                            <Provenance id={candidate.id} observations={observations} />
                            <details className={styles.details}>
                              <summary>Reference details</summary>
                              <p className={styles.meta}>Exact ID: {candidate.id}</p>
                              {candidate.summary.length === 0 ? null : (
                                <p className={styles.meta}>{candidate.summary.join(' · ')}</p>
                              )}
                            </details>
                          </li>
                        ))}
                      </ul>
                    )}
                    {selection.kind === 'port' && source.kind === 'explore' ? (
                      position === undefined ? (
                        <p className={styles.meta}>
                          Nearby position is unavailable because no vessel position was supplied.
                        </p>
                      ) : (
                        <NearbySection
                          places={candidates}
                          connections={source.response.data.connections}
                          position={position}
                        />
                      )
                    ) : null}
                  </>
                ) : null}
                <IndependentSources observations={observations} />
              </>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
      {inspectTarget === undefined ? null : (
        <ResourceReader
          resource={{ id: inspectTarget.id }}
          {...(accountId === undefined ? {} : { accountId })}
          onClose={handleReaderClose}
        />
      )}
    </>
  );
}
