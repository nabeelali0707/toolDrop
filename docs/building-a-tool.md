# Building a tool

::: info Status
Planned for Phase 2 (the build pipeline); signing in arrives with Phase 3.
:::

Ask your agent to build a tool, or call `build_tool` yourself. A build is a background job: it may pause to ask you a question, and it ends with a published, tested tool.

## What happens during a build

1. **Reuse first.** If a tool on the site already does the task, toolDrop returns it.
2. **Sign in.** With a saved login, toolDrop runs the site's login recipe and handles 2FA. See [Auth and 2FA](./auth-and-2fa).
3. **Capture.** It replays your [recording](./recording-mode) if there is one. Otherwise it explores the site with a step budget, and asks you for a recording if it cannot find the data.
4. **Clarify.** When the task is ambiguous (which account, how many pages), the job asks a question and waits for your answer.
5. **Analyze.** It ranks the captured requests by how much of the target data they return, and works out which request fields are constants, inputs, values from earlier responses, credentials or page numbers.
6. **Choose a strategy:** the cheapest one that works (see [Concepts](./concepts#strategies-cheapest-first)).
7. **Write the recipe.** The model writes the declarative steps as strict JSON, checked against the recipe schema and retried when it does not match.
8. **Describe it.** Input and output schemas, and a description your agent can read.
9. **Validate twice.** It runs 2 to 3 sets of inputs through the chosen strategy and through the browser, and the results must agree.
10. **Publish.** Version 1 goes live as an MCP tool and a REST endpoint.

## From your agent

The MCP server offers these management tools next to the tools you have built:

| Tool | Purpose |
| --- | --- |
| `find_tool` | Search existing tools by site and task |
| `build_tool` | Start a build: URL, task, authority, optional recording |
| `get_job` | Job status, pending questions and the result |
| `answer_question` | Answer a build's question |
| `run_tool` | Run a published tool by name |

Your agent should ask you before it builds a tool with `write` authority.

## Over REST

```sh
curl -X POST http://127.0.0.1:3000/v1/builds \
  -H "Authorization: Bearer $TOOLDROP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "http://127.0.0.1:4104", "task": "List my orders with status and delivery date", "authority": "read"}'
```

Then poll `GET /v1/jobs/:id`, and answer questions with `POST /v1/jobs/:id/answers`.

## Tips

- **Record when you can.** A recording gives the local model exactly what you did, which is faster and more reliable than exploring.
- **Name the data.** "List my orders with status and delivery date" builds a better tool than "orders".
- **Start read-only.** Build `write` tools once the read tools work, and keep [safe mode](./safe-mode) on.
