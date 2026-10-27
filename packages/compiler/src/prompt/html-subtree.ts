import { load, type CheerioAPI } from 'cheerio';

// The part of a server-rendered page that holds the data, for html_fetch
// recipes (SPEC, Local LLM usage rule 1): the smallest subtree that contains
// the target values, without scripts and styles, keeping only the id, class,
// role, aria-* and data-testid attributes, with text and repeated rows cut.

// DOM node types, as numbers: the parser's own enum is not exported.
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

/** Share of the target values a subtree must contain to count as holding the data. */
export const DATA_COVERAGE = 0.8;
const MAX_VALUES = 60;

interface Limits {
  rows: number;
  text: number;
  classes: boolean;
}

const LEVELS: Limits[] = [
  { rows: 3, text: 60, classes: true },
  { rows: 2, text: 30, classes: true },
  { rows: 1, text: 20, classes: false },
];

/** A selection of elements; cheerio does not export the element type itself. */
const bodyOf = ($: CheerioAPI) => $('body');
type Selection = ReturnType<typeof bodyOf>;

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Distinct values worth searching for, spread over the whole list. */
export function sampleValues(values: readonly string[]): string[] {
  const distinct = [...new Set(values.map(normalizeText).filter((value) => value.length >= 2))];
  if (distinct.length <= MAX_VALUES) return distinct;
  const step = distinct.length / MAX_VALUES;
  return Array.from({ length: MAX_VALUES }, (_, i) => distinct[Math.floor(i * step)] ?? '');
}

/** Share of `values` that appear in an element's text. */
function coverage($: CheerioAPI, element: Selection, values: readonly string[]): number {
  if (values.length === 0) return 0;
  const text = normalizeText(element.text());
  return values.filter((value) => text.includes(value)).length / values.length;
}

function cleanDocument(html: string): CheerioAPI {
  const $ = load(html);
  $('script, style, noscript, svg, template, link, meta, iframe').remove();
  $('*')
    .contents()
    .filter((_, node) => node.nodeType === COMMENT_NODE)
    .remove();
  return $;
}

/**
 * The smallest element whose text holds most of the values, found by walking
 * down from <body> while one child still holds them. Undefined when the page
 * does not contain the data at all, so html_fetch cannot work.
 */
function findData($: CheerioAPI, values: readonly string[]): Selection | undefined {
  let current: Selection = bodyOf($).first();
  if (current.length === 0) current = $.root().children().first();
  if (coverage($, current, values) < DATA_COVERAGE) return undefined;
  for (;;) {
    let best: Selection | undefined;
    let bestCoverage = 0;
    for (const child of current.children().toArray()) {
      const selection = $(child);
      const share = coverage($, selection, values);
      if (share > bestCoverage) {
        best = selection;
        bestCoverage = share;
      }
    }
    if (!best || bestCoverage < DATA_COVERAGE) break;
    current = best;
  }
  // Rows without their table lose the headers that name the columns.
  const table = current.is('table') ? current : current.parents('table').first();
  return table.length > 0 ? table : current;
}

/** Share of the values that appear anywhere in the page's visible markup. */
export function htmlCoverage(html: string, values: readonly string[]): number {
  const $ = cleanDocument(html);
  const body = bodyOf($).first();
  return coverage($, body.length > 0 ? body : $.root().children().first(), sampleValues(values));
}

/** Whether the HTML holds the values: the test for html_fetch. */
export function htmlHoldsData(html: string, values: readonly string[]): boolean {
  return findData(cleanDocument(html), sampleValues(values)) !== undefined;
}

/** The data's subtree as compact HTML; undefined past the last level or when the data is not there. */
export function formatSubtree(html: string, values: readonly string[], level = 0): string | undefined {
  const limits = LEVELS[level];
  if (!limits) return undefined;
  const $ = cleanDocument(html);
  const root = findData($, sampleValues(values));
  if (!root) return undefined;

  for (const element of [...root.toArray(), ...root.find('*').toArray()]) {
    for (const name of Object.keys(element.attribs)) {
      const keep =
        ['id', 'role', 'data-testid'].includes(name) ||
        name.startsWith('aria-') ||
        (name === 'class' && limits.classes);
      if (!keep) $(element).removeAttr(name);
    }
  }
  cutRepeats($, root, limits.rows);
  root
    .find('*')
    .addBack()
    .contents()
    .each((_, node) => {
      if (node.nodeType === TEXT_NODE && 'data' in node) {
        const text = node.data.replace(/\s+/g, ' ');
        node.data = text.length > limits.text ? `${text.slice(0, limits.text - 1)}…` : text;
      }
    });
  const path = pathTo($, root);
  const markup = ($.html(root) ?? '').replace(/>\s+</g, '><');
  return `<!-- ${path} -->\n${markup}`;
}

/** Keeps the first rows of every run of repeated siblings: table rows, list items, cards. */
function cutRepeats($: CheerioAPI, root: Selection, keep: number): void {
  root
    .find('*')
    .addBack()
    .each((_, element) => {
      const children = $(element).children().toArray();
      const signature = (child: (typeof children)[number]) => `${child.tagName}.${child.attribs.class ?? ''}`;
      const groups = new Map<string, typeof children>();
      for (const child of children)
        groups.set(signature(child), [...(groups.get(signature(child)) ?? []), child]);
      for (const group of groups.values()) {
        const extra = group.slice(keep);
        const first = extra[0];
        if (!first || group.length <= keep + 1) continue;
        $(first).before(`<!-- ${extra.length} more ${first.tagName} -->`);
        $(extra).remove();
      }
    });
}

/** Where the subtree sits, e.g. "body > main > table#invoices". */
function pathTo($: CheerioAPI, element: Selection): string {
  const steps = element
    .parents()
    .toArray()
    .reverse()
    .concat(element.toArray())
    .filter((node) => node.tagName !== 'html')
    .map((node) => `${node.tagName}${node.attribs.id ? `#${node.attribs.id}` : ''}`);
  return steps.join(' > ');
}
