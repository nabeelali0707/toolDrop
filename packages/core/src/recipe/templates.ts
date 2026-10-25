// Template references inside recipe strings: {{site}}, {{input.status}},
// {{session.csrf}}, {{loop.page}} and {{vars.accountId}}. The runtime fills
// them in; this module only finds and checks them.

export const TEMPLATE_ROOTS = ['site', 'input', 'session', 'loop', 'vars'] as const;
export type TemplateRoot = (typeof TEMPLATE_ROOTS)[number];

export interface TemplateRef {
  root: TemplateRoot;
  /** Names after the root: `['status']` for {{input.status}}, empty for {{site}}. */
  path: string[];
  /** The text between the braces, trimmed. */
  raw: string;
}

export interface TemplateScan {
  refs: TemplateRef[];
  errors: string[];
}

const REFERENCE = /\{\{([^{}]*)\}\}/g;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseTemplate(text: string): TemplateScan {
  const refs: TemplateRef[] = [];
  const errors: string[] = [];

  for (const match of text.matchAll(REFERENCE)) {
    const raw = (match[1] ?? '').trim();
    const [root = '', ...path] = raw.split('.');
    if (!isTemplateRoot(root)) {
      errors.push(`{{${raw}}} has an unknown root "${root}"; use one of ${TEMPLATE_ROOTS.join(', ')}`);
    } else if (root === 'site' && path.length > 0) {
      errors.push(`{{${raw}}}: {{site}} takes no path`);
    } else if (root !== 'site' && path.length === 0) {
      errors.push(`{{${raw}}} needs a name, e.g. {{${root}.name}}`);
    } else if (!path.every((name) => NAME.test(name))) {
      errors.push(`{{${raw}}} has an invalid name; names use letters, digits and _`);
    } else {
      refs.push({ root, path, raw });
    }
  }

  const rest = text.replace(REFERENCE, '');
  if (rest.includes('{{') || rest.includes('}}')) {
    errors.push(`unbalanced braces in "${text}"`);
  }
  return { refs, errors };
}

/** Finds the template references in every string inside a JSON-like value. */
export function collectTemplateRefs(value: unknown): TemplateScan {
  const scan: TemplateScan = { refs: [], errors: [] };
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      const found = parseTemplate(node);
      scan.refs.push(...found.refs);
      scan.errors.push(...found.errors);
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node !== null && typeof node === 'object') {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return scan;
}

function isTemplateRoot(value: string): value is TemplateRoot {
  return (TEMPLATE_ROOTS as readonly string[]).includes(value);
}
