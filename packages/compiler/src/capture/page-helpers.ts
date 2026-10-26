/// <reference lib="dom" />
import type { Selector } from '@tooldrop/core';

// Code that runs inside the captured page. Playwright serializes
// `installPageHelpers` into the page, so it may not use imports or anything
// outside its own body; types are fine, they are erased.
//
// Elements of interest get a stable ref (`data-tooldrop-ref="e12"`), which
// the explore agent and the recorder use to name them. Recipes never contain
// refs: they get ranked selectors, checked against the live page in Node.

/** One node of the pruned accessibility tree a model sees (SPEC, Local LLM usage rule 1). */
export interface AxNode {
  ref: string;
  role: string;
  name: string;
  value?: string;
  /** Options of a select, as their visible text. */
  options?: string[];
  checked?: boolean;
  disabled?: boolean;
  level?: number;
  /** Where a link goes, relative to the page. */
  href?: string;
  /** For tables: column headers, row count and the first row. */
  columns?: string[];
  rows?: number;
  first?: string[];
  /** For lists: item count. */
  items?: number;
  /** The field holds a password: its value is never read. */
  secret?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  nodes: AxNode[];
}

/** What the marked target element holds, as text. */
export type TargetData =
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'list'; items: string[] }
  | { kind: 'text'; text: string };

/** An element the recorder saw the user act on. */
export interface ElementInfo {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  candidates: Selector[];
  options?: { value: string; label: string }[];
}

export interface PageHelpers {
  snapshot(maxNodes: number): PageSnapshot;
  candidates(ref: string): Selector[];
  /** The data in or around an element, and the ref of the table, list or element that holds it. */
  extract(ref: string): { ref: string; data: TargetData } | undefined;
  /** The ref of the element itself, or of the nearest element around it worth naming. */
  refFor(element: Element): string | undefined;
  info(ref: string): ElementInfo | undefined;
}

export const REF_ATTRIBUTE = 'data-tooldrop-ref';

