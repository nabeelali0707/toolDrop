---
name: tooldrop
description: Turn a task on any website into a fast, typed tool with toolDrop, a free and local MCP server. Use when the user wants an agent to read data from a website or web app (orders, invoices, listings, dashboards, prices) more than once, to build a reusable tool for a site, to watch a page for changes, or to fill in a web form safely with approval. Covers setup, building tools, running them, sign-ins and 2FA, approvals for writes, watches and errors.
---

# toolDrop

toolDrop turns a task on a website into a tool. A local model builds the tool once; after that, every call runs as plain code in a few seconds, with no model involved. When the site changes, toolDrop repairs the tool and the call still returns a result.

Use toolDrop instead of driving a browser yourself when the user will need the same data again, or wants it fast and reliable. For a one-off look at a public page, a normal fetch is simpler.

## What this skill does on the user's machine

Tell the user this before you set anything up:

- It installs the `tooldrop` package from npm (Apache-2.0, https://github.com/nabeelali0707/toolDrop) and runs it locally.
- `tooldrop init` downloads a free local model through Ollama, and a Chromium browser through Playwright.
- toolDrop visits only the websites the user asks it to work on. Logins are encrypted on the user's machine, in `~/.tooldrop`.
- Nothing needs a paid service or API key.

## Setup

Needs Node.js 24 or newer (`node --version`) and Ollama (https://ollama.com/download) for building tools. Running finished tools does not need Ollama.

1. Run `npx -y tooldrop init`. It checks Ollama, picks a model that fits the machine and downloads it.
2. Add the MCP server:
   - Claude Code: `claude mcp add tooldrop -- npx -y tooldrop mcp`
   - Claude Desktop, Cursor and other clients: add to the client's MCP config, then restart it:
     ```json
     { "mcpServers": { "tooldrop": { "command": "npx", "args": ["-y", "tooldrop", "mcp"] } } }
     ```
3. Check it: the client should list `find_tool`, `build_tool` and the other toolDrop tools. If not, see [reference/troubleshooting.md](reference/troubleshooting.md).

## Workflow

1. **Look for an existing tool first.** Call `find_tool` with the site and the task. Every published tool is also listed as its own MCP tool: call it directly with its inputs.
2. **Sign-in, if the site needs one.** Call `list_logins` for the site. If there is none, ask the user to run `tooldrop logins add <site>` in their own terminal, so you never see the password. Use `add_login` only when the user gives you the credentials for that purpose.
3. **Build the tool.** Call `build_tool` with:
   - `url`: the page where the task starts;
   - `task`: what the tool returns, in plain words, e.g. "list my orders with status and delivery date";
   - `authority`: `"read"` unless the user asked for a tool that changes the site;
   - optional `inputs_hint`: which values should be inputs, e.g. "status and date range".
4. **Wait for the build.** It returns a job at once. Call `get_job` every 15 seconds until its status is `succeeded` or `failed`. A build takes one to a few minutes.
5. **Answer questions.** When the job's status is `waiting_for_answer`, read its question. Answer it yourself only when the answer is obvious from what the user said; otherwise ask the user, including any 2FA code. Then call `answer_question`.
6. **Use the tool.** When the job succeeds, it includes the new tool and sample results. Show the user the samples, then call the tool. Results come back as `{ result, meta }`; `meta.strategy` says how the call ran and `meta.healed` whether a repair happened.

To explore a site the user has not described yet, call `discover_tools` with one URL. It proposes tools; build the ones the user picks by passing each proposal's `url` and `task` to `build_tool`.

## Writes need the user's approval

A tool with authority `"write"` changes the site: it submits a form, places an order, posts a message. toolDrop never acts on a write at once.

- Always ask the user before building a write tool. A write build also needs a `recording_id`: the user records the task once with `tooldrop record <url>` or the toolDrop Chrome extension.
- Calling a write tool returns a preview (the fields it will fill and a screenshot) and an `approval_id`, as an `approval_required` error. Show the preview to the user.
- Call `approve_action` with `decision: "approve"` only after the user says yes. If they say no or are unsure, use `"reject"`. Never approve on your own.
- Pass `dry_run: true` to a write tool to see its preview without creating an approval.

## Watches

`create_watch` runs a read tool on a schedule (at least every 300 seconds) and POSTs each new, changed or removed row to a webhook. It needs the tool, its inputs, `key_field` (the field that tells rows apart, such as an order number) and `webhook_url`. The signing secret is shown once: tell the user to save it. Use `list_watches` and `delete_watch` to manage them.

## Rules

- Only build tools for sites the user has the right to automate. If the user is unsure, suggest they check the site's terms.
- Never ask for, store or repeat passwords, API keys or 2FA codes except to pass a value the user gave you to the tool that needs it.
- Do not build tools that get around paywalls, captchas or access controls. When a call fails with `human_needed`, the user must act in their own browser.
- Prefer read tools. Build write tools only when the user asks for one.

## Reference

- [reference/mcp-tools.md](reference/mcp-tools.md): every toolDrop MCP tool and its inputs.
- [reference/troubleshooting.md](reference/troubleshooting.md): error codes and what to do about each.
- Docs: https://nabeelali0707.github.io/toolDrop/
