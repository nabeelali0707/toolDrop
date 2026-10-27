import { startHtmlAppFixture } from '@tooldrop/fixture-html-app';
import type { RunningFixture } from '@tooldrop/fixture-kit';
import { FIXTURE_ACCOUNT, startLoginTotpFixture } from '@tooldrop/fixture-login-totp';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Recorder } from './recorder.ts';
import { replayRecording } from './replay.ts';

// `tooldrop record`, scripted: Playwright plays the person, so the page's own
// events reach the recorder exactly as real clicks and typing would.

let browser: Browser;
let htmlApp: RunningFixture;
let login: RunningFixture;

beforeAll(async () => {
  browser = await chromium.launch();
  htmlApp = await startHtmlAppFixture();
  login = await startLoginTotpFixture();
});

afterAll(async () => {
  await browser.close();
  await htmlApp.close();
  await login.close();
});

describe('the recorder', () => {
  it('records the steps and the marked data, and the recording replays', async () => {
    const recorder = await Recorder.start(`${htmlApp.url}/invoices`, { browser, headless: true });
    const { page } = recorder;
    await page.selectOption('select[name="status"]', 'overdue');
    // The search loads a new page; the recorder and its bar come back on it.
    await page.getByRole('button', { name: 'Search' }).click();
    await page.waitForURL('**/invoices?status=overdue*');
    await page.getByRole('button', { name: 'Mark data' }).click();
    await page.locator('#invoices tbody tr').first().click();
    const finished = recorder.nextFinish();
    await page.getByRole('button', { name: 'Finish' }).click();
    await finished;

    expect(recorder.actions.map((action) => action.kind)).toEqual(['goto', 'select', 'click']);
    expect(recorder.actions[1]).toMatchObject({
      kind: 'select',
      label: 'combobox "Status"',
      value: 'overdue',
    });
    expect(recorder.valueActions().map(({ index }) => index)).toEqual([1]);
    // Selectors that find only this element come first.
    expect(recorder.target?.selector[0]).toEqual({ kind: 'test_id', value: 'invoices' });

    const recording = await recorder.stop(
      [{ name: 'status', action: 1, example: 'overdue' }],
      'Overdue invoices',
    );
    const capture = await replayRecording(recording, { browser });
    const data = capture.target?.data;
    expect(data?.kind === 'table' && data.rows.every((row) => row[4] === 'overdue')).toBe(true);
  }, 60_000);

  it('never keeps what goes into a password field', async () => {
    const recorder = await Recorder.start(`${login.url}/login`, { browser, headless: true });
    const { page } = recorder;
    await page.getByLabel('Username').fill(FIXTURE_ACCOUNT.username);
    await page.getByLabel('Password').fill(FIXTURE_ACCOUNT.password);
    await page.getByLabel('Username').focus(); // leaving the field commits it, as a person tabbing on would
    await expect.poll(() => recorder.actions.length).toBe(3);
    const recording = await recorder.stop([]);

    expect(recording.actions[1]).toMatchObject({ kind: 'fill', value: FIXTURE_ACCOUNT.username });
    expect(recording.actions[2]).toMatchObject({
      kind: 'fill',
      label: 'textbox "Password"',
      value: null,
      secret: true,
    });
    expect(JSON.stringify(recording)).not.toContain(FIXTURE_ACCOUNT.password);
  }, 60_000);
});
