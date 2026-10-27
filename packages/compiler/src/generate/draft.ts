import type { Selector, Step, Strategy } from '@tooldrop/core';
import type { Capture } from '../capture/capture.ts';
import type { Exchange } from '../capture/har.ts';
import { parseBody } from '../prompt/har-summary.ts';
import { identifier, type ClassifiedField, type RequestAnalysis } from '../analyze/classify.ts';
import { targetRows, type HtmlCandidate, type JsonCandidate } from '../analyze/rank.ts';

// Draft recipes built from the evidence alone: requests, templates, paging
// and field paths come from the analysis, not from a model. The code model
// then reviews the draft against the task (generate/recipe.ts), which is far
// more reliable for a 7B model than writing a recipe from nothing.

/** An output field: the column on screen it shows in, and its path in each JSON record. */
type HttpStep = Extract<Step, { op: 'http' }>;

export interface ColumnBinding {
  field: string;
  header?: string;
  path?: string;
}

export interface Draft {
  strategy: Strategy;
  steps: Step[];
  bindings: ColumnBinding[];
}

/** Output field names from column headers: snake_case and unique. */
export function fieldNames(headers: string[]): string[] {
  const taken = new Set<string>();
  return headers.map((header) => {
    const base = identifier(header);
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
    taken.add(name);
    return name;
  });
}

/** A captured URL relative to the site, so the recipe follows the site to another origin. */
export function siteUrl(url: string, site: string, withQuery = false): string {
  const parsed = new URL(url);
  const rest = `${parsed.pathname}${withQuery ? parsed.search : ''}`;
  return parsed.origin === new URL(site).origin ? `{{site}}${rest}` : `${parsed.origin}${rest}`;
}

/** What a classified field becomes in the recipe. */
function template(field: ClassifiedField, pagingVariable: string | undefined): unknown {
  switch (field.kind) {
    case 'user_input':
      return `{{input.${field.input}}}`;
    case 'pagination':
      return `{{loop.${pagingVariable}}}`;
    case 'auth':
    case 'derived':
      return field.variable ? `${field.prefix ?? ''}{{vars.${field.variable}}}` : field.raw;
    default:
      return field.raw;
  }
}

/** Steps that repeat earlier requests: pages for cookies and tokens, API calls for IDs. */
function prerequisiteSteps(analysis: RequestAnalysis, site: string): Step[] {
  const steps: Step[] = [];
  for (const exchange of analysis.prerequisites) {
    const reads = analysis.fields.filter((field) => field.from?.exchange === exchange && field.variable);
    const saves = Object.fromEntries(
      reads.flatMap((field) => (field.from?.kind === 'response' ? [[field.variable, field.from.path]] : [])),
    ) as Record<string, string>;
    steps.push({
      op: 'http',
      method: exchange.method as HttpStep['method'],
      url: siteUrl(exchange.url, site),
      ...queryOf(exchange),
      ...bodyOf(exchange, (field) => field.raw),
      ...(Object.keys(saves).length > 0 && { save: saves }),
    });
    for (const field of reads) {
      if (field.from?.kind !== 'page' || !field.variable) continue;
      steps.push({
        op: 'extract_text',
        target: [{ kind: 'css', value: field.from.selector }],
        attribute: field.from.attribute,
        save: field.variable,
      });
    }
  }
  return steps;
}

function queryOf(
  exchange: Exchange,
  fields?: ClassifiedField[],
  paging?: string,
): { query?: Record<string, string> } {
  const query: Record<string, string> = {};
  if (fields) {
    for (const field of fields.filter((f) => f.location === 'query'))
      query[field.name] = String(template(field, paging));
  } else {
    for (const [name, value] of new URL(exchange.url).searchParams) query[name] = value;
  }
  return Object.keys(query).length > 0 ? { query } : {};
}

function bodyOf(
  exchange: Exchange,
  value: (field: ClassifiedField) => unknown,
  fields?: ClassifiedField[],
): Pick<HttpStep, 'body' | 'body_format'> {
  const parsed = parseBody(exchange);
  if (parsed === undefined) return {};
  const form = /x-www-form-urlencoded/.test(exchange.request_headers['content-type'] ?? '');
  const body = structuredClone(parsed);
  for (const field of fields ?? []) {
    if (field.location !== 'body' || !field.at) continue;
    let node = body as Record<string, unknown>;
    for (const key of field.at.slice(0, -1)) node = node[key] as Record<string, unknown>;
    const last = field.at.at(-1);
    if (last !== undefined) node[last] = value(field);
  }
  return { body: body as HttpStep['body'], ...(form && { body_format: 'form' as const }) };
}

