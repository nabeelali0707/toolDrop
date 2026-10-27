import { recordingSchema, type Recording } from '@tooldrop/core';
import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CaptureSession } from '../capture/capture.ts';
import type { PageSnapshot } from '../capture/page-helpers.ts';
import { replayRecording, toRecording } from './replay.ts';

let fixture: RunningFixture;
let browser: Browser;
let recording: Recording;

const ref = (snapshot: PageSnapshot, role: string, name?: string) => {
  const node = snapshot.nodes.find((n) => n.role === role && (name === undefined || n.name === name));
  if (!node) throw new Error(`no ${role} ${name ?? ''}`);
  return node.ref;
};

beforeAll(async () => {
  fixture = await startHtmlAppFixture();
  browser = await chromium.launch();
  // A person filters the server-rendered list: the form submits and a new page loads.
  const session = await CaptureSession.start(`${fixture.url}/invoices`, { browser });
  const page = await session.snapshot();
  await session.select(ref(page, 'combobox', 'Status'), 'overdue', { name: 'status' });
  await session.click(ref(page, 'button', 'Search'));
  await session.markTarget(ref(await session.snapshot(), 'table'));
  recording = toRecording(await session.finish(), { recorder: 'cli', task: 'List overdue invoices' });
}, 60_000);

afterAll(async () => {
  await browser.close();
  await fixture.close();
});

describe('recordings', () => {
  it('turns a capture into a valid recording', () => {
    expect(recordingSchema.safeParse(recording).success).toBe(true);
    expect(recording.actions.map((action) => action.kind)).toEqual(['goto', 'select', 'click']);
    expect(recording.inputs).toEqual([{ name: 'status', action: 1, example: 'overdue' }]);
    expect(recording.target?.selector).toContainEqual({ kind: 'test_id', value: 'invoices' });
  });

  it('replays in a fresh browser and captures the same data', async () => {
    const capture = await replayRecording(recording, { browser });
    expect(capture.inputs).toEqual(recording.inputs);
    const data = capture.target?.data;
    expect(data?.kind === 'table' && data.rows.length).toBe(10);
    expect(data?.kind === 'table' && data.rows.every((row) => row[4] === 'overdue')).toBe(true);
    const documents = capture.exchanges.filter((e) => e.resource_type === 'document').map((e) => e.url);
    expect(documents).toEqual([`${fixture.url}/invoices`, `${fixture.url}/invoices?status=overdue&from=`]);
    expect(capture.exchanges.at(-1)?.after_actions).toBe(2);
  });

  it('stops with a clear error when the page no longer matches', async () => {
    const changed: Recording = {
      ...recording,
      actions: recording.actions.map((action) =>
        action.kind === 'click' ? { ...action, target: [{ kind: 'css', value: '#gone' }] } : action,
      ),
    };
    await expect(replayRecording(changed, { browser, waitMs: 500 })).rejects.toMatchObject({
      code: 'strategy_failed',
    });
  });
});
