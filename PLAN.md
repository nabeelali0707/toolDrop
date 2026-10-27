# toolDrop plan

The build plan for [SPEC.md](SPEC.md): each roadmap phase broken into tasks of under a day, with the files each task touches. Choices and open questions are in [DECISIONS.md](DECISIONS.md).

**Status:** Phases 0 and 1 done (2026-10-26); Phase 1 waits only on a manual MCP check in Claude Desktop or Claude Code. The open-source release track is partly done (below). Phase 2 is next.

**How this file works**

- Phases run in order. A phase is done when lint, typecheck and all tests pass and its gate criteria (from SPEC's acceptance table) pass.
- A task is checked off when it is committed to `main`. If a task turns out bigger than a day, split it here first.
- File lists are the plan, not a limit: a task may add small helpers next to the files it names.
- Conventions (D-022): packages are named `@tooldrop/<dir>`, ESM only, TypeScript strict. Unit tests sit next to the code as `*.test.ts`, end-to-end tests are `*.e2e.test.ts`, and tests that call real Ollama models are `*.llm.test.ts`, run locally with `pnpm test:llm` and never in CI (D-019).

## Phase 0: Foundations

- [x] **0.1 Workspace scaffold.** pnpm workspace (`apps/*`, `packages/*`, `fixtures/*`), Turborepo `typecheck` per package (lint and tests run once from the root, D-024), strict shared TypeScript config, Node 24 pin (D-020), telemetry off (D-012).
  Files: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.npmrc`, `.nvmrc`, `.gitignore`, `.editorconfig`
- [x] **0.2 Lint and format.** ESLint flat config with type-aware typescript-eslint rules (`no-floating-promises`, `no-misused-promises`) and Prettier (D-023).
  Files: `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `package.json`
- [x] **0.3 Test harness.** One root Vitest config covering every workspace package; `pnpm test` for CI, `pnpm test:llm` for real-model tests.
  Files: `vitest.config.ts`, `package.json`
- [x] **0.4 License check.** A script that reads `pnpm licenses list --json` and fails on any license outside the policy (D-002), with unit tests for the policy logic.
  Files: `scripts/check-licenses.ts`, `scripts/license-policy.ts`, `scripts/license-policy.test.ts`, `license-policy.json`
- [x] **0.5 CI.** GitHub Actions on push and pull request: frozen-lockfile install, format check, lint, typecheck, test, license check, pnpm store cache. Playwright Chromium joins with the first browser tests (Phase 1).
  Files: `.github/workflows/ci.yml`
- [x] **0.6 `core`: IDs, errors, shared types.** ULID helpers, `ToolDropError` with stable error codes, strategy and authority enums, JSON Schema type.
  Files: `packages/core/package.json`, `packages/core/src/{index,ids,errors,common}.ts`, tests
- [x] **0.7 `core`: recipe format.** Zod schemas for the recipe envelope, the `http`, `map` and `paginate` ops, the browser ops (`goto`, `click`, `fill`, `select`, `wait_for`, `extract_table`, `extract_text`), ranked selectors and `{{...}}` template references. SPEC's example recipe must parse.
  Files: `packages/core/src/recipe/{schema,ops,selectors,templates}.ts`, tests
- [x] **0.8 `core`: tool, job and run schemas.** Tool definition (name, description, authority, input and output JSON Schema), job kinds, states, questions and answers, and the run envelope `{ result, meta }`.
  Files: `packages/core/src/{tool,job,run}.ts`, tests
- [x] **0.9 `db`: schema.** Drizzle tables for every SPEC table (`sites`, `logins`, `sessions`, `tools`, `recipe_versions`, `jobs`, `runs`, `llm_calls`, `watches`, `approvals`, `captures`) with portable column choices: text ULIDs, JSON columns, integer timestamps. SQLite first; the Postgres schema follows in 5.1 (D-015).
  Files: `packages/db/package.json`, `packages/db/src/schema.ts`
- [x] **0.10 `db`: migrations and client.** drizzle-kit migration for the schema, connection factory, migration runner, and a round-trip test that writes and reads every table.
  Files: `packages/db/drizzle.config.ts`, `packages/db/migrations/*`, `packages/db/src/{client,migrate,index}.ts`, tests
- [x] **0.11 Fixture kit.** Shared helpers: start a fixture on a free port, seed invoices, switches that tests flip over HTTP (D-026), cookies and HTML. `pnpm fixtures` starts all three sites on ports 4101 to 4103 for manual testing.
  Files: `fixtures/kit/src/{index,server,switches,invoices,html}.ts`, `scripts/run-fixtures.ts`, tests
- [x] **0.12 Fixture: JSON-API app.** An invoice page whose script calls `POST /api/v2/invoices/search` (CSRF header, `hasMore` pagination), matching SPEC's example recipe. Switches: move the API to `/api/v3` so replayed requests break while the page keeps working (cascade test); rename the Search button and move the date filter (heal tests).
  Files: `fixtures/json-api/src/server.ts`, `fixtures/json-api/public/app.js`, tests
- [x] **0.13 Fixture: server-rendered HTML app.** An invoice table with query-string filters and pagination links. Switches: rename the button, move the date filter, reorder the columns.
  Files: `fixtures/html-app/src/server.ts`, tests
- [x] **0.14 Fixture: login + TOTP app.** Username and password, then a TOTP step (`otplib`), a session cookie, `/api/me`, a protected invoice page with an account menu, and a control that expires every session. The test account and TOTP secret exist only in the fixture.
  Files: `fixtures/login-totp/src/server.ts`, tests

**Gate:** lint, typecheck, tests and the license check pass locally and in CI; every fixture's own tests pass.

## Phase 1: Run a hand-written recipe

- [x] **1.1 `runtime`: templates and JSONPath.** Resolve `{{site}}`, `{{input.*}}`, `{{session.*}}`, `{{loop.*}}` and `{{vars.*}}`, keeping value types; JSONPath via `jsonpath-plus` with evaluation off (D-030).
  Files: `packages/runtime/package.json`, `packages/runtime/src/{templates,jsonpath}.ts`, tests
- [x] **1.2 `runtime`: safe conditions.** A small parser for `paginate.until` (`==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||`, parentheses, path against path). No `eval`.
  Files: `packages/runtime/src/conditions.ts`, tests
- [x] **1.3 `runtime`: `http_replay` executor.** The `http` op over `got-scraping` with a per-site cookie jar, page-number and cursor pagination, `map`, and page tokens read with `extract_text` (D-025).
  Files: `packages/runtime/src/executors/http.ts`, `packages/runtime/src/steps.ts`, tests against `fixtures/json-api`
- [x] **1.4 `runtime`: `html_fetch` executor.** Same executor: `cheerio` for `extract_table` (columns matched by header text, so reordering is harmless) and `extract_text`.
  Files: `packages/runtime/src/executors/http.ts`, tests against `fixtures/html-app`
- [x] **1.5 `runtime`: browser pool.** Warm Playwright contexts per site; Chromium starts on first use.
  Files: `packages/runtime/src/browser/pool.ts`
- [x] **1.6 `runtime`: `browser_script` executor.** All browser ops; ranked selectors tried in order; `click` with `repeat` for "Load more"; waits for the page's own requests after each action (D-030).
  Files: `packages/runtime/src/executors/browser.ts`, tests against fixtures
- [x] **1.7 `runtime`: session pool.** Cookie jars per site for HTTP, warm browser contexts per site; signing in again arrives in 3.5.
  Files: `packages/runtime/src/sessions.ts`
- [x] **1.8 `runtime`: cascade.** Input validation with defaults, authority check, primary strategy, browser fallback, output validation with type coercion, empty-result cross-check, `meta` and the list of attempts (D-030).
  Files: `packages/runtime/src/{runtime,validate}.ts`, `packages/runtime/src/runtime.e2e.test.ts`
- [x] **1.9 `runtime`: limits and cache.** Token bucket per site (1 request/second sustained, bursts of 5, 2 at once), optional TTL cache for read tools.
  Files: `packages/runtime/src/{limits,runtime}.ts`, tests
- [x] **1.10 `db`: repositories.** Sites, publishing tools as new versions, finding tools by site and task, recording runs (metadata only, never results), API keys stored as hashes; the `engine` package ties them to the runtime (D-031).
  Files: `packages/db/src/{repos,schema,client}.ts`, `packages/db/migrations/0001_*`, `packages/engine/src/*`, tests
- [x] **1.11 `server`: REST app.** Fastify app, bearer API keys (`api_keys` table, D-021) with scopes, `GET /health`, `GET /v1/tools`, `POST /v1/tools/:name/run`, one error shape mapped to HTTP statuses.
  Files: `apps/server/src/app.ts`, tests
- [x] **1.12 `mcp`: server.** `find_tool` and `run_tool`, one MCP tool per published tool (input schema, output schema, read-only hint), structured results, `tools/list_changed`; stdio, and stateless Streamable HTTP at `/mcp` in the REST app.
  Files: `apps/mcp/src/server.ts`, tests with the MCP SDK client
- [x] **1.13 Hand-written recipes.** `list_invoices` (JSON API with a browser fallback) and `search_invoices` (HTML with a browser fallback) in `fixtures/recipes`. `tooldrop tools add` publishes them, which replaced the planned seed script. End-to-end runs over REST, MCP over HTTP, MCP over stdio and the CLI.
  Files: `fixtures/recipes/*.json`, `apps/*/src/*.e2e.test.ts`
- [x] **1.14 `cli`: the `tooldrop` package.** `init`, `mcp`, `serve`, `run`, `tools`, `keys`; bundled with esbuild for npm (D-032). Added to this phase so the open-source release could start (see the release track below).
  Files: `apps/cli/*`, tests

**Gate:** *Cascade* and *MCP* criteria. Both pass in CI: the cascade falls back to the browser when the JSON API moves, with the same answer; MCP works over stdio and over HTTP from SDK clients. Still to do: the one-time manual check in Claude Desktop or Claude Code (yours).

## Phase 2: Build pipeline (MVP core)

- [x] **2.1 `llm`: provider and Ollama adapter.** The `LlmProvider` interface, the Ollama adapter (`ollama` npm client), per-call options (`num_ctx`, temperature, seed, `keep_alive`) and the `code` and `reasoning` model roles (D-003).
  Files: `packages/llm/package.json`, `packages/llm/src/{provider,ollama,config}.ts`, tests against a stub HTTP server
- [x] **2.2 `llm`: strict JSON.** `generateJson(schema, prompt)`: Zod to JSON Schema (`z.toJSONSchema`), passed as `format`; parse, validate, retry with the validation errors up to 3 times (D-005).
  Files: `packages/llm/src/json.ts`, tests
- [x] **2.3 `llm`: OpenAI-compatible adapter.** `fetch` against `/v1/chat/completions`; `response_format` with a JSON schema where supported, else plain JSON mode; same validation and retries.
  Files: `packages/llm/src/openai-compatible.ts`, tests against a stub server
- [x] **2.4 `llm`: masking and redaction.** Credentials, cookies and tokens become placeholders in every prompt; PII redaction for external endpoints; local versus external endpoint detection, including Ollama cloud models (D-011).
  Files: `packages/llm/src/{redact,endpoint}.ts`, tests
- [x] **2.5 `llm`: usage, budgets, fake provider.** `llm_calls` rows and per-job totals, prompt token estimate and budget check (D-006), and a fake provider that replays recorded replies for CI.
  Files: `packages/llm/src/{usage,budget,fake}.ts`, `packages/db/src/repos/{llm-calls,jobs}.ts` (the repositories moved into `repos/`), `packages/db/migrations/0002_*`, tests
- [x] **2.6 `compiler`: capture.** Playwright HAR with bodies, accessibility-tree and DOM snapshots and user actions, stored in the data directory and indexed in `captures`.
  Files: `packages/compiler/package.json`, `packages/compiler/src/capture/{capture,har,network,page-helpers,store}.ts`, tests against fixtures
- [x] **2.7 `compiler`: prompt builders.** Accessibility-tree pruner, HAR summarizer (URL templates, JSON shapes, truncated samples) and the HTML subtree pruner for `html_fetch`.
  Files: `packages/compiler/src/prompt/{ax-prune,har-summary,html-subtree,json-shape}.ts`, tests
- [x] **2.8 Recordings.** Recording format v1 (actions with ranked selectors, marked inputs, HAR), recording-mode replay into a capture, `POST /v1/recordings`.
  Files: `packages/core/src/recording.ts`, `packages/compiler/src/recording/replay.ts`, `packages/engine/src/recordings.ts`, `apps/server/src/app.ts`, tests
- [ ] **2.9 `cli`: `tooldrop record`.** A headed Playwright browser that records clicks, inputs and HAR, lets the user mark inputs at the end, then saves and uploads the recording (D-016).
  Files: `apps/cli/package.json`, `apps/cli/src/commands/record.ts`, `packages/compiler/src/recording/recorder.ts`, tests with a scripted session on a fixture
- [ ] **2.10 `compiler`: traffic analyzer.** Rank requests by how much target data they return; classify fields (`constant`, `user_input`, `derived`, `auth`, `pagination`) with heuristics first and the `reasoning` model only for leftovers.
  Files: `packages/compiler/src/analyze/{rank,classify}.ts`, tests with recorded HAR files
- [ ] **2.11 `compiler`: strategy picker and recipe generator.** Pick the cheapest viable strategy; the `code` model writes the recipe JSON, validated by the `core` recipe schema.
  Files: `packages/compiler/src/generate/{strategy,recipe,prompts}.ts`, tests with the fake provider
- [ ] **2.12 `compiler`: schemas.** Infer input and output JSON Schema from captured values; the `reasoning` model writes names and descriptions.
  Files: `packages/compiler/src/generate/schemas.ts`, tests
- [ ] **2.13 `compiler`: double validation.** Run 2 to 3 input sets via the chosen strategy and via `browser_script`, compare, and loop back to the strategy step at most 3 times.
  Files: `packages/compiler/src/validate/double.ts`, tests
- [ ] **2.14 `compiler`: explore agent.** The fallback when there is no recording: the `reasoning` model picks actions from the pruned accessibility tree, within a 30-action budget; when it gives up, the job asks for a recording (D-007).
  Files: `packages/compiler/src/explore/{agent,actions}.ts`, tests with the fake provider on fixtures
- [ ] **2.15 Jobs and build orchestration.** In-process queue, job states (`queued`, `running`, `waiting_for_answer`, `succeeded`, `failed`), clarifying questions that pause and resume, and the build steps 1 to 10 wired together.
  Files: `packages/core/src/job.ts`, `apps/server/src/jobs/{queue,build}.ts`, tests
- [ ] **2.16 Build interfaces.** MCP `build_tool`, `get_job`, `answer_question` and `find_tool`; REST `/v1/builds`, `/v1/jobs/:id`, `/v1/jobs/:id/answers`.
  Files: `apps/server/src/routes/{builds,jobs}.ts`, `apps/mcp/src/tools/{build,jobs,find}.ts`, tests
- [ ] **2.17 `cli`: `init`, `build`, `run`, `serve`.** `init` creates the data directory and config, checks that Ollama is running and pulls missing models.
  Files: `apps/cli/src/commands/{init,build,run,serve}.ts`, tests
- [ ] **2.18 End-to-end build tests.** Recorded model replies in CI; the same tests with real Ollama models via `pnpm test:llm`.
  Files: `apps/server/test/build.e2e.test.ts`, `apps/server/test/build.llm.test.ts`, `fixtures/llm-replies/*.json`

**Gate:** *Build (JSON API fixture)*, *Build (HTML fixture)*, *Recording* (with `tooldrop record`), *LLM output* and *Privacy* criteria.

## Phase 3: Auth and self-healing

- [ ] **3.1 `auth`: vault and master key.** libsodium secretbox; master key from the OS keychain (library per Q-1) or a mounted key file; `tooldrop init` generates the key (D-009).
  Files: `packages/auth/package.json`, `packages/auth/src/vault/{vault,keychain,key-file}.ts`, `apps/cli/src/commands/init.ts`, tests
- [ ] **3.2 `auth`: logins.** `add_login` and `list_logins` over MCP and REST, encrypted secrets, masked previews only.
  Files: `packages/auth/src/logins.ts`, `apps/server/src/routes/logins.ts`, `apps/mcp/src/tools/logins.ts`, tests
- [ ] **3.3 `auth`: login recipes.** Build and run a site's login recipe, verify the signed-in state, save the session.
  Files: `packages/auth/src/login-recipe.ts`, tests against `fixtures/login-totp`
- [ ] **3.4 `auth`: 2FA.** TOTP via `otplib`; human in the loop through a job question answered over MCP or REST.
  Files: `packages/auth/src/twofa/{index,totp,human}.ts`, tests
- [ ] **3.5 `auth`: session refresh.** Detect expiry (401/403, login redirect, failed check), re-login silently, hook into the runtime session pool.
  Files: `packages/auth/src/sessions.ts`, `packages/runtime/src/sessions/pool.ts`, tests
- [ ] **3.6 `healer`: detect.** Runtime-failure trigger, daily health check with saved test inputs, drift alert when the output shape changes.
  Files: `packages/healer/package.json`, `packages/healer/src/detect.ts`, `apps/server/src/jobs/health-check.ts`, tests
- [ ] **3.7 `healer`: diagnose.** Re-run up to the failing step with full capture; try the ranked-selector fallback before calling the model; build the diagnosis prompt (D-006).
  Files: `packages/healer/src/diagnose.ts`, tests
- [ ] **3.8 `healer`: patch, test, publish.** The `code` model returns a patch validated by a Zod patch schema; apply it, run the saved test inputs, publish or escalate after 3 attempts (`degraded`, owner notified); the `reasoning` model writes the heal reason.
  Files: `packages/core/src/recipe/patch.ts`, `packages/healer/src/{patch,publish}.ts`, tests
- [ ] **3.9 Versions and rollback.** Version history, rollback over REST and the CLI, heal log.
  Files: `packages/db/src/repos/recipes.ts`, `apps/server/src/routes/tools.ts`, `apps/cli/src/commands/rollback.ts`, tests
- [ ] **3.10 `runtime`: hold during heal.** Hold the call for up to 5 minutes while the heal runs, then return a structured error with the job ID; record `runs.heal_job_id`.
  Files: `packages/runtime/src/cascade.ts`, `apps/server/src/jobs/heal.ts`, tests
- [ ] **3.11 Security sweep.** Log redaction paths; a test that greps logs and recorded prompts for the fixture credentials.
  Files: `packages/core/src/logging.ts`, `apps/server/test/security.e2e.test.ts`
- [ ] **3.12 `llm`: API key in the vault.** The OpenAI-compatible adapter reads its optional API key from the vault.
  Files: `packages/llm/src/openai-compatible.ts`, `packages/auth/src/vault/vault.ts`, tests

**Gate:** *Login + 2FA*, *Self-heal*, *Rollback* and *Security* criteria.

## Phase 4: MVP differentiators

- [ ] **4.1 `extension`: scaffold.** Manifest V3 with Vite, a popup to start and stop recording, installed unpacked (D-017).
  Files: `apps/extension/{package.json,manifest.json,vite.config.ts}`, `apps/extension/src/{background,popup}/*`
- [ ] **4.2 `extension`: action recorder.** A content script that records clicks and inputs with ranked selectors and lets the user mark inputs.
  Files: `apps/extension/src/content/recorder.ts`, `apps/extension/src/popup/mark-inputs.ts`, tests in Chromium with the unpacked extension
- [ ] **4.3 `extension`: network capture and upload.** Network capture through `chrome.debugger` (needed for response bodies), export as recording v1, upload to `POST /v1/recordings`.
  Files: `apps/extension/src/background/{network,upload}.ts`, tests
- [ ] **4.4 `watches`: scheduler and diff.** `node-cron` schedules (5-minute minimum), snapshot hashes, diff by key field into `created`, `updated` and `deleted`.
  Files: `packages/watches/package.json`, `packages/watches/src/{scheduler,diff}.ts`, tests
- [ ] **4.5 `watches`: delivery.** HMAC-SHA256 signatures with a timestamp, retries with backoff, MCP notifications, `create_watch` and `delete_watch`, `POST /v1/watches`.
  Files: `packages/watches/src/deliver.ts`, `apps/server/src/routes/watches.ts`, `apps/mcp/src/tools/watches.ts`, tests
- [ ] **4.6 Safe mode: previews and approvals.** Preview (fields, target page, screenshot), approval tokens, `approve_action`, `POST /v1/approvals/:id`, plus a write form on the HTML fixture to test against.
  Files: `packages/runtime/src/safe-mode/{preview,approvals}.ts`, `apps/server/src/routes/approvals.ts`, `apps/mcp/src/tools/approvals.ts`, `fixtures/html-app/src/views.ts`, tests
- [ ] **4.7 Safe mode: policies and audit.** Policies (e.g. "auto-approve under $100"), the dry-run flag, a write audit log with before and after evidence.
  Files: `packages/runtime/src/safe-mode/{policies,audit}.ts`, tests
- [ ] **4.8 `dashboard`: tools and runs.** Next.js scaffold with an API client; tool pages with schema and a cURL example; run history.
  Files: `apps/dashboard/package.json`, `apps/dashboard/app/{layout,page}.tsx`, `apps/dashboard/app/tools/*`, `apps/dashboard/app/runs/*`
- [ ] **4.9 `dashboard`: logins, approvals, 2FA, heals.** Masked logins, approve or reject previews with the screenshot, answer human-in-the-loop 2FA prompts, heal log.
  Files: `apps/dashboard/app/{logins,approvals,heals}/*`, tests

**Gate:** *Watches*, *Safe mode* and *Recording* (through the extension) criteria; a dashboard smoke test.

## Phase 5 and later

Items marked "split first" are broken into day-sized tasks before work starts.

**Self-hosted mode**

- [ ] **5.1 `db`: Postgres.** The Postgres side of the database layer (D-015), with migrations and a parity test against the local database.
  Files: `packages/db/src/*`, `packages/db/migrations/*`, tests
- [ ] **5.2 Queue on Valkey.** A BullMQ implementation of the queue interface; CI runs the queue tests against a Valkey 8.1 service (D-010).
  Files: `apps/server/src/jobs/bullmq-queue.ts`, `.github/workflows/ci.yml`, tests
- [ ] **5.3 Compose stack.** App image on the Playwright base image, `compose.yaml` with `app`, `postgres`, `valkey` and `ollama` (behind a profile), the master key as a Compose secret, volumes, model pull on first start, telemetry off.
  Files: `Dockerfile`, `compose.yaml`, `.dockerignore`
- [ ] **5.4 Zero-cost check.** A script that, on a clean machine with no API keys, runs `docker compose up`, builds and runs a fixture tool.
  Files: `scripts/zero-cost-e2e.sh`
- [ ] **5.5 Multi-user, roles, audit logs** (split first).

**More 2FA methods**

- [ ] **5.6 Email OTP over IMAP.** Read the code from a connected inbox, matched by sender and time.
  Files: `packages/auth/src/twofa/email.ts`, tests with a local IMAP test server
- [ ] **5.7 SMS webhook.** `POST /v1/sms/inbound` with HMAC or bearer verification, stale and duplicate rejection, code extraction, waiting logins, the LAN-only listener in local mode, codes kept in memory or Valkey for 5 minutes (D-008).
  Files: `packages/auth/src/twofa/sms.ts`, `apps/server/src/routes/sms.ts`, `apps/server/src/lan-listener.ts`, tests
- [ ] **5.8 SMS fixture mode.** The login fixture sends its code "by SMS" to a test forwarder that posts to the webhook.
  Files: `fixtures/login-totp/src/sms.ts`, tests

**Later features** (split first)

- [ ] **5.9 Transparency dashboard**
- [ ] **5.10 URL-first discovery**
- [ ] **5.11 Multi-site workflows**
- [ ] **5.12 Code export**

**Gate:** *SMS 2FA* and *Zero cost* criteria, plus each feature's own tests.

## Open-source release track

From your release plan (2026-10-26). It runs alongside the phases: each item needs the features of the phase named.

- [x] **R1 License and community files.** Apache-2.0 (D-027), README, CONTRIBUTING, Code of Conduct, SECURITY, CHANGELOG, issue and PR templates, Dependabot.
- [x] **R2 Docs site.** VitePress in `docs/`, deployed to GitHub Pages once Pages is enabled (D-029).
- [x] **R3 Community recipe library.** `recipes/` with format checks and gitleaks in CI (D-028).
- [x] **R4 MCP directory listings.** `server.json` (validated), `glama.json`, `smithery.yaml`, `listings/README.md`; not submitted.
- [x] **R5 Install path A (npx), C (global CLI) and D (from source).** Tested from clean folders with the packed package.
- [x] **R6 Release automation.** Changesets; a tag-triggered workflow with npm provenance, a multi-arch image on ghcr.io signed with cosign, and a GitHub release (D-033). Runs for the first time at your first tag.
- [ ] **R7 Install path B (Docker Compose).** The image and `compose.yaml` (app, Ollama, model download) are built and checked in CI. Still needed: the dashboard on port 3000 (Phase 4), and Postgres and Valkey (Phase 5).
- [ ] **R8 Bring your own model.** `tooldrop init` sizes and pulls Ollama models and accepts keyless OpenAI-compatible endpoints. Keys for other endpoints need the vault (Phase 3).
- [ ] **R9 Main use case: the Demo Shop.** The fixture is ready (`fixtures/demo-shop`). The end-to-end test and the demo GIF need building (Phase 2), sign-in and healing (Phase 3), and watches and the dashboard (Phase 4).
- [ ] **R10 Chrome extension release zip and store listing.** The privacy policy page is written (`docs/privacy.md`); the extension, icons and screenshots come with Phase 4.
- [ ] **R11 Chrome QA.** Dashboard and extension checks come with Phase 4. Done so far: the fixture pages and the docs site, checked in Chrome.

## Done log

Filled in at the end of each phase: what shipped, test results and the commit.

### Phase 0: Foundations, done 2026-10-26

- **Shipped:**
  - A pnpm and Turborepo workspace on Node 24 and TypeScript 6.0.
  - Type-aware ESLint, Prettier, Vitest.
  - The zero-cost license check.
  - GitHub Actions CI.
  - `@tooldrop/core`: IDs, errors, the recipe format, and the tool, job and run schemas.
  - `@tooldrop/db`: all 11 SPEC tables on SQLite, with the init migration.
  - Three fixture sites with switches, and their shared kit.
- **Results:** 91 tests in 12 files pass. Format, lint and typecheck are clean. The license check passes for all 223 installed packages. [CI passes on Linux](https://github.com/nabeelali0707/toolDrop/actions/runs/40233563626). The JSON-API fixture's page was also checked in Chrome, including after its API moves.
- **Commits:** `e229906` (tooling), `147c652` (core), `bf0a758` (db), `f7ccf21` (fixtures).
- **Still open:** Q-1, the keychain library, needed before task 3.1. Q-2, toolDrop's own license. Neither blocks Phase 1.

### Phase 1: Run a hand-written recipe, done 2026-10-26

- **Shipped:**
  - `@tooldrop/runtime`: four strategies, the cascade with a browser fallback, per-site rate limits, sessions and a cache.
  - `@tooldrop/engine`.
  - The MCP server (stdio and Streamable HTTP).
  - The REST API with scoped API keys.
  - The `tooldrop` CLI and npm package.
  - Two hand-written fixture tools.
- **Results:** 179 tests pass. The license check passes for 484 packages. Install paths A, C and D work from clean folders. *Cascade* passes: when the JSON API moves, the browser returns the same 57 invoices. *MCP* passes over stdio and HTTP.
- **Commits:** `68078d8` (runtime), `ae646ae` (db, engine, MCP, REST), `4240b84` (CLI and package), plus the release automation.
- **Still open:** the one-time MCP check in Claude Desktop or Claude Code. Q-2 is answered (Apache-2.0); Q-1, the keychain library, is still needed before task 3.1.
