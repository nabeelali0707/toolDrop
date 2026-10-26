# toolDrop: Build Spec for Claude Code

Oct 26, 2026 · @nabeel ali

## Overview

toolDrop turns a task on any website into a deterministic, self-hosted API and MCP tool that AI agents can call. An LLM is used as a **compiler** (to build and repair tools), never as the **runtime** (to execute every request).

The product is inspired by [Pomerado](https://pomerado.ai) (YC, open source), which builds, hosts and self-heals website integrations. toolDrop is an independent implementation: write our own code, do not copy theirs. If any of their code is studied or reused, check their license first.

**Goals**

- A user describes a task ("list my supplier invoices by status and date") or records it once, and gets a typed tool back in minutes.
- Published tools run without an LLM: target 1 to 5 seconds per call via HTTP, under 15 seconds via browser.
- Tools repair themselves when the website changes, and the caller still gets a result.
- It costs nothing to run: local models by default, and no paid API, service or plan anywhere (see Zero-cost rule).
- Go beyond Pomerado with recording by demonstration, website-to-webhook triggers and a safe mode for write actions (see Differentiating features).

## Zero-cost rule

toolDrop must cost nothing to run, for every user and every feature.

- Every dependency (library, tool, model, container image, service) must be free and open source under an OSI-approved license, or self-hostable at zero cost.
- No feature may need a paid API or service. Optional integrations, such as an OpenAI-compatible API, are allowed only if every feature also works without them.
- **Never add a dependency or service that needs a paid plan or a paid API key to run any feature.**
- A dependency that is free but not OSI-licensed (e.g. the Llama 3.1 model weights) is recorded in DECISIONS.md with its license terms.
- CI checks the license of every package against an allowlist and fails on anything else.

What the spec uses instead of paid or non-free options:

| Instead of | toolDrop uses | Why |
| --- | --- | --- |
| A hosted LLM API (e.g. Anthropic Claude) | Local open-source models via Ollama | Paid per token, and prompts leave the machine |
| Twilio or another SMS service | The user's own Android phone with an open-source SMS forwarder app | Paid service |
| A cloud KMS | The OS keychain (local) or a key file mounted at runtime (self-hosted) | Paid cloud service |
| Redis | Valkey | Valkey keeps the BSD license; Redis moved off it in 7.4 |
| Managed cloud hosting | Self-hosting with Docker Compose | Paid |
| Captcha-solving services | Human in the loop | Paid |
| Ollama cloud models | Local models only | They run on ollama.com, have paid tiers, and prompts leave the machine |
| Docker Desktop | Docker Engine with Compose, or Podman | Needs a paid subscription in larger companies |
| Chrome Web Store publishing | Loading the extension unpacked | One-time registration fee |

## Assumptions and decisions

These defaults were chosen because the open questions were not answered yet. Change any of them before handing the doc to Claude Code.

| Decision | Choice | Why |
| --- | --- | --- |
| Language | TypeScript (Node 20+) | One language for runtime, MCP server, dashboard and extension |
| Browser engine | Playwright (Chromium) | Network interception, stable selectors, headless and headed |
| LLM | Local open-source models via Ollama (Qwen2.5-Coder for recipes and heals, Llama 3.1 8B for general reasoning), behind a pluggable `LlmProvider` interface | Free and private; an optional OpenAI-compatible adapter can plug in a free-tier or self-hosted API |
| Deployment | Local-first (single machine), or self-hosted with Docker Compose | Privacy by default; no paid cloud services |
| Storage | SQLite via Drizzle ORM locally, Postgres when self-hosted | Zero setup locally |
| Queue | In-process locally, BullMQ on Valkey when self-hosted | Valkey is the BSD-licensed Redis fork |
| Secrets | Encrypted vault (libsodium); master key from the OS keychain (local) or a mounted key file (self-hosted) | Credentials never stored in plain text; no cloud KMS |
| SMS 2FA | The user's own Android phone, with an open-source SMS forwarder posting to a local webhook | No paid SMS service |
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

```
Callers      AI agents (MCP) · apps and scripts (REST) · dashboard · CLI
Interfaces   MCP server (stdio + Streamable HTTP) · REST API (Fastify)
Engine       Compiler (LLM) · Runtime (no LLM) · Healer (LLM) · Watches
Services     Vault + sessions · Browser pool · LLM provider (Ollama) · Queue · Database
Targets      Websites: official APIs · internal JSON APIs · server-rendered HTML · browser UI
```

Callers reach the engine through MCP or REST; the engine uses shared services to act on target websites.

- **Compiler** (`packages/compiler`): explores the site, analyzes traffic, writes and validates recipes.
- **Runtime** (`packages/runtime`): executes recipes through the strategy cascade, with session pooling and rate limits.
- **Healer** (`packages/healer`): repairs failed recipes and publishes new versions.
- **Watches** (`packages/watches`): schedules read tools, diffs results, delivers webhooks.
- **Vault + sessions** (`packages/auth`): encrypted credentials, login recipes, 2FA, session refresh.
- **Browser pool**: warm Playwright contexts per site, isolated per login.
- **LLM provider** (`packages/llm`): one interface for all model calls (local Ollama by default), schema-checked JSON output with retries, PII redaction for external APIs, token and duration logging.
- **Queue**: runs build, heal and watch jobs; in-process locally, BullMQ on Valkey when self-hosted.
- **Database** (`packages/db`): sites, tools, recipe versions, jobs, runs, watches, approvals, LLM calls.

## Local LLM usage

Every model call goes through `packages/llm`. By default that means Ollama on the same machine (or on the Compose network), so builds and heals cost nothing and no prompt leaves the machine. Published tools never call a model, so if Ollama is down only builds and heals wait; tool calls keep working.

**Providers** (both behind the `LlmProvider` interface)

| Provider | When | Notes |
| --- | --- | --- |
| Ollama | Default, for every call | Official `ollama` npm client. `http://127.0.0.1:11434` locally, the `ollama` service under Docker Compose |
| OpenAI-compatible | Optional | Any `/v1/chat/completions` server: llama.cpp, vLLM, LM Studio, LocalAI, or a free-tier hosted API. Configured with a base URL, a model and an optional API key (kept in the vault). Nothing may require it: every feature and test must pass with Ollama alone |

**Default models** (set per role in config; `tooldrop init` checks that Ollama is running and pulls missing models)

| Role | Model | Used for |
| --- | --- | --- |
| `code` | `qwen2.5-coder:7b` (4.7 GB download, about 8 GB RAM), or `qwen2.5-coder:14b` (9 GB download, about 16 GB RAM) when the machine allows | Recipe generation and heal patches |
| `reasoning` | `llama3.1:8b` (4.9 GB download, about 8 GB RAM) | Agent exploration, clarifying questions, field classification, tool names and descriptions, heal reasons |

**Rules for local models.** They are weaker than hosted frontier models, so:

1. **Keep prompts small.** Send pruned accessibility trees and short HAR summaries, never screenshots or full HTML.
   - Accessibility tree: interactive and named nodes only (role, name, value and a stable ref), long text truncated.
   - HAR summary: only the top-ranked candidate requests (default 10), each as method, URL template, status, content type, request field names with short sample values, and the response's JSON shape (keys, types, one truncated sample). Never full bodies.
   - For `html_fetch` recipes: only the smallest DOM subtree that contains the target data, without scripts and styles, keeping only the `id`, `class`, `role`, `aria-*` and `data-testid` attributes, with text truncated.
   - Every prompt has a token budget (default 6,000). Set Ollama's context window (`num_ctx`) explicitly on every call, 8,192 by default: Ollama truncates prompts that do not fit instead of failing.
2. **Ask for strict JSON and validate it.** Every call that returns data names a Zod schema. The schema is converted to JSON Schema and passed as Ollama's `format` (constrained decoding), or as `response_format` to OpenAI-compatible servers that support it. The reply is parsed and validated with Zod. If validation fails, the call is retried with the validation errors, up to 3 times (4 calls at most); after that the job fails with the last error. These calls use temperature 0 and a fixed seed.
3. **Prefer recording mode over agent exploration wherever possible** (see Build pipeline, step 3). With a recording, the model labels and assembles what the user did instead of exploring.

**Usage logging.** Each call records its job, provider, model, role, prompt and completion tokens, duration, attempt number and whether the output validated (`llm_calls` table and the job log). Jobs show totals for tokens, duration, calls and retries. No cost is tracked.

**Privacy.** With local models nothing leaves the machine. Credentials, cookies and tokens are replaced with placeholders in every prompt, local or external, so they can never end up in a recipe or a log. When an external API is configured, PII (emails, phone numbers, IDs) is also redacted from everything sent to it, and this cannot be turned off. An endpoint counts as local only if it is on loopback or on the Compose network; anything else is external, and so are Ollama cloud models, even though they are called through the local Ollama.

## Build pipeline

A build turns a task description (or a recording) into a published, tested tool. It runs as an async job with a status the caller can poll.

1. **Intake.** Input is `{ url, task, authority, inputs_hint?, recording_id? }`. Check the registry for an existing tool on that site that already does the task (`find_tool`); reuse it if found.
2. **Sign in.** If the site needs a login, load credentials from the vault, run the site's login recipe (or build one), handle 2FA (see Authentication). Save the session.
3. **Explore and capture.** Launch Playwright with full network capture (request/response bodies, headers, timing). Either:
   - **Recording mode (preferred):** replay the user's recorded actions from the extension or `tooldrop record` (no exploration needed). Use it wherever possible: it is faster and far more reliable with local models.
   - **Agent mode (fallback):** only when there is no recording. An LLM agent (`reasoning` model) drives the page using the pruned accessibility tree (not screenshots) plus a small action set: `click`, `fill`, `select`, `navigate`, `wait`, `extract`. It has a step budget (default 30 actions); if it cannot reach the target data, the job asks the caller for a recording instead of exploring further.
4. **Clarify.** When the task is ambiguous (multiple accounts, optional fields, pagination limits), ask the caller a question and pause the job until answered. Questions and answers are stored on the job.
5. **Analyze traffic.** Rank captured requests by how well their responses contain the target data. For the best candidates, classify each request field as `constant`, `user_input`, `derived` (from an earlier response, e.g. an ID), `auth` (cookie, bearer, CSRF) or `pagination`. Only short HAR summaries reach the model (see Local LLM usage).
6. **Pick a strategy.** Prefer, in order: `official_api` (known public API) > `http_replay` (internal JSON API) > `html_fetch` (server-rendered HTML + parser) > `browser_script` (Playwright steps). Pick the cheapest one that passes validation.
7. **Generate the recipe.** The LLM (`code` model) writes the recipe as a declarative JSON step list (see Data models), not free-form code. This keeps it diffable, safe to run and easy to heal. The reply must validate against the recipe's Zod schema (see Local LLM usage).
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

- **Vault.** Credentials encrypted at rest with libsodium secretbox. The master key lives in the OS keychain (local) or in a key file mounted into the container at runtime (self-hosted, e.g. a Docker Compose secret); there is no cloud KMS. `tooldrop init` generates the key. It is never baked into an image, passed in an environment variable, logged or stored in the database. Values are never returned by any API, only masked previews.
- **Login recipe.** Each site has its own recipe, built like any tool, that ends in a verified signed-in state (a check such as "account menu visible" or "`/api/me` returns 200").
- **Sessions.** Cookies, local storage and bearer tokens are saved per login and refreshed on expiry. Detect expiry from 401/403, redirects to the login page, or a failed signed-in check.
- **2FA, in order of preference:**
  1. TOTP: store the authenticator secret, generate codes with `otplib`.
  2. Email OTP: read the code from a connected inbox (IMAP or Gmail API), matched by sender and time.
  3. SMS OTP: codes come from the user's own Android phone, through an open-source SMS forwarder app that posts to a local webhook (see below). No paid SMS service.
  4. Human in the loop: pause and ask the user for the code through MCP or the dashboard.
- **SSO / identity providers.** When a login redirects to another origin (e.g. Okta, Microsoft), ask the user once to approve that origin and record it on the site.
- **Captchas.** Do not auto-solve. Pause and ask the human. No solver plugin ships: solver services are paid, which the zero-cost rule forbids.

**SMS codes from the user's phone**

- The user installs an open-source SMS forwarder on their Android phone, e.g. [SMS to URL Forwarder](https://github.com/bogkonstantin/android_income_sms_gateway_webhook) (MIT, on F-Droid), and points it at `POST /v1/sms/inbound`.
- The forwarder's JSON template is set to `{"from":"%from%","text":"%text%","receivedStamp":"%receivedStamp%"}`. Other forwarders work through a configurable field mapping.
- Requests must be signed with a per-install secret: a hex HMAC-SHA256 of the body in `X-Signature` (what SMS to URL Forwarder sends), or a bearer token for forwarders that cannot sign. The secret is valid only for this endpoint. Anything else gets 401.
- The signature carries no timestamp, so messages received more than 5 minutes ago, and duplicates, are dropped.
- A login waiting for a code takes the first message from its expected sender that arrived after the code was requested, and extracts the code with the login's pattern (default: the first 4 to 8 digit number).
- Locally the server listens on loopback only, so turning on SMS 2FA opens a second listener on the LAN address that serves only this route. The phone must be on the same network, or reach it over the user's own VPN (e.g. WireGuard). Self-hosted, the route is part of the app's normal URL.
- The forwarder's sender filter should pass only 2FA senders. Message text is never logged or stored: only the extracted code is kept, in memory (local) or in Valkey (self-hosted), and deleted after use or after 5 minutes.

## Self-healing maintenance

When a recipe fails, the system repairs only the failing step, tests the fix and publishes a new version, while the original call waits for the result.

1. **Detect.** Triggers: a runtime failure (selector not found, unexpected status, schema mismatch), a scheduled health check (daily, using saved test inputs), or a drift alert (output shape changed).
2. **Diagnose.** Re-run the recipe in a headed-capable browser with full capture up to the failing step. Give the LLM (`code` model): the failing step, a summary of its last good capture, the new pruned accessibility tree and a short HAR summary of the new traffic. Never screenshots or full HTML (see Local LLM usage).
3. **Patch.** The LLM proposes a minimal change to the step list (a new selector, a moved field, a renamed API parameter), as JSON that must validate against the patch schema. Prefer patches over rewrites.
4. **Test.** Run the saved test inputs against the patched recipe. All must pass and match the output schema.
5. **Publish or escalate.** Pass = new version, old version kept for rollback, original call completed. Fail after 3 attempts = mark the tool `degraded`, notify the owner, keep the call's error clear.

Every heal is logged with a human-readable reason, e.g. "Date filter moved into a new Search options panel", shown on the dashboard.

## Differentiating features

Three features ship in the MVP; the rest follow in later phases (see Roadmap).

| Feature | What it does | Phase |
| --- | --- | --- |
| Recording by demonstration | A Chrome extension (Manifest V3) records clicks, inputs and network traffic while the user does a task once. The build pipeline compiles it without LLM exploration: cheaper, faster, more accurate. Users mark which typed values are inputs. `tooldrop record` captures the same recording in a Playwright browser. The extension installs unpacked; a Chrome Web Store listing is optional. | MVP |
| Website to webhooks (Watches) | Turn any read tool into an event source: "notify me when a new invoice appears". A scheduler runs the tool on an interval (min 5 minutes), diffs results by a key field, and POSTs `created` / `updated` / `deleted` events to a webhook URL, signed with HMAC-SHA256. Also exposed as MCP notifications. | MVP |
| Safe mode for write actions | A write tool first returns a preview: the fields it will fill, the page it will submit, a screenshot of the filled form. Execution needs an approval token (from the user, or a policy such as "auto-approve under $100"). Every write is logged with before/after evidence. Dry-run flag on every write tool. | MVP |
| Transparency dashboard | Per tool: strategy used, p50/p95 latency, LLM tokens and time spent on its builds and heals, success rate, heal history, version diff and one-click rollback. | Phase 2 |
| URL-first discovery | Give a URL only; the system crawls the signed-in site and proposes a catalog of possible tools to build. | Phase 2 |
| Multi-site workflows | Chain tools across sites into one tool (e.g. `onboard_employee` across HR, IT and email), passing data between steps, with retry and compensating actions on failure. | Phase 3 |
| Code export | Export any tool as a standalone TypeScript package that runs without toolDrop. No lock-in. | Phase 3 |
| Local-first privacy mode | Browser, vault, runtime and models (Ollama) run entirely on the user's machine; nothing leaves it. If an external API is configured, PII is redacted before anything is sent. | MVP (default) |

## Data models

Core tables (Drizzle schema). IDs are ULIDs; all rows carry `created_at` and `updated_at`.

| Table | Key fields |
| --- | --- |
| `sites` | id, origin, name, login\_recipe\_id, approved\_auth\_origins\[\], rate\_limit, notes |
| `logins` | id, site\_id, label, encrypted\_secret (blob), twofa\_method (`totp` / `email` / `sms` / `human`), twofa\_config (expected sender, code pattern), status (`verified` / `needs_attention` / `unchecked`) |
| `sessions` | id, login\_id, storage\_state (encrypted JSON), expires\_at, last\_verified\_at |
| `tools` | id, site\_id, name, description, authority (`read` / `write`), input\_schema, output\_schema, current\_version, status (`live` / `degraded` / `disabled`) |
| `recipe_versions` | id, tool\_id, version, strategy, steps (JSON), test\_inputs (JSON), created\_by (`build` / `heal` / `user`), change\_reason |
| `jobs` | id, kind (`build` / `heal` / `discover`), status, input, questions\[\], answers\[\], result, error |
| `runs` | id, tool\_id, recipe\_version, strategy\_used, duration\_ms, ok, error\_code, healed, heal\_job\_id |
| `llm_calls` | id, job\_id, provider, model, role (`code` / `reasoning`), prompt\_tokens, completion\_tokens, duration\_ms, attempt, ok, error\_code |
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
POST   /v1/sms/inbound            forwarded SMS from the user's phone (signed; no API key)
```

Every tool page in the dashboard shows its schema and a ready cURL example.

## Self-hosting

toolDrop is self-host only: there is no managed cloud version, and no setup uses a paid cloud service.

| Mode | How it runs | Database | Queue | Master key | Models |
| --- | --- | --- | --- | --- | --- |
| Local (default) | `tooldrop serve` on one machine | SQLite | In-process + `node-cron` | OS keychain | Ollama on the same machine |
| Self-hosted | `docker compose up`: `app`, `postgres`, `valkey`, `ollama` | Postgres | BullMQ on Valkey | Key file mounted as a Compose secret | The `ollama` service |

- One `app` image runs the REST API, the MCP server (Streamable HTTP), the job workers and the dashboard, with Playwright's Chromium. Volumes hold the Postgres data, Ollama models and captures.
- Model weights are pulled on first start, never baked into an image.
- Ollama on macOS: Docker has no access to the Apple GPU, so run Ollama natively, start only the app (`docker compose up app`), and point it at `http://host.docker.internal:11434` with `OLLAMA_HOST`. NVIDIA GPUs on Linux need the NVIDIA Container Toolkit, which is free.
- Any container runtime works: Docker Engine with Compose, or Podman. Docker Desktop is not required.
- For remote MCP or REST access over TLS, put the app behind your own reverse proxy (e.g. Caddy, with free Let's Encrypt certificates).
- No telemetry: toolDrop sends none, and the Next.js and Turborepo telemetry is turned off in scripts, CI and images.

## Tech stack and repo structure

| Layer | Choice | License |
| --- | --- | --- |
| Monorepo | pnpm workspaces + Turborepo | MIT |
| Runtime / API | Node 20, TypeScript strict, Fastify, Zod for schemas | MIT, Apache-2.0, MIT, MIT |
| MCP | `@modelcontextprotocol/sdk` (stdio + Streamable HTTP) | MIT |
| Browser | Playwright Chromium, HAR capture, `storageState` for sessions | Apache-2.0 (Chromium: BSD-3-Clause) |
| HTTP replay | `got-scraping` (browser-like TLS/headers), `cheerio` for HTML | Apache-2.0, MIT |
| LLM | Ollama via the `ollama` npm client, behind a `LlmProvider` interface; optional OpenAI-compatible adapter | MIT |
| Models | `qwen2.5-coder:7b` or `:14b`, `llama3.1:8b` | Apache-2.0; Llama 3.1 Community License (free to self-host, not OSI) |
| Jobs and scheduling | BullMQ + Valkey when self-hosted; in-process queue + `node-cron` locally | MIT, BSD-3-Clause, ISC |
| Database | SQLite (better-sqlite3) local, Postgres self-hosted, Drizzle ORM | Public domain, MIT, PostgreSQL License, Apache-2.0 |
| Secrets | libsodium, `keytar` for the OS keychain (local), mounted key file (self-hosted) | ISC, MIT |
| Dashboard | Next.js + Tailwind + shadcn/ui | MIT |
| Extension | Chrome Manifest V3, TypeScript, Vite | Apache-2.0, MIT |
| Self-hosting | Docker Compose: app, Postgres, Valkey, Ollama | Apache-2.0, PostgreSQL License, BSD-3-Clause, MIT |
| Tests | Vitest, Playwright test, local fixture sites | MIT, Apache-2.0 |

```
toolDrop/
  apps/
    server/        Fastify REST API + job workers
    mcp/           MCP server (stdio + HTTP)
    dashboard/     Next.js UI
    extension/     Chrome recorder
    cli/           `tooldrop` CLI (init, record, build, run, serve)
  packages/
    core/          types, Zod schemas, recipe format
    compiler/      explore agent, traffic analyzer, recipe generator, validator
    runtime/       executors per strategy, cascade, session pool
    healer/        diagnose, patch, test, publish
    auth/          vault, login recipes, 2FA providers, SMS webhook
    watches/       scheduler, diffing, webhook delivery
    llm/           provider interface, Ollama + OpenAI-compatible adapters, JSON validation, PII redaction
    db/            Drizzle schema + migrations
  fixtures/        small local test websites (JSON API, server-rendered, login + TOTP)
  compose.yaml     self-hosted stack: app + Postgres + Valkey + Ollama
  Dockerfile       app image
```

## Phased roadmap

Kept as text so it survives export to Markdown for Claude Code. Each phase ends with its own acceptance check before the next starts.

**Phase 0: Foundations**

- [ ] Monorepo, lint, typecheck, Vitest, CI
- [ ] License check in CI: fail on any dependency whose license is not on the allowlist (zero-cost rule)
- [ ] `core` types, recipe format, Zod schemas; `db` schema + migrations
- [ ] Three fixture sites: a JSON-API app, a server-rendered HTML app, a login + TOTP app

**Phase 1: Run a hand-written recipe**

- [ ] Executors for `http_replay`, `html_fetch`, `browser_script`
- [ ] Cascade with fallback, session pool, rate limits
- [ ] MCP server exposing a hand-written recipe as a tool; REST `run`

**Phase 2: Build pipeline (MVP core)**

- [ ] `llm` package: Ollama and OpenAI-compatible adapters, Zod-validated JSON with retries, prompt budgets, redaction, token and duration logging
- [ ] Capture (HAR + accessibility tree), recording-mode builds with `tooldrop record`, explore agent, traffic analyzer
- [ ] Strategy picker, recipe generator, schema inference, double validation
- [ ] Clarifying questions on jobs; `build_tool`, `get_job`, `answer_question`

**Phase 3: Auth and self-healing**

- [ ] Vault (key from the OS keychain or a mounted key file), login recipes, TOTP + human-in-the-loop 2FA, session refresh
- [ ] Healer: detect, diagnose, patch, test, publish; versioning + rollback

**Phase 4: MVP differentiators**

- [ ] Chrome recorder extension, producing the same recordings as `tooldrop record`
- [ ] Watches: scheduler, diffing, signed webhooks, MCP notifications
- [ ] Safe mode: previews, approval tokens, policies, write audit log
- [ ] Minimal dashboard: tools, runs, logins, approvals

**Phase 5 and later**

- [ ] Transparency dashboard, URL-first discovery
- [ ] Multi-site workflows, code export
- [ ] Email OTP (IMAP) and SMS OTP (phone forwarder webhook)
- [ ] Self-hosted mode: Docker Compose (app + Postgres + Valkey + Ollama), multi-user, roles, audit logs

## Testing and acceptance criteria

All tests run against the local fixture sites, never against real third-party websites in CI.

CI never calls a real model: LLM-dependent tests use a fake provider that replays recorded model replies. The same tests run against real Ollama models locally (and optionally in a nightly job). Build-time criteria assume the models run on a GPU or Apple Silicon; CPU-only machines work, but builds take longer.

| Area | Acceptance criterion |
| --- | --- |
| Build (JSON API fixture) | Task description → published tool using `http_replay` in under 3 minutes; tool call returns in under 1 second |
| Build (HTML fixture) | Falls back to `html_fetch` or `browser_script`; output matches schema on 3 input sets |
| Login + 2FA | TOTP fixture signs in unattended; expired session refreshes without failing the call |
| Cascade | Breaking the JSON endpoint makes the same call succeed via `browser_script`, with `meta.strategy` reported |
| Self-heal | Renaming a button or moving a field in a fixture: next call heals, publishes v2, and still returns a correct result |
| Rollback | Rolling back to v1 restores the old recipe exactly |
| Recording | A recorded session on a fixture produces a working tool with zero LLM exploration calls |
| LLM output | A reply that fails its Zod schema is retried with the validation errors, at most 3 times; a 4th failure fails the job with that error |
| Watches | Adding a row to a fixture emits exactly one signed `created` webhook within one interval |
| Safe mode | A write tool never submits without an approval; a rejected preview leaves the fixture unchanged |
| SMS 2FA | A signed forwarded SMS completes the login fixture's SMS sign-in; an unsigned, stale or duplicate one is rejected |
| Security | No API, log, error or LLM prompt ever contains a plain-text credential (tested by grep over logs and recorded prompts) |
| Privacy | With the default config, the only outbound connections go to the fixture sites and the local Ollama; with an external API configured, nothing sent to it contains fixture emails, phone numbers, tokens or passwords |
| Zero cost | On a clean machine with no API keys or paid accounts, `docker compose up` builds and runs a fixture tool end to end; the CI license check passes |
| MCP | Tools work from Claude Desktop/Claude Code via stdio and from a remote client via HTTP |

Unit-test the traffic analyzer, field classifier, recipe executor and differ in isolation with recorded HAR files, and the LLM retry loop with scripted replies.

## Security, legal and non-goals

**Security**

- Recipes are declarative JSON run by our executor; never `eval` LLM-written code. Browser steps run in an isolated context per login.
- Mask credentials and tokens in every prompt. Redact obvious PII (emails, phone numbers, IDs) from everything sent to an external API; for local models PII redaction is optional.
- Sign webhooks (HMAC-SHA256 with timestamp) and API keys scoped per user and per tool. Verify the signature on every forwarded SMS.
- Write tools need explicit authority at build time and approval at run time (safe mode).

**Legal and responsible use**

- Users are responsible for having the right to automate a site; show a notice to check the site's Terms of Service on each new site.
- Respect `robots.txt` for unauthenticated discovery crawls; enforce conservative default rate limits.
- Do not build features to bypass paywalls or access controls the user is not entitled to.
- toolDrop is an independent implementation inspired by Pomerado. Do not copy Pomerado's code, assets or branding; if any open-source code is reused, follow its license.
- Model weights keep their own licenses. toolDrop does not bundle weights; users pull them through Ollama. Llama 3.1 is under the Llama 3.1 Community License (see DECISIONS.md for its terms).

**Non-goals for the MVP**

- Automatic captcha solving
- Residential proxy networks
- A managed cloud service, or billing of any kind (toolDrop is self-host only)
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
5. Keep every LLM call behind packages/llm, and make every feature work with
   local Ollama models alone. Log token usage and duration per job.
6. After each phase: run lint, typecheck and all tests; update PLAN.md with
   what is done; commit with a clear message; then stop and summarise for me.
7. If the spec is ambiguous or a choice is costly to reverse, ask me before
   building. Record decisions in DECISIONS.md.
8. Never write real credentials to disk, logs or tests. Use the fixture's
   test accounts.
9. Never add a dependency or service that needs a paid plan or a paid API key
   to run any feature.
```

To hand this over, export the doc as Markdown, save it as `SPEC.md` in an empty folder, and open Claude Code there.
