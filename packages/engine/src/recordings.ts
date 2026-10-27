import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { idSchema, newId, recordingSchema, ToolDropError, type Recording } from '@tooldrop/core';
import { collectSecrets, fromHar, maskExchanges, toHar, type Har } from '@tooldrop/compiler';
import { formatIssues } from '@tooldrop/llm';

// Uploaded recordings (SPEC, POST /v1/recordings), kept as files in the data
// directory until a build uses them: `<data>/recordings/<id>.json`.

export function writeRecording(dataDir: string, input: unknown): { id: string; recording: Recording } {
  const parsed = recordingSchema.safeParse(input);
  if (!parsed.success) {
    const problems = formatIssues(parsed.error.issues);
    throw new ToolDropError('invalid_input', `not a valid recording: ${problems.slice(0, 3).join('; ')}`, {
      details: { problems },
    });
  }
  const recording = parsed.data.har ? { ...parsed.data, har: maskHar(parsed.data.har) } : parsed.data;
  const id = newId();
  mkdirSync(join(dataDir, 'recordings'), { recursive: true });
  writeFileSync(join(dataDir, 'recordings', `${id}.json`), JSON.stringify(recording));
  return { id, recording };
}

export function readRecording(dataDir: string, id: string): Recording {
  const path = join(dataDir, 'recordings', `${id}.json`);
  // The ID becomes part of a path, so only real IDs are looked up.
  if (!idSchema.safeParse(id).success || !existsSync(path)) {
    throw new ToolDropError('not_found', `no recording ${id}`);
  }
  return recordingSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Recorders mask their HAR; it is masked again here, so no cookie or token is ever kept. */
function maskHar(har: Record<string, unknown>): Record<string, unknown> {
  const log = har.log as { entries?: unknown } | undefined;
  if (!Array.isArray(log?.entries)) {
    throw new ToolDropError('invalid_input', 'the recording har has no log.entries');
  }
  let masked: Har;
  try {
    const exchanges = fromHar(har as unknown as Har);
    masked = toHar(maskExchanges(exchanges, collectSecrets(exchanges)), 0);
  } catch (error) {
    throw new ToolDropError('invalid_input', 'the recording har is not valid HAR 1.2', { cause: error });
  }
  return { log: masked.log };
}
