import type { JsonSchema, LoginRecipe } from '@tooldrop/core';
import type { PublishedTool } from '@tooldrop/db';

// Code export (SPEC, Differentiating features): a tool as a standalone npm
// package that runs without toolDrop. It holds the tool's recipe, toolDrop's
// runtime bundled into one file, typed functions, a README and the license.
// No login ever goes into it: the caller passes one at call time.

/** The bundled runtime an export carries; the CLI provides it (apps/cli/src/export-runtime.ts). */
export interface ExportRuntime {
  /** runtime.js: toolDrop's runtime in one file of plain JavaScript. */
  source: string;
  /** The npm packages it imports, with their versions. */
  dependencies: Record<string, string>;
  /** toolDrop's license, which the runtime carries. */
  license: string;
}

/** The files of a tool's package, by path. */
export function exportFiles(
  tool: PublishedTool,
  loginRecipe: LoginRecipe | undefined,
  runtime: ExportRuntime,
): Record<string, string> {
  const write = tool.authority === 'write';
  const definition = {
    name: tool.name,
    description: tool.description,
    authority: tool.authority,
    input_schema: tool.input_schema,
    output_schema: tool.output_schema,
    version: tool.version,
    recipe: tool.recipe,
    site: tool.site.origin,
    rate_limit: tool.site.rate_limit,
    ...(loginRecipe && { login_recipe: loginRecipe }),
  };
  const usesBrowser =
    tool.recipe.strategy === 'browser_script' ||
    tool.recipe.fallback !== undefined ||
    loginRecipe !== undefined;
  const packageJson = {
    name: tool.name.replaceAll('_', '-'),
    version: `${tool.version}.0.0`,
    description: tool.description,
    private: true,
    type: 'module',
    main: 'index.js',
    types: 'index.d.ts',
    license: 'Apache-2.0',
    engines: { node: '>=24' },
    dependencies: runtime.dependencies,
  };
  return {
    'package.json': `${JSON.stringify(packageJson, null, 2)}\n`,
    'tool.json': `${JSON.stringify(definition, null, 2)}\n`,
    'index.js': indexJs(tool.name, tool.description, write),
    'index.d.ts': indexDts(tool, write),
    'runtime.js': runtime.source,
    'README.md': readme(tool, { write, usesBrowser, signsIn: loginRecipe !== undefined }),
    LICENSE: runtime.license,
  };
}

function indexJs(name: string, description: string, write: boolean): string {
  const header = `// ${name}, exported from toolDrop. It runs without toolDrop: see README.md.
import { createTool as create } from './runtime.js';
import definition from './tool.json' with { type: 'json' };

/** A reusable instance that keeps its browser and session between calls. Call close() when done. */
export function createTool() {
  return create(definition);
}
`;
  if (write) {
    return `${header}
/** What the write would do, without submitting it: the page, the action, the fields and a screenshot. */
export async function preview(input, options) {
  const tool = create(definition);
  try {
    return await tool.preview(input, options);
  } finally {
    await tool.close();
  }
}

/** ${comment(description)} Submits the write: call it only for one you mean to make. */
export async function commit(input, options) {
  const tool = create(definition);
  try {
    return await tool.commit(input, options);
  } finally {
    await tool.close();
  }
}
`;
  }
  return `${header}
/** ${comment(description)} */
export async function ${name}(input = {}, options) {
  const tool = create(definition);
  try {
    return await tool.run(input, options);
  } finally {
    await tool.close();
  }
}

export default ${name};
`;
}

function indexDts(tool: PublishedTool, write: boolean): string {
  const shared = `/** The tool's input. */
export type Input = ${typeOf(tool.input_schema, '')};

/** The tool's result. */
export type Output = ${typeOf(tool.output_schema, '')};

export interface ToolOptions {
  /** Another origin for the same site, such as a staging copy. */
  site?: string;
  /** The account to sign in with, for a site that needs one. Read it from the environment, never from code. */
  login?: {
    username: string;
    password: string;
    /** The authenticator secret, for sites that ask for a one-time code. */
    totp_secret?: string;
    /** Or a way to get the code, e.g. by asking a person. */
    otp?: () => Promise<string>;
  };
  /** How long a browser step waits for the page, in milliseconds (default 10 000). */
  browserWaitMs?: number;
}

export interface Preview {
  preview: { url: string; action: string; fields: { field: string; value: string }[] };
  /** A PNG of the filled form. */
  screenshot?: Uint8Array;
}
`;
  if (write) {
    return `${shared}
export interface Tool {
  preview(input: Input, options?: ToolOptions): Promise<Preview>;
  commit(input: Input, options?: ToolOptions): Promise<Output>;
  close(): Promise<void>;
}

export function createTool(): Tool;
/** What the write would do, without submitting it. */
export function preview(input: Input, options?: ToolOptions): Promise<Preview>;
/** ${comment(tool.description)} Submits the write. */
export function commit(input: Input, options?: ToolOptions): Promise<Output>;
`;
  }
  return `${shared}
export interface Tool {
  run(input?: Input, options?: ToolOptions): Promise<Output>;
  close(): Promise<void>;
}

export function createTool(): Tool;
/** ${comment(tool.description)} */
export function ${tool.name}(input?: Input, options?: ToolOptions): Promise<Output>;
export default ${tool.name};
`;
}

