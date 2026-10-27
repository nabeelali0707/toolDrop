import { load, type CheerioAPI } from 'cheerio';
import type { Capture } from '../capture/capture.ts';
import type { Exchange } from '../capture/har.ts';
import {
  isBoilerplateHeader,
  parseBody,
  type FieldKind,
  type FieldLocation,
  type FieldNote,
} from '../prompt/har-summary.ts';
import { tryJson } from '../prompt/json-shape.ts';
import { leaves, pathStep, type Primitive } from './values.ts';

// What each part of the data request is (SPEC, Build pipeline step 5):
// constant, user_input, derived, auth or pagination. Heuristics decide all
// they can; an opaque value nothing explains is left for the reasoning model.

/** Where an auth or derived value comes from: an earlier page or an earlier JSON response. */
export type ValueSource =
  | { kind: 'page'; exchange: Exchange; selector: string; attribute: string }
  | { kind: 'response'; exchange: Exchange; path: string };

export interface ClassifiedField extends FieldNote {
  kind: FieldKind;
  /** The value as sent; numbers in JSON bodies stay numbers. */
  raw: unknown;
  /** Body fields: the path to the value inside the body. */
  at?: string[];
  /** user_input: the input that fills it. */
  input?: string;
  /** auth and derived: where to read the value, and the variable it is saved in. */
  from?: ValueSource;
  variable?: string;
  /** Text before the value, e.g. "Bearer ". */
  prefix?: string;
  /** Opaque, and nothing captured explains it: for the reasoning model. */
  leftover?: boolean;
}

export interface Pagination {
  location: FieldLocation;
  /** The field's name, with dots for nested body fields. */
  field: string;
  mode: 'page' | 'offset' | 'cursor';
  /** The loop variable, read as {{loop.<variable>}}. */
  variable: string;
  start?: number;
  step?: number;
  /** Cursor mode: where each response holds the next cursor. */
  from?: string;
  until: string;
}

export interface RequestAnalysis {
  exchange: Exchange;
  fields: ClassifiedField[];
  pagination?: Pagination;
  /** Earlier requests the recipe repeats first, oldest first: pages that set cookies or hold tokens, and API calls that return IDs. */
  prerequisites: Exchange[];
  /** Why replaying the request cannot work, if it cannot. */
  blockers: string[];
}

const AUTH_HEADER = /^(authorization|x-api-key)$|csrf|xsrf|token|auth|session/i;
const AUTH_FIELD =
  /^(_?csrf(_?token)?|_?xsrf(_?token)?|csrfmiddlewaretoken|authenticity_token|_token|token|access_token|session(_?id)?|sid)$/i;
const PAGE = /^(page|p|pg|page_?num(ber)?|page_?no|page_?index|current_?page)$/i;
const OFFSET = /^(offset|skip|start|start_?index)$/i;
const CURSOR =
  /^(cursor|after|next|next_?cursor|next_?token|page_?token|continuation(_?token)?|starting_after)$/i;
const SIZE = /^(limit|size|page_?size|per_?page|count|take|first)$/i;
/** Headers the runtime sets itself. */
const RUNTIME_HEADERS = new Set(['cookie', 'content-type', 'content-length']);

