import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from 'react-aria-components';
import cssStyles from './authoring.module.css';

const styles = cssStyles as Record<'field' | 'label' | 'input' | 'error' | 'controls' | 'button' | 'production' | 'item' | 'meta' | 'entry', string>;

export type ProductionPickerTarget =
  | { section: 'tool'; entryIndex: number }
  | { section: 'ingredient'; entryIndex: number; ingredientIndex: number }
  | { section: 'area'; entryIndex: number; areaIndex: number };

export interface DescriptiveProductionEditorProps {
  production: unknown;
  onChange: (production: unknown) => void;
  onChooseAsset: (target: ProductionPickerTarget) => void;
  onChooseVariety: (target: ProductionPickerTarget) => void;
  onChooseArea: (target: ProductionPickerTarget) => void;
  onValidityChange?: (valid: boolean) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function formatJson(value: unknown, fallback: unknown): string {
  const target = value === undefined ? fallback : value;
  return JSON.stringify(target, null, 2) ?? '';
}

function useStableKeys(count: number, prefix: string): string[] {
  const store = useRef<{ keys: string[]; next: number }>({ keys: [], next: 0 });
  const state = store.current;
  while (state.keys.length < count) state.keys.push(`${prefix}-${state.next++}`);
  if (state.keys.length > count) state.keys.length = count;
  return state.keys.slice();
}

function JsonObjectField(props: {
  label: string;
  value: unknown;
  onChange: (value: Record<string, unknown>) => void;
  onValidityChange: (valid: boolean) => void;
}): ReactElement {
  const { label, value, onChange, onValidityChange } = props;
  const id = useId();
  const initial = formatJson(value, {});
  const [raw, setRaw] = useState(initial);
  const [error, setError] = useState<string | undefined>();
  const invalid = useRef(false);
  const lastValid = useRef(initial);

  useEffect(() => {
    if (invalid.current) return;
    const serialized = formatJson(value, {});
    if (serialized === lastValid.current) return;
    lastValid.current = serialized;
    setRaw(serialized);
  }, [value]);

  const handleChange = (text: string): void => {
    setRaw(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (caught) {
      if (!(caught instanceof SyntaxError)) throw caught;
      invalid.current = true;
      setError(`${label} is invalid JSON and must be a JSON object.`);
      onValidityChange(false);
      return;
    }
    if (!isRecord(parsed)) {
      invalid.current = true;
      setError(`${label} must be a JSON object.`);
      onValidityChange(false);
      return;
    }
    invalid.current = false;
    lastValid.current = formatJson(parsed, {});
    setError(undefined);
    onValidityChange(true);
    onChange(parsed);
  };

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className={styles.input}
        value={raw}
        onChange={(event) => handleChange(event.target.value)}
      />
      {error === undefined ? null : <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}

interface EntryEditorProps {
  entry: Record<string, unknown>;
  index: number;
  onChangeEntry: (entry: Record<string, unknown>) => void;
  onChooseAsset: (target: ProductionPickerTarget) => void;
  onChooseVariety: (target: ProductionPickerTarget) => void;
  onChooseArea: (target: ProductionPickerTarget) => void;
  onValidityChange: (key: string, valid: boolean) => void;
}

function ProductionEntryEditor(props: EntryEditorProps): ReactElement {
  const { entry, index, onChangeEntry, onChooseAsset, onChooseVariety, onChooseArea, onValidityChange } = props;
  const ingredients = Array.isArray(entry.ingredients) ? entry.ingredients : [];
  const locations = Array.isArray(entry.location) ? entry.location : [];
  const yields = Array.isArray(entry.yield) ? entry.yield : [];
  const ingredientKeys = useStableKeys(ingredients.length, `entry-${index}-ingredient`);
  const locationKeys = useStableKeys(locations.length, `entry-${index}-location`);
  const yieldKeys = useStableKeys(yields.length, `entry-${index}-yield`);

  const updateIngredient = (ingredientIndex: number, update: (record: Record<string, unknown>) => Record<string, unknown>): void => {
    const next = ingredients.slice();
    const record = isRecord(next[ingredientIndex]) ? next[ingredientIndex] : {};
    next[ingredientIndex] = update({ ...record });
    onChangeEntry({ ...entry, ingredients: next });
  };

  const updateLocation = (areaIndex: number, update: (record: Record<string, unknown>) => Record<string, unknown>): void => {
    const next = locations.slice();
    const record = isRecord(next[areaIndex]) ? next[areaIndex] : {};
    next[areaIndex] = update({ ...record });
    onChangeEntry({ ...entry, location: next });
  };

  const updateYield = (yieldIndex: number, update: (record: Record<string, unknown>) => Record<string, unknown>): void => {
    const next = yields.slice();
    const record = isRecord(next[yieldIndex]) ? next[yieldIndex] : {};
    next[yieldIndex] = update({ ...record });
    onChangeEntry({ ...entry, yield: next });
  };

  const addIngredient = (item: boolean): void => {
    const next = ingredients.slice();
    next.push(item ? { id: '', variety: '', data: {} } : { variety: '', count: 0, data: {} });
    onChangeEntry({ ...entry, ingredients: next });
  };

  const addLocation = (): void => {
    const next = locations.slice();
    next.push({ id: '', name: '', territory: '' });
    onChangeEntry({ ...entry, location: next });
  };

  const addYield = (): void => {
    const next = yields.slice();
    next.push({ probability: 0, count: 0, data: {} });
    onChangeEntry({ ...entry, yield: next });
  };

  let stackOrdinal = 0;
  let itemOrdinal = 0;
  let locationOrdinal = 0;

  return (
    <section role="group" aria-label={`Production entry ${index + 1}`} className={styles.entry}>
      <p className={styles.meta}>Type: {display(entry.type) || '(unspecified)'}</p>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`entry-${index}-type`}>Type</label>
        <input
          id={`entry-${index}-type`}
          className={styles.input}
          value={display(entry.type)}
          onChange={(event) => onChangeEntry({ ...entry, type: event.target.value })}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`entry-${index}-duration`}>Duration</label>
        <input
          id={`entry-${index}-duration`}
          className={styles.input}
          value={display(entry.duration)}
          onChange={(event) => onChangeEntry({ ...entry, duration: parseNumber(event.target.value) })}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`entry-${index}-tool`}>Tool</label>
        <input
          id={`entry-${index}-tool`}
          className={styles.input}
          value={display(entry.tool)}
          onChange={(event) => {
            const next = { ...entry };
            if (event.target.value === '') delete next.tool;
            else next.tool = event.target.value;
            onChangeEntry(next);
          }}
        />
      </div>
      <div className={styles.controls}>
        <Button
          className={styles.button}
          onPress={() => onChooseAsset({ section: 'tool', entryIndex: index })}
        >
          Choose tool asset
        </Button>
        <Button className={styles.button} onPress={() => addIngredient(false)}>Add stack ingredient</Button>
        <Button className={styles.button} onPress={() => addIngredient(true)}>Add item ingredient</Button>
        <Button className={styles.button} onPress={addLocation}>Add location</Button>
        <Button className={styles.button} onPress={addYield}>Add yield</Button>
      </div>

      {ingredients.map((value, ingredientIndex) => {
        const record = isRecord(value) ? value : {};
        const item = Object.hasOwn(record, 'id');
        const ordinal = item ? ++itemOrdinal : ++stackOrdinal;
        const label = item ? `Item ingredient ${ordinal}` : `Stack ingredient ${ordinal}`;
        const key = ingredientKeys[ingredientIndex] ?? `ingredient-${ingredientIndex}`;
        return (
          <section role="group" aria-label={label} className={styles.item} key={key}>
            <h4 className={styles.label}>{label}</h4>
            {item ? (
              <div className={styles.field}>
                <label className={styles.label} htmlFor={`${key}-id`}>Item ID</label>
                <input
                  id={`${key}-id`}
                  className={styles.input}
                  value={display(record.id)}
                  onChange={(event) => updateIngredient(ingredientIndex, (current) => ({ ...current, id: event.target.value }))}
                />
              </div>
            ) : null}
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${key}-variety`}>Variety</label>
              <input
                id={`${key}-variety`}
                className={styles.input}
                value={display(record.variety)}
                onChange={(event) => updateIngredient(ingredientIndex, (current) => ({ ...current, variety: event.target.value }))}
              />
            </div>
            <div className={styles.controls}>
              <Button
                className={styles.button}
                onPress={() => onChooseVariety({ section: 'ingredient', entryIndex: index, ingredientIndex })}
              >
                Choose ingredient variety
              </Button>
            </div>
            {item ? null : (
              <div className={styles.field}>
                <label className={styles.label} htmlFor={`${key}-count`}>Count</label>
                <input
                  id={`${key}-count`}
                  className={styles.input}
                  value={display(record.count)}
                  onChange={(event) => updateIngredient(ingredientIndex, (current) => ({ ...current, count: parseNumber(event.target.value) }))}
                />
              </div>
            )}
            <JsonObjectField
              label="Data"
              value={record.data}
              onChange={(data) => updateIngredient(ingredientIndex, (current) => ({ ...current, data }))}
              onValidityChange={(valid) => onValidityChange(`ingredient-${key}`, valid)}
            />
          </section>
        );
      })}

      {locations.map((value, areaIndex) => {
        const record = isRecord(value) ? value : {};
        const ordinal = ++locationOrdinal;
        const key = locationKeys[areaIndex] ?? `location-${areaIndex}`;
        return (
          <section role="group" aria-label={`Location ${ordinal}`} className={styles.item} key={key}>
            <h4 className={styles.label}>{`Location ${ordinal}`}</h4>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${key}-id`}>Area ID</label>
              <input
                id={`${key}-id`}
                className={styles.input}
                value={display(record.id)}
                onChange={(event) => updateLocation(areaIndex, (current) => ({ ...current, id: event.target.value }))}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${key}-name`}>Area name</label>
              <input
                id={`${key}-name`}
                className={styles.input}
                value={display(record.name)}
                onChange={(event) => updateLocation(areaIndex, (current) => ({ ...current, name: event.target.value }))}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${key}-territory`}>Territory</label>
              <input
                id={`${key}-territory`}
                className={styles.input}
                value={display(record.territory)}
                onChange={(event) => updateLocation(areaIndex, (current) => ({ ...current, territory: event.target.value }))}
              />
            </div>
            {(display(record.name) === '' || display(record.territory) === '') ? (
              <p className={styles.meta}>Area name or Territory is missing; enter the exact published values.</p>
            ) : null}
            <div className={styles.controls}>
              <Button
                className={styles.button}
                onPress={() => onChooseArea({ section: 'area', entryIndex: index, areaIndex })}
              >
                Choose location area
              </Button>
            </div>
          </section>
        );
      })}

      {yields.map((value, yieldIndex) => {
        const record = isRecord(value) ? value : {};
        const ordinal = yieldIndex + 1;
        const key = yieldKeys[yieldIndex] ?? `yield-${yieldIndex}`;
        return (
          <section role="group" aria-label={`Yield ${ordinal}`} className={styles.item} key={key}>
            <h4 className={styles.label}>{`Yield ${ordinal}`}</h4>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${key}-probability`}>Probability</label>
              <input
                id={`${key}-probability`}
                className={styles.input}
                value={display(record.probability)}
                onChange={(event) => updateYield(yieldIndex, (current) => ({ ...current, probability: parseNumber(event.target.value) }))}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${key}-count`}>Count</label>
              <input
                id={`${key}-count`}
                className={styles.input}
                value={display(record.count)}
                onChange={(event) => updateYield(yieldIndex, (current) => ({ ...current, count: parseNumber(event.target.value) }))}
              />
            </div>
            <JsonObjectField
              label="Data"
              value={record.data}
              onChange={(data) => updateYield(yieldIndex, (current) => ({ ...current, data }))}
              onValidityChange={(valid) => onValidityChange(`yield-${key}`, valid)}
            />
          </section>
        );
      })}
    </section>
  );
}

