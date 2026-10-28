// Stable error codes. Callers (MCP clients, REST users, the dashboard) branch
// on `code`, never on the message, so codes are only ever added, not renamed.
export const ERROR_CODES = [
  'invalid_input', // input does not match the tool's input schema
  'invalid_output', // a strategy returned data that does not match the output schema
  'not_found',
  'unauthorized', // missing or unknown API key
  'forbidden', // the key lacks the scope, or a write lacks authority
  'rate_limited',
  'strategy_failed', // every strategy in the cascade failed
  'session_expired', // the session expired and signing in again failed
  'approval_required', // safe mode: a write is waiting for approval
  'conflict', // the request no longer fits: an approval already decided or expired, or a tool changed since
  'heal_timeout', // the call waited 5 minutes and the heal did not publish
  'llm_invalid_output', // the model's reply failed its schema after every retry
  'llm_unavailable', // Ollama, or the configured endpoint, cannot be reached
  'llm_prompt_too_large', // a prompt stayed over its token budget after the most pruning
  'vault_unavailable', // the master key cannot be read, or a sealed value does not open
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ToolDropErrorJson {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class ToolDropError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ToolDropError';
    this.code = code;
    this.details = options.details;
  }

  /** The shape every API returns for an error. Never includes the cause. */
  toJSON(): ToolDropErrorJson {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

export function isToolDropError(error: unknown, code?: ErrorCode): error is ToolDropError {
  return error instanceof ToolDropError && (code === undefined || error.code === code);
}