export function classifyRequest(capture: Capture, exchange: Exchange, items?: string): RequestAnalysis {
  const earlier = capture.exchanges.filter((e) => e.index < exchange.index && e.status < 400).reverse();
  const fields = collectFields(exchange);
  const pagination = detectPagination(capture, exchange, fields, items);
  const pages = new Map<Exchange, CheerioAPI>();
  const variables = new Set<string>();
  const prerequisites = new Set<Exchange>();
  const blockers: string[] = [];

  for (const field of fields) {
    const text = String(field.raw);
    if (pagination && field.location === pagination.location && field.name === pagination.field) {
      field.kind = 'pagination';
      continue;
    }
    const input = text === '' ? undefined : inputFor(capture, text);
    if (input) {
      Object.assign(field, { kind: 'user_input', input, source: `input ${input}` });
      continue;
    }
    const authNamed =
      field.location === 'header' ? AUTH_HEADER.test(field.name) : AUTH_FIELD.test(lastName(field));
    const { prefix, value } = authNamed ? splitScheme(text) : { prefix: '', value: text };
    if (authNamed || looksLikeId(value)) {
      const from = findSource(earlier, exchange, value, pages);
      if (from) {
        const variable = unique(variableName(field, from), variables);
        // Prompts show the template that replaces the value, never the value itself.
        Object.assign(field, {
          kind: authNamed ? 'auth' : 'derived',
          from,
          variable,
          prefix,
          value: `${prefix}{{vars.${variable}}}`,
          source: describeSource(from),
        });
        prerequisites.add(from.exchange);
        continue;
      }
      if (authNamed && value !== '') {
        field.kind = 'auth';
        field.value = '[masked]';
        blockers.push(
          `the ${field.location} ${field.name} carries a credential that no captured page or response explains`,
        );
        continue;
      }
    }
    field.kind = 'constant';
    if (value.length >= 16 && /\d/.test(value) && /[a-z]/i.test(value) && !/\s/.test(value))
      field.leftover = true;
  }

  // Cookies live in the runtime's cookie jar: the recipe first loads the page that set them.
  if (exchange.request_headers.cookie) {
    const setter = [...earlier].reverse().find((e) => e.response_headers['set-cookie']);
    if (setter) prerequisites.add(setter);
  }
  return {
    exchange,
    fields,
    ...(pagination && { pagination }),
    prerequisites: [...prerequisites].sort((a, b) => a.index - b.index),
    blockers,
  };
}

/** Path segments, query and body fields, and the headers that matter, all as constants until classified. */
function collectFields(exchange: Exchange): ClassifiedField[] {
  const url = new URL(exchange.url);
  const fields: ClassifiedField[] = [];
  url.pathname.split('/').forEach((segment, index) => {
    if (segment === '') return;
    const value = decodeURIComponent(segment);
    fields.push({ location: 'path', name: String(index), value, raw: value, kind: 'constant' });
  });
  for (const [name, value] of url.searchParams) {
    fields.push({ location: 'query', name, value, raw: value, kind: 'constant' });
  }
  const body = parseBody(exchange);
  const walk = (node: unknown, at: string[]) => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      for (const [key, value] of Object.entries(node)) walk(value, [...at, key]);
      return;
    }
    if (at.length === 0) return;
    const value = typeof node === 'string' ? node : JSON.stringify(node);
    fields.push({ location: 'body', name: at.join('.'), value, raw: node, at, kind: 'constant' });
  };
  if (body !== undefined) walk(body, []);
  for (const [name, value] of Object.entries(exchange.request_headers)) {
    if (isBoilerplateHeader(name) || RUNTIME_HEADERS.has(name)) continue;
    fields.push({ location: 'header', name, value, raw: value, kind: 'constant' });
  }
  return fields;
}

/** The marked input whose value the request carries: the value itself, or the option's label. */
function inputFor(capture: Capture, text: string): string | undefined {
  for (const input of capture.inputs) {
    if (input.example === text) return input.name;
    const action = capture.actions[input.action];
    if (action?.kind === 'select') {
      const option = action.options.find((o) => o.value === input.example);
      if (option && option.label === text) return input.name;
    }
  }
  return undefined;
}

function lastName(field: FieldNote): string {
  return field.name.split('.').at(-1) ?? field.name;
}

function splitScheme(text: string): { prefix: string; value: string } {
  const scheme = /^(Bearer|Token|Basic)\s+/i.exec(text)?.[0] ?? '';
  return { prefix: scheme, value: text.slice(scheme.length) };
}

