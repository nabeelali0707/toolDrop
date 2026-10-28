import type { RankedSelector, Step } from '@tooldrop/core';
import { describeTarget } from './steps.ts';

// Safe mode in the executors (SPEC, Safe mode): a write recipe's first
// commit step is where it changes the site. A preview stops before it; a
// commit runs it, with evidence from before and after.

export interface WriteRecord {
  /** Each value the recipe filled in, by field. */
  fields: { field: string; value: string }[];
  /** The page the commit step acts on, or the URL its request goes to. */
  url?: string;
  /** What the commit step does, e.g. `click role=button[name="Pay"]`. */
  action?: string;
  /** The filled form, just before the commit step (browser recipes). */
  before?: Buffer;
  /** True once the commit step itself has run: from then on, the site has changed. */
  committed?: boolean;
  /** The page after the last step (browser recipes). */
  after?: Buffer;
  url_after?: string;
}

export interface WriteMode {
  /** "preview" stops before the first commit step; "commit" runs it. */
  mode: 'preview' | 'commit';
  record: WriteRecord;
}

export function isCommit(step: Step): boolean {
  return 'commit' in step && step.commit === true;
}

/** A field's name in a preview: the accessible name or test id among its selectors, else the first selector. */
export function fieldName(target: RankedSelector): string {
  for (const selector of target) {
    if (selector.kind === 'role' && selector.name) return selector.name;
  }
  for (const selector of target) {
    if (selector.kind === 'test_id') return selector.value;
  }
  return describeTarget(target.slice(0, 1));
}
