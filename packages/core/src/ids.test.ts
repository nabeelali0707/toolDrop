import { describe, expect, it } from 'vitest';
import { idTime, isId, newId } from './ids.ts';

describe('ids', () => {
  it('creates ULIDs', () => {
    expect(isId(newId())).toBe(true);
    expect(isId('not-an-id')).toBe(false);
  });

  it('sorts by creation order, even within one millisecond', () => {
    const ids = Array.from({ length: 1000 }, newId);
    expect([...ids].sort()).toEqual(ids);
  });

  it('records when the ID was made', () => {
    const before = Date.now();
    const time = idTime(newId()).getTime();
    expect(time).toBeGreaterThanOrEqual(before);
    expect(time).toBeLessThanOrEqual(Date.now());
  });
});
