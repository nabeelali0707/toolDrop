'use client';

import { useEffect, useState } from 'react';
import { api, message } from '../lib/api';
import { diffLines } from '../lib/diff';
import type { ToolStats, VersionDetails } from '../lib/types';
import { cn, when } from '../lib/utils';
import { Badge } from './ui/badge';
import { Table, Td, Th } from './ui/table';

// The transparency dashboard (SPEC, Differentiating features): how a tool's
// calls went, what its builds and heals cost in model time, its repairs, and
// what changed between versions.

/** A duration for people: "340 ms", "2.4 s", "3.1 min". */
export function duration(ms: number | null): string {
  if (ms === null) return '–';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md bg-slate-50 p-3 dark:bg-slate-900">
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-xs text-slate-500 dark:text-slate-400">{hint}</div>}
    </div>
  );
}

/** Calls, success rate, latency and the strategies that answered. */
export function CallFigures({ stats }: { stats: ToolStats }) {
  const { runs } = stats;
  const strategies = Object.entries(runs.by_strategy).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <div data-testid="call-figures" className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Figure label={`Calls, last ${stats.days} days`} value={String(runs.total)} />
        <Figure
          label="Success rate"
          value={runs.success_rate === null ? '–' : `${Math.round(runs.success_rate * 1000) / 10}%`}
          hint={runs.failed > 0 ? `${runs.failed} failed` : undefined}
        />
        <Figure label="p50 latency" value={duration(runs.p50_ms)} />
        <Figure label="p95 latency" value={duration(runs.p95_ms)} />
        <Figure label="Repaired during the call" value={String(runs.healed)} />
      </div>
      {strategies.length > 0 && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500 dark:text-slate-400">Answered by:</span>
          {strategies.map(([strategy, count]) => (
            <Badge key={strategy}>
              {strategy.replace('_', ' ')}: {count}
            </Badge>
          ))}
        </p>
      )}
    </>
  );
}

/** Model calls, tokens and time spent on the tool's builds and on its heals. */
export function ModelUse({ stats }: { stats: ToolStats }) {
  return (
    <Table data-testid="model-use">
      <thead>
        <tr>
          <Th />
          <Th>Jobs</Th>
          <Th>Model calls</Th>
          <Th>Retries</Th>
          <Th>Tokens in / out</Th>
          <Th>Model time</Th>
        </tr>
      </thead>
      <tbody>
        {(['builds', 'heals'] as const).map((kind) => {
          const use = stats.model[kind];
          return (
            <tr key={kind}>
              <Td>{kind === 'builds' ? 'Builds' : 'Repairs'}</Td>
              <Td>{use.jobs}</Td>
              <Td>{use.calls}</Td>
              <Td>{use.retries}</Td>
              <Td className="tabular-nums">
                {use.prompt_tokens.toLocaleString()} / {use.completion_tokens.toLocaleString()}
              </Td>
              <Td>{duration(use.duration_ms)}</Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

const TRIGGERS: Record<string, string> = {
  failure: 'every strategy failed',
  fast_path: 'the fast path broke',
  drift: 'selectors drifted',
};

/** The tool's builds and heals, newest first: why each ran and how it ended. */
export function JobHistory({ stats }: { stats: ToolStats }) {
  if (stats.jobs.length === 0)
    return <p className="text-sm text-slate-500">No builds or repairs recorded.</p>;
  return (
    <Table data-testid="job-history">
      <thead>
        <tr>
          <Th>When</Th>
          <Th>Job</Th>
          <Th>Outcome</Th>
          <Th>Why</Th>
          <Th>Model time</Th>
        </tr>
      </thead>
      <tbody>
        {stats.jobs.map((job) => (
          <tr key={job.id}>
            <Td>{when(job.created_at)}</Td>
            <Td>
              {job.kind === 'heal' ? 'Repair' : 'Build'}
              {job.trigger && (
                <span className="text-slate-500 dark:text-slate-400">
                  {' '}
                  ({TRIGGERS[job.trigger] ?? job.trigger})
                </span>
              )}
            </Td>
            <Td>
              <Badge tone={job.status === 'succeeded' ? 'good' : job.status === 'failed' ? 'bad' : 'warn'}>
                {job.status === 'succeeded' && job.version !== undefined
                  ? `published v${job.version}`
                  : job.status.replaceAll('_', ' ')}
              </Badge>
            </Td>
            <Td>{job.reason ?? '–'}</Td>
            <Td>{duration(job.usage.duration_ms)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** What changed between an earlier version's recipe and the current one. */
export function VersionDiff({ tool, from, to }: { tool: string; from: number; to: number }) {
  const [texts, setTexts] = useState<{ before: string; after: string }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    const path = (version: number) => `/v1/tools/${encodeURIComponent(tool)}/versions/${version}`;
    Promise.all([
      api<{ version: VersionDetails }>(path(from)),
      api<{ version: VersionDetails }>(path(to)),
    ]).then(
      ([before, after]) =>
        current &&
        setTexts({
          before: JSON.stringify(before.version.recipe, null, 2),
          after: JSON.stringify(after.version.recipe, null, 2),
        }),
      (failure: unknown) => current && setError(message(failure)),
    );
    return () => {
      current = false;
    };
  }, [tool, from, to]);
  if (error) return <p className="text-sm text-red-700 dark:text-red-400">{error}</p>;
  if (!texts) return <p className="text-sm text-slate-500">Loading…</p>;
  const lines = diffLines(texts.before, texts.after);
  const changed = lines.filter((line) => line.kind !== 'same').length;
  return (
    <div data-testid="version-diff" className="mt-3">
      <p className="mb-1 text-sm">
        v{from} → v{to}: {changed === 0 ? 'the recipes are the same' : `${changed} lines differ`}
      </p>
      <pre className="max-h-96 overflow-auto rounded-md border border-slate-200 text-xs dark:border-slate-700">
        {lines.map((line, index) => (
          <div
            key={index}
            className={cn(
              'px-2',
              line.kind === 'added' &&
                'bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
              line.kind === 'removed' && 'bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-200',
            )}
          >
            {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}
