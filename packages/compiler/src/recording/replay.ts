import { recordingSchema, recordingUrl, ToolDropError, type Recording } from '@tooldrop/core';
import { CaptureSession, type Capture, type CaptureOptions } from '../capture/capture.ts';

/**
 * Replays a recording in a fresh browser and captures it (SPEC, Build
 * pipeline step 3, recording mode). No model is needed: the person already
 * showed the way, so this is the path that works best with local models.
 */
export async function replayRecording(recording: Recording, options: CaptureOptions = {}): Promise<Capture> {
  const session = await CaptureSession.start(recordingUrl(recording), options);
  try {
    // Action 0 is the start page, which start() has loaded.
    for (const action of recording.actions.slice(1)) {
      switch (action.kind) {
        case 'goto':
          await session.goto(action.url);
          break;
        case 'click':
          await session.click(await session.refFor(action.target));
          break;
        case 'fill':
          if (action.value === null) {
            throw new ToolDropError(
              'invalid_input',
              `the recording types a password into ${action.label}; signing in arrives with Phase 3`,
            );
          }
          await session.fill(await session.refFor(action.target), action.value);
          break;
        case 'select':
          await session.select(await session.refFor(action.target), action.value);
          break;
      }
    }
    for (const input of recording.inputs) session.markInput(input.action, input.name, input.description);
    await session.snapshot();
    if (recording.target) await session.markTarget(await session.refFor(recording.target.selector));
    return await session.finish();
  } catch (error) {
    await session.abort();
    throw error;
  }
}

/** A capture's actions, inputs and target as a recording, e.g. to keep what the explore agent did. */
export function toRecording(
  capture: Capture,
  options: { recorder: Recording['recorder']; task?: string },
): Recording {
  return recordingSchema.parse({
    version: 1,
    recorder: options.recorder,
    recorded_at: capture.started_at,
    ...(options.task !== undefined && { task: options.task }),
    actions: capture.actions,
    inputs: capture.inputs,
    ...(capture.target && { target: { selector: capture.target.selector, label: capture.target.label } }),
  });
}
