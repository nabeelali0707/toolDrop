# Watches and webhooks

::: info Status
Since Phase 4. Watches run while `tooldrop serve` or `tooldrop mcp` is running.
:::

A watch turns any read tool into an event source: "tell me when an order's status changes". toolDrop runs the tool on a schedule, compares the result with the last run by a key field, and sends a webhook for each change.

## Create a watch

From your agent, call `create_watch` with the tool, its inputs, an interval, the key field and your webhook URL. Over REST:

```sh
curl -X POST http://127.0.0.1:3000/v1/watches \
  -H "Authorization: Bearer $TOOLDROP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tool": "list_orders", "inputs": {}, "interval_s": 300, "key_field": "id", "webhook_url": "https://example.com/hooks/orders"}'
```

- The interval is at least 5 minutes, to be gentle with the site.
- The first run happens at once and is the baseline: it sends nothing, but it fails, saying why, when the tool fails or `key_field` does not tell the rows apart.
- Each later run diffs the result by `key_field` and sends one webhook for each `created`, `updated` or `deleted` row.
- The answer holds the watch and its signing `secret`. The secret is shown only this once, so keep it with your receiver.
- `GET /v1/watches` and `list_watches` show each watch with when it last ran and its last error. `DELETE /v1/watches/:id` and `delete_watch` stop one.
- MCP clients connected over stdio get the same events as log messages from the `tooldrop.watches` logger.

## What a webhook carries

```json
{
  "id": "01JC8V9X3QH2R6YQ2W1Z6T9KQ4",
  "watch_id": "01JC8V0A7E4B5S3F8N2P1M6R0D",
  "tool": "list_orders",
  "type": "created",
  "key": "ORD-2015",
  "row": { "order": "ORD-2015", "status": "processing", "total": 42.5 },
  "detected_at": "2026-10-28T12:05:00.000Z"
}
```

A deleted row comes with its `key` only: between runs, toolDrop keeps a hash of each row, never the rows themselves.

When your receiver does not answer with a 2xx status, toolDrop tries again after 1, 5 and 25 seconds, for timeouts, 408, 429 and 5xx answers. The tries carry the same event `id`, also in the `X-Tooldrop-Event` header. If every try fails, the next run finds the change again and sends it with a new `id`, so a change can arrive more than once: compare `key`, `type` and `row` to spot a repeat. Redirects are not followed.

## Verify webhooks

Every webhook is signed with HMAC-SHA256 using the watch's secret, over the timestamp and the raw body, so you can reject forged or replayed requests:

```
X-Tooldrop-Timestamp: 1793000000
X-Tooldrop-Signature: sha256=<hex of HMAC-SHA256(secret, timestamp + "." + body)>
```

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function isGenuine(secret, timestamp, body, signature) {
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!(age < 300)) return false; // older than 5 minutes: maybe a replay
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
```