/** http_replay: replay the API call that returned the data, then map its records. */
export function jsonDraft(candidate: JsonCandidate, analysis: RequestAnalysis, site: string): Draft {
  const { exchange, pagination } = { exchange: analysis.exchange, pagination: analysis.pagination };
  const paging = pagination?.variable;
  const names = fieldNames(candidate.columns.map((column) => column.header));
  const bindings = candidate.columns.map((column, index) => ({
    field: names[index] ?? `field_${index}`,
    header: column.header,
    path: column.path,
  }));

  let url = siteUrl(exchange.url, site);
  for (const field of analysis.fields.filter((f) => f.location === 'path' && f.kind !== 'constant')) {
    url = url.replace(`/${encodeURIComponent(String(field.raw))}`, `/${String(template(field, paging))}`);
  }
  const headers = Object.fromEntries(
    analysis.fields
      .filter((field) => field.location === 'header')
      .map((field) => [field.name, String(template(field, paging))]),
  );
  const request: Step = {
    op: 'http',
    method: exchange.method as HttpStep['method'],
    url,
    ...queryOf(exchange, analysis.fields, paging),
    ...(Object.keys(headers).length > 0 && { headers }),
    ...bodyOf(exchange, (field) => template(field, paging), analysis.fields),
    ...(pagination && {
      paginate: {
        var: pagination.variable,
        until: pagination.until,
        ...(pagination.mode === 'cursor' ? { from: pagination.from } : { start: pagination.start }),
        ...(pagination.step !== undefined && { step: pagination.step }),
      },
    }),
  };
  return {
    strategy: 'http_replay',
    steps: [
      ...prerequisiteSteps(analysis, site),
      request,
      {
        op: 'map',
        path: candidate.items,
        fields: Object.fromEntries(bindings.map((binding) => [binding.field, binding.path])),
      },
    ],
    bindings,
  };
}

/** Selectors that work without a browser: css and test ids. */
function parseable(selectors: Selector[]): Selector[] {
  return selectors.filter((selector) => selector.kind === 'css' || selector.kind === 'test_id');
}

/** html_fetch: fetch the server-rendered page and read its table. Undefined when that cannot work. */
export function htmlDraft(
  capture: Capture,
  candidate: HtmlCandidate,
  analysis: RequestAnalysis,
  site: string,
): Draft | undefined {
  const target = capture.target;
  if (target?.data.kind !== 'table') return undefined;
  const selectors = parseable(target.selector);
  if (selectors.length === 0 || candidate.exchange.method !== 'GET') return undefined;
  const { headers } = targetRows(target.data);
  const names = fieldNames(headers);
  const bindings = headers.map((header, index) => ({ field: names[index] ?? `field_${index}`, header }));
  return {
    strategy: 'html_fetch',
    steps: [
      ...prerequisiteSteps(analysis, site),
      {
        op: 'http',
        method: 'GET',
        url: siteUrl(candidate.exchange.url, site),
        ...queryOf(candidate.exchange, analysis.fields),
      },
      {
        op: 'extract_table',
        target: selectors,
        columns: Object.fromEntries(bindings.map((binding) => [binding.field, binding.header])),
      },
    ],
    bindings,
  };
}

/**
 * browser_script: the recorded actions, with marked inputs as templates, a
 * "Load more" loop when the page has one, and the data read from the page.
 * It is also every recipe's fallback.
 */
export function browserDraft(capture: Capture, site: string, bindings?: ColumnBinding[]): Draft {
  const target = capture.target;
  const steps: Step[] = [];
  capture.actions.forEach((action, index) => {
    const input = capture.inputs.find((candidate) => candidate.action === index);
    const value = (recorded: string) => (input ? `{{input.${input.name}}}` : recorded);
    switch (action.kind) {
      case 'goto':
        steps.push({ op: 'goto', url: siteUrl(action.url, site, true) });
        break;
      case 'click':
        steps.push({ op: 'click', target: action.target });
        break;
      case 'fill':
        // Typing a password is signing in, which the session takes care of.
        if (action.value !== null)
          steps.push({ op: 'fill', target: action.target, value: value(action.value) });
        break;
      case 'select':
        steps.push({ op: 'select', target: action.target, value: value(action.value) });
        break;
    }
  });
  if (target?.more) steps.push({ op: 'click', target: target.more.selector, repeat: { max: 20 } });

  let used = bindings;
  if (!used) {
    const { headers } = target ? targetRows(target.data) : { headers: [] };
    const names = fieldNames(headers);
    used = headers.map((header, index) => ({ field: names[index] ?? `field_${index}`, header }));
  }
  if (target?.data.kind === 'table') {
    steps.push({
      op: 'extract_table',
      target: target.selector,
      columns: Object.fromEntries(used.flatMap((b) => (b.header ? [[b.field, b.header]] : []))),
    });
  } else if (target) {
    // Lists and text are read as one text; reading list items one by one needs an op of its own.
    steps.push({ op: 'extract_text', target: target.selector });
  }
  return { strategy: 'browser_script', steps, bindings: used };
}
