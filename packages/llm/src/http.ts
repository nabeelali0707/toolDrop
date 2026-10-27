import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/**
 * fetch without the 5-minute limits of Node's built-in client. A model on a
 * CPU can take longer than that to read a long prompt, and Ollama sends no
 * headers until the reply is ready, so the built-in fetch would give up on
 * a call that is still working. The caller's signal is the only timeout.
 */
export const patientFetch: typeof fetch = (input, init = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const signal = init.signal ?? undefined;
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(
      url,
      { method: init.method ?? 'GET', headers: plainHeaders(init.headers) },
      (response) => {
        const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
        resolve(
          new Response(response.statusCode === 204 ? null : body, {
            status: response.statusCode ?? 0,
            headers: responseHeaders(response.headers),
          }),
        );
      },
    );
    const abort = () =>
      request.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    signal?.addEventListener('abort', abort, { once: true });
    request.on('error', reject);
    request.on('close', () => signal?.removeEventListener('abort', abort));
    if (typeof init.body === 'string') request.end(init.body);
    else request.end();
  });

function plainHeaders(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function responseHeaders(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) out.append(name, item);
  }
  return out;
}
