import type { RecordedAction, Recording } from '@tooldrop/core';
import type { RecorderEvent } from './recorder-page.ts';

// How a recording grows from what the person does, the same for
// `tooldrop record` and the Chrome extension, so both make the same
// recordings. Browser-safe: it imports only types.

/** The recording so far: the steps, and the data the person marked. */
export interface RecordingDraft {
  actions: RecordedAction[];
  target?: Recording['target'];
}

/**
 * Parts of a page that only hold others: a click there lands on empty space
 * or text, does nothing, and is no step.
 */
const STRUCTURE_ROLES = new Set([
  'document',
  'main',
  'navigation',
  'banner',
  'contentinfo',
  'region',
  'complementary',
  'article',
  'form',
  'group',
  'list',
  'listitem',
  'table',
  'rowgroup',
  'row',
  'cell',
  'columnheader',
  'rowheader',
  'heading',
  'paragraph',
  'img',
  'presentation',
  'none',
]);
const STRUCTURE_TAGS = new Set(['html', 'body']);

/** Adds one thing the person did. Elements toolDrop could not describe are left out. */
export function addRecorderEvent(
  draft: RecordingDraft,
  event: Exclude<RecorderEvent, { kind: 'finish' }>,
): void {
  const { info } = event;
  const label = info.name ? `${info.role || info.tag} "${info.name}"` : info.role || info.tag;
  if (info.candidates.length === 0) return;
  const target = info.candidates.slice(0, 8);
  if (event.kind === 'target') {
    draft.target = { selector: target, label };
    return;
  }
  if (event.kind === 'click') {
    if (STRUCTURE_ROLES.has(info.role) || (!info.role && STRUCTURE_TAGS.has(info.tag))) return;
    draft.actions.push({ kind: 'click', target, label });
    return;
  }
  // A field edited twice in a row keeps its last value.
  const last = draft.actions.at(-1);
  const sameField =
    last && last.kind === event.kind && JSON.stringify(last.target) === JSON.stringify(target);
  const action: RecordedAction =
    event.kind === 'select'
      ? { kind: 'select', target, label, value: event.value, options: info.options ?? [] }
      : { kind: 'fill', target, label, value: event.value, ...(event.value === null && { secret: true }) };
  if (sameField) draft.actions[draft.actions.length - 1] = action;
  else draft.actions.push(action);
}

/**
 * The values typed or picked, which the person may turn into inputs. An
 * empty one, such as an "All" choice or a cleared field, is no input.
 */
export function valueActions(
  actions: readonly RecordedAction[],
): { index: number; action: Extract<RecordedAction, { kind: 'fill' | 'select' }> }[] {
  return actions.flatMap((action, index) =>
    (action.kind === 'fill' || action.kind === 'select') && action.value ? [{ index, action }] : [],
  );
}
