import type { URI } from '@fctp/protocol';
import { formatAuthoringEntry, formatResource } from './presentation.js';
import { setupProductionEditor } from './production-editor.js';

type PlayerSession = { role: string; player: string; credential: string };
type RequestOptions = { method?: 'GET' | 'POST'; body?: unknown; token?: string };
type AuthoringCatalog = { actor: string; assets: Record<string, unknown>[]; varieties: Record<string, unknown>[]; grants: Record<string, unknown>[] };
type AuthoringDependencies = {
  authorityOrigin: string;
  getSession: () => PlayerSession | undefined;
  request: <T>(origin: string, path: string, options?: RequestOptions) => Promise<T>;
  task: (output: string, action: () => Promise<unknown>, refresh?: () => Promise<void>) => void;
  getPublicResource: (uri: string) => Promise<unknown>;
};

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing interface element: ${id}`);
  return element as T;
};

const field = (form: HTMLFormElement, name: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
  const element = form.elements.namedItem(name);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) throw new Error(`Missing form field: ${name}`);
  return element;
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function setupAuthoring(dependencies: AuthoringDependencies): { sessionChanged: () => void; refresh: () => Promise<void> } {
  const assetForm = byId<HTMLFormElement>('asset-authoring-form');
  const varietyForm = byId<HTMLFormElement>('variety-authoring-form');
  const assetChoice = field(varietyForm, 'asset') as HTMLSelectElement;
  const productionEditor = setupProductionEditor(varietyForm);
  const resultPanel = byId('authoring-result');
  const catalogPanel = byId('authoring-catalog');

  const playerToken = (): string => {
    const session = dependencies.getSession();
    if (!session || session.role !== 'player' || !session.player) throw new Error('Apply a Player session first');
    return session.credential;
  };

  const sessionChanged = (): void => {
    assetForm.reset();
    varietyForm.reset();
    productionEditor.reset();
    resultPanel.replaceChildren();
    catalogPanel.replaceChildren();
    assetChoice.replaceChildren(new Option('None', ''));
  };

  const showResource = (parent: HTMLElement, label: string, uri: string, action: () => Promise<unknown>): void => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${label}: ${uri}`;
    button.addEventListener('click', () => dependencies.task('authoring-result', async () => {
      const value = await action();
      const output = document.createElement('pre');
      output.textContent = typeof value === 'string' ? value : formatResource(value);
      resultPanel.replaceChildren(output);
      return undefined;
    }));
    parent.append(button);
  };

  const renderCatalog = (catalog: AuthoringCatalog): void => {
    catalogPanel.replaceChildren();
    assetChoice.replaceChildren(new Option('None', ''));
    for (const asset of catalog.assets) {
      if (typeof asset.id !== 'string') continue;
      const option = new Option(String(asset.name ?? asset.id), asset.id);
      assetChoice.append(option);
    }
    for (const [title, entries] of [['Assets', catalog.assets], ['Varieties', catalog.varieties], ['Grants', catalog.grants]] as const) {
      const heading = document.createElement('h3');
      heading.textContent = title;
      catalogPanel.append(heading);
      for (const entry of entries) {
        const article = document.createElement('article');
        const details = document.createElement('pre');
        details.textContent = formatAuthoringEntry(title === 'Varieties' ? 'Variety' : title === 'Assets' ? 'Asset' : 'Asset grant', entry);
        article.append(details);
        if (typeof entry.id === 'string') {
          const kind = title === 'Varieties' ? 'Variety' : title.slice(0, -1);
          showResource(article, `Fetch ${kind}`, entry.id, () => dependencies.getPublicResource(entry.id as string));
        }
        if (Array.isArray(entry.media)) {
          for (const media of entry.media) {
            if (record(media) && typeof media.url === 'string') {
              showResource(article, 'View text Asset', media.url, async () => {
                const response = await fetch(media.url as string, { headers: { Accept: 'text/plain' }, cache: 'no-store' });
                if (!response.ok) throw new Error(`Asset text request failed: ${response.status}`);
                return response.text();
              });
            }
          }
        }
        catalogPanel.append(article);
      }
    }
  };

  const refresh = async (): Promise<void> => {
    const catalog = await dependencies.request<AuthoringCatalog>(dependencies.authorityOrigin, '/local/authoring', { token: playerToken() });
    renderCatalog(catalog);
  };

  byId<HTMLButtonElement>('refresh-authoring').addEventListener('click', () => {
    dependencies.task('authoring-result', async () => { await refresh(); return undefined; });
  });

  assetForm.addEventListener('submit', (event) => {
    event.preventDefault();
    dependencies.task('authoring-result', () => dependencies.request(dependencies.authorityOrigin, '/local/authoring/assets', {
      method: 'POST', token: playerToken(), body: { name: field(assetForm, 'name').value, text: field(assetForm, 'text').value }
    }), refresh);
  });

  varietyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    dependencies.task('authoring-result', () => {
      const mass = Number(field(varietyForm, 'mass').value);
      if (!Number.isFinite(mass) || mass <= 0) throw new TypeError('Mass must be a positive finite number');
      const production = productionEditor.collect();
      const asset = assetChoice.value;
      return dependencies.request(dependencies.authorityOrigin, '/local/authoring/varieties', {
        method: 'POST', token: playerToken(),
        body: { name: field(varietyForm, 'name').value, mass, version: field(varietyForm, 'version').value, ...(asset ? { asset: asset as URI } : {}), production }
      });
    }, refresh);
  });

  return { sessionChanged, refresh };
}
