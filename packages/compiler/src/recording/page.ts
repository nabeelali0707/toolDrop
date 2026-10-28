// What the Chrome extension takes from the compiler: the code it injects into
// pages, and how a recording grows. Everything here is browser-safe.

export { installPageHelpers, type ElementInfo } from '../capture/page-helpers.ts';
export { addRecorderEvent, valueActions, type RecordingDraft } from './assemble.ts';
export { identifier, suggestedInputName } from '../names.ts';
export { installRecorder, RECORDER_BAR_ID, RECORDER_BINDING, type RecorderEvent } from './recorder-page.ts';
