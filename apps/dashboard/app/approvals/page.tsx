'use client';

import { useEffect, useState } from 'react';
import { PageTitle, Status } from '../../components/shell';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardTitle } from '../../components/ui/card';
import { Table, Td, Th } from '../../components/ui/table';
import { api, apiImage, message, useApi } from '../../lib/api';
import type { ApprovalView } from '../../lib/types';
import { when } from '../../lib/utils';

export default function ApprovalsPage() {
  const pending = useApi<{ approvals: ApprovalView[] }>('/v1/approvals?status=pending');
  const all = useApi<{ approvals: ApprovalView[] }>('/v1/approvals');
  const reload = () => {
    pending.reload();
    all.reload();
  };
  const waiting = pending.data?.approvals ?? [];
  const decided = (all.data?.approvals ?? []).filter((approval) => approval.status !== 'pending');
  return (
    <>
      <PageTitle title="Approvals">
        Writes wait here until you decide. Approving makes the write at once; rejecting changes nothing.
      </PageTitle>
      <Status
        loading={pending.loading}
        error={pending.error}
        empty={pending.data && waiting.length === 0 ? 'No write is waiting for approval.' : undefined}
      />
      <div className="grid gap-4">
        {waiting.map((approval) => (
          <Pending key={approval.id} approval={approval} onDecided={reload} />
        ))}
      </div>

      <h2 className="mb-2 mt-8 text-base font-semibold">Every write</h2>
      <Status
        loading={all.loading}
        error={all.error}
        empty={all.data && decided.length === 0 ? 'No decisions yet.' : undefined}
      />
      {decided.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Tool</Th>
              <Th>Decision</Th>
              <Th>By</Th>
              <Th>Outcome</Th>
            </tr>
          </thead>
          <tbody>
            {decided.map((approval) => (
              <tr key={approval.id}>
                <Td>{when(approval.decided_at)}</Td>
                <Td>{approval.tool}</Td>
                <Td>
                  <Badge tone={approval.status === 'approved' ? 'good' : 'neutral'}>{approval.status}</Badge>
                </Td>
                <Td>{approval.decided_by}</Td>
                <Td>
                  {approval.outcome
                    ? approval.outcome.ok
                      ? 'done'
                      : `failed: ${approval.outcome.error?.message ?? 'unknown error'}`
                    : '–'}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}

function Pending({ approval, onDecided }: { approval: ApprovalView; onDecided: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function decide(decision: 'approve' | 'reject'): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/v1/approvals/${approval.id}`, { method: 'POST', body: { decision } });
      onDecided();
    } catch (failure) {
      setError(message(failure));
      setBusy(false);
    }
  }

  return (
    <Card data-testid="pending-approval">
      <CardTitle>{approval.tool}</CardTitle>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        {approval.preview.action} on {approval.preview.url}
      </p>
      <Table className="mt-2 max-w-lg">
        <tbody>
          {approval.preview.fields.map((field) => (
            <tr key={field.field}>
              <Th>{field.field}</Th>
              <Td>
                <code>{field.value}</code>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {approval.screenshots.before && <Screenshot id={approval.id} />}
      <p className="mt-2 text-xs text-slate-500">Can be approved until {when(approval.expires_at)}.</p>
      <div className="mt-3 flex gap-2">
        <Button disabled={busy} onClick={() => void decide('approve')}>
          Approve
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void decide('reject')}>
          Reject
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </Card>
  );
}

/** The filled form, as the write would submit it. Screenshots need the key, so they load through the API. */
function Screenshot({ id }: { id: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let url: string | undefined;
    apiImage(`/v1/approvals/${id}/screenshot`).then(
      (loaded) => setSrc((url = loaded)),
      () => undefined,
    );
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  return src ? (
    // A plain img: the source is a blob URL, which next/image has nothing to optimize in.
    <img
      src={src}
      alt="The filled form, before the write"
      className="mt-3 max-h-96 rounded border dark:border-slate-700"
    />
  ) : null;
}
