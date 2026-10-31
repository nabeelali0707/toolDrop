'use client';

import Link from 'next/link';
import { Discover } from '../components/discover';
import { PageTitle, Status } from '../components/shell';
import { Badge } from '../components/ui/badge';
import { Table, Td, Th } from '../components/ui/table';
import { useApi } from '../lib/api';
import type { ToolSummary } from '../lib/types';

export default function ToolsPage() {
  const { data, error, loading } = useApi<{ tools: ToolSummary[] }>('/v1/tools');
  const tools = data?.tools ?? [];
  return (
    <>
      <PageTitle title="Tools">Every published tool, which your agent calls over MCP or REST.</PageTitle>
      <Status
        loading={loading}
        error={error}
        empty={
          tools.length === 0
            ? 'No tools yet. Ask your agent to build one, or add a tool file with tooldrop tools add.'
            : undefined
        }
      />
      {tools.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>Tool</Th>
              <Th>Site</Th>
              <Th>Kind</Th>
              <Th>Version</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {tools.map((tool) => (
              <tr key={tool.name}>
                <Td>
                  <Link
                    href={`/tool/?name=${encodeURIComponent(tool.name)}`}
                    className="font-medium text-sky-700 hover:underline dark:text-sky-400"
                  >
                    {tool.name}
                  </Link>
                  <div className="text-slate-500">{tool.description}</div>
                </Td>
                <Td>{tool.site}</Td>
                <Td>
                  <Badge tone={tool.authority === 'write' ? 'warn' : 'neutral'}>
                    {tool.authority === 'write' ? 'writes' : 'reads'}
                  </Badge>
                </Td>
                <Td>v{tool.version}</Td>
                <Td>
                  <Badge tone={tool.status === 'live' ? 'good' : 'bad'}>{tool.status}</Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Discover />
    </>
  );
}
