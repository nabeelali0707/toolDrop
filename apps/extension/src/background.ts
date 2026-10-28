import {
  addRecorderEvent,
  installPageHelpers,
  installRecorder,
  RECORDER_BAR_ID,
} from '@tooldrop/compiler/page';
import type { Message, RecordingState } from './shared.ts';

// The extension's service worker. It starts recording a tab, puts toolDrop's
// recorder into every page the tab loads while recording, and keeps the
// recording in session storage, because Chrome may stop the worker between
// events (Manifest V3). It records only the tab it was started on, and only
// until Finish (docs/privacy.md).

const key = (tabId: number) => `recording:${tabId}`;

async function load(tabId: number): Promise<RecordingState | undefined> {
  const stored = await chrome.storage.session.get(key(tabId));
  return stored[key(tabId)] as RecordingState | undefined;
}

async function save(tabId: number, state: RecordingState): Promise<void> {
  await chrome.storage.session.set({ [key(tabId)]: state });
}

/** Runs updates one after another, so two quick events never start from the same old state. */
let queue: Promise<unknown> = Promise.resolve();
function serially<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task);
  queue = next.catch(() => undefined);
  return next;
}

/** Runs in the page: hands the recorder's events to this worker. */
function connectRecorder(): void {
  const host = window as Window & { __tooldropRecord?: (event: unknown) => Promise<void> };
  host.__tooldropRecord = async (event) => {
    await chrome.runtime.sendMessage({ type: 'recorder-event', event });
  };
}

/** Puts toolDrop's page helpers and the recorder bar into the tab's page. */
async function inject(tabId: number): Promise<void> {
  const target = { tabId };
  await chrome.scripting.executeScript({ target, func: installPageHelpers });
  await chrome.scripting.executeScript({ target, func: connectRecorder });
  await chrome.scripting.executeScript({ target, func: installRecorder });
}

/** Shows a line in the page's toolDrop bar. */
async function say(tabId: number, text: string): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (barId: string, line: string) => {
      const status = document.getElementById(barId)?.shadowRoot?.querySelector('.status');
      if (status) status.textContent = line;
    },
    args: [RECORDER_BAR_ID, text],
  });
}

async function start(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:/.test(tab.url)) {
    throw new Error('toolDrop records web pages: open the site first, then start recording.');
  }
  await save(tabId, { started_at: Date.now(), draft: { actions: [{ kind: 'goto', url: tab.url }] } });
  try {
    await inject(tabId);
  } catch (error) {
    await chrome.storage.session.remove(key(tabId));
    throw error;
  }
}

/**
 * Ends the recording and opens the review page, where the person names the
 * inputs and uploads it. False while no data is marked: a build needs to know
 * what the tool returns.
 */
async function finish(tabId: number): Promise<boolean> {
  const state = await load(tabId);
  if (!state) return false;
  if (!state.draft.target) {
    await say(tabId, 'Mark the data first: click Mark data, then the table or list.');
    return false;
  }
  await chrome.storage.session.remove(key(tabId));
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [`finished:${id}`]: state });
  await chrome.scripting
    .executeScript({
      target: { tabId },
      func: (barId: string) => document.getElementById(barId)?.remove(),
      args: [RECORDER_BAR_ID],
    })
    .catch(() => undefined);
  await chrome.tabs.create({ url: chrome.runtime.getURL(`review.html?recording=${id}`) });
  return true;
}

async function handle(message: Message, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.type) {
    case 'start':
      return serially(() => start(message.tabId));
    case 'status':
      return (await load(message.tabId)) !== undefined;
    case 'stop':
      return serially(() => finish(message.tabId));
    case 'recorder-event': {
      const tabId = sender.tab?.id;
      if (tabId === undefined) return undefined;
      const { event } = message;
      return serially(async () => {
        if (event.kind === 'finish') return finish(tabId);
        const state = await load(tabId);
        if (!state) return undefined;
        addRecorderEvent(state.draft, event);
        await save(tabId, state);
        return undefined;
      });
    }
  }
}

chrome.runtime.onMessage.addListener((message: Message, sender, respond) => {
  handle(message, sender).then(
    (value) => respond({ ok: true, value }),
    (error: unknown) => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true; // The answer comes later.
});

// Every page the recorded tab loads gets the recorder again.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'complete') return;
  void load(tabId)
    .then((state) => (state ? inject(tabId) : undefined))
    .catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(key(tabId));
});
