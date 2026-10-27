/// <reference lib="dom" />
import type { Selector } from '@tooldrop/core';
import type { ElementInfo, PageHelpers } from '../capture/page-helpers.ts';

// The recorder's code inside the page (`tooldrop record`). Like the page
// helpers it is serialized into the page, so it may use nothing from outside
// its body. It reports what the person does through an exposed binding, and
// shows a small toolDrop bar with "Mark data" and "Finish".

export type RecorderEvent =
  | { kind: 'click'; info: ElementInfo }
  | { kind: 'fill'; info: ElementInfo; value: string | null }
  | { kind: 'select'; info: ElementInfo; value: string }
  | { kind: 'target'; info: ElementInfo }
  | { kind: 'finish' };

export const RECORDER_BINDING = '__tooldropRecord';
export const RECORDER_BAR_ID = 'tooldrop-recorder';

export function installRecorder(): void {
  const host = window as Window & {
    __tooldrop?: PageHelpers;
    __tooldropRecorder?: boolean;
    __tooldropRecord?: (event: RecorderEvent) => Promise<void>;
  };
  if (host.__tooldropRecorder) return;
  host.__tooldropRecorder = true;

  const BAR_ID = 'tooldrop-recorder';
  let marking = false;
  let status: HTMLElement | undefined;
  let bar: HTMLElement | undefined;

  const send = (event: RecorderEvent) => {
    void host.__tooldropRecord?.(event);
  };
  const say = (text: string) => {
    if (status) status.textContent = text;
  };

  /** Selectors that find only this element come first, so replays find it without waiting. */
  function ordered(info: ElementInfo): ElementInfo {
    const element = document.querySelector(`[data-tooldrop-ref="${info.ref}"]`);
    const unique = (selector: Selector) => {
      const css =
        selector.kind === 'css'
          ? selector.value
          : selector.kind === 'test_id'
            ? `[data-testid="${selector.value.replace(/"/g, '\\"')}"]`
            : undefined;
      if (!css || !element) return false;
      try {
        const matches = document.querySelectorAll(css);
        return matches.length === 1 && matches[0] === element;
      } catch {
        return false;
      }
    };
    const first = info.candidates.filter(unique);
    return { ...info, candidates: [...first, ...info.candidates.filter((c) => !first.includes(c))] };
  }

  function describe(element: Element): ElementInfo | undefined {
    const helpers = host.__tooldrop;
    const ref = helpers?.refFor(element);
    const info = ref ? helpers?.info(ref) : undefined;
    return info ? ordered(info) : undefined;
  }

  const isTextField = (element: Element) =>
    (element instanceof HTMLInputElement &&
      !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file'].includes(element.type)) ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement;

  const inBar = (event: Event) => (bar ? event.composedPath().includes(bar) : false);

  document.addEventListener(
    'click',
    (event) => {
      if (inBar(event) || !(event.target instanceof Element)) return;
      if (marking) {
        event.preventDefault();
        event.stopPropagation();
        marking = false;
        const helpers = host.__tooldrop;
        const extracted = helpers?.extract(helpers.refFor(event.target) ?? '');
        const info = extracted ? helpers?.info(extracted.ref) : undefined;
        if (info) send({ kind: 'target', info: ordered(info) });
        say(info ? 'Data marked. Click Finish when you are done.' : 'Nothing to mark there; try again.');
        return;
      }
      // Clicking into a field is not a step; what is typed into it is.
      if (isTextField(event.target)) return;
      const info = describe(event.target);
      if (info) send({ kind: 'click', info });
    },
    true,
  );

  document.addEventListener(
    'change',
    (event) => {
      const element = event.target;
      if (!(element instanceof Element) || !isTextField(element)) return;
      const info = describe(element);
      if (!info) return;
      if (element instanceof HTMLSelectElement) send({ kind: 'select', info, value: element.value });
      else {
        const field = element as HTMLInputElement | HTMLTextAreaElement;
        // Never keep what is typed into a password field.
        send({ kind: 'fill', info, value: field.type === 'password' ? null : field.value });
      }
    },
    true,
  );

  // Pressing Enter in a form submits it without a click: record its submit button instead.
  document.addEventListener(
    'submit',
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || event.submitter) return;
      const button = form.querySelector('button:not([type=button]):not([type=reset]), input[type=submit]');
      const info = button ? describe(button) : undefined;
      if (info) send({ kind: 'click', info });
    },
    true,
  );

  function addBar(): void {
    if (document.getElementById(BAR_ID) || !document.body) return;
    bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = bar.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      div{font:13px system-ui,sans-serif;background:#111;color:#fff;border-radius:10px;padding:10px 12px;display:flex;gap:8px;align-items:center;box-shadow:0 4px 16px #0005}
      button{font:inherit;border:0;border-radius:6px;padding:6px 10px;cursor:pointer}
      .mark{background:#ffd54a}.finish{background:#7ee08a}
    </style><div><span>toolDrop is recording</span>
      <button class="mark" type="button">Mark data</button>
      <button class="finish" type="button">Finish</button>
      <span class="status"></span></div>`;
    status = root.querySelector<HTMLElement>('.status') ?? undefined;
    root.querySelector('.mark')?.addEventListener('click', () => {
      marking = true;
      say('Now click the table or list with the data.');
    });
    root.querySelector('.finish')?.addEventListener('click', () => {
      say('Saving the recording...');
      send({ kind: 'finish' });
    });
    document.body.append(bar);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addBar);
  else addBar();
}