export function installPageHelpers(): void {
  const host = window as Window & { __tooldrop?: PageHelpers };
  if (host.__tooldrop) return;

  const REF = 'data-tooldrop-ref';
  let nextRef = 1;

  const INTERACTIVE = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'select',
    'textarea',
    'summary',
    '[contenteditable=""]',
    '[contenteditable=true]',
    ...[
      'button',
      'link',
      'checkbox',
      'radio',
      'tab',
      'menuitem',
      'option',
      'switch',
      'combobox',
      'textbox',
      'searchbox',
    ].map((role) => `[role=${role}]`),
  ].join(',');
  const STRUCTURE =
    'h1,h2,h3,h4,h5,h6,table,[role=table],[role=grid],[role=alert],[role=status],dialog,[role=dialog],ul,ol,nav,[role=search],form[aria-label]';
  const INPUT_ROLES: Record<string, string> = {
    button: 'button',
    checkbox: 'checkbox',
    image: 'button',
    number: 'spinbutton',
    radio: 'radio',
    range: 'slider',
    reset: 'button',
    submit: 'button',
  };
  /** Roles whose accessible name comes from their text. */
  const NAMED_BY_CONTENT = new Set([
    'button',
    'link',
    'heading',
    'tab',
    'menuitem',
    'option',
    'checkbox',
    'radio',
    'switch',
    'cell',
    'columnheader',
    'listitem',
  ]);

  const clean = (text: string | null | undefined, max = 80): string => {
    const value = (text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  };
  const looksGenerated = (value: string) => /\d{3,}|[a-f0-9]{8,}|^[a-z]{1,3}-?\d+$/i.test(value);
  const cssString = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  function isVisible(element: Element): boolean {
    if (!(element instanceof HTMLElement)) return false;
    if (element.closest('[aria-hidden="true"]')) return false;
    if (!element.checkVisibility({ visibilityProperty: true })) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function roleOf(element: Element): string {
    const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
    if (explicit) return explicit;
    switch (element.tagName) {
      case 'A':
      case 'AREA':
        return element.hasAttribute('href') ? 'link' : '';
      case 'BUTTON':
        return 'button';
      case 'INPUT': {
        const input = element as HTMLInputElement;
        const type = input.type.toLowerCase();
        if (['email', 'search', 'tel', 'text', 'url', ''].includes(type)) {
          return input.list ? 'combobox' : type === 'search' ? 'searchbox' : 'textbox';
        }
        if (type === 'hidden') return '';
        if (type === 'file') return 'button';
        return INPUT_ROLES[type] ?? 'textbox';
      }
      case 'SELECT': {
        const select = element as HTMLSelectElement;
        return select.multiple || select.size > 1 ? 'listbox' : 'combobox';
      }
      case 'TEXTAREA':
        return 'textbox';
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6':
        return 'heading';
      case 'TABLE':
        return 'table';
      case 'UL':
      case 'OL':
      case 'MENU':
        return 'list';
      case 'NAV':
        return 'navigation';
      case 'DIALOG':
        return 'dialog';
      case 'SEARCH':
        return 'search';
      case 'FORM':
        return element.hasAttribute('aria-label') || element.hasAttribute('aria-labelledby') ? 'form' : '';
      case 'IMG':
        return element.getAttribute('alt') === '' ? 'presentation' : 'img';
      default:
        return '';
    }
  }

  /** The label's own text, without the controls inside it. */
  function labelText(label: HTMLLabelElement): string {
    const copy = label.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('select, input, textarea, button').forEach((control) => control.remove());
    return copy.textContent ?? '';
  }

  function nameOf(element: Element, role: string): string {
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ');
      if (clean(text)) return clean(text);
    }
    const label = clean(element.getAttribute('aria-label'));
    if (label) return label;
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
    ) {
      if (element instanceof HTMLInputElement && ['submit', 'button', 'reset'].includes(element.type)) {
        return clean(element.value) || (element.type === 'submit' ? 'Submit' : '');
      }
      const fromLabels = clean([...(element.labels ?? [])].map(labelText).join(' '));
      if (fromLabels) return fromLabels;
      return clean(element.getAttribute('title') ?? element.getAttribute('placeholder'));
    }
    if (element instanceof HTMLImageElement) return clean(element.alt);
    if (element instanceof HTMLTableElement) return clean(element.caption?.textContent);
    if (
      NAMED_BY_CONTENT.has(role) ||
      element.tagName === 'SUMMARY' ||
      role === 'alert' ||
      role === 'status'
    ) {
      return clean((element as HTMLElement).innerText);
    }
    return clean(element.getAttribute('title'));
  }

  function refOf(element: Element): string {
    let ref = element.getAttribute(REF);
    if (!ref) {
      ref = `e${nextRef++}`;
      element.setAttribute(REF, ref);
    }
    return ref;
  }

  function byRef(ref: string): Element | null {
    return document.querySelector(`[${REF}=${cssString(ref)}]`);
  }

  function tableData(table: HTMLTableElement): { headers: string[]; rows: string[][] } {
    const text = (cell: Element) => clean(cell.textContent, 500);
    const headerRow = table.querySelector('thead tr') ?? table.querySelector('tr');
    const bodyRows =
      table.querySelectorAll('tbody tr').length > 0
        ? [...table.querySelectorAll('tbody tr')]
        : [...table.querySelectorAll('tr')].slice(1);
    return {
      headers: [...(headerRow?.querySelectorAll('th, td') ?? [])].map(text),
      rows: bodyRows.map((row) => [...row.querySelectorAll('td')].map(text)),
    };
  }

  function describe(element: Element): AxNode {
    const role = roleOf(element) || element.tagName.toLowerCase();
    const node: AxNode = { ref: refOf(element), role, name: nameOf(element, role) };
    if (element instanceof HTMLInputElement) {
      if (element.type === 'password') node.secret = true;
      else if (element.type === 'checkbox' || element.type === 'radio') node.checked = element.checked;
      else if (element.value) node.value = clean(element.value, 60);
    }
    if (element instanceof HTMLTextAreaElement && element.value) node.value = clean(element.value, 60);
    if (element instanceof HTMLSelectElement) {
      node.value = clean(element.selectedOptions[0]?.text ?? '', 40);
      node.options = [...element.options].slice(0, 30).map((option) => clean(option.text, 40));
    }
    if ((element as HTMLButtonElement).disabled) node.disabled = true;
    if (role === 'heading') node.level = Number(element.tagName.slice(1)) || 2;
    if (element instanceof HTMLAnchorElement) {
      const href = element.getAttribute('href') ?? '';
      node.href = clean(href.startsWith(location.origin) ? href.slice(location.origin.length) : href, 80);
    }
    if (element instanceof HTMLTableElement) {
      const data = tableData(element);
      node.columns = data.headers.map((header) => clean(header, 40));
      node.rows = data.rows.length;
      if (data.rows[0]) node.first = data.rows[0].map((cell) => clean(cell, 40));
    }
    if (element instanceof HTMLUListElement || element instanceof HTMLOListElement) {
      node.items = element.querySelectorAll(':scope > li').length;
      const firstItem = element.querySelector(':scope > li');
      if (firstItem) node.first = [clean(firstItem.textContent, 80)];
    }
    return node;
  }

  function snapshot(maxNodes: number): PageSnapshot {
    const nodes: AxNode[] = [];
    for (const element of document.querySelectorAll(`${INTERACTIVE},${STRUCTURE}`)) {
      if (nodes.length >= maxNodes) break;
      if (!isVisible(element)) continue;
      // A table is one node: its cells are data, not controls.
      if (element.tagName !== 'TABLE' && element.closest('table') && !element.matches(INTERACTIVE)) continue;
      if (element instanceof HTMLUListElement || element instanceof HTMLOListElement) {
        if (element.querySelectorAll(':scope > li').length < 3 || element.closest('nav')) continue;
      }
      nodes.push(describe(element));
    }
    return { url: location.href, title: document.title, nodes };
  }

  function cssCandidates(element: Element): string[] {
    const tag = element.tagName.toLowerCase();
    const found: string[] = [];
    if (element.id && !looksGenerated(element.id)) found.push(`#${CSS.escape(element.id)}`);
    const testId = element.getAttribute('data-testid');
    if (testId) found.push(`[data-testid=${cssString(testId)}]`);
    const name = element.getAttribute('name');
    if (name) found.push(`${tag}[name=${cssString(name)}]`);
    const label = element.getAttribute('aria-label');
    if (label) found.push(`${tag}[aria-label=${cssString(label)}]`);

    // A path from the nearest ancestor with a usable id.
    const steps: string[] = [];
    let node: Element | null = element;
    while (node && node !== document.body && node !== document.documentElement) {
      if (node !== element && node.id && !looksGenerated(node.id)) {
        steps.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const current: Element = node;
      const sameTag = current.parentElement
        ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current.tagName)
        : [];
      const step = current.tagName.toLowerCase();
      steps.unshift(sameTag.length > 1 ? `${step}:nth-of-type(${sameTag.indexOf(current) + 1})` : step);
      node = current.parentElement;
    }
    found.push(steps.join(' > '));
    return [...new Set(found)];
  }

  function candidates(ref: string): Selector[] {
    const element = byRef(ref);
    if (!element) return [];
    const found: Selector[] = [];
    const role = roleOf(element);
    const name = nameOf(element, role);
    if (role && role !== 'presentation')
      found.push(name ? { kind: 'role', role, name } : { kind: 'role', role });
    const testId = element.getAttribute('data-testid');
    if (testId) found.push({ kind: 'test_id', value: testId });
    const text = clean((element as HTMLElement).innerText, 60);
    if (text && (['button', 'link', 'tab', 'menuitem'].includes(role) || element.tagName === 'SUMMARY')) {
      found.push({ kind: 'text', value: text, exact: true });
    }
    for (const css of cssCandidates(element)) found.push({ kind: 'css', value: css });
    return found;
  }

  function extract(ref: string): { ref: string; data: TargetData } | undefined {
    const element = byRef(ref);
    if (!element) return undefined;
    const table =
      element instanceof HTMLTableElement
        ? element
        : (element.closest('table') ?? element.querySelector('table'));
    if (table) return { ref: refOf(table), data: { kind: 'table', ...tableData(table) } };
    const list =
      element instanceof HTMLUListElement || element instanceof HTMLOListElement
        ? element
        : element.closest('ul, ol');
    if (list) {
      const items = [...list.querySelectorAll(':scope > li')].map((item) => clean(item.textContent, 500));
      return { ref: refOf(list), data: { kind: 'list', items } };
    }
    return { ref, data: { kind: 'text', text: clean((element as HTMLElement).innerText, 4000) } };
  }

  function refFor(element: Element): string | undefined {
    const target = element.closest(`${INTERACTIVE},table,ul,ol,[role=table],[role=grid]`) ?? element;
    return refOf(target);
  }

  function info(ref: string): ElementInfo | undefined {
    const element = byRef(ref);
    if (!element) return undefined;
    const role = roleOf(element);
    return {
      ref,
      role,
      name: nameOf(element, role),
      tag: element.tagName.toLowerCase(),
      ...(element instanceof HTMLInputElement && { type: element.type }),
      candidates: candidates(ref),
      ...(element instanceof HTMLSelectElement && {
        options: [...element.options].map((option) => ({
          value: option.value,
          label: clean(option.text, 60),
        })),
      }),
    };
  }

  host.__tooldrop = { snapshot, candidates, extract, refFor, info };
}