export function DescriptiveProductionEditor(props: DescriptiveProductionEditorProps): ReactElement {
  const { production, onChange, onChooseAsset, onChooseVariety, onChooseArea, onValidityChange } = props;
  const entries = Array.isArray(production) ? production : [];
  const entryKeys = useStableKeys(entries.length, 'entry');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [advancedRaw, setAdvancedRaw] = useState('');
  const [advancedError, setAdvancedError] = useState<string | undefined>();
  const invalidKeys = useRef(new Set<string>());
  const advancedInvalid = useRef(false);

  const report = (key: string, valid: boolean): void => {
    if (valid) invalidKeys.current.delete(key);
    else invalidKeys.current.add(key);
    onValidityChange?.(invalidKeys.current.size === 0);
  };

  const updateEntry = (entryIndex: number, entry: Record<string, unknown>): void => {
    const next = entries.slice();
    next[entryIndex] = entry;
    onChange(next);
  };

  const toggleAdvanced = (open: boolean): void => {
    setAdvancedOpen(open);
    if (open && advancedInvalid.current) {
      report('advanced', false);
      return;
    }
    if (!open) {
      report('advanced', true);
      return;
    }
    setAdvancedError(undefined);
    report('advanced', true);
    if (open) setAdvancedRaw(formatJson(production === undefined ? [] : production, []));
  };

  const handleAdvanced = (text: string): void => {
    setAdvancedRaw(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (caught) {
      if (!(caught instanceof SyntaxError)) throw caught;
      advancedInvalid.current = true;
      setAdvancedError('Advanced Production JSON is invalid JSON.');
      report('advanced', false);
      return;
    }
    if (!Array.isArray(parsed)) {
      advancedInvalid.current = true;
      setAdvancedError('Advanced Production JSON must be an array of entries.');
      report('advanced', false);
      return;
    }
    advancedInvalid.current = false;
    setAdvancedError(undefined);
    report('advanced', true);
    onChange(parsed);
  };

  const addEntry = (): void => {
    onChange([...entries, { type: 'manufacture', duration: 0, yield: [] }]);
  };

  return (
    <div className={styles.production}>
      <div className={styles.controls}>
        <Button className={styles.button} onPress={addEntry}>Add production entry</Button>
        <label className={styles.label}>
          <input
            type="checkbox"
            checked={advancedOpen}
            onChange={(event) => toggleAdvanced(event.target.checked)}
          />
          {' '}Advanced Production JSON
        </label>
      </div>
      {advancedOpen ? (
        <div className={styles.field}>
          <label className={styles.label} htmlFor="production-json">Production JSON</label>
          <textarea
            id="production-json"
            className={styles.input}
            value={advancedRaw}
            onChange={(event) => handleAdvanced(event.target.value)}
          />
          {advancedError === undefined ? null : <p className={styles.error} role="alert">{advancedError}</p>}
        </div>
      ) : entries.length === 0 ? (
        <p className={styles.meta}>No structured Production entries are defined.</p>
      ) : (
        entries.map((value, entryIndex) => {
          const entry = isRecord(value) ? value : {};
          const key = entryKeys[entryIndex] ?? `entry-${entryIndex}`;
          return (
            <ProductionEntryEditor
              key={key}
              entry={entry}
              index={entryIndex}
              onChangeEntry={(next) => updateEntry(entryIndex, next)}
              onChooseAsset={onChooseAsset}
              onChooseVariety={onChooseVariety}
              onChooseArea={onChooseArea}
              onValidityChange={report}
            />
          );
        })
      )}
    </div>
  );
}
