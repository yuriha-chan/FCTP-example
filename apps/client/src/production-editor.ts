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

export function setupProductionEditor(form: HTMLFormElement): { collect: () => unknown[]; reset: () => void } {
  const mode = field(form, 'productionMode') as HTMLSelectElement;
  const structured = document.getElementById('production-structured')!;
  const advanced = document.getElementById('production-advanced')!;
  const advancedJson = field(form, 'productionAdvanced') as HTMLTextAreaElement;
  const entries = document.getElementById('production-entries')!;

  const addRow = (container: HTMLElement, kind: 'ingredient' | 'location' | 'yield'): void => {
    const row = document.createElement('div');
    row.dataset.productionRow = kind;
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
  };

  const addEntry = (): void => {
    const entry = document.createElement('fieldset');
    entry.dataset.productionEntry = 'true';
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
  };

  form.querySelector<HTMLButtonElement>('[data-production-add-entry]')!.addEventListener('click', addEntry);
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
    mode.value = 'structured';
    advancedJson.value = '[]';
    setMode();
  };

  const collect = (): unknown[] => {
    if (mode.value === 'advanced') {
      const value: unknown = JSON.parse(advancedJson.value);
      if (!Array.isArray(value)) throw new TypeError('Advanced Production JSON must be an array');
      return value;
    }
    return [...entries.querySelectorAll<HTMLFieldSetElement>(':scope > [data-production-entry]')].map((entry) => {
      const type = (entry.querySelector('[name="productionType"]') as HTMLSelectElement).value;
      if (type !== 'mine' && type !== 'manufacture') throw new TypeError('Choose a valid production kind');
      const durationText = (entry.querySelector('[name="productionDuration"]') as HTMLInputElement).value;
      const duration = requiredNumber(durationText, 'Production time');
      const production: Record<string, unknown> = { type, duration, yield: [] as unknown[] };
      const tool = (entry.querySelector('[name="productionTool"]') as HTMLInputElement).value;
      if (tool) production.tool = tool;
      const ingredientRows = entry.querySelectorAll<HTMLElement>('[data-production-rows="ingredient"] [data-production-row]');
      if (ingredientRows.length) production.ingredients = [...ingredientRows].map((row) => {
        const values = [...row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')];
        const [shape, variety, countText, id, dataText] = values.map((control) => control.value);
        const data: unknown = JSON.parse(dataText || '{}');
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Ingredient data must be a JSON object');
        if (!variety) throw new TypeError('Ingredient variety URI is required');
        if (shape === 'item') { if (!id) throw new TypeError('Item ID URI is required'); return { id, variety, data }; }
        return { variety, count: requiredNumber(countText!, 'Ingredient count'), data };
      });
      const locationRows = entry.querySelectorAll<HTMLElement>('[data-production-rows="location"] [data-production-row]');
      if (locationRows.length) production.location = [...locationRows].map((row) => {
        const [id, name, territory] = [...row.querySelectorAll<HTMLInputElement>('input')].map((control) => control.value);
        if (!id || !name || !territory) throw new TypeError('Area ID, name and territory are required');
        return { id, name, territory };
      });
      const yieldRows = entry.querySelectorAll<HTMLElement>('[data-production-rows="yield"] [data-production-row]');
      production.yield = [...yieldRows].map((row) => {
        const [probabilityText, countText, dataText] = [...row.querySelectorAll<HTMLInputElement>('input')].map((control) => control.value);
        const probability = requiredNumber(probabilityText!, 'Yield probability', true);
        const count = requiredNumber(countText!, 'Yield count');
        const data: unknown = JSON.parse(dataText || '{}');
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('Yield data must be a JSON object');
        return { probability, count, data };
      });
      return production;
    });
  };

  return { collect, reset };
}
