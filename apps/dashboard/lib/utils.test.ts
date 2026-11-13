import { describe, expect, it } from 'vitest';
import { duration } from './utils.ts';

describe('duration', () => {
  it('shows milliseconds, seconds and minutes as people read them', () => {
    expect(duration(340)).toBe('340 ms');
    expect(duration(999.6)).toBe('1000 ms');
    expect(duration(2400)).toBe('2.4 s');
    expect(duration(12_034)).toBe('12.0 s');
    expect(duration(186_000)).toBe('3.1 min');
  });

  it('shows a dash when there is no time', () => {
    expect(duration(null)).toBe('–');
  });
});
