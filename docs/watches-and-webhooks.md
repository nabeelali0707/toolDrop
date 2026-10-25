# Watches and webhooks

::: info Status
Planned for Phase 4. The webhook format below is the plan and may change before then.
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
- Each run diffs the result by `key_field` and sends `created`, `updated` and `deleted` events.
- MCP clients that support notifications receive the same events.

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
