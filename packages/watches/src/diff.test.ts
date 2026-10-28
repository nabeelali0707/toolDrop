import { describe, expect, it } from 'vitest';
import { applyChange, diff, hashOf, rowsByKey, snapshotOf } from './diff.ts';

const invoices = [
  { number: 'INV-1002', status: 'open', amount: 20 },
  { number: 'INV-1001', status: 'paid', amount: 10 },
];

describe('rowsByKey', () => {
  it('keys rows by a text or number field', () => {
    expect([...rowsByKey(invoices, 'number').keys()]).toEqual(['INV-1002', 'INV-1001']);
    expect([...rowsByKey([{ id: 7 }, { id: 8 }], 'id').keys()]).toEqual(['7', '8']);
  });

  it('says why a result cannot be watched by that key', () => {
    expect(() => rowsByKey({ number: 'INV-1' }, 'number')).toThrow('returns a list of rows');
    expect(() => rowsByKey([invoices[0], 'text'], 'number')).toThrow('row 2 of the result is not a record');
    expect(() => rowsByKey(invoices, 'id')).toThrow('row 1 has no "id"');
    expect(() => rowsByKey(invoices, 'status')).not.toThrow();
    expect(() => rowsByKey([...invoices, { number: 'INV-1001' }], 'number')).toThrow(
      '"number" is not unique: "INV-1001" appears twice',
    );
  });
});

describe('diff', () => {
  const before = snapshotOf(rowsByKey(invoices, 'number'));

  it('finds created, updated and deleted rows', () => {
    const now = rowsByKey(
      [
        { number: 'INV-1003', status: 'open', amount: 30 },
        { number: 'INV-1002', status: 'paid', amount: 20 },
      ],
      'number',
    );
    expect(diff(before, now)).toEqual([
      { type: 'created', key: 'INV-1003', row: { number: 'INV-1003', status: 'open', amount: 30 } },
      { type: 'updated', key: 'INV-1002', row: { number: 'INV-1002', status: 'paid', amount: 20 } },
      { type: 'deleted', key: 'INV-1001' },
    ]);
  });

  it('sees no change when only the field order or the row order differs', () => {
    const reordered = rowsByKey(
      [
        { amount: 10, status: 'paid', number: 'INV-1001' },
        { status: 'open', number: 'INV-1002', amount: 20 },
      ],
      'number',
    );
    expect(diff(before, reordered)).toEqual([]);
    expect(snapshotOf(reordered).rows).toEqual(before.rows);
  });

  it('keeps only hashes, and moves the snapshot one delivered change at a time', () => {
    expect(JSON.stringify(before)).not.toContain('INV-1001","status');
    const rows = { ...before.rows };
    applyChange(rows, { type: 'created', key: 'INV-1003', row: { number: 'INV-1003' } });
    applyChange(rows, { type: 'deleted', key: 'INV-1001' });
    expect(rows).toEqual({ 'INV-1002': before.rows['INV-1002'], 'INV-1003': hashOf({ number: 'INV-1003' }) });
  });
});
