import type { RecorderEvent, RecordingDraft } from '@tooldrop/compiler/page';
import type { MarkedInput, Recording } from '@tooldrop/core';

// What the popup, the review page and the service worker share.

export type Message =
  | { type: 'start'; tabId: number }
  | { type: 'status'; tabId: number }
  | { type: 'stop'; tabId: number }
  | { type: 'recorder-event'; event: RecorderEvent };

/** A recording in progress, kept in session storage: Chrome may stop the worker between events. */
export interface RecordingState {
  started_at: number;
  draft: RecordingDraft;
}

/** Sends a message to the service worker, and returns its answer or throws its error. */
export async function ask<T>(message: Message): Promise<T> {
  const answer = await chrome.runtime.sendMessage<Message, { ok: boolean; value?: T; error?: string }>(
    message,
  );
  if (!answer.ok) throw new Error(answer.error ?? 'the recorder did not answer');
  return answer.value as T;
}

export const DEFAULT_SERVER = 'http://127.0.0.1:3000';

export interface Settings {
  /** The toolDrop server recordings go to. */
  server: string;
  /** Its API key. Kept in session storage, so it is gone when Chrome closes. */
  apiKey: string;
}

export async function readSettings(): Promise<Settings> {
  const { server } = await chrome.storage.local.get('server');
  const { apiKey } = await chrome.storage.session.get('apiKey');
  return {
    server: typeof server === 'string' && server !== '' ? server : DEFAULT_SERVER,
    apiKey: typeof apiKey === 'string' ? apiKey : '',
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ server: settings.server });
  await chrome.storage.session.set({ apiKey: settings.apiKey });
}

/** The recording as toolDrop stores it (recording format v1). */
export function toRecording(state: RecordingState, inputs: MarkedInput[], task: string): Recording {
  return {
    version: 1,
    recorder: 'extension',
    recorded_at: state.started_at,
    ...(task !== '' && { task }),
    actions: state.draft.actions,
    inputs,
    ...(state.draft.target && { target: state.draft.target }),
  };
}

/** Calls the toolDrop server's REST API with the saved key; errors carry the server's message. */
export async function callServer<T>(settings: Settings, path: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, settings.server), {
      method: 'POST',
      headers: { authorization: `Bearer ${settings.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(`toolDrop is not answering at ${settings.server}. Is \`tooldrop serve\` running?`);
  }
  const answer = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  if (!response.ok) throw new Error(answer.error?.message ?? `toolDrop answered ${response.status}`);
  return answer as T;
}
