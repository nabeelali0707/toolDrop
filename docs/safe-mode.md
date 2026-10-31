# Safe mode

::: info Status
Since Phase 4, for write tools from tool files and community recipes; since Phase 5, also for write tools built from a recording.
:::

Tools that change something (submit a form, approve an invoice, cancel an order) have `write` authority. toolDrop never lets one act on its own: every call shows you what it will do first.

## When a write tool runs

1. **Preview.** The call fills in the form but does not submit it. It returns `approval_required` with an `approval_id` and a preview: the page, the button it will press, and each field with its value. MCP clients also get a screenshot of the filled form, and REST clients can fetch it.
2. **Approve or reject.** Decide with `approve_action` from your agent, with `POST /v1/approvals/:id` and `{"decision": "approve"}`, or with `tooldrop approvals approve <id>`. Approving makes the write at once and returns its result. Rejecting changes nothing.
3. **Record.** Every decision is kept: who decided and when, the inputs, the preview, a screenshot of the filled form, a screenshot of the page after the write, and how it went.

An approval is used once, and only for the tool version it previewed. After 24 hours, call the tool again for a fresh preview.

Add `"dry_run": true` to a call to see the preview without asking for an approval.

```sh
tooldrop run record_payment --input '{"invoice": "INV-1057", "amount": 100}'
tooldrop approvals                 # writes waiting for you
tooldrop approvals show <id> --screenshot form.png
tooldrop approvals approve <id>    # or: reject
tooldrop approvals --all           # the audit log
```

## Policies

A policy approves a tool's writes by itself when one input meets a condition, such as payments under $100:

```sh
tooldrop policies add record_payment --when "amount < 100"
```

The operators are `<`, `<=`, `>`, `>=`, `==` and `!=`. Over REST, policies live at `/v1/policies` and need an API key with access to every tool. Agents cannot set policies over MCP, so they cannot approve their own writes. Writes approved by a policy are recorded like any other, with the policy as the decider.

## Building a write tool

Do the submission once while recording, mark the confirmation the site shows after it with **Mark data**, then build with `--write`:

```sh
tooldrop record http://127.0.0.1:4102/payments/new --task "Record a payment" --out payment.json
tooldrop build http://127.0.0.1:4102/payments/new --task "Record a payment" --recording payment.json --write
```

Recording it does the task for real once, as you would by hand. The build then never submits: it turns the recording into steps, with the values you marked as inputs, the last click as the commit step, and the confirmation as the result. It checks every step before the submit with a preview, and the model only names and describes the tool. Over MCP and REST, a build with `"authority": "write"` needs a `recording_id`; a write is never built by exploring, since exploring could submit a form.

## Writing a write recipe

Mark the step that changes the site with `"commit": true`, usually the submit click. The preview runs every step before it; only an approved write runs it and the steps after it.

```json
{ "op": "click", "target": [{ "kind": "role", "role": "button", "name": "Record payment" }], "commit": true }
```

A write tool runs one plan, without a browser fallback: retrying a failed submit another way could submit twice. For the same reason, toolDrop does not repair write tools by itself. When something fails after the submit, the error says the write was submitted, so check the site before you try again.

## Good habits

- Build and test the read tools for a site first.
- Keep policies narrow and specific.
- Review `tooldrop approvals --all` from time to time.
