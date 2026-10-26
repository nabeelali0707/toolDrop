import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { recipeSchema } from './schema.ts';

/** The example under "Recipe step format" in SPEC.md, so spec and schema cannot drift apart. */
function specExampleRecipe(): unknown {
  const spec = readFileSync(new URL('../../../../SPEC.md', import.meta.url), 'utf8');
  const section = spec.slice(spec.indexOf('**Recipe step format**'));
  const block = /```json\n([\s\S]*?)```/.exec(section);
  if (!block?.[1]) throw new Error('SPEC.md has no json block under "Recipe step format"');
  return JSON.parse(block[1]);
}

/** Messages of a failed parse, for readable assertions. */
function issues(value: unknown): string[] {
  const result = recipeSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

const search = {
  op: 'http',
  method: 'POST',
  url: '{{site}}/api/v2/invoices/search',
  body: { status: '{{input.status}}' },
};

describe('recipeSchema', () => {
  it("accepts SPEC's example recipe", () => {
    expect(issues(specExampleRecipe())).toEqual([]);
  });

  it('accepts a browser recipe with ranked selectors', () => {
    const recipe = {
      strategy: 'browser_script',
      steps: [
        { op: 'goto', url: '{{site}}/invoices' },
        {
          op: 'select',
          target: [{ kind: 'role', role: 'combobox', name: 'Status' }],
          value: '{{input.status}}',
        },
        {
          op: 'click',
          target: [
            { kind: 'role', role: 'button', name: 'Search' },
            { kind: 'test_id', value: 'search' },
            { kind: 'css', value: 'form button[type=submit]' },
          ],
        },
        { op: 'wait_for', target: [{ kind: 'css', value: '#invoices tbody tr' }] },
        {
          op: 'extract_table',
          target: [{ kind: 'css', value: '#invoices' }],
          columns: { number: 'Number', amount: 'Amount', status: 4 },
        },
      ],
    };
    expect(issues(recipe)).toEqual([]);
  });

  it('rejects an op the strategy does not allow', () => {
    const recipe = {
      strategy: 'http_replay',
      steps: [search, { op: 'click', target: [{ kind: 'css', value: 'a' }] }],
    };
    expect(issues(recipe)).toEqual([
      '"click" is not allowed in a http_replay recipe; allowed: http, map, extract_text',
    ]);
  });

  it('rejects unknown keys, so invented fields are caught', () => {
    expect(issues({ strategy: 'http_replay', steps: [{ ...search, retries: 3 }] })).toHaveLength(1);
  });

  it('requires css or test_id selectors in html_fetch recipes', () => {
    const recipe = {
      strategy: 'html_fetch',
      steps: [
        { op: 'http', method: 'GET', url: '{{site}}/invoices' },
        { op: 'extract_text', target: [{ kind: 'text', value: 'Total' }] },
      ],
    };
    expect(issues(recipe)).toEqual([
      'html_fetch has no browser to resolve role or text selectors; add a css or test_id selector',
    ]);
  });

  it('allows {{loop.*}} only in the step that paginates with that variable', () => {
    const recipe = {
      strategy: 'http_replay',
      steps: [{ ...search, body: { page: '{{loop.page}}' } }],
    };
    expect(issues(recipe)).toEqual([
      '{{loop.page}} only works inside the http step whose paginate.var is "page"',
    ]);
  });

  it('allows {{vars.*}} only after an earlier step saved it', () => {
    const fetchAccount = {
      op: 'http',
      method: 'GET',
      url: '{{site}}/api/me',
      save: { accountId: '$.account.id' },
    };
    const listInvoices = {
      op: 'http',
      method: 'GET',
      url: '{{site}}/api/accounts/{{vars.accountId}}/invoices',
    };

    expect(issues({ strategy: 'http_replay', steps: [fetchAccount, listInvoices] })).toEqual([]);
    expect(issues({ strategy: 'http_replay', steps: [listInvoices, fetchAccount] })).toEqual([
      '{{vars.accountId}} is used before an earlier step saves "accountId"',
    ]);
  });

  it('rejects template references with an unknown root', () => {
    const recipe = { strategy: 'http_replay', steps: [{ ...search, url: '{{host}}/api' }] };
    expect(issues(recipe)).toEqual([
      '{{host}} has an unknown root "host"; use one of site, input, session, loop, vars',
    ]);
  });

  it('requires exactly one pagination mode', () => {
    const both = { ...search, paginate: { var: 'page', until: '$.done', start: 1, from: '$.next' } };
    expect(issues({ strategy: 'http_replay', steps: [both] })).toEqual([
      'set exactly one of "start" (page numbers) or "from" (cursor)',
    ]);
  });

  it('lets http_replay read a page token and send it with later requests', () => {
    const recipe = {
      strategy: 'http_replay',
      steps: [
        { op: 'http', method: 'GET', url: '{{site}}/' },
        {
          op: 'extract_text',
          target: [{ kind: 'css', value: 'meta[name=csrf-token]' }],
          attribute: 'content',
          save: 'csrf',
        },
        { ...search, headers: { 'x-csrf-token': '{{vars.csrf}}' } },
      ],
    };
    expect(issues(recipe)).toEqual([]);
  });

  it('accepts a browser fallback, checked as its own recipe', () => {
    const fallback = {
      strategy: 'browser_script',
      steps: [
        { op: 'goto', url: '{{site}}/invoices' },
        { op: 'extract_table', target: [{ kind: 'css', value: '#invoices' }], columns: { number: 'Number' } },
      ],
    };
    expect(issues({ strategy: 'http_replay', steps: [search], fallback })).toEqual([]);

    const httpInFallback = { ...fallback, steps: [search] };
    expect(issues({ strategy: 'http_replay', steps: [search], fallback: httpInFallback })).toEqual([
      '"http" is not allowed in a browser_script recipe; allowed: goto, click, fill, select, wait_for, extract_table, extract_text, map',
    ]);
  });

  it('keeps saved values separate between the recipe and its fallback', () => {
    const recipe = {
      strategy: 'http_replay',
      steps: [{ ...search, save: { total: '$.total' } }],
      fallback: { strategy: 'browser_script', steps: [{ op: 'goto', url: '{{site}}/{{vars.total}}' }] },
    };
    expect(issues(recipe)).toEqual(['{{vars.total}} is used before an earlier step saves "total"']);
  });

  it('does not give a browser recipe a fallback', () => {
    const goto = { op: 'goto', url: '{{site}}' };
    const recipe = {
      strategy: 'browser_script',
      steps: [goto],
      fallback: { strategy: 'browser_script', steps: [goto] },
    };
    expect(issues(recipe)).toEqual([
      'a browser_script recipe has nothing to fall back to; remove "fallback"',
    ]);
  });

  it('converts to JSON Schema, which constrained decoding in Ollama needs', () => {
    const jsonSchema = z.toJSONSchema(recipeSchema);
    expect(jsonSchema).toMatchObject({ type: 'object', required: ['strategy', 'steps'] });
  });
});
