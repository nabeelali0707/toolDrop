import Link from 'next/link';
import { when } from '../lib/utils';
import type { RunView } from '../lib/types';
import { Badge } from './ui/badge';
import { Table, Td, Th } from './ui/table';

/** Runs as the run log keeps them: how each call went, never its result. */
export function RunTable({ runs, showTool = true }: { runs: RunView[]; showTool?: boolean }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>When</Th>
          {showTool && <Th>Tool</Th>}
          <Th>Version</Th>
          <Th>How it ran</Th>
          <Th>Time</Th>
          <Th>Outcome</Th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id}>
            <Td>{when(run.created_at)}</Td>
            {showTool && (
              <Td>
                <Link
                  href={`/tool/?name=${encodeURIComponent(run.tool)}`}
                  className="text-sky-700 hover:underline dark:text-sky-400"
                >
                  {run.tool}
                </Link>
              </Td>
            )}
            <Td>v{run.version}</Td>
            <Td>{run.strategy.replace('_', ' ')}</Td>
            <Td>{run.duration_ms} ms</Td>
            <Td>
              <Badge tone={run.ok ? 'good' : 'bad'}>{run.ok ? 'ok' : (run.error_code ?? 'failed')}</Badge>
              {run.healed && (
                <Badge tone="warn" className="ml-1">
                  repaired
                </Badge>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
