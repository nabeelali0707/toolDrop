/** Options for one request: a form or JSON body makes it a POST. */
export interface TestRequest {
  method?: string;
  form?: Record<string, string>;
  json?: unknown;
  headers?: Record<string, string>;
}

/**
 * A minimal client for fixture tests: keeps cookies like a browser and never
 * follows redirects, so tests can check each step of a sign-in.
 */
export function testClient(baseUrl: string) {
  const cookies = new Map<string, string>();

  async function request(path: string, options: TestRequest = {}): Promise<Response> {
    const { form, json, headers = {} } = options;
    let body: string | undefined;
    if (form) body = new URLSearchParams(form).toString();
    else if (json !== undefined) body = JSON.stringify(json);
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? (body === undefined ? 'GET' : 'POST'),
      redirect: 'manual',
      headers: {
        ...(cookies.size > 0 && {
          cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        }),
        ...(form && { 'content-type': 'application/x-www-form-urlencoded' }),
        ...(json !== undefined && { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body !== undefined && { body }),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair = '', ...attributes] = header.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator).trim();
      if (attributes.some((attribute) => attribute.trim() === 'Max-Age=0')) cookies.delete(name);
      else cookies.set(name, pair.slice(separator + 1).trim());
    }
    return response;
  }

  return { request, cookies };
}
