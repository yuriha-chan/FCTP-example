import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button, Radio, RadioGroup } from 'react-aria-components';
import type { AuthorityRecord } from '@fctp/client-sdk';
import { AuthorityPicker } from './authority-picker';
import type { AuthorityPickerRole } from './authority-picker';
import { RegistryCard } from './registry-card';
import { TerritoryCard } from './territory-card';
import { UiButton } from './ui';
import cssStyles from './admission-list-editor.module.css';

const styles = cssStyles as Record<
  'editor' | 'header' | 'title' | 'mode' | 'radio' | 'summary' | 'empty' | 'error' | 'unknown'
  | 'selectedList' | 'selectedItem' | 'card' | 'details' | 'addRow' | 'button',
  string
>;

export type AdmissionMode = 'allowlist' | 'denylist';

export interface AdmissionListValue {
  mode: AdmissionMode;
  allowlist: string[];
  denylist: string[];
}

export interface AdmissionListEditorProps {
  label: string;
  role: AuthorityPickerRole;
  value: AdmissionListValue;
  authorities: readonly AuthorityRecord[];
  directoryLoading?: boolean;
  directoryError?: string;
  onRetryDirectory: () => void;
  onChange: (value: AdmissionListValue) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export function readAdmissionList(value: unknown, fallbackMode: AdmissionMode): AdmissionListValue {
  const record = isRecord(value) ? value : {};
  const mode = record.mode === 'allowlist' || record.mode === 'denylist' ? record.mode : fallbackMode;
  return {
    mode,
    allowlist: stringList(record.allowlist),
    denylist: stringList(record.denylist)
  };
}

function displayName(authority: AuthorityRecord | undefined, role: AuthorityPickerRole): string {
  return authority?.name ?? authority?.handle ?? `Unnamed ${role}`;
}

export function AdmissionListEditor(props: AdmissionListEditorProps): ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const rolePlural = props.role === 'registry' ? 'registries' : 'territories';
  const selected = props.value[props.value.mode];
  const byId = new Map(props.authorities.map((authority) => [authority.actorId, authority] as const));

  const updateMode = (mode: AdmissionMode): void => {
    props.onChange({ ...props.value, mode });
  };

  const add = (authority: AuthorityRecord): void => {
    if (selected.includes(authority.actorId)) return;
    props.onChange({
      ...props.value,
      [props.value.mode]: [...selected, authority.actorId]
    });
  };

  const remove = (actorId: string): void => {
    props.onChange({
      ...props.value,
      [props.value.mode]: selected.filter((id) => id !== actorId)
    });
  };

  const closePicker = (): void => {
    setPickerOpen(false);
    requestAnimationFrame(() => { addButton.current?.focus(); });
  };

  return (
    <section className={styles.editor} role="group" aria-label={props.label}>
      <div className={styles.header}>
        <h5 className={styles.title}>{props.label}</h5>
        <RadioGroup
          className={styles.mode}
          aria-label={`${props.label} mode`}
          value={props.value.mode}
          onChange={(mode) => updateMode(mode as AdmissionMode)}
          orientation="horizontal"
        >
          <Radio value="allowlist" className={styles.radio}>Allow</Radio>
          <Radio value="denylist" className={styles.radio}>Deny</Radio>
        </RadioGroup>
      </div>
      <p className={styles.summary}>
        {props.value.mode === 'allowlist'
          ? `Only listed ${rolePlural} are permitted.`
          : `All ${rolePlural} are permitted except those listed.`}
      </p>
      {selected.length === 0 ? (
        <p className={styles.empty}>No {rolePlural} are listed.</p>
      ) : (
        <ul className={styles.selectedList}>
          {selected.map((actorId) => {
            const authority = byId.get(actorId);
            const name = displayName(authority, props.role);
            return (
              <li key={actorId} className={styles.selectedItem}>
                <div className={styles.card}>
                  {props.role === 'registry' ? (
                    <RegistryCard
                      {...(authority?.name === undefined ? {} : { name: authority.name })}
                      {...(authority?.handle === undefined ? {} : { handle: authority.handle })}
                    />
                  ) : (
                    <TerritoryCard
                      {...(authority?.name === undefined ? {} : { name: authority.name })}
                      {...(authority?.handle === undefined ? {} : { handle: authority.handle })}
                    />
                  )}
                </div>
                {authority === undefined ? <p className={styles.unknown}>Not in the known directory.</p> : null}
                <UiButton variant="quiet" aria-label={`Remove ${name}`} onPress={() => remove(actorId)}>
                  Remove
                </UiButton>
                <details className={styles.details}>
                  <summary>Technical details</summary>
                  <code>{actorId}</code>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      <div className={styles.addRow}>
        <Button ref={addButton} className={styles.button} onPress={() => setPickerOpen(true)}>
          {`Add ${props.role}`}
        </Button>
        {props.directoryError === undefined ? null : (
          <p className={styles.error} role="alert">{props.directoryError}</p>
        )}
      </div>
      {pickerOpen ? (
        <AuthorityPicker
          role={props.role}
          authorities={props.authorities}
          selected={selected}
          loading={props.directoryLoading === true}
          {...(props.directoryError === undefined ? {} : { error: props.directoryError })}
          onRetry={props.onRetryDirectory}
          onSelect={(authority) => {
            add(authority);
            closePicker();
          }}
          onClose={closePicker}
        />
      ) : null}
    </section>
  );
}
