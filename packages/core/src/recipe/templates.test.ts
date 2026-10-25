import { describe, expect, it } from 'vitest';
import { collectTemplateRefs, parseTemplate } from './templates.ts';

describe('parseTemplate', () => {
  it('finds every reference, ignoring whitespace inside the braces', () => {
    const scan = parseTemplate('{{site}}/api?status={{ input.status }}&csrf={{session.csrf}}');
    expect(scan.errors).toEqual([]);
    expect(scan.refs).toEqual([
      { root: 'site', path: [], raw: 'site' },
      { root: 'input', path: ['status'], raw: 'input.status' },
      { root: 'session', path: ['csrf'], raw: 'session.csrf' },
    ]);
  });

  it('keeps nested paths', () => {
    expect(parseTemplate('{{input.filter.from}}').refs[0]?.path).toEqual(['filter', 'from']);
  });

  it.each([
    ['{{input}}', '{{input}} needs a name, e.g. {{input.name}}'],
    ['{{site.host}}', '{{site.host}}: {{site}} takes no path'],
    ['{{input.2fa}}', '{{input.2fa}} has an invalid name; names use letters, digits and _'],
    ['{{input.status', 'unbalanced braces in "{{input.status"'],
  ])('reports %s', (text, error) => {
    expect(parseTemplate(text).errors).toEqual([error]);
  });

  it('treats text without references as plain text', () => {
    expect(parseTemplate('/api/v2/invoices')).toEqual({ refs: [], errors: [] });
  });
});

describe('collectTemplateRefs', () => {
  it('walks nested objects and arrays', () => {
    const scan = collectTemplateRefs({ url: '{{site}}', body: { ids: ['{{vars.first}}', 7, null] } });
    expect(scan.refs.map((ref) => ref.raw)).toEqual(['site', 'vars.first']);
  });
});
