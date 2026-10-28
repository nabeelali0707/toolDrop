'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { RunTable } from '../../components/runs';
import { PageTitle, Status } from '../../components/shell';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardTitle } from '../../components/ui/card';
import { Table, Td, Th } from '../../components/ui/table';
import { api, message, useApi } from '../../lib/api';
import type { RunView, ToolSummary, VersionSummary } from '../../lib/types';
import { when } from '../../lib/utils';

export default function ToolPage() {
  // Static pages read their query on the client, inside Suspense.
  return (
    <Suspense>
      <ToolDetails />
    </Suspense>
  );
}

function ToolDetails() {
  const name = useSearchParams().get('name') ?? '';
  const path = `/v1/tools/${encodeURIComponent(name)}`;
  const tool = useApi<{ tool: ToolSummary }>(name ? path : null);
  const versions = useApi<{ versions: VersionSummary[] }>(name ? `${path}/versions` : null);
  const runs = useApi<{ runs: RunView[] }>(
    name ? `/v1/runs?tool=${encodeURIComponent(name)}&limit=20` : null,
  );

  if (!tool.data)
    return <Status loading={tool.loading} error={tool.error ?? (name ? undefined : 'No tool named.')} />;
  const { tool: details } = tool.data;
  return (
    <>
      <PageTitle title={details.name}>{details.description}</PageTitle>
      <p className="mb-4 flex flex-wrap gap-2 text-sm">
        <Badge>{details.site}</Badge>
        <Badge tone={details.authority === 'write' ? 'warn' : 'neutral'}>
          {details.authority === 'write' ? 'writes: each call waits for approval' : 'reads'}
        </Badge>
        <Badge>v{details.version}</Badge>
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardTitle>Inputs</CardTitle>
          <pre className="overflow-x-auto text-xs">{JSON.stringify(details.input_schema, null, 2)}</pre>
        </Card>
        <Card>
          <CardTitle>Output</CardTitle>
          <pre className="overflow-x-auto text-xs">{JSON.stringify(details.output_schema, null, 2)}</pre>
        </Card>
      </div>

      <Card className="mt-4">
        <CardTitle>Call it with cURL</CardTitle>
        <pre data-testid="curl" className="overflow-x-auto text-xs">
          {curlExample(details)}
        </pre>
      </Card>

      <Card className="mt-4">
        <CardTitle>Versions and repairs</CardTitle>
        <Status loading={versions.loading} error={versions.error} />
        {versions.data && (
          <Versions tool={details.name} versions={versions.data.versions} onChange={versions.reload} />
        )}
      </Card>

      <Card className="mt-4">
        <CardTitle>Recent runs</CardTitle>
        <Status
          loading={runs.loading}
          error={runs.error}
          empty={runs.data?.runs.length === 0 ? 'No runs yet.' : undefined}
        />
        {runs.data && runs.data.runs.length > 0 && <RunTable runs={runs.data.runs} showTool={false} />}
      </Card>
    </>
  );
}

function Versions({
  tool,
  versions,
  onChange,
}: {
  tool: string;
  versions: VersionSummary[];
  onChange: () => void;
}) {
  // Rolling back asks twice, on the page itself: a click on "Roll back", then on "Confirm".
  const [confirming, setConfirming] = useState<number>();
  const [error, setError] = useState<string>();

  async function rollback(version: number): Promise<void> {
    try {
      await api(`/v1/tools/${encodeURIComponent(tool)}/rollback`, { method: 'POST', body: { version } });
      setConfirming(undefined);
      onChange();
    } catch (failure) {
      setError(message(failure));
    }
  }

  return (
    <>
      <Table>
        <thead>
          <tr>
            <Th>Version</Th>
            <Th>Made by</Th>
            <Th>Why</Th>
            <Th>When</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {[...versions].reverse().map((version) => (
            <tr key={version.version}>
              <Td>
                v{version.version}{' '}
                {version.current && (
                  <Badge tone="good" className="ml-1">
                    current
                  </Badge>
                )}
              </Td>
              <Td>{version.created_by}</Td>
              <Td>{version.change_reason ?? '–'}</Td>
              <Td>{when(version.created_at)}</Td>
              <Td className="text-right">
                {!version.current &&
                  (confirming === version.version ? (
                    <Button variant="destructive" onClick={() => void rollback(version.version)}>
                      Confirm roll back to v{version.version}
                    </Button>
                  ) : (
                    <Button variant="outline" onClick={() => setConfirming(version.version)}>
                      Roll back
                    </Button>
                  ))}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * A ready call with sample inputs from the schema: a listed value where the
 * schema has one, a placeholder such as "<invoice>" for other required text,
 * and optional inputs without a sample left out. The key stays out of it.
 */
function curlExample(tool: ToolSummary): string {
  const properties = (tool.input_schema.properties ?? {}) as Record<
    string,
    { type?: string; enum?: unknown[]; examples?: unknown[] }
  >;
  const required = new Set((tool.input_schema.required ?? []) as string[]);
  const input = Object.fromEntries(
    Object.entries(properties).flatMap(([name, schema]) => {
      const listed = schema.examples?.[0] ?? schema.enum?.[0];
      if (listed !== undefined) return [[name, listed]];
      if (!required.has(name)) return [];
      if (schema.type === 'number' || schema.type === 'integer') return [[name, 0]];
      return [[name, schema.type === 'boolean' ? false : `<${name}>`]];
    }),
  );
  return [
    `curl -X POST ${window.location.origin}/v1/tools/${tool.name}/run \\`,
    '  -H "Authorization: Bearer $TOOLDROP_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${JSON.stringify(input)}'`,
  ].join('\n');
}
