# Multi-site workflows

::: info Status
Since Phase 5.
:::

A workflow chains published tools, on any sites, into one: `pay_newest_overdue` reads the newest overdue invoice from one system and records its payment in another. Your agent calls a workflow like any tool.

## A workflow file

```json
{
  "name": "pay_newest_overdue",
  "description": "Pay the newest overdue invoice from the invoices API in the payments portal.",
  "input_schema": {
    "type": "object",
    "properties": { "amount": { "type": "number" } },
    "required": ["amount"]
  },
  "steps": [
    { "id": "find", "tool": "list_invoices", "inputs": { "status": "overdue" } },
    {
      "id": "pay",
      "tool": "record_payment",
      "inputs": { "invoice": "{{steps.find.result.0.number}}", "amount": "{{input.amount}}" },
      "retries": 1
    }
  ],
  "output": { "invoice": "{{steps.find.result.0.number}}", "confirmation": "{{steps.pay.result}}" }
}
```

::: v-pre

- **Steps** run in order. Each calls a published tool by name.
- **Inputs** are plain values or templates: `{{input.amount}}` reads the workflow's input, and `{{steps.find.result.0.number}}` reads an earlier step's result, by dotted path. A template that is the whole value keeps its type; inside other text it becomes text.
- **`retries`** (0 to 3) tries a failing step again, after 1, 2 and 4 seconds. A rejected write is never retried.
- **`compensate`** names the tool that undoes a step, with its inputs, which may read that step's result. When a step fails for good, the steps already done are undone, newest first. One that cannot be undone is reported, and the others still run.
- **`output`** is the workflow's result; without it, the last step's result.

:::

toolDrop checks a workflow before saving it: every tool must be published, and a step may only read steps before it.

## Running one

```sh
tooldrop workflows add pay_newest_overdue.json
tooldrop workflows run pay_newest_overdue --input '{"amount": 120}'
```

A run is a job, like a build. Over MCP, each workflow is listed as a tool: calling it starts a run and returns its job, which your agent follows with `get_job`. Over REST: `POST /v1/workflows` saves one, and `POST /v1/workflows/:name/run` starts a run; follow it with `GET /v1/jobs/:id`.

## Writes in a workflow

A workflow whose steps or compensations change a site is a write workflow. Each write goes through [safe mode](./safe-mode), as any call does: a policy may approve it, or the run pauses on a question that shows the write's page, action and filled-in fields. Answer it in the terminal, on the dashboard's Questions page, with `answer_question`, or decide the approval itself on the Approvals page or with `approve_action`. Every write keeps its record in the audit log.

A run belongs to the process that started it, since it may wait long for an approval; it ends if that process stops.
