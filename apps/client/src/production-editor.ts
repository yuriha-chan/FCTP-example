const field = (form: HTMLFormElement, name: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
  const element = form.elements.namedItem(name);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) throw new Error(`Missing form field: ${name}`);
  return element;
};

const labeled = (labelText: string, control: HTMLElement): HTMLLabelElement => {
  const label = document.createElement('label');
  label.append(document.createTextNode(labelText), control);
  return label;
};

const input = (name: string, type = 'text', step?: string): HTMLInputElement => {
  const element = document.createElement('input');
  element.name = name;
  element.type = type;
  if (step) element.step = step;
  return element;
};

const requiredNumber = (value: string, label: string, fractional = false): number => {
  if (value.trim() === '') throw new TypeError(`${label} is required`);
  const number = Number(value);
  if (fractional ? !Number.isFinite(number) : !Number.isSafeInteger(number) || number < 0) throw new TypeError(fractional ? `${label} must be a number` : `${label} must be a nonnegative whole number`);
  return number;
};

export function setupProductionEditor(form: HTMLFormElement): { collect: () => unknown[]; reset: () => void; populate: (production: unknown[]) => void } {
  const mode = field(form, 'productionMode') as HTMLSelectElement;
  const structured = document.getElementById('production-structured')!;
  const advanced = document.getElementById('production-advanced')!;
  const advancedJson = field(form, 'productionAdvanced') as HTMLTextAreaElement;
  const entries = document.getElementById('production-entries')!;
  let originals: unknown[] = [];

  const clone = <T>(value: T): T => structuredClone(value);
  const originalAt = (index: string | undefined): unknown => index === undefined ? undefined : originals[Number(index)];
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

  const addRow = (container: HTMLElement, kind: 'ingredient' | 'location' | 'yield', originalIndex?: number): HTMLElement => {
    const row = document.createElement('div');
    row.dataset.productionRow = kind;
    if (originalIndex !== undefined) row.dataset.productionOriginal = String(originalIndex);
    if (kind === 'ingredient') {
      const shape = document.createElement('select'); shape.name = 'ingredientShape';
      shape.add(new Option('Stack · variety, count and data', 'stack'));
      shape.add(new Option('Item · variety, item ID and data', 'item'));
      row.append(labeled('Quantity kind', shape), labeled('Variety URI', input('ingredientVariety', 'url')),
        labeled('Count (Stack)', input('ingredientCount', 'number', '1')), labeled('Item ID (Item)', input('ingredientId', 'url')),
        labeled('Data JSON object', input('ingredientData')));
    } else if (kind === 'location') {
      row.append(labeled('Area ID URI', input('areaId', 'url')), labeled('Area name', input('areaName')),
        labeled('Territory URI', input('areaTerritory', 'url')));
    } else {
      row.append(labeled('Probability', input('yieldProbability', 'number', 'any')), labeled('Count', input('yieldCount', 'number', '1')),
        labeled('Data JSON object', input('yieldData')));
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = `Remove ${kind}`;
    remove.addEventListener('click', () => row.remove());
    row.append(remove);
    container.append(row);
    return row;
  };

  const addEntry = (originalIndex?: number): HTMLFieldSetElement => {
    const entry = document.createElement('fieldset');
    entry.dataset.productionEntry = 'true';
    if (originalIndex !== undefined) entry.dataset.productionOriginal = String(originalIndex);
    const legend = document.createElement('legend'); legend.textContent = `Production entry ${entries.children.length + 1}`;
    const type = document.createElement('select'); type.name = 'productionType';
    type.add(new Option('Choose kind', ''));
    type.add(new Option('Mining', 'mine'));
    type.add(new Option('Manufacturing', 'manufacture'));
    const duration = input('productionDuration', 'number', '1'); duration.min = '0';
    const tool = input('productionTool', 'url');
    entry.append(legend, labeled('Production kind', type), labeled('Production time in ticks', duration), labeled('Optional tool URI', tool));
    for (const [kind, title, buttonText] of [
      ['ingredient', 'Ingredients · optional, repeatable', 'Add ingredient'],
      ['location', 'Locations · optional, repeatable', 'Add location'],
      ['yield', 'Yield outcomes · repeatable', 'Add yield']
    ] as const) {
      const group = document.createElement('fieldset');
      const groupLegend = document.createElement('legend'); groupLegend.textContent = title;
      const container = document.createElement('div'); container.dataset.productionRows = kind;
      const add = document.createElement('button'); add.type = 'button'; add.textContent = buttonText;
      add.addEventListener('click', () => addRow(container, kind));
      group.append(groupLegend, container, add);
      entry.append(group);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove Production entry';
    remove.addEventListener('click', () => entry.remove());
    entry.append(remove);
    entries.append(entry);
    return entry;
  };

  form.querySelector<HTMLButtonElement>('[data-production-add-entry]')!.addEventListener('click', () => { addEntry(); });
  const setMode = (): void => {
    const isAdvanced = mode.value === 'advanced';
    advanced.hidden = !isAdvanced;
    structured.hidden = isAdvanced;
    structured.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea,button').forEach((control) => { control.disabled = isAdvanced; });
    advancedJson.disabled = !isAdvanced;
  };
  mode.addEventListener('change', setMode);
  setMode();

  const reset = (): void => {
    entries.replaceChildren();
    originals = [];
    mode.value = 'structured';
    advancedJson.value = '[]';
    setMode();
  };

  const populate = (production: unknown[]): void => {
    reset();
    if (!Array.isArray(production)) return;
    originals = production.map((value) => clone(value));
    for (const [entryIndex, value] of production.entries()) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const source = value as Record<string, unknown>;
      const entry = addEntry(entryIndex);
      const type = entry.querySelector<HTMLSelectElement>('[name="productionType"]')!;
      type.value = source.type === 'mine' ? 'mine' : source.type === 'manufacture' ? 'manufacture' : '';
      entry.querySelector<HTMLInputElement>('[name="productionDuration"]')!.value = String(source.duration ?? '');
      entry.querySelector<HTMLInputElement>('[name="productionTool"]')!.value = typeof source.tool === 'string' ? source.tool : '';
      if (Array.isArray(source.ingredients)) {
        const container = entry.querySelector<HTMLElement>('[data-production-rows="ingredient"]')!;
        for (const [rowIndex, ingredient] of source.ingredients.entries()) {
          if (!ingredient || typeof ingredient !== 'object' || Array.isArray(ingredient)) continue;
          const item = ingredient as Record<string, unknown>;
          const row = addRow(container, 'ingredient', rowIndex);
          const [shape, variety, count, id, data] = [...row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')];
          shape!.value = typeof item.id === 'string' ? 'item' : 'stack';
          variety!.value = typeof item.variety === 'string' ? item.variety : '';
          count!.value = typeof item.count === 'number' ? String(item.count) : '1';
          id!.value = typeof item.id === 'string' ? item.id : '';
          data!.value = JSON.stringify(item.data ?? {});
        }
      }
      if (Array.isArray(source.location)) {
        const container = entry.querySelector<HTMLElement>('[data-production-rows="location"]')!;
        for (const [rowIndex, location] of source.location.entries()) {
          if (!location || typeof location !== 'object' || Array.isArray(location)) continue;
          const item = location as Record<string, unknown>;
          const row = addRow(container, 'location', rowIndex);
          const [id, name, territory] = [...row.querySelectorAll<HTMLInputElement>('input')];
          id!.value = typeof item.id === 'string' ? item.id : '';
          name!.value = typeof item.name === 'string' ? item.name : '';
          territory!.value = typeof item.territory === 'string' ? item.territory : '';
        }
      }
      if (Array.isArray(source.yield)) {
        const container = entry.querySelector<HTMLElement>('[data-production-rows="yield"]')!;
        for (const [rowIndex, outcome] of source.yield.entries()) {
          if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) continue;
          const item = outcome as Record<string, unknown>;
          const row = addRow(container, 'yield', rowIndex);
          const [probability, count, data] = [...row.querySelectorAll<HTMLInputElement>('input')];
          probability!.value = typeof item.probability === 'number' ? String(item.probability) : '';
          count!.value = typeof item.count === 'number' ? String(item.count) : '1';
          data!.value = JSON.stringify(item.data ?? {});
        }
      }
    }
  };

  const collect = (): unknown[] => {
    if (mode.value === 'advanced') {
      const value: unknown = JSON.parse(advancedJson.value);
      if (!Array.isArray(value)) throw new TypeError('Advanced Production JSON must be an array');
      return value;
    }
    return [...entries.querySelectorAll<HTMLFieldSetElement>(':scope > [data-production-entry]')].map((entry) => {
      const original = originalAt(entry.dataset.productionOriginal);
      const source = isObject(original) ? clone(original) : {};
      const type = (entry.querySelector('[name="productionType"]') as HTMLSelectElement).value;
      if (type !== 'mine' && type !== 'manufacture') throw new TypeError('Choose a valid production kind');
      const durationText = (entry.querySelector('[name="productionDuration"]') as HTMLInputElement).value;
      const duration = requiredNumber(durationText, 'Production time');
      source.type = type;
      source.duration = duration;
      const tool = (entry.querySelector('[name="productionTool"]') as HTMLInputElement).value;
      if (tool) source.tool = tool; else delete source.tool;
      const originalRows = (kind: 'ingredients' | 'location' | 'yield'): unknown[] | undefined => isObject(original) && Array.isArray(original[kind]) ? original[kind] : undefined;
      const ingredientRows = entry.querySelectorAll<HTMLElement>('[data-production-rows="ingredient"] [data-production-row]');
      if (ingredientRows.length) source.ingredients = [...ingredientRows].map((row) => {
        const originalRow = originalRows('ingredients')?.[Number(row.dataset.productionOriginal)];
        const ingredient: Record<string, unknown> = isObject(originalRow) ? clone(originalRow) : {};
        const values = [...row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')];
        const [shape, variety, countText, id, dataText] = values.map((control) => control.value);
        const data: unknown = JSON.parse(dataText || '{}');
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Ingredient data must be a JSON object');
        if (!variety) throw new TypeError('Ingredient variety URI is required');
        ingredient.variety = variety;
        ingredient.data = data;
        if (shape === 'item') {
          if (!id) throw new TypeError('Item ID URI is required');
          ingredient.id = id;
          delete ingredient.count;
        } else {
          ingredient.count = requiredNumber(countText!, 'Ingredient count');
          delete ingredient.id;
        }
        return ingredient;
      });
      else if (originalRows('ingredients') !== undefined) source.ingredients = [];
      else delete source.ingredients;
      const locationRows = entry.querySelectorAll<HTMLElement>('[data-production-rows="location"] [data-production-row]');
      if (locationRows.length) source.location = [...locationRows].map((row) => {
        const originalRow = originalRows('location')?.[Number(row.dataset.productionOriginal)];
        const location: Record<string, unknown> = isObject(originalRow) ? clone(originalRow) : {};
        const [id, name, territory] = [...row.querySelectorAll<HTMLInputElement>('input')].map((control) => control.value);
        if (!id || !name || !territory) throw new TypeError('Area ID, name and territory are required');
        location.id = id;
        location.name = name;
        location.territory = territory;
        return location;
      });
      else if (originalRows('location') !== undefined) source.location = [];
      else delete source.location;
      const yieldRows = entry.querySelectorAll<HTMLElement>('[data-production-rows="yield"] [data-production-row]');
      const yielded = [...yieldRows].map((row) => {
        const originalRow = originalRows('yield')?.[Number(row.dataset.productionOriginal)];
        const outcome: Record<string, unknown> = isObject(originalRow) ? clone(originalRow) : {};
        const [probabilityText, countText, dataText] = [...row.querySelectorAll<HTMLInputElement>('input')].map((control) => control.value);
        const probability = requiredNumber(probabilityText!, 'Yield probability', true);
        const count = requiredNumber(countText!, 'Yield count');
        const data: unknown = JSON.parse(dataText || '{}');
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Yield data must be a JSON object');
        outcome.probability = probability;
        outcome.count = count;
        outcome.data = data;
        return outcome;
      });
      if (yieldRows.length > 0 || !isObject(original) || originalRows('yield') !== undefined) source.yield = yielded;
      else delete source.yield;
      return source;
    });
  };

  return { collect, reset, populate };
}
