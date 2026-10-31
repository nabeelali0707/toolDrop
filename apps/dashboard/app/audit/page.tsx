'use client';

import { PageTitle, Status } from '../../components/shell';
import { Badge } from '../../components/ui/badge';
import { Table, Td, Th } from '../../components/ui/table';
import { useApi } from '../../lib/api';
import type { AuditEvent } from '../../lib/types';
import { when } from '../../lib/utils';

// The audit log (D-057): every change made over the API and remote MCP, who
// made it and how it went, newest first. Only admins see it.

export default function AuditPage() {
  const { data, error, loading } = useApi<{ events: AuditEvent[] }>('/v1/audit?limit=200');
  const events = data?.events ?? [];
  return (
    <>
      <PageTitle title="Audit log">
        Every change made over the API and remote MCP, by whom, and how it went. Reads are not logged.
      </PageTitle>
      <Status
        loading={loading}
        error={error}
        empty={events.length === 0 ? 'Nothing changed yet.' : undefined}
      />
      {events.length > 0 && (
        <Table data-testid="audit-log">
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Who</Th>
              <Th>What</Th>
              <Th>On</Th>
              <Th>Outcome</Th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <Td>{when(event.created_at)}</Td>
                <Td>{event.actor.replace(/^user:/, '')}</Td>
                <Td>
                  <code className="text-xs">{event.action}</code>
                </Td>
                <Td>{event.target ?? '–'}</Td>
                <Td>
                  <Badge tone={event.status !== null && event.status < 400 ? 'good' : 'bad'}>
                    {event.status ?? '–'}
                  </Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
