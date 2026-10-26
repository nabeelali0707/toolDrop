import type { Exchange } from '../capture/har.ts';
import { truncate } from './ax-prune.ts';
import { describeJson, SHAPE_LEVELS, tryJson } from './json-shape.ts';

// Captured requests as a model sees them (SPEC, Local LLM usage rule 1): the
// top-ranked candidates only, each as method, URL, status, content type, its
// fields with short samples and what they are, and the response's JSON shape.
// Never full bodies.

/** What a request field is (SPEC, Build pipeline step 5). */
export const FIELD_KINDS = ['constant', 'user_input', 'derived', 'auth', 'pagination'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export type FieldLocation = 'path' | 'query' | 'body' | 'header';

export interface FieldNote {
  location: FieldLocation;
  /** The query or body field, header name, or path segment index. */
  name: string;
  /** A short sample, or the placeholder that stands for a secret. */
  value: string;
  kind?: FieldKind;
  /** Where the value comes from, e.g. "input status" or "<meta name=csrf-token> on the page". */
  source?: string;
}

export interface SummaryInput {
  exchange: Exchange;
  /** Why the request matters, e.g. "has 10 of 10 rows shown in the table". */
  why?: string;
  /** The action that triggered it, e.g. `click button "Search"`. */
  after?: string;
  /** Classified fields; without them the fields are listed as found. */
  fields?: FieldNote[];
}

/** Headers every browser sends; they say nothing about the API. */
const BOILERPLATE = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'content-length',
  'dnt',
  'host',
  'origin',
  'pragma',
  'priority',
  'referer',
  'upgrade-insecure-requests',
  'user-agent',
]);

/** The fields of a request: query and body fields, and the headers that are not boilerplate. */
export function requestFields(exchange: Exchange): FieldNote[] {
  const url = new URL(exchange.url);
  const fields: FieldNote[] = [...url.searchParams].map(([name, value]) => ({
    location: 'query',
    name,
    value,
  }));
  const body = parseBody(exchange);
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [name, value] of Object.entries(body)) {
      fields.push({
        location: 'body',
        name,
        value: typeof value === 'string' ? value : JSON.stringify(value),
      });
    }
  }
  for (const [name, value] of Object.entries(exchange.request_headers)) {
    if (BOILERPLATE.has(name) || name.startsWith('sec-') || name.startsWith(':')) continue;
    fields.push({ location: 'header', name, value });
  }
  return fields;
}

/** A JSON or form body as an object; anything else as undefined. */
export function parseBody(exchange: Exchange): unknown {
  const body = exchange.request_body;
  if (body === undefined || body === '') return undefined;
  const type = exchange.request_headers['content-type'] ?? '';
  if (/x-www-form-urlencoded/.test(type)) return Object.fromEntries(new URLSearchParams(body));
  return tryJson(body);
}

export function summarizeExchanges(inputs: readonly SummaryInput[], level = 0): string | undefined {
  if (level >= SHAPE_LEVELS.length) return undefined;
  return inputs.map((input, index) => summarizeExchange(input, index + 1, level)).join('\n\n');
}

function summarizeExchange(input: SummaryInput, number: number, level: number): string {
  const { exchange } = input;
  const shape = SHAPE_LEVELS[level] ?? SHAPE_LEVELS[0]!;
  const valueWidth = level === 0 ? 40 : 20;
  const url = new URL(exchange.url);
  const lines = [
    `#${number} ${exchange.method} ${url.pathname} → ${exchange.status} ${exchange.mime_type || 'no body'}${input.after ? ` (after ${input.after})` : ''}`,
  ];
  if (input.why) lines.push(`  why: ${input.why}`);

  const fields = input.fields ?? requestFields(exchange);
  for (const location of ['path', 'query', 'body', 'header'] as const) {
    const here = fields.filter((field) => field.location === location);
    // At the tightest level only fields that need explaining stay.
    const shown = level >= 2 ? here.filter((field) => field.kind && field.kind !== 'constant') : here;
    if (shown.length === 0) continue;
    const label = location === 'body' ? `body (${bodyFormat(exchange)})` : `${location}`;
    lines.push(`  ${label}: ${shown.map((field) => formatField(field, valueWidth)).join(' · ')}`);
  }

  const response = tryJson(exchange.response_body);
  if (response !== undefined) lines.push(`  response: ${describeJson(response, shape)}`);
  else if (exchange.response_body)
    lines.push(`  response: ${exchange.mime_type}, ${exchange.response_body.length} characters`);
  return lines.join('\n');
}

function formatField(field: FieldNote, width: number): string {
  const kind = field.kind ? ` [${field.kind}${field.source ? `: ${field.source}` : ''}]` : '';
  return `${field.name}=${JSON.stringify(truncate(field.value, width))}${kind}`;
}

function bodyFormat(exchange: Exchange): string {
  const type = exchange.request_headers['content-type'] ?? '';
  if (/json/.test(type)) return 'json';
  if (/x-www-form-urlencoded/.test(type)) return 'form';
  return type || 'raw';
}