/** IDs and tokens, not words, dates or small numbers: values worth tracing to an earlier response. */
function looksLikeId(value: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return false;
  return (
    (value.length >= 4 && /\d/.test(value) && /^[\w.:-]+$/.test(value)) ||
    (value.length >= 12 && /^[\w-]+$/.test(value))
  );
}

/** The most recent earlier page or response that holds the value. */
function findSource(
  earlier: Exchange[],
  request: Exchange,
  value: string,
  pages: Map<Exchange, CheerioAPI>,
): ValueSource | undefined {
  if (value.length < 3) return undefined;
  const endpoint = (e: Exchange) => `${e.method} ${new URL(e.url).pathname}`;
  for (const exchange of earlier) {
    if (!exchange.response_body) continue;
    if (exchange.resource_type === 'document' && /html/i.test(exchange.mime_type)) {
      let $ = pages.get(exchange);
      if (!$) {
        $ = load(exchange.response_body);
        pages.set(exchange, $);
      }
      const found = findInPage($, value);
      if (found) return { kind: 'page', exchange, ...found };
      continue;
    }
    if (endpoint(exchange) === endpoint(request)) continue;
    const json = tryJson(exchange.response_body);
    const leaf = leaves(json).find((candidate) => String(candidate.value) === value);
    if (leaf) return { kind: 'response', exchange, path: leaf.path };
  }
  return undefined;
}

/** A <meta> or <input> holding the value, as a selector cheerio and browsers both read. */
function findInPage($: CheerioAPI, value: string): { selector: string; attribute: string } | undefined {
  for (const element of $('meta[content], input[value]').toArray()) {
    const attribute = element.tagName === 'meta' ? 'content' : 'value';
    if (element.attribs[attribute] !== value) continue;
    const name = element.attribs.name ?? element.attribs.property;
    if (name)
      return {
        selector: `${element.tagName}[${element.attribs.name ? 'name' : 'property'}="${name}"]`,
        attribute,
      };
    if (element.attribs.id) return { selector: `#${element.attribs.id}`, attribute };
  }
  return undefined;
}

