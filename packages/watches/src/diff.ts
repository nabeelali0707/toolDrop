import { createHash } from 'node:crypto';
import { ToolDropError, type WatchEventType } from '@tooldrop/core';

// Diffing a tool's result by its key field (SPEC, Watches). Between runs a
// watch keeps only hashes, never the rows, so tool results stay off the disk
// and a deleted row is reported by its key alone.

/** What a watch keeps between runs. */
export interface Snapshot {
  /** Hash of the whole result, to skip the diff when nothing changed. */
  hash: string;
  /** Hash of each row, by key. */
  rows: Record<string, string>;
}

export interface Change {
  type: WatchEventType;
  key: string;
  /** The row now; deleted rows have none. */
  row?: Record<string, unknown>;
}

export type Rows = Map<string, Record<string, unknown>>;

/**
 * A tool's rows by key. Fails, saying why, when the result is not a list of
 * records, or when a row has no key or shares it with another row: a diff by
 * such a key would report changes that did not happen.
 */
export function rowsByKey(result: unknown, keyField: string): Rows {
  if (!Array.isArray(result)) {
    throw new ToolDropError('invalid_input', 'a watch needs a tool that returns a list of rows');
  }
  const rows: Rows = new Map();
  result.forEach((row: unknown, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new ToolDropError('invalid_input', `row ${index + 1} of the result is not a record`);
    }
    const record = row as Record<string, unknown>;
    const value = record[keyField];
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new ToolDropError(
        'invalid_input',
        `row ${index + 1} has no "${keyField}"; the key field must be a text or number field every row has`,
      );
    }
    const key = String(value);
    if (rows.has(key)) {
      throw new ToolDropError(
        'invalid_input',
        `"${keyField}" is not unique: ${JSON.stringify(key)} appears twice; pick a field that tells rows apart`,
      );
    }
    rows.set(key, record);
  });
  return rows;
}

export function snapshotOf(rows: Rows): Snapshot {
  const hashes = Object.fromEntries([...rows].map(([key, row]) => [key, hashOf(row)]));
  return { hash: hashOf(hashes), rows: hashes };
}

/** What changed since the last snapshot: created and updated rows in result order, then deleted ones. */
export function diff(previous: Snapshot, rows: Rows): Change[] {
  const changes: Change[] = [];
  for (const [key, row] of rows) {
    const before = previous.rows[key];
    if (before === undefined) changes.push({ type: 'created', key, row });
    else if (before !== hashOf(row)) changes.push({ type: 'updated', key, row });
  }
  for (const key of Object.keys(previous.rows)) {
    if (!rows.has(key)) changes.push({ type: 'deleted', key });
  }
  return changes;
}

/** The snapshot once a change is delivered: the next run compares against it. */
export function applyChange(snapshot: Record<string, string>, change: Change): void {
  if (change.row) snapshot[change.key] = hashOf(change.row);
  else delete snapshot[change.key];
}

/** SHA-256 of a value's JSON with sorted keys, so field order does not count as a change. */
export function hashOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
