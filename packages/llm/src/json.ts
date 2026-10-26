import type { JsonSchema } from '@tooldrop/core';
import { z } from 'zod';

// Strict JSON from models (SPEC, Local LLM usage rule 2; DECISIONS.md, D-005).
// The Zod schema becomes JSON Schema for constrained decoding, and the reply
// is validated with the Zod schema itself, which also checks what JSON Schema
// cannot express.

/** Formats the grammar converters behind Ollama and llama.cpp understand. */
const SUPPORTED_FORMATS = new Set(['date', 'time', 'date-time', 'uuid']);
const UNSUPPORTED_KEYWORDS = new Set([
  '$schema',
  'propertyNames',
  'contentEncoding',
  'contentMediaType',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
]);

/**
 * The JSON Schema a model is asked to follow. Keywords the decoders cannot
 * turn into a grammar are dropped: an unanchored `pattern`, say, makes
 * llama.cpp reject the whole schema. Zod still checks them afterwards.
 */
export function modelSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  return simplify(json) as JsonSchema;
}

function simplify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(simplify);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    if (key === 'pattern' && !(typeof value === 'string' && isAnchored(value))) continue;
    if (key === 'format' && !(typeof value === 'string' && SUPPORTED_FORMATS.has(value))) continue;
    // Zod's integer bounds say nothing, and they turn into large grammars.
    if ((key === 'minimum' || key === 'maximum') && Math.abs(Number(value)) === Number.MAX_SAFE_INTEGER)
      continue;
    // Property names are data here, not keywords.
    out[key] = key === 'properties' || key === '$defs' ? simplifyMembers(value) : simplify(value);
  }
  return out;
}

/** Starts with ^, ends with an unescaped $, and has no lookarounds, which grammars cannot express. */
function isAnchored(pattern: string): boolean {
  const trailingBackslashes = /(\\*)\$$/.exec(pattern)?.[1]?.length;
  return (
    pattern.startsWith('^') &&
    trailingBackslashes !== undefined &&
    trailingBackslashes % 2 === 0 &&
    !/\(\?[=!<]/.test(pattern)
  );
}

function simplifyMembers(members: unknown): unknown {
  if (members === null || typeof members !== 'object') return members;
  return Object.fromEntries(Object.entries(members).map(([name, schema]) => [name, simplify(schema)]));
}

export type ParsedReply = { ok: true; value: unknown } | { ok: false; error: string };

/** Parses a reply as JSON, tolerating a Markdown code fence around it. */
export function parseReply(content: string): ParsedReply {
  let text = content.trim();
  const fenced = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const MAX_ISSUES = 20;
const MAX_ISSUE_LENGTH = 300;

/** Zod issues as "path: message" lines, short enough to send back to the model. */
export function formatIssues(issues: readonly z.core.$ZodIssue[]): string[] {
  const lines = issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    const line = `${path}: ${issue.message}`;
    return line.length > MAX_ISSUE_LENGTH ? `${line.slice(0, MAX_ISSUE_LENGTH)}...` : line;
  });
  if (issues.length > MAX_ISSUES) lines.push(`...and ${issues.length - MAX_ISSUES} more`);
  return lines;
}
