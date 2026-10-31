import type { ReactElement } from 'react';
import { Button } from 'react-aria-components';
import cssStyles from './authoring.module.css';

const styles = cssStyles as Record<'editor' | 'subheading' | 'field' | 'label' | 'input' | 'meta' | 'error' | 'controls' | 'button', string>;

export interface EditorChromeProps {
  dirty: boolean;
  saving: boolean;
  publishing: boolean;
  canPublish: boolean;
  errors: readonly string[];
  onSave: () => void;
  onPublish: () => void;
  onClose: () => void;
}

export interface AssetEditorProps extends EditorChromeProps {
  fields: Record<string, unknown>;
  onChange: (fields: Record<string, unknown>) => void;
}

function textValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return String(value);
}

export function AssetEditor(props: AssetEditorProps): ReactElement {
  const { fields, onChange, dirty, saving, publishing, canPublish, errors, onSave, onPublish, onClose } = props;
  return (
    <section aria-label="Asset draft" className={styles.editor}>
      <h3 className={styles.subheading}>Asset draft</h3>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="asset-name">Name</label>
        <input
          id="asset-name"
          className={styles.input}
          value={textValue(fields.name)}
          onChange={(event) => onChange({ ...fields, name: event.target.value })}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="asset-text">Text</label>
        <textarea
          id="asset-text"
          className={styles.input}
          value={textValue(fields.text)}
          onChange={(event) => onChange({ ...fields, text: event.target.value })}
        />
      </div>
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
