import { randomBytes } from 'node:crypto';
import { chromium, type BrowserContext, type ElementHandle } from 'playwright';

export interface TextView {
  url: string;
  markdown: string;
}

export interface CreateBrowserSessionOptions {
  url: string;
  allowedOrigins: string[];
  headless?: boolean;
}

export interface BrowserSession {
  view(): Promise<TextView>;
  fill(ref: string, value: string): Promise<TextView>;
  select(ref: string, value: string): Promise<TextView>;
  click(ref: string): Promise<TextView>;
  submit(ref: string): Promise<TextView>;
  back(): Promise<TextView>;
  reload(): Promise<TextView>;
  close(): Promise<void>;
}

type ControlKind = 'input' | 'select' | 'button' | 'link' | 'textarea';
interface ControlRef {
  handle: ElementHandle<HTMLElement>;
  kind: ControlKind;
}

const SETTLE_TIMEOUT_MS = 8_000;

export async function createBrowserSession(options: CreateBrowserSessionOptions): Promise<BrowserSession> {
  const origins = new Set(options.allowedOrigins.map((origin) => new URL(origin).origin));
  const initialUrl = new URL(options.url);
  if (!origins.has(initialUrl.origin)) throw new Error(`URL origin is not allowed: ${initialUrl.origin}`);

  const browser = await chromium.launch({ headless: options.headless ?? true });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    await page.route('**/*', async (route) => {
      let origin: string;
      try {
        origin = new URL(route.request().url()).origin;
      } catch {
        await route.abort();
        return;
      }
      if (origins.has(origin)) await route.continue();
      else await route.abort();
    });

    await page.goto(initialUrl.href, { waitUntil: 'domcontentloaded', timeout: SETTLE_TIMEOUT_MS });
    let currentRefs = new Map<string, ControlRef>();
    const knownSecrets = new Set<string>();

    const settle = async (): Promise<void> => {
      await page.waitForFunction(() => document.documentElement?.getAttribute('data-client-busy') !== 'true', undefined, { timeout: SETTLE_TIMEOUT_MS });
      await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.includes('Timeout')) throw error;
      });
      await page.waitForFunction(() => document.documentElement?.getAttribute('data-client-busy') !== 'true', undefined, { timeout: SETTLE_TIMEOUT_MS });
    };

    const view = async (): Promise<TextView> => {
      await settle();
      for (const ref of currentRefs.values()) await ref.handle.dispose();
      currentRefs = new Map();
      const nonce = randomBytes(8).toString('hex');
      const rendered = await page.evaluate((opaquePrefix) => {
        const visible = (element: Element): boolean => {
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        };
        const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        const controls = Array.from(document.querySelectorAll<HTMLElement>('input,select,button,a,textarea'));
        const refs = new Map<HTMLElement, string>();
        let next = 0;
        const reference = (element: HTMLElement): string => {
          let ref = refs.get(element);
          if (!ref) {
            ref = `${opaquePrefix}-${(++next).toString(36)}`;
            refs.set(element, ref);
          }
          return ref;
        };
        const labelFor = (element: HTMLElement): string => {
          const id = element.id;
          const visibleText = (root: Element): string => {
            const collect = (node: Node): string => {
              if (node instanceof Text) return node.textContent ?? '';
              if (!(node instanceof Element) || !visible(node) || ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(node.tagName)) return '';
              return Array.from(node.childNodes, collect).join('');
            };
            return collect(root).replace(/\s+/g, ' ').trim();
          };
          const label = id ? Array.from(document.querySelectorAll('label')).find((candidate) => candidate.htmlFor === id) : undefined;
          return element.getAttribute('aria-label') || (label ? visibleText(label) : '') || (element.closest('label') ? visibleText(element.closest('label')!) : '') || element.getAttribute('name') || element.getAttribute('title') || '';
        };
        const lines: string[] = [];
        const inline = (node: Node): string => {
          if (node instanceof Text) return node.textContent ?? '';
          if (!(node instanceof Element) || !visible(node) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'].includes(node.tagName)) return '';
          const element = node as HTMLElement;
          if (element.tagName === 'A') {
            const anchor = element as HTMLAnchorElement;
            return `[${text(element) || labelFor(anchor)}](${anchor.href}) [${reference(anchor)}]`;
          }
          if (element.tagName === 'BUTTON') {
            const button = element as HTMLButtonElement;
            return `${labelFor(button) || text(button)} [${reference(button)}]${button.disabled ? ' (disabled)' : ''}`;
          }
          if (['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) {
            const control = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
            const label = labelFor(control);
            const type = control instanceof HTMLInputElement ? control.type : element.tagName.toLowerCase();
            const secret = type === 'password' || /password|secret|token|credential/i.test(`${label} ${control.name}`);
            const value = secret ? '[REDACTED]' : control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(type) ? '' : control.value;
            const checked = control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(type) ? ` ${control.checked ? '[checked]' : '[unchecked]'}` : '';
            const disabled = control.disabled ? ' (disabled)' : '';
            const choices = control instanceof HTMLSelectElement ? ` {${Array.from(control.options).filter((option) => !option.hidden).map((option) => `${option.selected ? '*' : ''}${option.textContent?.trim() ?? ''}=${option.value}${option.disabled ? ' (disabled)' : ''}`).join(', ')}}` : '';
            return `${label || '(unlabelled)'}: ${value}${checked}${choices} [${reference(control)}]${disabled}`;
          }
          return Array.from(element.childNodes, inline).join('');
        };
        const walk = (element: Element): void => {
          if (!visible(element) || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'].includes(element.tagName)) return;
          if (/^H[1-6]$/.test(element.tagName)) {
            const content = inline(element).trim();
            if (content) lines.push(`${'#'.repeat(Number(element.tagName[1]))} ${content}`);
            return;
          }
          if (element.tagName === 'PRE') {
            lines.push(`\n\`\`\`\n${inline(element)}\n\`\`\``);
            return;
          }
          if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) {
            const content = inline(element).trim();
            if (content) lines.push(content);
            return;
          }
          if (['P', 'LI', 'BLOCKQUOTE', 'DT', 'DD'].includes(element.tagName)) {
            const content = inline(element).trim();
            if (content) lines.push(content);
            return;
          }
          for (const child of Array.from(element.children)) walk(child);
          if (!element.children.length && !['BODY', 'HTML'].includes(element.tagName)) {
            const content = inline(element).trim();
            if (content) lines.push(content);
          }
        };
        for (const child of Array.from(document.body.children)) walk(child);
        return { markdown: lines.join('\n\n'), controls: controls.map((element) => refs.has(element) ? refs.get(element) : null) };
      }, nonce);
      const handles = await page.$$('input,select,button,a,textarea');
      for (let index = 0; index < rendered.controls.length; index += 1) {
        const ref = rendered.controls[index];
        const handle = handles[index];
        if (!ref || !handle) continue;
        const tag = await handle.evaluate((element) => element.tagName.toLowerCase());
        const kind: ControlKind = tag === 'a' ? 'link' : tag as ControlKind;
        currentRefs.set(ref, { handle: handle as ElementHandle<HTMLElement>, kind });
      }
      for (const handle of handles) {
        if (![...currentRefs.values()].some((ref) => ref.handle === handle)) await handle.dispose();
      }
      let markdown = rendered.markdown;
      for (const secret of knownSecrets) if (secret) markdown = markdown.replaceAll(secret, '[REDACTED]');
      return { url: page.url(), markdown };
    };

    const getControl = async (ref: string, kinds: ControlKind[]): Promise<ControlRef> => {
      const control = currentRefs.get(ref);
      if (!control) throw new Error('Unknown or stale reference');
      if (!kinds.includes(control.kind)) throw new Error(`Reference is not an allowed control type: ${control.kind}`);
      if (!(await control.handle.isVisible()) || !(await control.handle.isEnabled())) throw new Error('Reference is not a visible enabled control');
      return control;
    };

    const perform = async (action: () => Promise<void>): Promise<TextView> => {
      await action();
      await settle();
      return view();
    };

    return {
      view,
      fill: async (ref, value) => {
        const control = await getControl(ref, ['input', 'textarea']);
        const sensitive = await control.handle.evaluate((element) => element instanceof HTMLInputElement && element.type === 'password' || /password|secret|token|credential/i.test(`${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('name') ?? ''} ${element.getAttribute('title') ?? ''} ${element.closest('label')?.textContent ?? ''}`));
        if (sensitive && value) knownSecrets.add(value);
        await control.handle.fill(value);
        return view();
      },
      select: async (ref, value) => {
        const control = await getControl(ref, ['select']);
        await control.handle.selectOption(value);
        return view();
      },
      click: async (ref) => {
        const control = await getControl(ref, ['button', 'link', 'input']);
        if (control.kind === 'input') {
          const checkable = await control.handle.evaluate((element) => element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type));
          if (!checkable) throw new Error('Reference is not a button, link, checkbox, or radio input');
        }
        return perform(() => control.handle.click());
      },
      submit: async (ref) => {
        const control = await getControl(ref, ['button', 'input']);
        const submitCapable = await control.handle.evaluate((element) => element instanceof HTMLButtonElement ? element.type === 'submit' : element instanceof HTMLInputElement && ['submit', 'image'].includes(element.type));
        if (!submitCapable) throw new Error('Reference is not a submit control');
        const form = await control.handle.evaluateHandle((element) => element instanceof HTMLFormElement ? element : element.closest('form'));
        const exists = await form.evaluate((element) => element instanceof HTMLFormElement);
        await form.dispose();
        if (!exists) throw new Error('Reference is not a form control');
        return perform(() => control.handle.evaluate((element) => {
          const formElement = element instanceof HTMLFormElement ? element : element.closest('form');
          if (!(formElement instanceof HTMLFormElement)) throw new Error('Reference is not a form control');
          const submitter = element instanceof HTMLButtonElement || element instanceof HTMLInputElement ? element : undefined;
          if (submitter) formElement.requestSubmit(submitter);
          else formElement.requestSubmit();
        }));
      },
      back: async () => perform(async () => { await page.goBack({ waitUntil: 'domcontentloaded', timeout: SETTLE_TIMEOUT_MS }); }),
      reload: async () => perform(async () => { await page.reload({ waitUntil: 'domcontentloaded', timeout: SETTLE_TIMEOUT_MS }); }),
      close: async () => {
        for (const ref of currentRefs.values()) await ref.handle.dispose();
        currentRefs.clear();
        knownSecrets.clear();
        await context?.close();
        await browser.close();
      }
    };
  } catch (error) {
    await context?.close();
    await browser.close();
    throw error;
  }
}
