import { ToolDropError, type RankedSelector, type Step } from '@tooldrop/core';
import { queryAll, queryOne } from './jsonpath.ts';

// Helpers every executor shares: the data steps' semantics, and errors that
// say which step failed.

export type MapStep = Extract<Step, { op: 'map' }>;

/** Applies a `map` step to every page of the previous result and joins the rows. */
export function mapPages(pages: unknown[], step: MapStep): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const page of pages) {
    for (const item of queryAll(page, step.path)) {
      const row: Record<string, unknown> = {};
      for (const [field, path] of Object.entries(step.fields)) row[field] = queryOne(item, path) ?? null;
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Column positions for a table step: each output field names a header (matched
 * by its text, ignoring case and spacing) or a 0-based index. Matching headers
 * by text is what keeps a recipe working when a site reorders its columns.
 */
export function columnIndexes(
  headers: string[],
  columns: Record<string, string | number>,
): Record<string, number> {
  const normalized = headers.map((header) => header.replace(/\s+/g, ' ').trim().toLowerCase());
  const indexes: Record<string, number> = {};
  for (const [field, column] of Object.entries(columns)) {
    const index =
      typeof column === 'number'
        ? column
        : normalized.indexOf(column.replace(/\s+/g, ' ').trim().toLowerCase());
    if (index < 0 || (typeof column === 'number' && column >= headers.length)) {
      throw new ToolDropError('strategy_failed', `the table has no column "${column}"`, {
        details: { headers },
      });
    }
    indexes[field] = index;
  }
  return indexes;
}

/** A readable form of a ranked selector, for error messages. */
export function describeTarget(target: RankedSelector): string {
  return target
    .map((selector) => {
      if (selector.kind === 'role') {
        return `role=${selector.role}${selector.name ? `[name="${selector.name}"]` : ''}`;
      }
      return `${selector.kind}=${selector.value}`;
    })
    .join(' | ');
}

/** Runs one step and labels any failure with the step's number, so heals know where to look. */
export async function atStep<T>(index: number, step: Step, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const code = error instanceof ToolDropError ? error.code : 'strategy_failed';
    const details = error instanceof ToolDropError ? error.details : undefined;
    throw new ToolDropError(code, `step ${index + 1} (${step.op}): ${reason}`, {
      details: { ...details, step: index },
      cause: error,
    });
  }
}

/** Whether two URLs are the same page: origin and path, ignoring the query and a trailing slash. */
export function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (url: URL) => url.pathname.replace(/\/+$/, '') || '/';
    return x.origin === y.origin && path(x) === path(y);
  } catch {
    return false;
  }
}
