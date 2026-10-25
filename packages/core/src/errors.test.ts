import { describe, expect, it } from 'vitest';
import { isToolDropError, ToolDropError } from './errors.ts';

describe('ToolDropError', () => {
  it('serializes to code, message and details, never the cause', () => {
    const error = new ToolDropError('invalid_input', 'status must be one of open, paid', {
      details: { field: 'status' },
      cause: new Error('internal detail'),
    });
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: 'invalid_input',
      message: 'status must be one of open, paid',
      details: { field: 'status' },
    });
  });

  it('can be matched by code', () => {
    const error: unknown = new ToolDropError('heal_timeout', 'still healing');
    expect(isToolDropError(error)).toBe(true);
    expect(isToolDropError(error, 'heal_timeout')).toBe(true);
    expect(isToolDropError(error, 'internal')).toBe(false);
    expect(isToolDropError(new Error('plain'))).toBe(false);
  });
});
