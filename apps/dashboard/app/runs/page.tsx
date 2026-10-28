'use client';

import { RunTable } from '../../components/runs';
import { PageTitle, Status } from '../../components/shell';
import { useApi } from '../../lib/api';
import type { RunView } from '../../lib/types';

export default function RunsPage() {
  const { data, error, loading } = useApi<{ runs: RunView[] }>('/v1/runs?limit=100');
  const runs = data?.runs ?? [];
  return (
    <>
      <PageTitle title="Runs">
        The latest calls to your tools: how each ran and how long it took. Results are never kept.
      </PageTitle>
      <Status
        loading={loading}
        error={error}
        empty={data && runs.length === 0 ? 'No runs yet.' : undefined}
      />
      {runs.length > 0 && <RunTable runs={runs} />}
    </>
  );
}
