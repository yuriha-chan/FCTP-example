import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button, Dialog, Heading, Modal, ModalOverlay } from 'react-aria-components';
import type { SourcedObservation } from '@fctp/client-sdk';
import { formatResource } from './presentation';
import {
  readResourceReader,
  refreshResourceReader,
  type ResourceReaderResponse
} from './application-api';
import cssStyles from './resource-reader.module.css';

type ClassName = 'overlay' | 'modal' | 'dialog' | 'header' | 'heading' | 'controls' | 'button'
  | 'meta' | 'body' | 'error' | 'description' | 'text' | 'section' | 'sectionTitle' | 'list'
  | 'mediaItem' | 'details' | 'technical' | 'references';

const styles = cssStyles as Record<ClassName, string>;

export interface ResourceReference {
  id: string;
  authorityId?: string;
}

export interface ResourceReaderProps {
  resource: ResourceReference | undefined;
  accountId?: string;
  onClose: () => void;
}

interface ReaderView {
  key?: string | undefined;
  response?: ResourceReaderResponse | undefined;
  failure?: string | undefined;
  loading?: boolean | undefined;
  refreshing?: boolean | undefined;
  refreshError?: string | undefined;
}

interface LinkedReference {
  key: string;
  id: string;
  authorityId?: string;
}

