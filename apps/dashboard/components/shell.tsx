'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, message, savedKey, saveKey } from '../lib/api';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Input, Label } from './ui/input';

const LINKS = [
  { href: '/', label: 'Tools' },
  { href: '/runs/', label: 'Runs' },
  { href: '/approvals/', label: 'Approvals' },
  { href: '/jobs/', label: 'Questions and repairs' },
  { href: '/logins/', label: 'Logins' },
  { href: '/audit/', label: 'Audit log', admin: true },
];

/** Every page: asks for an API key once, then shows the navigation. */
export function Shell({ children }: { children: ReactNode }) {
  // Undefined until the browser has been asked: the static page renders nothing before that.
  const [key, setKey] = useState<string | null>();
  const [me, setMe] = useState<{ by: string; role: string }>();
  const path = usePathname();
  useEffect(() => setKey(savedKey()), []);
  // Who is signed in, so the header says it and offers what the role allows (D-057).
  useEffect(() => {
    if (!key) return;
    api<{ by: string; role: string }>('/v1/me').then(setMe, () => setMe(undefined));
  }, [key]);
  if (key === undefined) return null;
  if (!key) return <SignIn onSignedIn={setKey} />;
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 dark:border-slate-700">
        <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-1 px-4 py-2" aria-label="Main">
          <span className="mr-3 font-semibold">toolDrop</span>
          {LINKS.filter((link) => !link.admin || me?.role === 'admin').map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={path === link.href ? 'page' : undefined}
              className={cn(
                'rounded-md px-2 py-1 text-sm hover:bg-slate-100 dark:hover:bg-slate-800',
                path === link.href && 'bg-slate-100 font-medium dark:bg-slate-800',
              )}
            >
              {link.label}
            </Link>
          ))}
          {me && (
            <span data-testid="signed-in-as" className="ml-auto text-xs text-slate-500 dark:text-slate-400">
              {me.by.replace(/^user:/, '')} · {me.role}
            </span>
          )}
          <Button
            variant="ghost"
            className={me ? '' : 'ml-auto'}
            onClick={() => {
              saveKey(null);
              setKey(null);
            }}
          >
            Sign out
          </Button>
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}

function SignIn({ onSignedIn }: { onSignedIn: (key: string) => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const key = value.trim();
    try {
      await api('/v1/tools', { key });
      saveKey(key);
      onSignedIn(key);
    } catch (failure) {
      setError(message(failure));
    }
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-2xl font-semibold">toolDrop</h1>
      <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
        Paste an API key: the one <code>tooldrop serve</code> printed when it first started, or a new one from{' '}
        <code>tooldrop keys create</code>. It stays in this browser until you sign out.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <Label htmlFor="key">API key</Label>
        <Input
          id="key"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button type="submit" className="mt-4" disabled={value.trim() === ''}>
          Open the dashboard
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </main>
  );
}

/** A page's title, with an optional line under it. */
export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      {children && <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{children}</p>}
    </div>
  );
}

/** What a list shows while loading, after an error, or when it is empty. */
export function Status({ loading, error, empty }: { loading: boolean; error?: string; empty?: string }) {
  if (error) {
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-400">
        {error}
      </p>
    );
  }
  if (loading) return <p className="text-sm text-slate-500">Loading…</p>;
  return empty ? <p className="text-sm text-slate-500">{empty}</p> : null;
}
