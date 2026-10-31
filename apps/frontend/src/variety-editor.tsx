import type { ReactElement } from 'react';
import { Button } from 'react-aria-components';
import type { EditorChromeProps } from './asset-editor';
import {
  DescriptiveProductionEditor,
  type ProductionPickerTarget
} from './descriptive-production-editor';
import cssStyles from './authoring.module.css';

const styles = cssStyles as Record<'editor' | 'subheading' | 'field' | 'label' | 'input' | 'controls' | 'button' | 'meta' | 'error', string>;

export interface VarietyAssetPickerTarget {
  section: 'asset';
}

export interface VarietyEditorProps extends EditorChromeProps {
  fields: Record<string, unknown>;
  onChange: (fields: Record<string, unknown>) => void;
  onChooseAsset: (target: VarietyAssetPickerTarget | ProductionPickerTarget) => void;
  onChooseVariety: (target: ProductionPickerTarget) => void;
  onChooseArea: (target: ProductionPickerTarget) => void;
  onProductionValidityChange?: (valid: boolean) => void;
}

function display(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

function parseNumber(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : text;
}

export function VarietyEditor(props: VarietyEditorProps): ReactElement {
  const {
    fields, onChange, dirty, saving, publishing, canPublish, errors, onSave, onPublish, onClose,
    onChooseAsset, onChooseVariety, onChooseArea, onProductionValidityChange
  } = props;

  const setField = (key: string, value: unknown): void => {
    const next = { ...fields };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  return (
    <section aria-label="Variety draft" className={styles.editor}>
      <h3 className={styles.subheading}>Variety draft</h3>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="variety-name">Name</label>
        <input
          id="variety-name"
          className={styles.input}
          value={display(fields.name)}
          onChange={(event) => setField('name', event.target.value)}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="variety-mass">Mass</label>
        <input
          id="variety-mass"
          className={styles.input}
          value={display(fields.mass)}
          onChange={(event) => setField('mass', parseNumber(event.target.value))}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="variety-version">Version</label>
        <input
          id="variety-version"
          className={styles.input}
          value={display(fields.version)}
          onChange={(event) => setField('version', event.target.value)}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="variety-asset">Asset</label>
        <input
          id="variety-asset"
          className={styles.input}
          value={display(fields.asset)}
          onChange={(event) => setField('asset', event.target.value === '' ? undefined : event.target.value)}
        />
      </div>
      <div className={styles.controls}>
        <Button
          className={styles.button}
          onPress={() => onChooseAsset({ section: 'asset' })}
        >
          Choose variety asset
        </Button>
      </div>

      <DescriptiveProductionEditor
        production={fields.production}
        onChange={(production) => setField('production', production)}
        onChooseAsset={onChooseAsset}
        onChooseVariety={onChooseVariety}
        onChooseArea={onChooseArea}
        {...(onProductionValidityChange === undefined ? {} : { onValidityChange: onProductionValidityChange })}
      />

      {dirty ? (
        <p className={styles.meta}>Save the draft before publishing; unsaved changes are not published.</p>
      ) : null}
      {errors.map((message, index) => (
        <p key={`${message}-${index}`} className={styles.error} role="alert">{message}</p>
      ))}
      <div className={styles.controls}>
        <Button className={styles.button} onPress={onSave} isPending={saving} isDisabled={saving}>
          Save draft
        </Button>
        <Button
          className={styles.button}
          onPress={onPublish}
          isPending={publishing}
          isDisabled={publishing || !canPublish}
        >
          Publish draft
        </Button>
        <Button className={styles.button} onPress={onClose}>
          Close editor
        </Button>
      </div>
    </section>
  );
}