const referenceKeys = ['creator', 'holder', 'asset', 'assets', 'varieties', 'media', 'resources', 'variety', 'grantee'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function observationOf(response: ResourceReaderResponse): SourcedObservation<unknown> | undefined {
  return Object.values(response.observations).find((observation) => observation.source === response.data.resourceId);
}

function observationTime(observation: SourcedObservation<unknown> | undefined): string | undefined {
  return observation !== undefined && 'observedAt' in observation ? observation.observedAt : undefined;
}

function observationError(observation: SourcedObservation<unknown> | undefined): string | undefined {
  return observation !== undefined && 'error' in observation ? observation.error : undefined;
}

function stateLabel(state: string): string {
  if (state === 'not-retrieved') return 'Not retrieved';
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function addReference(target: LinkedReference[], seen: Set<string>, reference: LinkedReference): void {
  if (!URL.canParse(reference.id) || !['http:', 'https:'].includes(new URL(reference.id).protocol)) return;
  const identity = `${reference.key}\u0000${reference.id}\u0000${reference.authorityId ?? ''}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  target.push(reference);
}

function collectReference(value: unknown, key: string, target: LinkedReference[], seen: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectReference(entry, key, target, seen);
    return;
  }
  if (typeof value === 'string') {
    if (value.trim()) addReference(target, seen, { key, id: value });
    return;
  }
  if (!isRecord(value)) return;
  const id = typeof value.url === 'string' ? value.url : typeof value.id === 'string' ? value.id : undefined;
  if (id !== undefined) {
    addReference(target, seen, {
      key,
      id,
      ...(typeof value.authorityId === 'string' ? { authorityId: value.authorityId } : {})
    });
    return;
  }
  for (const entry of Object.values(value)) collectReference(entry, key, target, seen);
}

function linkedReferences(value: unknown): LinkedReference[] {
  if (!isRecord(value)) return [];
  const references: LinkedReference[] = [];
  const seen = new Set<string>();
  for (const key of referenceKeys) collectReference(value[key], key, references, seen);
  return references;
}

function mediaObservations(response: ResourceReaderResponse): SourcedObservation<unknown>[] {
  const mainSource = response.data.resourceId;
  const seen = new Set<string>();
  const media: SourcedObservation<unknown>[] = [];
  for (const observation of Object.values(response.observations)) {
    if (observation.source === mainSource || seen.has(observation.source)) continue;
    seen.add(observation.source);
    media.push(observation);
  }
  return media;
}

export function ResourceReader(props: ResourceReaderProps): ReactElement | null {
  const { resource, accountId, onClose } = props;
  const [navigation, setNavigation] = useState<{ base: string; reference: ResourceReference } | undefined>();
  const [view, setView] = useState<ReaderView>({});
  const generation = useRef(0);
  const previousAccount = useRef(accountId);
  const closeCallback = useRef(onClose);

  useEffect(() => {
    closeCallback.current = onClose;
  }, [onClose]);

  const propKey = resource === undefined ? '' : `${resource.id}\u0000${resource.authorityId ?? ''}`;
  const active = navigation !== undefined && navigation.base === propKey ? navigation.reference : resource;

  useEffect(() => {
    setNavigation(undefined);
  }, [propKey]);

  const activeKey = active === undefined
    ? undefined
    : `${active.id}\u0000${active.authorityId ?? ''}\u0000${accountId ?? ''}`;

  useEffect(() => {
    const current = ++generation.current;
    const previous = previousAccount.current;
    previousAccount.current = accountId;
    if (active === undefined) {
      setView({});
      return;
    }
    if (previous !== accountId) {
      setView({});
      setNavigation(undefined);
      closeCallback.current();
      return;
    }
    const key = `${active.id}\u0000${active.authorityId ?? ''}\u0000${accountId ?? ''}`;
    setView({ key, loading: true });
    const input = {
      ...(accountId === undefined ? {} : { accountId }),
      ...(active.authorityId === undefined ? {} : { authorityId: active.authorityId })
    };
    readResourceReader(active.id, input).then(
      (response) => {
        if (current !== generation.current) return;
        setView({ key, response, loading: false });
      },
      (error: unknown) => {
        if (current !== generation.current) return;
        setView({ key, failure: errorText(error), loading: false });
      }
    );
    return () => {
      generation.current += 1;
    };
  }, [active?.id, active?.authorityId, accountId]);

  const handleClose = (): void => {
    generation.current += 1;
    setNavigation(undefined);
    setView({});
    onClose();
  };

  const handleRefresh = (): void => {
    if (active === undefined || view.refreshing === true) return;
    const current = ++generation.current;
    const key = `${active.id}\u0000${active.authorityId ?? ''}\u0000${accountId ?? ''}`;
    setView((value) => (value.key === key ? { ...value, refreshing: true, refreshError: undefined } : value));
    const input = {
      ...(accountId === undefined ? {} : { accountId }),
      ...(active.authorityId === undefined ? {} : { authorityId: active.authorityId })
    };
    refreshResourceReader(active.id, input).then(
      (response) => {
        if (current !== generation.current) return;
        setView({ key, response, loading: false });
      },
      (error: unknown) => {
        if (current !== generation.current) return;
        setView((value) => (value.key === key ? { ...value, refreshing: false, refreshError: errorText(error) } : value));
      }
    );
  };

  if (resource === undefined) return null;

  const isCurrent = active !== undefined && view.key === activeKey;
  const response = isCurrent ? view.response : undefined;
  const failure = isCurrent ? view.failure : undefined;
  const loading = active !== undefined && (!isCurrent || view.loading === true);

  const value = response?.data.value;
  const record = isRecord(value) ? value : undefined;
  const name = record !== undefined && typeof record.name === 'string' ? record.name : undefined;
  const description = record !== undefined && typeof record.description === 'string' ? record.description : undefined;
  const observation = response === undefined ? undefined : observationOf(response);
  const source = observation?.source ?? response?.data.resourceId ?? active?.id ?? '';
  const observedAt = observationTime(observation);
  const observationErrorMessage = observationError(observation);
  const state = observation?.state ?? 'not-retrieved';
  const title = loading ? 'Loading resource' : name ?? (typeof value === 'string' ? 'Resource text' : 'Resource');
  const references = response === undefined ? [] : linkedReferences(response.data.value);
  const media = response === undefined ? [] : mediaObservations(response);
  const technical = value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);

  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => { if (!open) handleClose(); }}
      className={styles.overlay}
    >
      <Modal className={styles.modal}>
        <Dialog className={styles.dialog}>
          <header className={styles.header}>
            <Heading slot="title" level={2} className={styles.heading}>{title}</Heading>
            <div className={styles.controls}>
              <Button className={styles.button} onPress={handleRefresh} isDisabled={loading} isPending={view.refreshing === true}>
                Refresh
              </Button>
              <Button className={styles.button} onPress={handleClose}>
                Close
              </Button>
            </div>
          </header>

          {loading ? (
            <p className={styles.meta}>Reading the retained resource…</p>
          ) : failure !== undefined ? (
            <div className={styles.body}>
              <p className={styles.meta}>Resource unavailable</p>
              <p className={styles.error}>The resource could not be read: {failure}</p>
              <p className={styles.meta}>Use Refresh to try again.</p>
            </div>
          ) : response !== undefined ? (
            <div className={styles.body}>
              <p className={styles.meta}>
                {stateLabel(state)}
                {observedAt === undefined ? '' : ` · ${observedAt}`}
                {observationErrorMessage === undefined ? '' : ` · ${observationErrorMessage}`}
              </p>
              {view.refreshError === undefined ? null : (
                <p className={styles.error}>Refresh failed: {view.refreshError}</p>
              )}
              {description === undefined ? null : <p className={styles.description}>{description}</p>}
              {value === undefined ? (
                <p className={styles.meta}>No retained body is available. Use Refresh to read this resource.</p>
              ) : typeof value === 'string' ? (
                <pre className={styles.text}>{value}</pre>
              ) : (
                <pre className={styles.text}>{formatResource(value)}</pre>
              )}

              {media.length === 0 ? null : (
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>Media</h3>
                  <ul className={styles.list}>
                    {media.map((entry) => {
                      const mediaValue = 'value' in entry ? entry.value : undefined;
                      const mediaError = observationError(entry);
                      const mediaTime = observationTime(entry);
                      return (
                        <li key={entry.source} className={styles.mediaItem}>
                          <p className={styles.meta}>
                            {stateLabel(entry.state)}
                            {mediaTime === undefined ? '' : ` · ${mediaTime}`}
                            {mediaError === undefined ? '' : ` · ${mediaError}`}
                          </p>
                          {mediaValue === undefined ? null : typeof mediaValue === 'string' ? (
                            <pre className={styles.text}>{mediaValue}</pre>
                          ) : (
                            <pre className={styles.text}>{formatResource(mediaValue)}</pre>
                          )}
                          <details className={styles.details}>
                            <summary>Media details</summary>
                            <pre className={styles.technical}>{`Source ${entry.source}\nState ${entry.state}${mediaError === undefined ? '' : `\nError ${mediaError}`}`}</pre>
                          </details>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {references.length === 0 ? null : (
                <section className={styles.section}>
                  <h3 className={styles.sectionTitle}>Linked resources</h3>
                  <div className={styles.references}>
                    {references.map((reference, index) => (
                      <Button
                        key={`${reference.key}\u0000${reference.id}\u0000${reference.authorityId ?? ''}`}
                        className={styles.button}
                        onPress={() => setNavigation({ base: propKey, reference })}
                      >
                        {`Read linked ${reference.key} reference${references.length > 1 ? ` ${index + 1}` : ''}`}
                      </Button>
                    ))}
                  </div>
                </section>
              )}

              <details className={styles.details}>
                <summary>Resource details</summary>
                <pre className={styles.technical}>{`Source ${source}\nAuthority ${response.data.authorityId ?? ''}\nState ${state}\nObserved ${observedAt ?? 'not retrieved'}\n${technical}`}</pre>
              </details>
            </div>
          ) : null}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
