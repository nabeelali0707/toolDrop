import { ask } from './shared.ts';

// The toolbar popup: start recording the current tab, or finish.

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function fail(error: unknown): void {
  const box = element('error');
  box.textContent = error instanceof Error ? error.message : String(error);
  box.hidden = false;
}

async function main(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab?.id;
  if (tabId === undefined) return fail('There is no tab to record.');
  if (tab?.url) element('where').textContent = new URL(tab.url).host;
  const recording = await ask<boolean>({ type: 'status', tabId });
  element('idle').hidden = recording;
  element('recording').hidden = !recording;

  element('start').addEventListener('click', () => {
    ask({ type: 'start', tabId }).then(() => window.close(), fail);
  });
  element('stop').addEventListener('click', () => {
    ask<boolean>({ type: 'stop', tabId }).then(
      (finished) =>
        finished ? window.close() : fail('Mark the data first: click Mark data, then the table.'),
      fail,
    );
  });
}

main().catch(fail);
