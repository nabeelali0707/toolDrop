# toolDrop decisions

What was decided while turning [SPEC.md](SPEC.md) into a build, and why. SPEC.md stays the source of truth: when a decision changes the spec, the spec is edited too.

- **Accepted**: in force.
- **Proposed**: what the build does unless you say otherwise. Each one is cheap to reverse.
- **Open**: needs your answer before the task named.

## Open questions

### Q-1 Which library reads the OS keychain?

*Open · needed before task 3.1*

SPEC names `keytar`, but [keytar](https://github.com/atom/node-keytar) was archived when the Atom organization was sunset and gets no more fixes, security fixes included. [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring) (MIT, actively maintained) covers the same OS stores: macOS Keychain, Windows Credential Manager and the Linux Secret Service.

Recommendation: use `@napi-rs/keyring`, and change SPEC's tech stack to match.

## Accepted

### D-001 Project name

*Accepted · 2026-10-26 · from you*

The project is **toolDrop** (no longer "Webforge"). Lowercase `tooldrop` is used where case matters or lowercase is the convention: the CLI command, the npm scope `@tooldrop/*`, the `TOOLDROP_` prefix for environment variables and the `~/.tooldrop` data directory.

### D-002 Zero-cost rule, and how CI enforces it

*Accepted · 2026-10-26 · from you*

Everything toolDrop needs must be OSI-licensed or free to self-host, and no feature may need a paid plan or a paid API key (SPEC, Zero-cost rule).

The license part is enforced in CI (task 0.4) by a script over `pnpm licenses list --json`, which covers dev dependencies too:

- **Allowed:** OSI-approved permissive licenses (MIT, MIT-0, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0, Zlib, Python-2.0, Unlicense, MPL-2.0), plus CC0-1.0, a public-domain dedication that the OSI never approved but that sets no conditions at all.
- **Allowed per package after review**, listed in `license-policy.json` with a reason: LGPL, and free non-software licenses such as CC-BY-4.0 on data packages.
- **Fails:** GPL and AGPL, which cannot ship inside an Apache-2.0 package (D-027); a missing, `UNKNOWN` or `UNLICENSED` license; any custom or commercial one.
- SPDX expressions: `A OR B` passes if either passes; `A AND B` needs both.

Services and model weights are outside the script's reach, so each one is checked by hand when added and recorded here (e.g. D-004).

### D-003 Local models through Ollama

*Accepted · 2026-10-26 · from you*

- All model calls go through `LlmProvider` in `packages/llm`. The default adapter is the official `ollama` npm client (MIT).
- Two roles, each set in config: `code` uses `qwen2.5-coder:7b` (Apache-2.0) for recipes and heal patches; `reasoning` uses `llama3.1:8b` for exploration, questions, classification and descriptions.
- 7B is the default because it runs on 8 GB of RAM. With 16 GB or more, set `code` to `qwen2.5-coder:14b` for better recipes (Ollama's sizing guidance).
- Jobs pass a long `keep_alive` (30 minutes) so Ollama does not unload a model between calls; its default unloads after 5 idle minutes.
- The OpenAI-compatible adapter uses plain `fetch` (no SDK dependency) and is optional; no feature or test may need it. Its API key lives in the vault once the vault exists (task 3.12); before that it is passed in memory and never written to disk.

### D-004 Llama 3.1 is free to self-host but not OSI-licensed

*Accepted · 2026-10-26 · from you, with a note*

`llama3.1:8b` uses the [Llama 3.1 Community License](https://github.com/meta-llama/llama-models/blob/main/models/llama3_1/LICENSE). It meets the zero-cost rule through "self-hostable at zero cost", but it is not an OSI-approved license. Terms that matter here:

- Use must follow Meta's Acceptable Use Policy. Products with more than 700 million monthly users need a separate license from Meta.
- Anyone who distributes the weights, or a product that contains them, must include a copy of the license and a "Notice" file, and display "Built with Llama".

toolDrop never bundles weights: users pull them with Ollama, so the distribution terms do not apply to toolDrop itself. If you would rather use only OSI-licensed models, `qwen2.5:7b` (Qwen2.5-7B-Instruct, Apache-2.0) can take the `reasoning` role with a config change.

### D-005 Strict JSON and retries

*Accepted · 2026-10-26 · from you, with an interpretation*

- "Validate and retry (up to 3 times)" means one call plus up to 3 retries: at most 4 calls.
- The Zod schema is converted with `z.toJSONSchema` and passed as Ollama's `format`, which [constrains generation](https://ollama.com/blog/structured-outputs) to that schema. `format: "json"` alone does not enforce a schema, so it is not used.
- Each retry adds the Zod issues (path and message) to the prompt, shortened to fit the token budget.
- Temperature 0 and a fixed seed (configurable), for repeatable replies.
- These retries happen inside one model call. They are separate from the build's 3 validation attempts (pipeline step 9) and the healer's 3 patch attempts.

### D-006 Prompt budgets

*Accepted · 2026-10-26 · from you, with details*

- Budget of 6,000 prompt tokens with `num_ctx` set to 8,192 on every call, leaving about 2,000 tokens for the reply.
- Tokens are estimated at 3 characters per token, which is conservative for JSON and code and needs no tokenizer dependency. Ollama reports the real count (`prompt_eval_count`), and it is logged, so the ratio can be tuned from data.
- A prompt over budget is pruned harder: fewer HAR candidates, a smaller accessibility tree, shorter samples. If it still does not fit, the step fails with a clear error. Prompts are never cut silently.

### D-007 Recording first; a budget for agent mode

*Accepted · 2026-10-26 · from you, with details*

Recording mode is the default path. Agent mode runs only without a recording, with a budget of 30 actions; when it cannot reach the data, the job asks the caller for a recording instead of exploring further.

### D-008 SMS codes from the user's own phone

*Accepted · 2026-10-26 · from you, with details*

- The documented forwarder is [SMS to URL Forwarder](https://github.com/bogkonstantin/android_income_sms_gateway_webhook) (MIT). It installs from F-Droid or GitHub releases; it is not on Google Play, whose SMS-permission policy does not cover it. It allows plain HTTP (its manifest sets `usesCleartextTraffic`), which a LAN address needs. It filters by sender, retries with backoff, and signs the body with HMAC-SHA256 in `X-Signature`.
- Its signature carries no timestamp, so the webhook drops messages received more than 5 minutes ago, and duplicates.
- Other forwarders work through a field mapping. One example is [SMS Gateway for Android](https://docs.sms-gate.app) (Apache-2.0), whose docs ask for an HTTPS webhook receiver (self-signed certificates allowed), which is more setup on a LAN.
- In local mode the LAN listener runs only while SMS 2FA is enabled, and serves only the SMS route.
- Codes live in memory (local) or in Valkey (self-hosted) for at most 5 minutes. Message text is never logged.

### D-009 Where the master key comes from

*Accepted · 2026-10-26 · from you, with details*

- **Local:** an OS keychain entry (service `tooldrop`, account `master-key`). The library is still to be confirmed (Q-1).
- **Self-hosted:** a file holding 32 random bytes in base64. It is mounted as a Compose secret at `/run/secrets/tooldrop_master_key`; the path can be changed with `TOOLDROP_KEY_FILE`, which takes a path, never the key itself.
- On POSIX, the app refuses to start if the key file is readable by group or others.
- `tooldrop init` generates the key into the keychain or the file.
- Headless Linux without a Secret Service (servers, CI) uses the key file even in local mode.
- Key rotation is out of scope for the MVP.

### D-010 Valkey, pinned to 8.1

*Accepted · 2026-10-26 · from you, with details*

- Compose uses `valkey/valkey:8.1`. BullMQ's [compatibility page](https://docs.bullmq.io/guide/redis-tm-compatibility) lists Redis 6.2+ and Dragonfly as regularly tested. BullMQ's own benchmarks run on Valkey 8.1 and 9.0, and found 9.0 about 11% slower on AMD machines ([details](https://bullmq.io/highlights/valkey-9-regression/)), so 8.1 until that changes.
- BullMQ connects through `ioredis` (MIT), which works with Valkey unchanged.
- CI runs the queue tests against a real Valkey (task 5.2), so an incompatibility shows up there.

### D-011 Local and external model endpoints

*Accepted · 2026-10-26 · from you, with details*

- **Local** means loopback (`localhost`, `127.0.0.0/8`, `::1`) or the Compose hosts `ollama` and `host.docker.internal`. Anything else is **external**.
- Ollama cloud models (tags ending in `cloud`) count as external even though the local Ollama serves them.
- **Masking, always on:** credentials, cookies, tokens, CSRF values and session IDs become stable placeholders such as `{{session.csrf}}`, so the model still sees where they go.
- **PII redaction:** emails, phone numbers and long numeric IDs. Forced on for external endpoints; off by default for local ones, and can be switched on.
- When an external endpoint is configured, `tooldrop init` and the dashboard say that prompts leave the machine.

### D-012 Self-host only

*Accepted · 2026-10-26 · from you, with details*

- No managed cloud version.
- Docker Desktop is not required. Docker Engine with Compose (Linux or WSL2) and Podman both work; so do Rancher Desktop and Colima. Docker Desktop needs a [paid subscription](https://www.docker.com/pricing/faq/) in companies with more than 250 employees or more than $10 million in annual revenue.
- Scripts, CI and images set `NEXT_TELEMETRY_DISABLED=1`, `TURBO_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1`.

### D-013 Token and duration logging instead of cost

*Accepted · 2026-10-26 · from you*

- A new `llm_calls` table holds one row per model call: job, provider, model, role, prompt and completion tokens, duration, attempt and whether the output validated. Job totals are summed from it.
- `runs.llm_cost_usd` is gone. A run that waited on a heal links to it through `runs.heal_job_id`.

### D-014 What "Phase 2" and "Phase 3" mean in SPEC's feature table

*Accepted · 2026-10-26 · interpretation*

SPEC uses "Phase" for two different things. In the Differentiating features table, "Phase 2" and "Phase 3" are product releases after the MVP. In the roadmap they are build phases, and all of those features fall under "Phase 5 and later". PLAN.md follows the roadmap.

### D-015 SQLite locally, Postgres when self-hosted

*Accepted · 2026-10-26 · as SPEC says*

SQLite (better-sqlite3, in WAL mode) locally; Postgres when self-hosted (task 5.1).

PGlite (Postgres compiled to WebAssembly, Apache-2.0) was considered, because it would mean one SQL dialect everywhere. It was rejected because PGlite is single-connection: one process at a time can open a database. Local mode has several processes sharing one: the stdio MCP server that an MCP client starts, `tooldrop serve` and the CLI. SQLite in WAL mode handles that.

The cost is a second Drizzle schema for Postgres in 5.1. To keep it small, the schema from task 0.9 uses only portable column types (text ULIDs, JSON stored as text, integer millisecond timestamps, no SQLite-only features), and a parity test checks that both schemas match.

Two more notes:

- Enum columns get CHECK constraints built from the same constants as the Zod enums in `core`, so the database and the API cannot disagree on the allowed values.
- On the Windows development machine, better-sqlite3 compiled from source during install, because no prebuilt binary was used for Node 24, so that setup needs a C++ toolchain. Node's built-in `node:sqlite` would remove the native build, and Drizzle supports it from 1.0, which is still a release candidate. Revisit once Drizzle 1.0 is stable.

### D-027 toolDrop is Apache-2.0

*Accepted · 2026-10-26 · from you (answers Q-2)*

The project is licensed under Apache-2.0 (`LICENSE`), and every `package.json` declares `"license": "Apache-2.0"`. Apache-2.0 is permissive and adds an explicit patent grant, which matters for a tool that companies may run internally.

Consequence for dependencies (D-002): GPL and AGPL packages are rejected, because a published Apache-2.0 bundle cannot include them. LGPL needs review, and MPL-2.0 and the permissive licenses stay allowed.

## Proposed

Choices made while updating the spec (D-016 to D-021) and while building Phase 0 (D-022 to D-026). Each one is easy to undo, so say no to any you disagree with. All are already reflected in SPEC.md and PLAN.md, except D-020, which changes SPEC only once you agree.

### D-016 A CLI recorder in Phase 2

*Proposed · 2026-10-26*

`tooldrop record` opens a headed Playwright browser and records clicks, inputs and network traffic in the same format as the extension (task 2.9). SPEC says to prefer recording mode, but the extension only arrives in Phase 4, after the build pipeline. With the CLI recorder, Phase 2 builds and tests recording mode first, the path that works best with local models. One limit: it uses a fresh browser profile, so sites that block automated browsers still need the extension.

### D-017 The extension installs unpacked

*Proposed · 2026-10-26*

Publishing to the Chrome Web Store needs a [one-time registration fee](https://developer.chrome.com/docs/webstore/register), so the documented install is "load unpacked" from the build output. A store listing stays optional.

### D-018 No captcha solver plugin

*Proposed · 2026-10-26*

The original spec allowed an optional solver plugin, but solver services are paid, which the zero-cost rule forbids. Captchas always go to a human.

### D-019 CI without real models

*Proposed · 2026-10-26*

- CI runs on GitHub Actions, which is free for public repositories like this one (private ones get a monthly free allowance).
- CI never calls a model: LLM-dependent tests run on a fake provider that replays recorded replies.
- The same tests run against real Ollama models locally with `pnpm test:llm`. A nightly job with a small model on CPU can come later.

### D-020 Node 24, not Node 20

*Proposed · 2026-10-26*

SPEC says Node 20+, but Node 20 reached end-of-life on 2026-04-30 ([release schedule](https://github.com/nodejs/Release)). The build uses Node 24 LTS, supported until 2028-04-30 and already installed on the development machine: `engines.node` is `>=24`, `.nvmrc` says 24, and CI runs on 24. Node 26 becomes LTS on 2026-10-28 and joins CI once the native dependencies ship builds for it. If you agree, SPEC's "Node 20+" becomes "Node 24+".

### D-021 An `api_keys` table

*Proposed · 2026-10-26*

SPEC requires bearer API keys scoped per user and per tool, but its data model has no table for them. Task 1.11 adds `api_keys`: id, label, key_hash (SHA-256; a key is shown once, at creation), scopes (tool names, or `*`), last_used_at, revoked_at. Scoping per user waits for multi-user support (task 5.5).

### D-022 Repo conventions

*Proposed · 2026-10-26*

- Workspace packages are named `@tooldrop/<dir>`, are private (never published), ESM only, TypeScript strict with `NodeNext` module resolution.
- Tests: `*.test.ts` (unit), `*.e2e.test.ts` (end to end), `*.llm.test.ts` (real models, local only).
- The local data directory is `~/.tooldrop` (override with `TOOLDROP_HOME`). It holds the SQLite database, captures and config.

### D-023 ESLint, typescript-eslint and Prettier

*Proposed · 2026-10-26*

ESLint flat config with typescript-eslint's type-aware rules. Rules such as `no-floating-promises` use the real TypeScript type checker, which matters in code this asynchronous. Prettier formats code and config; Markdown is left hand-formatted.

TypeScript is pinned to `~6.0.3`: typescript-eslint 8.72 supports TypeScript below 6.1, so TypeScript 7 (the native port) waits until typescript-eslint supports it.

### D-024 Node runs the TypeScript sources; no build step

*Proposed · 2026-10-26*

Node 24 strips TypeScript types natively, without a flag or warning. Workspace packages export their `src/*.ts` files directly, and Node, Vitest and `tsc` all read those, so internal packages have no build step and no `dist/` to keep in sync.

- The cost is that code must be erasable: no `enum`, `namespace` or constructor parameter properties (`erasableSyntaxOnly` enforces it), type-only imports use `import type` (`verbatimModuleSyntax`), and relative imports name the `.ts` file.
- The dashboard (Next.js) and the extension (Vite) keep their own builds.
- Turborepo runs `typecheck` per package and caches it. Tests run once from the root with Vitest.

### D-025 Recipe format details

*Proposed · 2026-10-26*

SPEC gives the recipe envelope, an example and the op names. `packages/core` fills in the rest:

- **Derived values.** SPEC's traffic analysis classifies some fields as `derived` (taken from an earlier response, such as an ID), but its format has no way to carry them. Any step may `save` values, read later as `{{vars.<name>}}`. An `http` step saves JSONPaths from its response; a data step saves its output.
- **Template roots** are `site`, `input`, `session`, `loop` and `vars`. `{{loop.*}}` is valid only in the step that paginates with that variable, and `{{vars.*}}` only after an earlier step saved it.
- **Pagination** has two modes: page numbers (`start`, optional `step`) as in SPEC's example, or a cursor read from each response (`from`). Both stop on `until`, with a `max_pages` cap (default 50).
- **Results.** The data steps are `map`, `extract_table` and `extract_text`; a recipe returns what its last data step produced.
- **Ops per strategy.** `official_api` uses `http` and `map`. `http_replay` adds `extract_text`, to read a value out of a page, such as a CSRF token in a `<meta>` tag (`attribute: "content"`), before replaying the requests that need it. `html_fetch` uses `http`, `extract_table` and `extract_text`. Strategies without a browser accept only css or test_id selectors, because nothing can resolve roles or text. `browser_script` uses the browser ops and `map`.
- **Fallback.** A recipe may carry `fallback`, the `browser_script` version of the same tool. SPEC's cascade falls back to the browser, and the build validates both, so they are stored and versioned together and a heal updates them as one.
- **Browser lists.** `click` takes `repeat: { max }` to press a "Load more" button while it is visible. A `fill` or `select` whose value is an input the caller left out is skipped.
- Every object is strict: unknown keys fail validation, so a field the model invents is reported instead of silently dropped.

### D-030 How the runtime runs a call

*Proposed · 2026-10-26*

- **Rate limit as a token bucket.** SPEC's default of 1 request per second and 2 at once, applied strictly to every request, would put a two-request call (fetch a token, then the data) over one second, against the "under 1 second" criterion. The bucket allows bursts of up to 5 requests, then holds to 1 per second, so short calls are fast and long page loops stay polite.
- **Output types are coerced.** Strategies that read pages produce text, so outputs are coerced to the output schema's types: `"844.64"` becomes `844.64`. Every strategy then returns the same shape, and text that does not convert still fails validation.
- **An empty result is cross-checked.** SPEC says empty output counts as a failure, but a filter with no matches is a real answer. When the primary strategy returns nothing, the fallback runs too. If it finds data, the primary had silently broken and the fallback's data wins. If it is also empty, the primary's empty answer stands.
- **JSONPath never evaluates code.** `jsonpath-plus` runs with `eval: false`, which disables filter expressions. Its filters have had remote-code-execution bugs, and community recipes are untrusted.
- **Browser steps wait for the page's own requests.** After a navigation, click or select, the executor waits until the page has no requests in flight and has been quiet for 300 ms, at most 10 s. Playwright's "networkidle" state cannot be used after the first load: once reached, it never waits again.
- **Write tools are refused** with `approval_required` until safe mode exists (Phase 4).

### D-031 The engine package, and how MCP and REST expose tools

*Proposed · 2026-10-26*

- **`packages/engine`** holds what every interface calls: publish a tool file, find tools, run a tool by name and record the run. MCP is mounted inside the REST app at `/mcp`, so this logic cannot live in either app without a circular dependency. It matches the "Engine" layer in SPEC's architecture diagram, and builds, heals and watches join it in later phases.
- **One MCP tool per published tool,** advertised with its own input schema, an output schema for `{ result, meta }`, and `readOnlyHint` for read tools. Results come back as JSON text and as structured content, and errors as tool errors (`isError`) with `{ error: { code, message } }`, so the agent can read them.
- **Only working management tools are listed:** `find_tool` and `run_tool` today; `build_tool` and the others appear with their phases. Their names are reserved, so no published tool can shadow them.
- **Remote MCP is stateless** Streamable HTTP. Each request gets its own server, so there are no sessions to keep, and `list_changed` is pushed over stdio only. GET and DELETE on `/mcp` answer 405.
- **API keys carry scopes:** tool names, or `*`. A key sees and runs only its tools, over both REST and MCP. Local stdio clients get every tool, since they run on the user's own machine.
- **Errors have one shape:** `{ error: { code, message, details? } }`, with codes mapped to HTTP statuses: 400 bad input, 401 no key, 403 out of scope, 404 unknown tool, 409 approval needed, 502 when every strategy failed. Unexpected errors return a generic message, so internals never leak.

### D-026 Fixture switches simulate site changes

*Proposed · 2026-10-26*

The acceptance tests need sites that change under a published tool. Each fixture has switches that tests flip over HTTP (`POST /__fixture/switches`, `POST /__fixture/reset`), and each switch is a change a real site makes:

- **`apiMoved`** (JSON-API app): the search API moves from `/api/v2` to `/api/v3` and the old path answers 410. The page's own script follows the move, so the browser still works while replayed requests fail: the *Cascade* criterion. Simply turning the API off would also break the page, and the browser fallback would have nothing to fall back to.
- **`searchButtonRenamed`**, **`dateFilterMoved`** and **`columnsReordered`**: a renamed button, the date filter moved into a "Search options" panel (SPEC's own heal example), and table columns in a new order: the *Self-heal* criterion.
- The login fixture can expire every session, for the session-refresh half of *Login + 2FA*.

The test account and TOTP secret are fixture-only values. The TOTP secret is RFC 6238's published test secret, so it can never be mistaken for a real one.

### D-028 The community recipe library lives in this repository

*Proposed · 2026-10-26 · you asked for this decision to be made and recorded*

Community recipes live in `recipes/` in the main repository, not in a separate repo.

- **Why here:** CI validates each recipe against the exact recipe schema the runtime uses, in the same pull request. A separate repo would need a published, versioned copy of `@tooldrop/core` to validate against, and the two could drift. One repo also means one place to contribute and one set of rules.
- **When to split:** once recipe pull requests outnumber code pull requests, or the library needs its own maintainers. At that point, publish the recipe schema as a package and move `recipes/` out with its history.
- **Rules, enforced by `pnpm check:recipes`:**
  - Recipes are read-only, need no sign-in, and may only reach their manifest's site.
  - No credential-like header or query value unless it comes from a template.
  - No email addresses or phone numbers.
  - Every test input must match the input schema, and every `{{input.*}}` reference must be declared in it.
  - gitleaks scans the whole repository history on every push; the only allowlisted value is RFC 6238's public test secret.
- **Layout:** `recipes/<site host>/<tool name>/` with `manifest.json`, `recipe.json`, `schema.json`, `test-inputs.json` and `README.md`. The manifest schema lives in `@tooldrop/core` (`library.ts`), so the CLI can install recipes with the same definitions.

### D-029 Docs site, and the interfaces it promises early

*Proposed · 2026-10-26*

- **Site:** VitePress (MIT) in `docs/`, served from GitHub Pages at `https://nabeelali0707.github.io/toolDrop/`. Pull requests build it; pushes to `main` deploy it. The deploy is skipped, with a notice, until Pages is enabled in the repository settings, so pushes don't fail before then.
- **Status on every page:** most features are not built yet, so each page says which phase brings its feature. The docs describe the design in SPEC.md, not a promise of dates.
- **Interfaces the docs commit to, ahead of the code:**
  - `tooldrop serve` listens on `127.0.0.1:3000` for the REST API and the dashboard, and the Compose stack exposes the same port. This matches the `http://localhost:3000` in your release plan.
  - Webhooks carry `X-Tooldrop-Timestamp` and `X-Tooldrop-Signature: sha256=<hex>`, an HMAC-SHA256 over `timestamp + "." + body`. Receivers reject requests older than 5 minutes.

  Changing either before Phase 4 means updating the docs in the same pull request.
- **Recorder privacy policy** (`docs/privacy.md`) states the extension's design: it records only while recording and only the recorded tab, sends recordings only to the user's own server, keeps no analytics and does not keep typed passwords. Task 4.2 must meet it, and the Chrome Web Store listing links to it.
