import { readFileSync } from 'node:fs';
import { toolFileSchema, ToolDropError, type ToolFile } from '@tooldrop/core';

/** Reads and validates a tool file (a tool definition plus its recipe), with every problem listed. */
export function readToolFile(path: string): ToolFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ToolDropError('invalid_input', `${path} is not readable JSON: ${(error as Error).message}`);
  }
  const parsed = toolFileSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ToolDropError('invalid_input', `${path} is not a valid tool file: ${problems.join('; ')}`, {
      details: { problems },
    });
  }
  return parsed.data;
}
