'use client';

import { useState, type FormEvent } from 'react';
import { PageTitle, Status } from '../../components/shell';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardTitle } from '../../components/ui/card';
import { Input, Label } from '../../components/ui/input';
import { Table, Td, Th } from '../../components/ui/table';
import { api, message, useApi } from '../../lib/api';
import type { LoginView } from '../../lib/types';
import { when } from '../../lib/utils';

export default function LoginsPage() {
  const { data, error, loading, reload } = useApi<{ logins: LoginView[] }>('/v1/logins');
  const logins = data?.logins ?? [];
  return (
    <>
      <PageTitle title="Logins">
        Saved logins, encrypted in toolDrop&apos;s vault. Only masked previews are ever shown.
      </PageTitle>
      <Status
        loading={loading}
        error={error}
        empty={data && logins.length === 0 ? 'No saved logins yet.' : undefined}
      />
      {logins.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Site</Th>
              <Th>Login</Th>
              <Th>Username</Th>
              <Th>Second factor</Th>
              <Th>Status</Th>
              <Th>Saved</Th>
            </tr>
          </thead>
          <tbody>
            {logins.map((login) => (
              <tr key={login.id}>
                <Td>{login.site}</Td>
                <Td>{login.label}</Td>
                <Td>
                  <code>{login.username}</code>
                </Td>
                <Td>{login.twofa ?? 'none'}</Td>
                <Td>
                  <Badge
                    tone={
                      login.status === 'verified'
                        ? 'good'
                        : login.status === 'needs_attention'
                          ? 'bad'
                          : 'neutral'
                    }
                  >
                    {login.status.replace('_', ' ')}
                  </Badge>
                </Td>
                <Td>{when(login.created_at)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <AddLogin onAdded={reload} />
    </>
  );
}

function AddLogin({ onAdded }: { onAdded: () => void }) {
  const [form, setForm] = useState({ site: '', username: '', password: '', totp_secret: '' });
  const [result, setResult] = useState<{ ok: boolean; text: string }>();
  const set = (field: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm({ ...form, [field]: event.target.value });

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      await api('/v1/logins', {
        method: 'POST',
        body: {
          site: form.site.trim(),
          username: form.username,
          password: form.password,
          ...(form.totp_secret.trim() && { totp_secret: form.totp_secret.replace(/\s+/g, '') }),
        },
      });
      setForm({ site: '', username: '', password: '', totp_secret: '' });
      setResult({ ok: true, text: 'Saved, encrypted in the vault.' });
      onAdded();
    } catch (failure) {
      setResult({ ok: false, text: message(failure) });
    }
  }

  return (
    <Card className="mt-6 max-w-lg">
      <CardTitle>Save a login</CardTitle>
      <form onSubmit={(event) => void submit(event)} autoComplete="off">
        <Label htmlFor="site">Site</Label>
        <Input
          id="site"
          type="url"
          placeholder="https://shop.example.com"
          value={form.site}
          onChange={set('site')}
        />
        <Label htmlFor="username">Username</Label>
        <Input id="username" value={form.username} onChange={set('username')} />
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" value={form.password} onChange={set('password')} />
        <Label htmlFor="totp">Authenticator secret (optional)</Label>
        <Input id="totp" type="password" value={form.totp_secret} onChange={set('totp_secret')} />
        <Button type="submit" className="mt-4" disabled={!form.site || !form.username || !form.password}>
          Save login
        </Button>
      </form>
      {result && (
        <p
          role={result.ok ? 'status' : 'alert'}
          className={result.ok ? 'mt-2 text-sm' : 'mt-2 text-sm text-red-700 dark:text-red-400'}
        >
          {result.text}
        </p>
      )}
    </Card>
  );
}
