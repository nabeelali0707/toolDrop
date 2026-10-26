import { parseTemplate, ToolDropError } from '@tooldrop/core';

/** The values a recipe's {{...}} references read from. */
export interface TemplateContext {
  /** The site's origin, e.g. http://127.0.0.1:4101 */
  site: string;
  input: Record<string, unknown>;
  session: Record<string, unknown>;
  vars: Record<string, unknown>;
  loop: Record<string, unknown>;
}

const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

/**
 * Fills in the template references in a JSON-like value.
 *
 * - A string that is exactly one reference keeps the value's type, so
 *   `"{{loop.page}}"` becomes the number 1, not "1".
 * - A reference to an input the caller left out is `undefined`, and object keys
 *   whose value is `undefined` are dropped: an optional filter disappears from
 *   the query instead of being sent empty.
 * - Inside a longer string, a missing input becomes an empty string.
 */
export function render(value: unknown, context: TemplateContext): unknown {
  if (typeof value === 'string') return renderString(value, context);
  if (Array.isArray(value)) return value.map((item) => render(item, context));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const rendered = render(item, context);
      if (rendered !== undefined) out[key] = rendered;
    }
    return out;
  }
  return value;
}

/** Like `render`, for strings that must stay strings (URLs, header values). */
export function renderText(text: string, context: TemplateContext): string {
  const value = renderString(text, context);
  return value === undefined || value === null ? '' : stringify(value);
}

function renderString(text: string, context: TemplateContext): unknown {
  const whole = WHOLE.exec(text);
  if (whole?.[1] !== undefined) return lookup(whole[1], context);
  if (!text.includes('{{')) return text;
  return text.replace(/\{\{([^{}]*)\}\}/g, (_match, raw: string) => {
    const value = lookup(raw.trim(), context);
    return value === undefined || value === null ? '' : stringify(value);
  });
}

function lookup(raw: string, context: TemplateContext): unknown {
  const { refs, errors } = parseTemplate(`{{${raw}}}`);
  const ref = refs[0];
  if (!ref) throw new ToolDropError('internal', `invalid template {{${raw}}}: ${errors.join('; ')}`);
  if (ref.root === 'site') return context.site;

  let value: unknown = context[ref.root];
  for (const name of ref.path) {
    value =
      value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined;
  }
  // Optional inputs may be missing; anything else missing is a broken recipe.
  if (value === undefined && ref.root !== 'input' && ref.root !== 'loop') {
    throw new ToolDropError('internal', `{{${raw}}} has no value at this step`);
  }
  return value;
}

/** How a value appears inside text: primitives as themselves, everything else as JSON. */
export function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}
