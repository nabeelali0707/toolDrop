'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { PageTitle, Status } from '../../components/shell';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Table, Td, Th } from '../../components/ui/table';
import { api, message, useApi } from '../../lib/api';
import type { JobView } from '../../lib/types';
import { when } from '../../lib/utils';

/** What a job is about, in a few words: a build's task, or the tool a heal repairs. */
function subject(job: JobView): string {
  const input = (job.input ?? {}) as { task?: string; tool?: string; url?: string };
  if (job.kind === 'heal') return input.tool ?? 'a tool';
  return input.task ?? input.url ?? 'a build';
}

function JobBadge({ job }: { job: JobView }) {
  const tone = job.status === 'succeeded' ? 'good' : job.status === 'failed' ? 'bad' : 'warn';
  return <Badge tone={tone}>{job.status.replaceAll('_', ' ')}</Badge>;
}

export default function JobsPage() {
  const waiting = useApi<{ jobs: JobView[] }>('/v1/jobs?status=waiting_for_answer');
  const heals = useApi<{ jobs: JobView[] }>('/v1/jobs?kind=heal&limit=30');
  const builds = useApi<{ jobs: JobView[] }>('/v1/jobs?kind=build&limit=30');
  const questions = waiting.data?.jobs ?? [];
  return (
    <>
      <PageTitle title="Questions and repairs">
        Builds and sign-ins that wait for you, such as a 2FA code, and what toolDrop repaired.
      </PageTitle>
      <Status
        loading={waiting.loading}
        error={waiting.error}
        empty={waiting.data && questions.length === 0 ? 'Nothing is waiting for an answer.' : undefined}
      />
      <div className="grid gap-4">
        {questions.map((job) => (
          <Questions key={job.id} job={job} onAnswered={waiting.reload} />
        ))}
      </div>

      <h2 className="mb-2 mt-8 text-base font-semibold">Repairs</h2>
      <JobTable
        state={heals}
        empty="No repairs yet: no tool has broken."
        title={(job) => (
          <Link
            href={`/tool/?name=${encodeURIComponent(subject(job))}`}
            className="text-sky-700 hover:underline dark:text-sky-400"
          >
            {subject(job)}
          </Link>
        )}
      />

      <h2 className="mb-2 mt-8 text-base font-semibold">Builds</h2>
      <JobTable state={builds} empty="No builds yet." title={subject} />
    </>
  );
}

function JobTable({
  state,
  empty,
  title,
}: {
  state: ReturnType<typeof useApi<{ jobs: JobView[] }>>;
  empty: string;
  title: (job: JobView) => React.ReactNode;
}) {
  const jobs = state.data?.jobs ?? [];
  return (
    <>
      <Status
        loading={state.loading}
        error={state.error}
        empty={state.data && jobs.length === 0 ? empty : undefined}
      />
      {jobs.length > 0 && (
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>What</Th>
              <Th>Status</Th>
              <Th>Details</Th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <Td>{when(job.created_at)}</Td>
                <Td>{title(job)}</Td>
                <Td>
                  <JobBadge job={job} />
                </Td>
                <Td className="text-slate-600 dark:text-slate-300">{job.error?.message ?? job.step ?? ''}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}

function Questions({ job, onAnswered }: { job: JobView; onAnswered: () => void }) {
  const open = job.questions.filter((question) => question.answer === undefined);
  return (
    <Card data-testid="job-question">
      <CardTitle>{subject(job)}</CardTitle>
      {open.map((question) => (
        <Answer key={question.id} jobId={job.id} question={question} onAnswered={onAnswered} />
      ))}
    </Card>
  );
}

function Answer({
  jobId,
  question,
  onAnswered,
}: {
  jobId: string;
  question: JobView['questions'][number];
  onAnswered: () => void;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();

  async function send(answer: string): Promise<void> {
    try {
      await api(`/v1/jobs/${jobId}/answers`, { method: 'POST', body: { question_id: question.id, answer } });
      onAnswered();
    } catch (failure) {
      setError(message(failure));
    }
  }

  return (
    <div className="mt-2">
      <p className="text-sm">{question.text}</p>
      {question.options ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {question.options.map((option) => (
            <Button key={option} variant="outline" onClick={() => void send(option)}>
              {option}
            </Button>
          ))}
        </div>
      ) : (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void send(value.trim());
          }}
        >
          <Input
            aria-label={question.text}
            autoComplete="one-time-code"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button type="submit" disabled={value.trim() === ''}>
            Answer
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
