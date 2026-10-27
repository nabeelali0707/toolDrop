// Matching what was on screen against what the network returned. A cell may
// show a JSON value exactly ("INV-1056"), formatted ("$1,234.50" for 1234.5),
// or inside other text ("Delivered 2026-10-20").

export function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A number as a page shows it: "$1,234.50" is 1234.5. Undefined for anything else. */
export function asNumber(text: string): number | undefined {
  const cleaned = text.replace(/[\s$€£¥,]/g, '');
  return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : undefined;
}

export type Primitive = string | number | boolean;
export type Match = 'exact' | 'partial';

/** How a cell's text relates to one JSON value: the same, containing it, or unrelated. */
export function compareCell(cell: string, value: Primitive): Match | undefined {
  const shown = normalize(cell);
  const raw = normalize(String(value));
  if (shown === '' || raw === '') return undefined;
  if (shown === raw) return 'exact';
  const a = asNumber(shown);
  const b = typeof value === 'number' ? value : asNumber(raw);
  if (a !== undefined && b !== undefined && Math.abs(a - b) < 1e-9) return 'exact';
  if (raw.length >= 4 && shown.includes(raw)) return 'partial';
  return undefined;
}

export interface Leaf {
  /** JSONPath relative to the value walked, e.g. "$.total.value". */
  path: string;
  value: Primitive;
}

/** A JSONPath step for a key: dot notation when it can be, brackets otherwise. */
export function pathStep(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `['${key.replace(/'/g, "\\'")}']`;
}

/**
 * The primitive values in a JSON value with their paths. Arrays inside are
 * skipped: a column shows one value per row, and a list of line items is not
 * one value.
 */
export function leaves(json: unknown, base = '$'): Leaf[] {
  if (json === null || json === undefined) return [];
  if (typeof json === 'string' || typeof json === 'number' || typeof json === 'boolean') {
    return [{ path: base, value: json }];
  }
  if (Array.isArray(json) || typeof json !== 'object') return [];
  return Object.entries(json).flatMap(([key, value]) => leaves(value, `${base}${pathStep(key)}`));
}

export interface ArrayOfRecords {
  /** JSONPath to the items, e.g. "$.items[*]" or "$.data.orders[*]". */
  path: string;
  items: Record<string, unknown>[];
}

/** Every array of objects in a JSON value, outermost first. */
export function recordArrays(json: unknown, base = '$'): ArrayOfRecords[] {
  if (json === null || typeof json !== 'object') return [];
  if (Array.isArray(json)) {
    const records = json.filter(
      (item): item is Record<string, unknown> =>
        item !== null && typeof item === 'object' && !Array.isArray(item),
    );
    const here = records.length > 0 ? [{ path: `${base}[*]`, items: records }] : [];
    // Nested arrays of the first item stand for all of them.
    return [...here, ...(records[0] ? recordArraysOf(records[0], `${base}[*]`) : [])];
  }
  return recordArraysOf(json as Record<string, unknown>, base);
}

function recordArraysOf(object: Record<string, unknown>, base: string): ArrayOfRecords[] {
  return Object.entries(object).flatMap(([key, value]) => recordArrays(value, `${base}${pathStep(key)}`));
}

/** The value at a path made by `leaves`, read without a JSONPath library. */
export function valueAt(json: unknown, path: string): unknown {
  const steps = path.slice(1).match(/\.[A-Za-z_$][A-Za-z0-9_$]*|\['(?:[^'\\]|\\.)*'\]/g) ?? [];
  let current: unknown = json;
  for (const step of steps) {
    if (current === null || typeof current !== 'object') return undefined;
    const key = step.startsWith('.') ? step.slice(1) : step.slice(2, -2).replace(/\\'/g, "'");
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
