import { identifier, suggestedInputName, valueActions } from '@tooldrop/compiler/page';
import type { MarkedInput } from '@tooldrop/core';
import {
  callServer,
  readSettings,
  saveSettings,
  toRecording,
  type RecordingState,
  type Settings,
} from './shared.ts';

// The review page: the person picks which recorded values become inputs,
// says what the tool does, and uploads the recording to their toolDrop
// server (POST /v1/recordings), or downloads it for `tooldrop build`.

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function show(id: 'result' | 'error', text: string): void {
  const box = element(id);
  box.textContent = text;
  box.hidden = text === '';
}

function fail(error: unknown): void {
  show('error', error instanceof Error ? error.message : String(error));
}

/** Servers on this machine need no extra permission; the manifest already allows them. */
function isLocal(server: string): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(server).hostname);
}

async function main(): Promise<void> {
  const id = new URLSearchParams(location.search).get('recording') ?? '';
  const stored = await chrome.storage.session.get(`finished:${id}`);
  const state = stored[`finished:${id}`] as RecordingState | undefined;
  if (!state) {
    show('error', 'This recording is no longer here: recordings stay only until Chrome closes.');
    return;
  }
  const { actions, target } = state.draft;
  const start = actions[0]?.kind === 'goto' ? actions[0].url : '';
  element('site').textContent = start;

  const steps = element('steps');
  for (const action of actions) {
    const item = document.createElement('li');
    item.textContent =
      action.kind === 'goto'
        ? `Open ${action.url}`
        : action.kind === 'click'
          ? `Click ${action.label}`
          : action.value === null
            ? `Type into ${action.label} (a password: not kept)`
            : `${action.kind === 'select' ? 'Pick' : 'Type'} "${action.value}" in ${action.label}`;
    steps.append(item);
  }
  element('data').textContent = target ? `The data: ${target.label ?? 'the marked element'}.` : '';

  const typed = valueActions(actions);
  element('inputs-section').hidden = typed.length === 0;
  const rows = typed.map(({ index, action }) => {
    const row = document.createElement('div');
    row.className = 'input';
    const pick = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    pick.append(box, ` ${action.label}: "${action.value ?? ''}"`);
    const named = document.createElement('label');
    const name = document.createElement('input');
    name.type = 'text';
    name.value = suggestedInputName(action.label);
    name.setAttribute('aria-label', `Input name for ${action.label}`);
    named.append('Name ', name);
    row.append(pick, named);
    element('inputs').append(row);
    return { index, action, box, name };
  });

  const settings = await readSettings();
  element<HTMLInputElement>('server').value = settings.server;
  element<HTMLInputElement>('key').value = settings.apiKey;

  const recording = () => {
    const inputs: MarkedInput[] = rows
      .filter((row) => row.box.checked)
      .map((row) => ({
        name: identifier(row.name.value || suggestedInputName(row.action.label)),
        action: row.index,
        example: row.action.value ?? '',
      }));
    const names = inputs.map((input) => input.name);
    const twice = names.find((name, at) => names.indexOf(name) !== at);
    if (twice) throw new Error(`Two inputs are named ${twice}: give each its own name.`);
    return toRecording(state, inputs, element<HTMLTextAreaElement>('task').value.trim());
  };

  const currentSettings = async (): Promise<Settings> => {
    const chosen = {
      server: element<HTMLInputElement>('server').value.trim().replace(/\/+$/, ''),
      apiKey: element<HTMLInputElement>('key').value.trim(),
    };
    if (!chosen.apiKey) throw new Error('Paste an API key from `tooldrop keys create` first.');
    if (!isLocal(chosen.server)) {
      // Asked here, on the click: Chrome only asks for permissions in answer to one.
      const origins = [`${new URL(chosen.server).origin}/*`];
      if (!(await chrome.permissions.request({ origins }))) {
        throw new Error(`toolDrop Recorder needs your permission to reach ${chosen.server}.`);
      }
    }
    await saveSettings(chosen);
    return chosen;
  };

  let uploaded: string | undefined;
  element('upload').addEventListener('click', () => {
    show('error', '');
    void (async () => {
      const chosen = await currentSettings();
      const { id: saved } = await callServer<{ id: string }>(chosen, '/v1/recordings', recording());
      uploaded = saved;
      const task = element<HTMLTextAreaElement>('task').value.trim() || 'what the tool does';
      show(
        'result',
        `Saved as recording ${saved}. Build the tool now, ask your agent to build it from recording ${saved}, or run: tooldrop build ${start} --task "${task}" --recording ${saved}`,
      );
      element('build').hidden = false;
    })().catch(fail);
  });

  element('build').addEventListener('click', () => {
    show('error', '');
    void (async () => {
      const task = element<HTMLTextAreaElement>('task').value.trim();
      if (!task) throw new Error('Say what the tool does first, in the task box.');
      const { job } = await callServer<{ job: { id: string } }>(await currentSettings(), '/v1/builds', {
        url: start,
        task,
        authority: 'read',
        recording_id: uploaded,
      });
      show(
        'result',
        `Building, as job ${job.id}. Your agent can follow it with get_job, or open /v1/jobs/${job.id}.`,
      );
    })().catch(fail);
  });

  element('download').addEventListener('click', () => {
    try {
      const file = new Blob([`${JSON.stringify(recording(), null, 2)}\n`], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(file);
      link.download = 'tooldrop-recording.json';
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) {
      fail(error);
    }
  });
}

main().catch(fail);
