import { newId } from '@tooldrop/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../client.ts';
import { DIALECTS, openTestDatabase } from '../testing.ts';
import {
  addJobAnswer,
  addJobQuestion,
  createJob,
  failUnfinishedJobs,
  getJob,
  jobUsage,
  listCaptures,
  listJobs,
  recordLlmCall,
  saveCapture,
  setJobStatus,
  setJobStep,
} from './index.ts';

const input = { url: 'http://127.0.0.1:4101/invoices', task: 'List invoices', authority: 'read' };

describe.each(DIALECTS)('on %s', (dialect) => {
  let handle: DatabaseHandle;
  beforeEach(async () => {
    handle = await openTestDatabase(dialect);
  });
  afterEach(() => handle.close());

  describe('jobs', () => {
    it('runs a job through its states, with a question and its answer', async () => {
      const { db } = handle;
      const job = await createJob(db, { kind: 'build', input });
      expect(job).toMatchObject({ status: 'queued', questions: [], answers: [] });

      await setJobStatus(db, job.id, 'running', { step: 'capturing' });
      await setJobStep(db, job.id, 'analyzing traffic');
      expect(await getJob(db, job.id)).toMatchObject({ status: 'running', step: 'analyzing traffic' });

      const question = {
        id: newId(),
        text: 'Fetch every page?',
        options: ['yes', 'no'],
        asked_at: Date.now(),
      };
      expect(await addJobQuestion(db, job.id, question)).toMatchObject({
        status: 'waiting_for_answer',
        questions: [question],
      });

      const answer = { question_id: question.id, text: 'yes', answered_at: Date.now() };
      expect((await addJobAnswer(db, job.id, answer)).answers).toEqual([answer]);
      await expect(addJobAnswer(db, job.id, answer)).rejects.toThrow(/already answered/);
      await expect(addJobAnswer(db, job.id, { ...answer, question_id: newId() })).rejects.toThrow(
        /no question/,
      );

      await setJobStatus(db, job.id, 'running');
      const done = await setJobStatus(db, job.id, 'succeeded', {
        step: null,
        result: { tool: 'list_invoices' },
      });
      expect(done).toMatchObject({ status: 'succeeded', step: null, result: { tool: 'list_invoices' } });
      await expect(setJobStatus(db, job.id, 'running')).rejects.toThrow(
        /cannot go from succeeded to running/,
      );
      await expect(addJobAnswer(db, job.id, answer)).rejects.toThrow(/not waiting/);
    });

    it('fails the jobs a restart interrupted', async () => {
      const { db } = handle;
      const queued = await createJob(db, { kind: 'build', input });
      const running = await createJob(db, { kind: 'build', input });
      await setJobStatus(db, running.id, 'running');
      const finished = await createJob(db, { kind: 'build', input });
      await setJobStatus(db, finished.id, 'running');
      await setJobStatus(db, finished.id, 'failed', { error: { code: 'internal', message: 'boom' } });

      expect(await failUnfinishedJobs(db, 'toolDrop restarted')).toBe(2);
      expect((await listJobs(db, { status: 'failed' })).map((job) => job.id).sort()).toEqual(
        [queued.id, running.id, finished.id].sort(),
      );
      expect((await getJob(db, queued.id))?.error).toEqual({
        code: 'internal',
        message: 'toolDrop restarted',
      });
    });

    it('indexes captures by job', async () => {
      const { db } = handle;
      const job = await createJob(db, { kind: 'build', input });
      await saveCapture(db, {
        job_id: job.id,
        har_path: 'captures/a/network.har',
        ax_trees: ['captures/a/ax-0.json'],
      });
      expect(await listCaptures(db, job.id)).toEqual([
        expect.objectContaining({
          har_path: 'captures/a/network.har',
          ax_trees: ['captures/a/ax-0.json'],
          actions: [],
        }),
      ]);
    });
  });

  describe('llm_calls', () => {
    it('logs every call and totals them per job', async () => {
      const { db } = handle;
      const job = await createJob(db, { kind: 'build', input });
      const call = {
        job_id: job.id,
        purpose: 'write_recipe',
        provider: 'ollama' as const,
        model: 'qwen2.5-coder:7b',
        role: 'code' as const,
        prompt_tokens: 1200,
        completion_tokens: 300,
        duration_ms: 4000,
      };
      await recordLlmCall(db, { ...call, attempt: 1, ok: false, error_code: 'llm_invalid_output' });
      await recordLlmCall(db, { ...call, attempt: 2, ok: true });
      await recordLlmCall(db, { ...call, purpose: 'name_tool', role: 'reasoning', attempt: 1, ok: true });

      expect(await jobUsage(db, job.id)).toEqual({
        calls: 3,
        retries: 1,
        prompt_tokens: 3600,
        completion_tokens: 900,
        duration_ms: 12000,
      });
      expect(await jobUsage(db, newId())).toEqual({
        calls: 0,
        retries: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        duration_ms: 0,
      });
    });
  });
});
