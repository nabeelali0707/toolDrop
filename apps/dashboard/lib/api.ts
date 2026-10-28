'use client';

import { useCallback, useEffect, useState } from 'react';

// The dashboard talks to the REST API it is served with, as any client does:
// with an API key, kept in this browser's local storage until you sign out.

const KEY = 'tooldrop.apiKey';

export function savedKey(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function saveKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(KEY, key);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage can be off, e.g. in a private window: the key then lasts for this page only.
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call(
  path: string,
  options: { method?: string; body?: unknown; key?: string },
): Promise<Response> {
  const key = options.key ?? savedKey() ?? '';
  const response = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${key}`,
      ...(options.body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    const answer = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new ApiError(answer.error?.message ?? `toolDrop answered ${response.status}`, response.status);
  }
  return response;
}

/** Calls the REST API; errors carry toolDrop's own message. */
export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; key?: string } = {},
): Promise<T> {
  const response = await call(path, options);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** A binary answer, such as a screenshot, as a URL an <img> can show. */
export async function apiImage(path: string): Promise<string> {
  return URL.createObjectURL(await (await call(path, {})).blob());
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Loads a path from the API, and again on reload(). */
export function useApi<T>(path: string | null): {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
} {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!path) return;
    let current = true;
    api<T>(path).then(
      (data) => current && setState({ data, loading: false }),
      (error: unknown) => current && setState({ error: message(error), loading: false }),
    );
    return () => {
      current = false;
    };
  }, [path, round]);
  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}
