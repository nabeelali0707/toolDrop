import { describe, expect, it } from 'vitest';
import { newId } from './ids.ts';
import { buildInputSchema, canTransition } from './job.ts';

describe('job transitions', () => {
  it('pauses for a question and resumes', () => {
    expect(canTransition('running', 'waiting_for_answer')).toBe(true);
    expect(canTransition('waiting_for_answer', 'running')).toBe(true);
  });

  it('never leaves a finished state', () => {
    expect(canTransition('succeeded', 'running')).toBe(false);
    expect(canTransition('failed', 'queued')).toBe(false);
  });

  it('cannot succeed without running', () => {
    expect(canTransition('queued', 'succeeded')).toBe(false);
  });
});

describe('buildInputSchema', () => {
  const valid = { url: 'https://supplier.example.com', task: 'list my invoices', authority: 'read' };

  it('accepts a build request', () => {
    expect(buildInputSchema.safeParse({ ...valid, recording_id: newId() }).success).toBe(true);
  });

  it('only accepts http and https sites', () => {
    expect(buildInputSchema.safeParse({ ...valid, url: 'file:///etc/passwd' }).success).toBe(false);
  });

  it('requires a task', () => {
    expect(buildInputSchema.safeParse({ ...valid, task: '' }).success).toBe(false);
  });
});