/** A TypeScript type for a JSON Schema: the common keywords, and `unknown` for the rest. */
export function typeOf(schema: JsonSchema | boolean | undefined, indent: string): string {
  if (schema === undefined || schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (Array.isArray(schema.enum))
    return schema.enum.map((value) => JSON.stringify(value)).join(' | ') || 'never';
  if ('const' in schema) return JSON.stringify(schema.const);
  const variants = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(variants)) return variants.map((variant) => typeOf(variant, indent)).join(' | ');
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string | undefined];
  return types.map((type) => single(schema, type, indent)).join(' | ');
}

function single(schema: JsonSchema, type: string | undefined, indent: string): string {
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array': {
      const items = typeOf(schema.items as JsonSchema | undefined, indent);
      return items.includes(' ') ? `Array<${items}>` : `${items}[]`;
    }
    case 'object':
    case undefined: {
      const properties = (schema.properties ?? undefined) as Record<string, JsonSchema> | undefined;
      if (!properties) return type === 'object' ? 'Record<string, unknown>' : 'unknown';
      const required = new Set((schema.required ?? []) as string[]);
      const inner = `${indent}  `;
      const lines = Object.entries(properties).map(([key, property]) => {
        const doc =
          typeof property.description === 'string' ? `${inner}/** ${comment(property.description)} */\n` : '';
        const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
        return `${doc}${inner}${name}${required.has(key) ? '' : '?'}: ${typeOf(property, inner)};`;
      });
      return lines.length > 0 ? `{\n${lines.join('\n')}\n${indent}}` : 'Record<string, never>';
    }
    default:
      return 'unknown';
  }
}

/** Text safe inside a /** comment *\/. */
function comment(text: string): string {
  return text.replaceAll('*/', '*\\/').replaceAll('\n', ' ');
}

function readme(
  tool: PublishedTool,
  { write, usesBrowser, signsIn }: { write: boolean; usesBrowser: boolean; signsIn: boolean },
): string {
  const options = signsIn
    ? `{
  login: { username: process.env.SITE_USERNAME, password: process.env.SITE_PASSWORD },
}`
    : '';
  const call = write
    ? `import { preview, commit } from './${tool.name}/index.js';

const input = { /* the tool's inputs, see index.d.ts */ };
console.log(await preview(input${options ? `, ${options}` : ''}));
// Only once you mean to make the write:
// await commit(input${options ? `, ${options}` : ''});`
    : `import { ${tool.name} } from './${tool.name}/index.js';

console.log(await ${tool.name}({ /* the tool's inputs, see index.d.ts */ }${options ? `, ${options}` : ''}));`;
  return `# ${tool.name}

${tool.description}

Exported from [toolDrop](https://github.com/nabeelali0707/toolDrop): version ${tool.version} of the tool, for ${tool.site.origin}. This package runs without toolDrop, on Node.js 24 or newer.

## Use it

\`\`\`sh
npm install${usesBrowser ? '\nnpx playwright install chromium' : ''}
\`\`\`

\`\`\`js
${call}
\`\`\`

The input and the result are typed in \`index.d.ts\`. \`createTool()\` gives an instance that keeps its ${usesBrowser ? 'browser and ' : ''}session between calls; call \`close()\` when done. \`{ site }\` points the tool at another origin of the same site, such as a staging copy.
${
  signsIn
    ? `
## Signing in

The site needs a login. Pass it at call time, read from the environment or your own secret store, never written into code. For sites that ask for a one-time code, add \`totp_secret\` (the authenticator secret) or \`otp\`, a function that returns the code. \`tool.json\` holds only the steps that sign in.
`
    : ''
}${
    write
      ? `
## A write

This tool changes the site. \`preview()\` fills the form and shows what it would submit, without submitting; \`commit()\` makes the write. toolDrop's safe mode (approvals and policies) is not part of an export: your code decides when to commit.
`
      : ''
  }
## What is inside

- \`tool.json\`: the tool's schemas and its recipe, the steps that call the site.
- \`runtime.js\`: toolDrop's runtime, bundled; it runs the recipe, validates the input and the result, and falls back to the browser when a faster strategy breaks.
- \`index.js\` and \`index.d.ts\`: the functions to call, with their types.

It does not repair itself: when the site changes and a call starts failing, export the tool again from toolDrop, where it heals, or edit the recipe in \`tool.json\`.

The runtime is toolDrop's code, under the Apache-2.0 license in \`LICENSE\`.
`;
}
