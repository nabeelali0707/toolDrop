import type { Capture } from '../capture/capture.ts';
import type { Exchange } from '../capture/har.ts';
import type { TargetData } from '../capture/page-helpers.ts';
import { htmlCoverage } from '../prompt/html-subtree.ts';
import { tryJson } from '../prompt/json-shape.ts';
import { compareCell, leaves, normalize, recordArrays, type Leaf } from './values.ts';

// Which captured request returned the data on screen (SPEC, Build pipeline
// step 5): every JSON response and page is scored by how many of the rows
// shown it contains. Plain code; no model.

/** A column on screen and the JSON value that fills it. */
export interface ColumnMatch {
  index: number;
  header: string;
  /** JSONPath inside each record, e.g. "$.total.value". */
  path: string;
  /** Rows whose cell matched the value. */
  rows: number;
  /** Every match was exact, not a cell that merely contains the value. */
  exact: boolean;
}

export interface JsonCandidate {
  kind: 'json';
  exchange: Exchange;
  /** Share of the rows on screen found in the response. */
  score: number;
  /** JSONPath to the records, e.g. "$.items[*]". */
  items: string;
  columns: ColumnMatch[];
  /** Headers of columns no single JSON value fills, e.g. one composed from several. */
  unmatched: string[];
}

export interface HtmlCandidate {
  kind: 'html';
  exchange: Exchange;
  score: number;
}

export type Candidate = JsonCandidate | HtmlCandidate;

/** Least share of the rows a response must hold to be the data source. */
export const MIN_SCORE = 0.6;

/** The target's data as rows of cells: a list's items are one-cell rows. */
export function targetRows(data: TargetData): { headers: string[]; rows: string[][] } {
  if (data.kind === 'table') return { headers: data.headers, rows: data.rows };
  if (data.kind === 'list') return { headers: ['item'], rows: data.items.map((item) => [item]) };
  return { headers: ['text'], rows: [[data.text]] };
}

/** Candidates for the data source, best first; at most one per endpoint. */
export function rankExchanges(capture: Capture): Candidate[] {
  if (!capture.target) return [];
  const { headers, rows } = targetRows(capture.target.data);
  if (rows.length === 0) return [];

  const best = new Map<string, Candidate>();
  for (const exchange of capture.exchanges) {
    if (exchange.status >= 400 || !exchange.response_body) continue;
    let candidate: Candidate | undefined;
    const json = tryJson(exchange.response_body);
    if (json !== null && typeof json === 'object') {
      const match = matchRecords(json, headers, rows);
      if (match) candidate = { kind: 'json', exchange, ...match };
    } else if (exchange.resource_type === 'document' && /html/i.test(exchange.mime_type)) {
      const score = htmlCoverage(exchange.response_body, rows.flat());
      if (score > 0) candidate = { kind: 'html', exchange, score };
    }
    if (!candidate) continue;
    // Later requests win ties: they produced what is on screen.
    const key = `${exchange.method} ${new URL(exchange.url).origin}${new URL(exchange.url).pathname}`;
    const current = best.get(key);
    if (!current || candidate.score >= current.score) best.set(key, candidate);
  }
  return [...best.values()].sort(
    (a, b) => b.score - a.score || (a.kind === 'json' ? 0 : 1) - (b.kind === 'json' ? 0 : 1),
  );
}

/** The best array of records for the rows, and which value fills each column. */
function matchRecords(json: object, headers: string[], rows: string[][]) {
  let best: { path: string; pairs: { row: string[]; leaves: Leaf[] }[] } | undefined;
  for (const array of recordArrays(json)) {
    const itemLeaves = array.items.map((item) => leaves(item));
    const pairs: { row: string[]; leaves: Leaf[] }[] = [];
    for (const row of rows) {
      const filled = row.filter((cell) => normalize(cell) !== '');
      let bestItem: Leaf[] | undefined;
      let bestHits = 0;
      for (const item of itemLeaves) {
        const hits = filled.filter((cell) => item.some((leaf) => compareCell(cell, leaf.value))).length;
        if (hits > bestHits) {
          bestHits = hits;
          bestItem = item;
        }
      }
      if (bestItem && bestHits >= Math.max(1, Math.ceil(filled.length / 2)))
        pairs.push({ row, leaves: bestItem });
    }
    if (pairs.length > (best?.pairs.length ?? 0)) best = { path: array.path, pairs };
  }
  if (!best) return undefined;

  const columns: ColumnMatch[] = [];
  const unmatched: string[] = [];
  const pairs = best.pairs;
  headers.forEach((header, index) => {
    const counts = new Map<string, { rows: number; exact: number }>();
    for (const { row, leaves: values } of pairs) {
      const seen = new Set<string>();
      for (const leaf of values) {
        const match = compareCell(row[index] ?? '', leaf.value);
        if (!match || seen.has(leaf.path)) continue;
        seen.add(leaf.path);
        const count = counts.get(leaf.path) ?? { rows: 0, exact: 0 };
        count.rows++;
        if (match === 'exact') count.exact++;
        counts.set(leaf.path, count);
      }
    }
    let pick: { path: string; rows: number; exact: number } | undefined;
    for (const [path, count] of counts) {
      if (!pick || count.rows > pick.rows || (count.rows === pick.rows && count.exact > pick.exact)) {
        pick = { path, ...count };
      }
    }
    if (pick && pick.rows >= Math.ceil(pairs.length / 2)) {
      columns.push({ index, header, path: pick.path, rows: pick.rows, exact: pick.exact === pick.rows });
    } else {
      unmatched.push(header);
    }
  });
  return { score: pairs.length / rows.length, items: best.path, columns, unmatched };
}
