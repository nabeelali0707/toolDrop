import { describe, expect, it } from 'vitest';
import { evaluateCondition } from './conditions.ts';
import { queryAll, queryOne } from './jsonpath.ts';
import { render, renderText, type TemplateContext } from './templates.ts';

const context: TemplateContext = {
  site: 'http://127.0.0.1:4101',
  input: { status: 'open', limit: 5 },
  session: {},
  vars: { token: 'abc' },
  loop: { page: 2 },
};

describe('render', () => {
  it('keeps the type of a value that fills a whole string', () => {
    expect(render({ page: '{{loop.page}}', limit: '{{input.limit}}' }, context)).toEqual({
      page: 2,
      limit: 5,
    });
  });

  it('interpolates inside longer strings', () => {
    expect(renderText('{{site}}/api?status={{input.status}}', context)).toBe(
      'http://127.0.0.1:4101/api?status=open',
    );
    expect(renderText('Bearer {{vars.token}}', context)).toBe('Bearer abc');
  });

  it('drops keys for inputs the caller left out', () => {
    expect(render({ status: '{{input.status}}', from: '{{input.from}}' }, context)).toEqual({
      status: 'open',
    });
  });

  it('fails on a missing saved value, which means the recipe is broken', () => {
    expect(() => render('{{vars.missing}}', context)).toThrow('{{vars.missing}} has no value at this step');
  });
});

describe('jsonpath', () => {
  const json = { items: [{ total: { value: 1 } }, { total: { value: 2 } }], hasMore: false };

  it('reads values', () => {
    expect(queryAll(json, '$.items[*].total.value')).toEqual([1, 2]);
    expect(queryOne(json, '$.hasMore')).toBe(false);
    expect(queryOne(json, '$.missing')).toBeUndefined();
  });

  it('never evaluates filter scripts', () => {
    expect(() => queryAll(json, '$.items[?(@.total.value > 1)]')).toThrow();
  });
});

describe('evaluateCondition', () => {
  it.each([
    ['$.hasMore == false', { hasMore: false }, true],
    ['$.hasMore == false', { hasMore: true }, false],
    ['$.meta.page >= $.meta.totalPages', { meta: { page: 3, totalPages: 3 } }, true],
    ['$.next == null', {}, true],
    ["$.state != 'open' && $.count < 10", { state: 'paid', count: 3 }, true],
    ['($.a == 1 || $.b == 2) && $.c == true', { a: 0, b: 2, c: true }, true],
    ["$['has more'] == false", { 'has more': false }, true],
  ])('%s', (expression, json, expected) => {
    expect(evaluateCondition(expression, json)).toBe(expected);
  });

  it('rejects anything that is not a comparison', () => {
    expect(() => evaluateCondition('process.exit(1)', {})).toThrow('invalid condition');
    expect(() => evaluateCondition('$.a == ', {})).toThrow('unexpected end');
  });
});