function variableName(field: ClassifiedField, from: ValueSource): string {
  const raw =
    from.kind === 'page'
      ? (/["']([^"']+)["']/.exec(from.selector)?.[1] ?? field.name)
      : (from.path
          .split(/[.[\]']+/)
          .filter(Boolean)
          .at(-1) ?? field.name);
  return identifier(raw.replace(/^x-/i, ''));
}

/** A name usable in templates: letters, digits and _. */
export function identifier(text: string): string {
  const name = text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (name === '') return 'value';
  return /^\d/.test(name) ? `f_${name}` : name;
}

function unique(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name}_${n}`;
  taken.add(candidate);
  return candidate;
}

function describeSource(from: ValueSource): string {
  const path = new URL(from.exchange.url).pathname;
  return from.kind === 'page'
    ? `${from.selector} on ${path}`
    : `${from.path} of ${from.exchange.method} ${path}`;
}

/** Page, offset or cursor paging on the data request, and when to stop (SPEC, Build pipeline step 5). */
function detectPagination(
  capture: Capture,
  exchange: Exchange,
  fields: ClassifiedField[],
  items: string | undefined,
): Pagination | undefined {
  const response = tryJson(exchange.response_body);
  const sameEndpoint = capture.exchanges.filter(
    (e) => e.method === exchange.method && new URL(e.url).pathname === new URL(exchange.url).pathname,
  );
  const observed = (field: ClassifiedField) =>
    sameEndpoint.flatMap((e) => {
      const value = collectFields(e).find((f) => f.location === field.location && f.name === field.name)?.raw;
      return typeof value === 'number'
        ? [value]
        : typeof value === 'string' && /^\d+$/.test(value)
          ? [Number(value)]
          : [];
    });

  for (const field of fields) {
    if (field.location !== 'query' && field.location !== 'body') continue;
    const name = lastName(field);
    const numeric =
      typeof field.raw === 'number' || (typeof field.raw === 'string' && /^\d{1,6}$/.test(field.raw));
    const mode =
      numeric && PAGE.test(name)
        ? 'page'
        : numeric && OFFSET.test(name)
          ? 'offset'
          : CURSOR.test(name)
            ? 'cursor'
            : undefined;
    if (!mode) continue;
    const stop = stopCondition(response, items, mode);
    if (!stop) continue;
    const variable = identifier(name);
    if (mode === 'cursor') {
      if (!stop.from) continue;
      return {
        location: field.location,
        field: field.name,
        mode,
        variable,
        from: stop.from,
        until: stop.until,
      };
    }
    const start = Math.min(...observed(field));
    const step = mode === 'offset' ? pageSize(fields, response, items) : undefined;
    if (mode === 'offset' && !step) continue;
    return {
      location: field.location,
      field: field.name,
      mode,
      variable,
      start: Number.isFinite(start) ? start : Number(field.raw),
      ...(step && { step }),
      until: stop.until,
    };
  }
  return undefined;
}

/** How a response says it is the last page. */
function stopCondition(
  response: unknown,
  items: string | undefined,
  mode: Pagination['mode'],
): { until: string; from?: string } | undefined {
  const flags = shallowLeaves(response);
  const find = (pattern: RegExp, type?: string) =>
    flags.find((leaf) => pattern.test(leaf.key) && (type === undefined || typeof leaf.value === type));
  if (mode === 'cursor') {
    const next = flags.find((leaf) =>
      /^(next(_?cursor|_?page_?token|_?token)?|end_?cursor|cursor)$/i.test(leaf.key),
    );
    return next ? { until: `${next.path} == null`, from: next.path } : undefined;
  }
  const more = find(/^(has_?more|has_?next(_?page)?|more_?available)$/i, 'boolean');
  if (more) return { until: `${more.path} == false` };
  const last = find(/^(is_?last(_?page)?|last)$/i, 'boolean');
  if (last) return { until: `${last.path} == true` };
  const total = find(/^(total_?pages|page_?count|num_?pages)$/i, 'number');
  const current = find(/^(page|current_?page|page_?number)$/i, 'number');
  if (total && current) return { until: `${current.path} >= ${total.path}` };
  // Without a flag, an empty page ends the loop.
  if (items) return { until: `${items.replace(/\[\*\].*$/, '[0]')} == null` };
  return undefined;
}

/** Leaves at the top level and one level down, where paging flags live: $.hasMore, $.meta.hasNextPage. */
function shallowLeaves(json: unknown): { key: string; path: string; value: Primitive | null }[] {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return [];
  const out: { key: string; path: string; value: Primitive | null }[] = [];
  for (const [key, value] of Object.entries(json)) {
    if (value === null || typeof value !== 'object') {
      out.push({ key, path: `$${pathStep(key)}`, value: value as Primitive | null });
    } else if (!Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (innerValue === null || typeof innerValue !== 'object') {
          out.push({
            key: inner,
            path: `$${pathStep(key)}${pathStep(inner)}`,
            value: innerValue as Primitive | null,
          });
        }
      }
    }
  }
  return out;
}

/** Offset paging moves by the page size: a size field, or the number of records per response. */
function pageSize(
  fields: ClassifiedField[],
  response: unknown,
  items: string | undefined,
): number | undefined {
  const size = fields.find((field) => SIZE.test(lastName(field)) && /^\d+$/.test(String(field.raw)));
  if (size) return Number(size.raw);
  if (!items || response === null || typeof response !== 'object') return undefined;
  const key = /^\$\.(\w+)\[\*\]$/.exec(items)?.[1];
  const list = key
    ? (response as Record<string, unknown>)[key]
    : Array.isArray(response)
      ? response
      : undefined;
  return Array.isArray(list) && list.length > 0 ? list.length : undefined;
}
