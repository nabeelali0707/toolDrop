import { Masker, MASKED } from '@tooldrop/llm';

// Network traffic from a capture or a recording. In memory it is a list of
// exchanges with bodies; on disk it is HAR 1.2, the format browsers export,
// so recordings from the extension and from `tooldrop record` read the same.

export interface Exchange {
  /** Order the request started in. */
  index: number;
  /** Milliseconds since the capture started. */
  started: number;
  method: string;
  url: string;
  /** Playwright's resource type: document, xhr, fetch, ... */
  resource_type: string;
  /** Lower-case header names. */
  request_headers: Record<string, string>;
  request_body?: string;
  status: number;
  response_headers: Record<string, string>;
  mime_type: string;
  /** Text bodies only, at most MAX_BODY characters. */
  response_body?: string;
  duration_ms: number;
  /** How many recorded actions had happened when the request started. */
  after_actions: number;
}

export const MAX_BODY = 1_000_000;

/** Bodies worth keeping: the ones that can carry the data a tool returns. */
export function isTextual(mimeType: string): boolean {
  return /json|html|xml|text\/|javascript|x-www-form-urlencoded/i.test(mimeType);
}

interface HarHeader {
  name: string;
  value: string;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarHeader[];
    queryString: HarHeader[];
    postData?: { mimeType: string; text: string };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarHeader[];
    content: { size: number; mimeType: string; text?: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  _resourceType?: string;
  _afterActions?: number;
}

export interface Har {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

export function toHar(exchanges: readonly Exchange[], startedAt: number, version = '0.0.0'): Har {
  const headers = (record: Record<string, string>) =>
    Object.entries(record).map(([name, value]) => ({ name, value }));
  return {
    log: {
      version: '1.2',
      creator: { name: 'toolDrop', version },
      entries: exchanges.map((exchange) => ({
        startedDateTime: new Date(startedAt + exchange.started).toISOString(),
        time: exchange.duration_ms,
        request: {
          method: exchange.method,
          url: exchange.url,
          httpVersion: 'HTTP/1.1',
          headers: headers(exchange.request_headers),
          queryString: [...new URL(exchange.url).searchParams].map(([name, value]) => ({ name, value })),
          ...(exchange.request_body !== undefined && {
            postData: {
              mimeType: exchange.request_headers['content-type'] ?? 'application/octet-stream',
              text: exchange.request_body,
            },
          }),
          headersSize: -1,
          bodySize: exchange.request_body?.length ?? 0,
        },
        response: {
          status: exchange.status,
          statusText: '',
          httpVersion: 'HTTP/1.1',
          headers: headers(exchange.response_headers),
          content: {
            size: exchange.response_body?.length ?? 0,
            mimeType: exchange.mime_type,
            ...(exchange.response_body !== undefined && { text: exchange.response_body }),
          },
          redirectURL: exchange.response_headers.location ?? '',
          headersSize: -1,
          bodySize: exchange.response_body?.length ?? -1,
        },
        cache: {},
        timings: { send: 0, wait: exchange.duration_ms, receive: 0 },
        _resourceType: exchange.resource_type,
        _afterActions: exchange.after_actions,
      })),
    },
  };
}

/** Reads a HAR from any browser or recorder. Entries without a usable URL are skipped. */
export function fromHar(har: Har): Exchange[] {
  const entries = har.log.entries;
  const first = entries[0] ? Date.parse(entries[0].startedDateTime) : 0;
  const lower = (list: HarHeader[] | undefined) =>
    Object.fromEntries((list ?? []).map((header) => [header.name.toLowerCase(), header.value]));
  return entries.flatMap((entry, index): Exchange[] => {
    if (!/^https?:/.test(entry.request.url)) return [];
    const text = entry.response.content.text;
    return [
      {
        index,
        started: Math.max(0, (Date.parse(entry.startedDateTime) || first) - first),
        method: entry.request.method.toUpperCase(),
        url: entry.request.url,
        resource_type: entry._resourceType ?? guessResourceType(entry),
        request_headers: lower(entry.request.headers),
        ...(entry.request.postData?.text !== undefined && { request_body: entry.request.postData.text }),
        status: entry.response.status,
        response_headers: lower(entry.response.headers),
        mime_type: entry.response.content.mimeType,
        ...(text !== undefined &&
          isTextual(entry.response.content.mimeType) && { response_body: text.slice(0, MAX_BODY) }),
        duration_ms: Math.round(entry.time),
        after_actions: entry._afterActions ?? 0,
      },
    ];
  });
}

function guessResourceType(entry: HarEntry): string {
  const mime = entry.response.content.mimeType;
  if (/html/i.test(mime) && entry.request.method === 'GET') return 'document';
  return /json/i.test(mime) ? 'fetch' : 'other';
}

/** Headers that carry credentials or sessions. Their values never reach the disk. */
const SECRET_HEADER =
  /^(cookie|set-cookie|authorization|proxy-authorization)$|token|secret|csrf|xsrf|session|api-?key/i;

/**
 * The secrets in a set of exchanges: cookies and secret header values. They
 * go into a Masker, so prompts and files get placeholders instead.
 */
export function collectSecrets(exchanges: readonly Exchange[], masker = new Masker()): Masker {
  const add = (value: string | undefined) => {
    if (value !== undefined && looksSecret(value)) masker.add(value);
  };
  for (const exchange of exchanges) {
    for (const [name, value] of [
      ...Object.entries(exchange.request_headers),
      ...Object.entries(exchange.response_headers),
    ]) {
      if (!SECRET_HEADER.test(name)) continue;
      if (name === 'cookie') {
        for (const part of value.split(';')) add(part.split('=').slice(1).join('=').trim());
      } else if (name === 'set-cookie') {
        for (const line of value.split('\n')) add(line.split(';')[0]?.split('=').slice(1).join('=').trim());
      } else {
        add(value.replace(/^(Bearer|Basic)\s+/i, ''));
      }
    }
  }
  return masker;
}

/**
 * Whether a cookie or header value can be a secret. Short words and numbers
 * cannot (`consent=true`, `lang=en`), and masking them would garble every
 * `true` and `en` in the prompt.
 */
export function looksSecret(value: string): boolean {
  return value.length >= 8 && !/^[a-z]+$/i.test(value) && !/^\d{1,12}$/.test(value);
}

/** A copy fit for the disk: secret headers masked, and registered secrets masked everywhere. */
export function maskExchanges(exchanges: readonly Exchange[], masker: Masker): Exchange[] {
  const headers = (record: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(record).map(([name, value]) => [
        name,
        SECRET_HEADER.test(name) ? MASKED : masker.apply(value),
      ]),
    );
  return exchanges.map((exchange) => ({
    ...exchange,
    url: masker.apply(exchange.url),
    request_headers: headers(exchange.request_headers),
    response_headers: headers(exchange.response_headers),
    ...(exchange.request_body !== undefined && { request_body: masker.apply(exchange.request_body) }),
    ...(exchange.response_body !== undefined && { response_body: masker.apply(exchange.response_body) }),
  }));
}
