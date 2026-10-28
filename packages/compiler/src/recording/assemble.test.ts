import type { Selector } from '@tooldrop/core';
import { describe, expect, it } from 'vitest';
import type { ElementInfo } from '../capture/page-helpers.ts';
import { addRecorderEvent, valueActions, type RecordingDraft } from './assemble.ts';

const element = (role: string, tag: string, name = ''): ElementInfo => ({
  ref: `e${role}${tag}`,
  role,
  name,
  tag,
  candidates: [{ kind: 'css', value: tag } satisfies Selector],
});

const draft = (): RecordingDraft => ({ actions: [{ kind: 'goto', url: 'http://127.0.0.1:4102/invoices' }] });

describe('addRecorderEvent', () => {
  it('keeps clicks on things that act, and drops clicks on empty space', () => {
    const recording = draft();
    for (const info of [
      element('', 'html'),
      element('', 'body'),
      element('navigation', 'nav', 'Pagination'),
      element('table', 'table'),
      element('button', 'button', 'Search'),
      element('link', 'a', 'Next page'),
    ]) {
      addRecorderEvent(recording, { kind: 'click', info });
    }
    expect(recording.actions.slice(1).map((action) => action.kind === 'click' && action.label)).toEqual([
      'button "Search"',
      'link "Next page"',
    ]);
  });

  it('keeps the last value of a field edited twice in a row', () => {
    const recording = draft();
    const status = element('combobox', 'select', 'Status');
    addRecorderEvent(recording, { kind: 'select', info: status, value: 'paid' });
    addRecorderEvent(recording, { kind: 'select', info: status, value: 'open' });
    expect(recording.actions.slice(1)).toMatchObject([{ kind: 'select', value: 'open' }]);
  });
});

describe('valueActions', () => {
  it('offers typed and picked values as inputs, but not empty ones', () => {
    const recording = draft();
    const status = element('combobox', 'select', 'Status');
    addRecorderEvent(recording, { kind: 'select', info: status, value: 'paid' });
    addRecorderEvent(recording, { kind: 'click', info: element('button', 'button', 'Search') });
    addRecorderEvent(recording, { kind: 'select', info: status, value: '' });
    addRecorderEvent(recording, { kind: 'fill', info: element('textbox', 'input', 'Password'), value: null });
    expect(valueActions(recording.actions).map(({ action }) => action.value)).toEqual(['paid']);
  });
});
