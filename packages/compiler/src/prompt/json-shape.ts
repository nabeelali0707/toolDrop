import { truncate } from './ax-prune.ts';

// A JSON body as keys, types and one truncated sample (SPEC, Local LLM usage:
// "the response's JSON shape"). Arrays show their length and their first
// item; literals show their type by their form.

export interface ShapeLimits {
  /** Characters kept of each string. */
  text: number;
  /** Keys shown per object. */
  keys: number;
  /** Nesting shown before `{…}`. */
  depth: number;
}

export const SHAPE_LEVELS: ShapeLimits[] = [
  { text: 40, keys: 25, depth: 5 },
  { text: 24, keys: 15, depth: 4 },
  { text: 12, keys: 8, depth: 3 },
];

export function describeJson(value: unknown, limits: ShapeLimits = SHAPE_LEVELS[0]!, depth = 0): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(truncate(value, limits.text));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (depth >= limits.depth) return `[${value.length} items]`;
    return `[${value.length} × ${describeJson(value[0], limits, depth + 1)}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    if (depth >= limits.depth) return '{…}';
    const shown = entries
      .slice(0, limits.keys)
      .map(([key, item]) => `${key}: ${describeJson(item, limits, depth + 1)}`);
    if (entries.length > limits.keys) shown.push(`…${entries.length - limits.keys} more keys`);
    return `{ ${shown.join(', ')} }`;
  }
  // Parsed JSON has no other types; anything else is named by its type.
  return typeof value;
}

/** Parses JSON, or returns undefined for anything that is not. */
export function tryJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
