import { z } from 'zod';

// Watches turn a read tool into an event source (SPEC, Differentiating
// features): run it on an interval, diff the result by a key field, and send
// each change to a webhook and to MCP clients.

/** Watches run at most every 5 minutes, to be gentle with the site. */
export const MIN_WATCH_INTERVAL_S = 300;
/** And at least every 30 days. */
export const MAX_WATCH_INTERVAL_S = 30 * 86_400;

/** What `create_watch` and `POST /v1/watches` take. */
export const createWatchSchema = z.strictObject({
  /** The read tool to run. */
  tool: z.string().min(1),
  /** Its inputs, the same on every run. */
  inputs: z.record(z.string(), z.unknown()).default({}),
  interval_s: z.number().int().min(MIN_WATCH_INTERVAL_S).max(MAX_WATCH_INTERVAL_S),
  /** The output field that tells rows apart, such as an invoice number. */
  key_field: z.string().min(1).max(100),
  webhook_url: z.url({ protocol: /^https?$/ }),
});
export type CreateWatch = z.input<typeof createWatchSchema>;

export const WATCH_EVENT_TYPES = ['created', 'updated', 'deleted'] as const;
export type WatchEventType = (typeof WATCH_EVENT_TYPES)[number];

/** One change, as a webhook body and as an MCP notification. */
export interface WatchEvent {
  /** Unique per event, so a receiver can drop a delivery it already has. */
  id: string;
  watch_id: string;
  tool: string;
  type: WatchEventType;
  /** The row's key field, as text. */
  key: string;
  /** The row as the tool returns it now. Deleted rows have none: watches keep no rows. */
  row?: Record<string, unknown>;
  /** ISO time of the run that found the change. */
  detected_at: string;
}

/** A watch as callers see it; its secret is shown once, when it is created. */
export interface WatchView {
  id: string;
  tool: string;
  inputs: Record<string, unknown>;
  interval_s: number;
  key_field: string;
  webhook_url: string;
  last_run_at: string | null;
  next_run_at: string | null;
  /** Why the last run or delivery failed, until one works. */
  last_error: string | null;
  created_at: string;
}
