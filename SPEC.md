# toolDrop: Build Spec for Claude Code

Oct 26, 2026 · @nabeel ali

## Overview

toolDrop turns a task on any website into a deterministic, hosted API and MCP tool that AI agents can call. An LLM is used as a **compiler** (to build and repair tools), never as the **runtime** (to execute every request).

The product is inspired by [Pomerado](https://pomerado.ai) (YC, open source), which builds, hosts and self-heals website integrations. toolDrop is an independent implementation: write our own code, do not copy theirs. If any of their code is studied or reused, check their license first.

**Goals**

- A user describes a task ("list my supplier invoices by status and date") or records it once, and gets a typed tool back in minutes.
- Published tools run without an LLM: target 1 to 5 seconds per call via HTTP, under 15 seconds via browser.
- Tools repair themselves when the website changes, and the caller still gets a result.
- Go beyond Pomerado with recording by demonstration, website-to-webhook triggers and a safe mode for write actions (see Differentiating features).

## Assumptions and decisions

These defaults were chosen because the open questions were not answered yet. Change any of them before handing the doc to Claude Code.

| Decision | Choice | Why |
| --- | --- | --- |
| Language | TypeScript (Node 20+) | One language for runtime, MCP server, dashboard and extension |
| Browser engine | Playwright (Chromium) | Network interception, stable selectors, headless and headed |
| LLM | Anthropic Claude via a pluggable provider interface | Swap to OpenAI or local models later |
| Deployment | Local-first (single machine), cloud-ready | Privacy by default; Docker for hosting later |
| Storage | SQLite via Drizzle ORM, Postgres in cloud mode | Zero setup locally |
| Secrets | Encrypted vault (libsodium), key from OS keychain | Credentials never stored in plain text |
| MVP features | Core build/run/heal + recording + webhooks + safe mode | Highest value, clearest difference from Pomerado |
| Audience | Developers and small teams first | Enterprise features (SSO, audit) in a later phase |

## Core concepts

| Term | Meaning |
| --- | --- |
| Site | A website origin plus its sign-in configuration (e.g. `supplier.coupahost.com`) |
| Integration | A group of tools for one site, sharing one login |
| Tool | One typed operation, e.g. `list_invoices(status, from, to) -> Invoice[]` |
| Recipe | The compiled, deterministic program behind a tool: a list of steps, versioned |
| Strategy | How a recipe executes: `official_api`, `http_replay`, `html_fetch` or `browser_script` |
| Capture | Raw evidence from a build or recording: HAR network log, DOM snapshots, accessibility trees, user actions |
| Authority | What a tool may do: `read` or `write`. Write tools require explicit user approval to create |
| Session | Stored cookies/tokens for a site login, reused across calls |
| Heal | An LLM-driven repair of a failed recipe, producing a new tested version |
| Watch | A scheduled check of a tool's output that emits a webhook when the result changes |

## System architecture

The LLM sits only in the Compiler and Healer; every normal call goes through the Runtime with plain code.

&#91;embedded content: toolDrop architecture · 5 layers\]

Callers reach the engine through MCP or REST; the engine uses shared services to act on target websites.

- **Compiler** (`packages/compiler`): explores the site, analyzes traffic, writes and validates recipes.
- **Runtime** (`packages/runtime`): executes recipes through the strategy cascade, with session pooling and rate limits.
- **Healer** (`packages/healer`): repairs failed recipes and publishes new versions.
- **Watches** (`packages/watches`): schedules read tools, diffs results, delivers webhooks.
- **Vault + sessions** (`packages/auth`): encrypted credentials, login recipes, 2FA, session refresh.
- **Browser pool**: warm Playwright contexts per site, isolated per login.
- **LLM provider** (`packages/llm`): one interface for all model calls, PII redaction, cost logging.
- **Database** (`packages/db`): sites, tools, recipe versions, jobs, runs, watches, approvals.

## Build pipeline

A build turns a task description (or a recording) into a published, tested tool. It runs as an async job with a status the caller can poll.

1. **Intake.** Input is `{ url, task, authority, inputs_hint?, recording_id? }`. Check the registry for an existing tool on that site that already does the task (`find_tool`); reuse it if found.
2. **Sign in.** If the site needs a login, load credentials from the vault, run the site's login recipe (or build one), handle 2FA (see Authentication). Save the session.
3. **Explore and capture.** Launch Playwright with full network capture (request/response bodies, headers, timing). Either:
   - **Agent mode:** an LLM agent drives the page using the accessibility tree (not screenshots) plus a small action set: `click`, `fill`, `select`, `navigate`, `wait`, `extract`.
   - **Recording mode:** replay the user's recorded actions from the extension (no exploration needed).
4. **Clarify.** When the task is ambiguous (multiple accounts, optional fields, pagination limits), ask the caller a question and pause the job until answered. Questions and answers are stored on the job.
5. **Analyze traffic.** Rank captured requests by how well their responses contain the target data. For the best candidates, classify each request field as `constant`, `user_input`, `derived` (from an earlier response, e.g. an ID), `auth` (cookie, bearer, CSRF) or `pagination`.
6. **Pick a strategy.** Prefer, in order: `official_api` (known public API) > `http_replay` (internal JSON API) > `html_fetch` (server-rendered HTML + parser) > `browser_script` (Playwright steps). Pick the cheapest one that passes validation.
7. **Generate the recipe.** The LLM writes the recipe as a declarative JSON step list (see Data models), not free-form code. This keeps it diffable, safe to run and easy to heal.
8. **Infer schemas.** Generate JSON Schema for inputs and outputs from the task, the captured values and the extracted data. Add a description the agent can read.
9. **Validate twice.** Run the recipe with 2 to 3 different input sets via its chosen strategy **and** via `browser_script` as a reference. Outputs must match the schema and agree with each other. Fail = loop back to step 6 with the error, max 3 attempts.
10. **Publish.** Save the recipe as version 1, register the tool, expose it on MCP and REST. Return the tool name, schema and one sample result.

## Runtime execution cascade

Every tool call runs the cheapest working strategy first and falls back only on failure. No LLM is called on the happy path.

1. **Validate input** against the tool's JSON Schema. Reject bad input with a clear error.
2. **Check authority.** Write tools in safe mode return a preview and wait for approval (see Differentiating features).
3. **Get a session** from the session pool. If expired, re-run the login recipe silently.
4. **Run the primary strategy** (e.g. `http_replay` with a browser-like TLS fingerprint via `got-scraping` or similar).
5. **On failure, fall back** one level: `http_replay` → `browser_script`. Log which level answered.
6. **Validate output** against the output schema. Empty or malformed output counts as a failure.
7. **Still failing → heal.** Open a heal job (see Self-healing) and hold the call for up to 5 minutes; return the result when the heal publishes, else a structured error with the job ID.
8. **Return** `{ result, meta: { strategy, duration_ms, recipe_version, healed } }`.

**Performance rules**

- Keep a warm pool of browser contexts per site; reuse sessions instead of logging in per call.
- Per-site rate limits and concurrency caps (default 1 request/second, 2 concurrent).
- Optional response cache per tool with a TTL set at publish time (default off; never cached for write tools).
- Results are deleted after delivery, or after 60 minutes if never read.

## Authentication, credentials and 2FA

Credentials are optional: a caller may pass them per request, or save them in the vault for automatic sign-in.

- **Vault.** Credentials encrypted at rest with libsodium secretbox; the master key lives in the OS keychain (local) or a KMS (cloud). Values are never returned by any API, only masked previews.
- **Login recipe.** Each site has its own recipe, built like any tool, that ends in a verified signed-in state (a check such as "account menu visible" or "`/api/me` returns 200").
- **Sessions.** Cookies, local storage and bearer tokens are saved per login and refreshed on expiry. Detect expiry from 401/403, redirects to the login page, or a failed signed-in check.
- **2FA, in order of preference:**
  1. TOTP: store the authenticator secret, generate codes with `otplib`.
  2. Email OTP: read the code from a connected inbox (IMAP or Gmail API), matched by sender and time.
  3. SMS OTP: optional Twilio number that receives codes.
  4. Human in the loop: pause and ask the user for the code through MCP or the dashboard.
- **SSO / identity providers.** When a login redirects to another origin (e.g. Okta, Microsoft), ask the user once to approve that origin and record it on the site.
- **Captchas.** Do not auto-solve by default. Pause and ask the human; make a solver plugin optional and off.

## Self-healing maintenance

When a recipe fails, the system repairs only the failing step, tests the fix and publishes a new version, while the original call waits for the result.

1. **Detect.** Triggers: a runtime failure (selector not found, unexpected status, schema mismatch), a scheduled health check (daily, using saved test inputs), or a drift alert (output shape changed).
2. **Diagnose.** Re-run the recipe in a headed-capable browser with full capture up to the failing step. Give the LLM: the failing step, its last good capture, the new DOM / accessibility tree and new network traffic.
3. **Patch.** The LLM proposes a minimal change to the step list (a new selector, a moved field, a renamed API parameter). Prefer patches over rewrites.
4. **Test.** Run the saved test inputs against the patched recipe. All must pass and match the output schema.
5. **Publish or escalate.** Pass = new version, old version kept for rollback, original call completed. Fail after 3 attempts = mark the tool `degraded`, notify the owner, keep the call's error clear.

Every heal is logged with a human-readable reason, e.g. "Date filter moved into a new Search options panel", shown on the dashboard.

## Differentiating features

Three features ship in the MVP; the rest follow in later phases (see Roadmap).

| Feature | What it does | Phase |
| --- | --- | --- |
| Recording by demonstration | A Chrome extension (Manifest V3) records clicks, inputs and network traffic while the user does a task once. The build pipeline compiles it without LLM exploration: cheaper, faster, more accurate. Users mark which typed values are inputs. | MVP |
| Website to webhooks (Watches) | Turn any read tool into an event source: "notify me when a new invoice appears". A scheduler runs the tool on an interval (min 5 minutes), diffs results by a key field, and POSTs `created` / `updated` / `deleted` events to a webhook URL, signed with HMAC-SHA256. Also exposed as MCP notifications. | MVP |
| Safe mode for write actions | A write tool first returns a preview: the fields it will fill, the page it will submit, a screenshot of the filled form. Execution needs an approval token (from the user, or a policy such as "auto-approve under $100"). Every write is logged with before/after evidence. Dry-run flag on every write tool. | MVP |
| Transparency dashboard | Per tool: strategy used, p50/p95 latency, cost per call, success rate, heal history, version diff and one-click rollback. | Phase 2 |
| URL-first discovery | Give a URL only; the system crawls the signed-in site and proposes a catalog of possible tools to build. | Phase 2 |
| Multi-site workflows | Chain tools across sites into one tool (e.g. `onboard_employee` across HR, IT and email), passing data between steps, with retry and compensating actions on failure. | Phase 3 |
| Code export | Export any tool as a standalone TypeScript package that runs without toolDrop. No lock-in. | Phase 3 |
| Local-first privacy mode | Browser, vault and runtime run entirely on the user's machine; only LLM calls leave it, with PII redacted before sending. | MVP (default) |

## Data models

Core tables (Drizzle schema). IDs are ULIDs; all rows carry `created_at` and `updated_at`.

| Table | Key fields |
| --- | --- |
| `sites` | id, origin, name, login\_recipe\_id, approved\_auth\_origins\[\], rate\_limit, notes |
| `logins` | id, site\_id, label, encrypted\_secret (blob), twofa\_method (`totp` / `email` / `sms` / `human`), status (`verified` / `needs_attention` / `unchecked`) |
| `sessions` | id, login\_id, storage\_state (encrypted JSON), expires\_at, last\_verified\_at |
| `tools` | id, site\_id, name, description, authority (`read` / `write`), input\_schema, output\_schema, current\_version, status (`live` / `degraded` / `disabled`) |
| `recipe_versions` | id, tool\_id, version, strategy, steps (JSON), test\_inputs (JSON), created\_by (`build` / `heal` / `user`), change\_reason |
| `jobs` | id, kind (`build` / `heal` / `discover`), status, input, questions\[\], answers\[\], result, error |
| `runs` | id, tool\_id, recipe\_version, strategy\_used, duration\_ms, llm\_cost\_usd, ok, error\_code, healed |
| `watches` | id, tool\_id, inputs, interval\_s, key\_field, webhook\_url, secret, last\_snapshot\_hash |
| `approvals` | id, run\_id, preview (JSON + screenshot path), status (`pending` / `approved` / `rejected`), decided\_by |
| `captures` | id, job\_id, har\_path, dom\_snapshots\[\], ax\_trees\[\], actions\[\] |

**Recipe step format** (declarative, no arbitrary code):

```json
{
  "strategy": "http_replay",
  "steps": [
    { "op": "http", "method": "POST", "url": "{{site}}/api/v2/invoices/search",
      "headers": { "x-csrf-token": "{{session.csrf}}" },
      "body": { "status": "{{input.status}}", "from": "{{input.from}}", "page": "{{loop.page}}" },
      "paginate": { "until": "$.hasMore == false", "var": "page", "start": 1 } },
    { "op": "map", "path": "$.items[*]",
      "fields": { "number": "$.invoiceNo", "amount": "$.total.value", "status": "$.state" } }
  ]
}
```

Browser steps use the same envelope with ops such as `goto`, `click`, `fill`, `select`, `wait_for`, `extract_table`, `extract_text`. Selectors are stored as a ranked list (role + name, test id, text, CSS) so a heal can fall back before calling the LLM.

## MCP and REST interfaces

One MCP server (stdio for local clients, Streamable HTTP for remote) exposes two kinds of tools: fixed **management tools**, and one **dynamic tool per published integration tool**, refreshed via `tools/list_changed`.

**Management MCP tools**

| Tool | Purpose |
| --- | --- |
| `find_tool` | Search existing tools by site and task |
| `build_tool` | Start a build job: url, task, authority, optional recording\_id |
| `get_job` | Job status, pending questions, result |
| `answer_question` | Answer a build job's clarifying question |
| `run_tool` | Run any published tool by name with inputs |
| `approve_action` | Approve or reject a pending write preview |
| `create_watch` / `delete_watch` | Manage website-to-webhook watches |
| `list_logins` / `add_login` | Manage saved logins (values never returned) |

The MCP client is told to ask the user before calling `build_tool` with `authority: write`.

**REST API** (same operations, JSON, bearer API key)

```
POST   /v1/builds                 start a build
GET    /v1/jobs/:id               job status
POST   /v1/jobs/:id/answers       answer a question
GET    /v1/tools                  list tools
POST   /v1/tools/:name/run        run a tool
POST   /v1/approvals/:id          approve / reject
POST   /v1/watches                create a watch
POST   /v1/recordings             upload an extension recording
```

Every tool page in the dashboard shows its schema and a ready cURL example.

## Tech stack and repo structure

| Layer | Choice |
| --- | --- |
| Monorepo | pnpm workspaces + Turborepo |
| Runtime / API | Node 20, TypeScript strict, Fastify, Zod for schemas |
| MCP | `@modelcontextprotocol/sdk` (stdio + Streamable HTTP) |
| Browser | Playwright Chromium, HAR capture, `storageState` for sessions |
| HTTP replay | `got-scraping` (browser-like TLS/headers), `cheerio` for HTML |
| LLM | `@anthropic-ai/sdk` behind a `LlmProvider` interface |
| Jobs and scheduling | BullMQ + Redis in cloud; in-process queue + `node-cron` locally |
| Database | SQLite (better-sqlite3) local, Postgres cloud, Drizzle ORM |
| Secrets | libsodium, `keytar` for the OS keychain |
| Dashboard | Next.js + Tailwind + shadcn/ui |
| Extension | Chrome Manifest V3, TypeScript, Vite |
| Tests | Vitest, Playwright test, local fixture sites |

```
toolDrop/
  apps/
    server/        Fastify REST API + job workers
    mcp/           MCP server (stdio + HTTP)
    dashboard/     Next.js UI
    extension/     Chrome recorder
    cli/           `tooldrop` CLI (init, build, run, serve)
  packages/
    core/          types, Zod schemas, recipe format
    compiler/      explore agent, traffic analyzer, recipe generator, validator
    runtime/       executors per strategy, cascade, session pool
    healer/        diagnose, patch, test, publish
    auth/          vault, login recipes, 2FA providers
    watches/       scheduler, diffing, webhook delivery
    llm/           provider interface + Anthropic adapter, PII redaction
    db/            Drizzle schema + migrations
  fixtures/        small local test websites (JSON API, server-rendered, login + TOTP)
```

## Phased roadmap

Kept as text so it survives export to Markdown for Claude Code. Each phase ends with its own acceptance check before the next starts.

**Phase 0: Foundations**

- [ ] Monorepo, lint, typecheck, Vitest, CI
- [ ] `core` types, recipe format, Zod schemas; `db` schema + migrations
- [ ] Three fixture sites: a JSON-API app, a server-rendered HTML app, a login + TOTP app

**Phase 1: Run a hand-written recipe**

- [ ] Executors for `http_replay`, `html_fetch`, `browser_script`
- [ ] Cascade with fallback, session pool, rate limits
- [ ] MCP server exposing a hand-written recipe as a tool; REST `run`

**Phase 2: Build pipeline (MVP core)**

- [ ] Capture (HAR + accessibility tree), explore agent, traffic analyzer
- [ ] Strategy picker, recipe generator, schema inference, double validation
- [ ] Clarifying questions on jobs; `build_tool`, `get_job`, `answer_question`

**Phase 3: Auth and self-healing**

- [ ] Vault, login recipes, TOTP + human-in-the-loop 2FA, session refresh
- [ ] Healer: detect, diagnose, patch, test, publish; versioning + rollback

**Phase 4: MVP differentiators**

- [ ] Chrome recorder extension + recording-mode builds
- [ ] Watches: scheduler, diffing, signed webhooks, MCP notifications
- [ ] Safe mode: previews, approval tokens, policies, write audit log
- [ ] Minimal dashboard: tools, runs, logins, approvals

**Phase 5 and later**

- [ ] Transparency dashboard, URL-first discovery
- [ ] Multi-site workflows, code export
- [ ] Cloud mode: Postgres, Redis, Docker, multi-user, roles, audit logs

## Testing and acceptance criteria

All tests run against the local fixture sites, never against real third-party websites in CI.

| Area | Acceptance criterion |
| --- | --- |
| Build (JSON API fixture) | Task description → published tool using `http_replay` in under 3 minutes; tool call returns in under 1 second |
| Build (HTML fixture) | Falls back to `html_fetch` or `browser_script`; output matches schema on 3 input sets |
| Login + 2FA | TOTP fixture signs in unattended; expired session refreshes without failing the call |
| Cascade | Breaking the JSON endpoint makes the same call succeed via `browser_script`, with `meta.strategy` reported |
| Self-heal | Renaming a button or moving a field in a fixture: next call heals, publishes v2, and still returns a correct result |
| Rollback | Rolling back to v1 restores the old recipe exactly |
| Recording | A recorded session on a fixture produces a working tool with zero LLM exploration calls |
| Watches | Adding a row to a fixture emits exactly one signed `created` webhook within one interval |
| Safe mode | A write tool never submits without an approval; a rejected preview leaves the fixture unchanged |
| Security | No API, log or error ever contains a plain-text credential (tested by grep over logs) |
| MCP | Tools work from Claude Desktop/Claude Code via stdio and from a remote client via HTTP |

Unit-test the traffic analyzer, field classifier, recipe executor and differ in isolation with recorded HAR files.

## Security, legal and non-goals

**Security**

- Recipes are declarative JSON run by our executor; never `eval` LLM-written code. Browser steps run in an isolated context per login.
- Redact credentials, tokens and obvious PII (emails, phone numbers, IDs) from captures before they are sent to the LLM.
- Sign webhooks (HMAC-SHA256 with timestamp) and API keys scoped per user and per tool.
- Write tools need explicit authority at build time and approval at run time (safe mode).

**Legal and responsible use**

- Users are responsible for having the right to automate a site; show a notice to check the site's Terms of Service on each new site.
- Respect `robots.txt` for unauthenticated discovery crawls; enforce conservative default rate limits.
- Do not build features to bypass paywalls or access controls the user is not entitled to.
- toolDrop is an independent implementation inspired by Pomerado. Do not copy Pomerado's code, assets or branding; if any open-source code is reused, follow its license.

**Non-goals for the MVP**

- Automatic captcha solving
- Residential proxy networks
- Multi-tenant cloud billing
- Mobile apps or desktop (non-web) application automation

## Instructions for Claude Code

Paste this section as the first prompt, with the rest of the doc attached as `SPEC.md`.

```
You are building toolDrop from SPEC.md in this repo. Follow it strictly.

1. Read SPEC.md fully. Write PLAN.md: the phases from the roadmap broken into
   tasks of under 1 day each, with the files each task touches.
2. Work one phase at a time, in order. Do not start a phase until the previous
   phase's acceptance criteria pass.
3. Build the fixture sites in Phase 0 first, and test only against them.
4. Recipes are declarative JSON executed by our runtime. Never eval
   LLM-generated code.
5. Keep every LLM call behind packages/llm. Log token usage and cost per job.
6. After each phase: run lint, typecheck and all tests; update PLAN.md with
   what is done; commit with a clear message; then stop and summarise for me.
7. If the spec is ambiguous or a choice is costly to reverse, ask me before
   building. Record decisions in DECISIONS.md.
8. Never write real credentials to disk, logs or tests. Use the fixture's
   test accounts.
```

To hand this over, export the doc as Markdown, save it as `SPEC.md` in an empty folder, and open Claude Code there.
