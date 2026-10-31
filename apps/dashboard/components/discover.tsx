'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, message } from '../lib/api';
import type { JobView } from '../lib/types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardTitle } from './ui/card';
import { Input } from './ui/input';

// URL-first discovery (SPEC, Differentiating features): give a URL, and toolDrop
// looks around the site, signed in when it has a saved login, and proposes
// tools to build. A read tool builds from here; a question, such as a 2FA
// code, waits on the Questions page.

interface Proposal {
  name: string;
  description: string;
  task: string;
  url: string;
  authority: 'read' | 'write';
  inputs: string[];
  existing?: string;
}

export function Discover() {
  const [url, setUrl] = useState('');
  const [job, setJob] = useState<JobView>();
  const [error, setError] = useState<string>();
  const [built, setBuilt] = useState<Record<string, string>>({});

  // Follows the job until it ends.
  useEffect(() => {
    if (!job || !['queued', 'running', 'waiting_for_answer'].includes(job.status)) return;
    const timer = setTimeout(() => {
      api<{ job: JobView }>(`/v1/jobs/${job.id}`).then(
        (answer) => setJob(answer.job),
        (failure: unknown) => setError(message(failure)),
      );
    }, 1000);
    return () => clearTimeout(timer);
  }, [job]);

  async function start(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(undefined);
    setBuilt({});
    try {
      setJob((await api<{ job: JobView }>('/v1/discover', { method: 'POST', body: { url } })).job);
    } catch (failure) {
      setError(message(failure));
    }
  }

  async function build(proposal: Proposal): Promise<void> {
    try {
      const answer = await api<{ job: JobView }>('/v1/builds', {
        method: 'POST',
        body: { url: proposal.url, task: proposal.task, authority: 'read' },
      });
      setBuilt((current) => ({ ...current, [proposal.name]: answer.job.id }));
    } catch (failure) {
      setError(message(failure));
    }
  }

  const result =
    job?.status === 'succeeded' ? (job.result as { pages: unknown[]; tools: Proposal[] }) : undefined;
  return (
    <Card className="mt-6" data-testid="discover">
      <CardTitle>Discover tools on a site</CardTitle>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => void start(event)}>
        <label className="sr-only" htmlFor="discover-url">
          Site address
        </label>
        <Input
          id="discover-url"
          type="url"
          required
          placeholder="https://portal.example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          className="min-w-64 flex-1"
        />
        <Button type="submit" disabled={job !== undefined && !result && job.status !== 'failed'}>
          Discover
        </Button>
      </form>
      {job && !result && job.status !== 'failed' && (
        <p className="mt-2 text-sm text-slate-500">
          {job.status === 'waiting_for_answer'
            ? 'Waiting for an answer on the Questions page.'
            : `Looking around: ${job.step ?? 'starting'}…`}
        </p>
      )}
      {job?.status === 'failed' && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          {job.error?.message}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {result && (
        <div className="mt-3">
          <p className="mb-2 text-sm text-slate-500">
            Looked at {result.pages.length} pages. {result.tools.length === 0 ? 'Nothing to propose.' : ''}
          </p>
          <ul className="grid gap-2">
            {result.tools.map((proposal) => (
              <li
                key={proposal.name}
                data-testid="proposal"
                className="rounded-md border border-slate-200 p-3 dark:border-slate-700"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{proposal.name}</span>
                  <Badge tone={proposal.authority === 'write' ? 'warn' : 'neutral'}>
                    {proposal.authority === 'write' ? 'writes' : 'reads'}
                  </Badge>
                  {proposal.inputs.length > 0 && (
                    <span className="text-xs text-slate-500">inputs: {proposal.inputs.join(', ')}</span>
                  )}
                </div>
                <p className="text-sm">{proposal.description}</p>
                <p className="text-xs text-slate-500">{proposal.url}</p>
                <div className="mt-2">
                  {proposal.existing ? (
                    <Badge tone="good">already built as {proposal.existing}</Badge>
                  ) : built[proposal.name] ? (
                    <Badge tone="good">building, as job {built[proposal.name]}</Badge>
                  ) : proposal.authority === 'write' ? (
                    <span className="text-xs text-slate-500">
                      A write: make it as a tool file with a commit step.
                    </span>
                  ) : (
                    <Button variant="outline" onClick={() => void build(proposal)}>
                      Build {proposal.name}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
