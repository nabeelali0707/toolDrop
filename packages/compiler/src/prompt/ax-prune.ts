import type { AxNode, PageSnapshot } from '../capture/page-helpers.ts';

// The page as the explore agent sees it (SPEC, Local LLM usage rule 1):
// interactive and named nodes only, one line each, with a stable ref. Higher
// levels prune harder, for `fitPrompt`.

interface Limits {
  name: number;
  options: number;
  links: number;
  cell: number;
  /** Only form controls, buttons, headings, tables and alerts. */
  essentials: boolean;
}

const LEVELS: Limits[] = [
  { name: 80, options: 12, links: 60, cell: 40, essentials: false },
  { name: 40, options: 6, links: 25, cell: 20, essentials: false },
  { name: 30, options: 4, links: 10, cell: 15, essentials: true },
];

const ESSENTIAL_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'spinbutton',
  'slider',
  'switch',
  'button',
  'summary',
  'heading',
  'table',
  'alert',
  'dialog',
]);

/** One line per node; undefined when `level` cannot prune any further. */
export function formatSnapshot(snapshot: PageSnapshot, level = 0): string | undefined {
  const limits = LEVELS[level];
  if (!limits) return undefined;
  const lines = [`Page: ${quote(snapshot.title, limits.name)} at ${snapshot.url}`];
  let links = 0;
  let skippedLinks = 0;
  for (const node of snapshot.nodes) {
    if (limits.essentials && !ESSENTIAL_ROLES.has(node.role)) continue;
    if (node.role === 'link' && ++links > limits.links) {
      skippedLinks++;
      continue;
    }
    lines.push(formatNode(node, limits));
  }
  if (skippedLinks > 0) lines.push(`(${skippedLinks} more links not shown)`);
  return lines.join('\n');
}

function formatNode(node: AxNode, limits: Limits): string {
  const parts = [`[${node.ref}] ${node.role}`];
  if (node.name) parts.push(quote(node.name, limits.name));
  if (node.level !== undefined) parts.push(`level=${node.level}`);
  if (node.secret) parts.push('(password)');
  if (node.value !== undefined) parts.push(`value=${quote(node.value, limits.name)}`);
  if (node.checked !== undefined) parts.push(node.checked ? 'checked' : 'unchecked');
  if (node.disabled) parts.push('disabled');
  if (node.options) parts.push(`options=${list(node.options, limits.options, limits.name)}`);
  if (node.href && !limits.essentials) parts.push(`href=${node.href}`);
  if (node.columns) parts.push(`columns=${list(node.columns, 20, limits.cell)}`);
  if (node.rows !== undefined) parts.push(`rows=${node.rows}`);
  if (node.items !== undefined) parts.push(`items=${node.items}`);
  if (node.first) parts.push(`first=${list(node.first, 20, limits.cell)}`);
  return parts.join(' ');
}

function quote(text: string, max: number): string {
  return JSON.stringify(truncate(text, max));
}

function list(items: string[], max: number, width: number): string {
  const shown = items.slice(0, max).map((item) => truncate(item, width));
  const more = items.length > max ? [`+${items.length - max} more`] : [];
  return `[${[...shown, ...more].join(', ')}]`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}
