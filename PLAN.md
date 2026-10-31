# toolDrop plan

The build plan for [SPEC.md](SPEC.md): each roadmap phase broken into tasks of under a day, with the files each task touches. Choices and open questions are in [DECISIONS.md](DECISIONS.md).

**Status:** Phases 0 to 4 done (2026-10-28). Phase 1 waits on a manual MCP check in Claude Desktop or Claude Code, and Phase 2 on full builds with real models on a machine with a GPU. The open-source release track is partly done (below). Phase 5 is next.

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
- [x] **2.9 `cli`: `tooldrop record`.** A headed Playwright browser that records clicks, inputs and HAR, lets the user mark inputs at the end, then saves and uploads the recording (D-016).
  Files: `apps/cli/src/commands/record.ts`, `packages/compiler/src/recording/{recorder,recorder-page}.ts`, tests with a scripted session on a fixture
- [x] **2.10 `compiler`: traffic analyzer.** Rank requests by how much target data they return; classify fields (`constant`, `user_input`, `derived`, `auth`, `pagination`) with heuristics first and the `reasoning` model only for leftovers.
  Files: `packages/compiler/src/analyze/{rank,classify,values}.ts`, `packages/compiler/src/generate/questions.ts`, tests against fixture captures
- [x] **2.11 `compiler`: strategy picker and recipe generator.** Pick the cheapest viable strategy; the `code` model writes the recipe JSON, validated by the `core` recipe schema.
  Files: `packages/compiler/src/generate/{strategy,draft,recipe,prompts}.ts`, tests with the fake provider
- [x] **2.12 `compiler`: schemas.** Infer input and output JSON Schema from captured values; the `reasoning` model writes names and descriptions.
  Files: `packages/compiler/src/generate/schemas.ts`, tests
- [x] **2.13 `compiler`: double validation.** Run 2 to 3 input sets via the chosen strategy and via `browser_script`, compare, and loop back to the strategy step at most 3 times.
  Files: `packages/compiler/src/validate/double.ts`, `packages/compiler/src/build.ts`, tests
- [x] **2.14 `compiler`: explore agent.** The fallback when there is no recording: the `reasoning` model picks actions from the pruned accessibility tree, within a 30-action budget; when it gives up, the job asks for a recording (D-007).
  Files: `packages/compiler/src/explore/{agent,actions}.ts`, tests with the fake provider on fixtures
- [x] **2.15 Jobs and build orchestration.** In-process queue, job states (`queued`, `running`, `waiting_for_answer`, `succeeded`, `failed`), clarifying questions that pause and resume, and the build steps 1 to 10 wired together.
  Files: `packages/engine/src/{builds,queue}.ts` (in the engine, so the stdio MCP server, `serve` and the CLI all run builds), `packages/db/src/repos/jobs.ts`, tests
- [x] **2.16 Build interfaces.** MCP `build_tool`, `get_job`, `answer_question` and `find_tool`; REST `/v1/builds`, `/v1/jobs/:id`, `/v1/jobs/:id/answers`.
  Files: `apps/server/src/app.ts`, `apps/mcp/src/server.ts`, tests
- [x] **2.17 `cli`: `init`, `build`, `run`, `serve`.** `init` creates the data directory and config, checks that Ollama is running and pulls missing models.
  Files: `apps/cli/src/commands/build.ts`, `apps/cli/src/home.ts` (`init`, `run` and `serve` were done in 1.14), tests with a stand-in Ollama
- [x] **2.18 End-to-end build tests.** Recorded model replies in CI; the same tests with real Ollama models via `pnpm test:llm`.
  Files: `apps/server/src/{build,build-replay}.e2e.test.ts`, `apps/server/src/build.llm.test.ts`, `fixtures/llm-replies/*.json` (recorded on a machine with a GPU, D-039)

**Gate:** *Build (JSON API fixture)*, *Build (HTML fixture)*, *Recording* (with `tooldrop record`), *LLM output* and *Privacy* criteria. All five pass in CI with a scripted model (`apps/server/src/build.e2e.test.ts`, D-039). Still open: the same builds with real models (`pnpm test:llm`), which need a machine with a GPU.

## Phase 3: Auth and self-healing

- [x] **3.1 `auth`: vault and master key.** libsodium secretbox; master key from the OS keychain (`@napi-rs/keyring`, D-040) or a mounted key file; `tooldrop init` generates the key (D-009).
  Files: `packages/auth/package.json`, `packages/auth/src/vault/{vault,key-store}.ts`, `packages/engine/src/engine.ts`, `apps/cli/src/commands/init.ts`, tests
- [x] **3.2 `auth`: logins.** `add_login` and `list_logins` over MCP and REST, encrypted secrets, masked previews only.
  Files: `packages/auth/src/logins.ts`, `packages/db/src/repos/logins.ts`, `apps/server/src/app.ts`, `apps/mcp/src/server.ts`, `apps/cli/src/commands/logins.ts` (`tooldrop logins add` with a hidden prompt), tests
- [x] **3.3 `auth`: login recipes.** Build and run a site's login recipe, verify the signed-in state, save the session.
  Files: `packages/core/src/login.ts`, `packages/compiler/src/login/build-login.ts`, `packages/runtime/src/runtime.ts` (`signIn`), `packages/db/src/repos/sessions.ts`, `packages/db/migrations/0003_*`, tests against `fixtures/login-totp` and `fixtures/demo-shop`
- [x] **3.4 `auth`: 2FA.** TOTP via `otplib`; human in the loop through a job question answered over MCP or REST.
  Files: `packages/auth/src/twofa/totp.ts`, `packages/engine/src/sessions.ts` (codes from a person through job questions or `tooldrop logins verify`), tests
- [x] **3.5 `auth`: session refresh.** Detect expiry (401/403, login redirect, failed check), re-login silently, hook into the runtime session pool.
  Files: `packages/engine/src/sessions.ts`, `packages/runtime/src/{sessions,browser/pool}.ts`, `packages/runtime/src/executors/{http,browser}.ts`, tests
- [x] **3.6 `healer`: detect.** Runtime-failure trigger, daily health check with saved test inputs, drift alert when the output shape changes.
  Files: `packages/runtime/src/executors/browser.ts` (drift), `packages/engine/src/{engine,heals}.ts` (triggers and the daily health check), `apps/cli/src/commands/{serve,tools}.ts`, tests
- [x] **3.7 `healer`: diagnose.** Re-run up to the failing step with full capture; try the ranked-selector fallback before calling the model; build the diagnosis prompt (D-006).
  Files: `packages/healer/src/{heal,prompts}.ts`, `packages/compiler/src/recording/replay-steps.ts`, tests
- [x] **3.8 `healer`: patch, test, publish.** The `code` model returns a patch validated by a Zod patch schema; apply it, run the saved test inputs, publish or escalate after 3 attempts (`degraded`, owner notified); the `reasoning` model writes the heal reason.
  Files: `packages/healer/src/{patch,heal}.ts`, `packages/engine/src/heals.ts`, tests
- [x] **3.9 Versions and rollback.** Version history, rollback over REST and the CLI, heal log.
  Files: `packages/db/src/repos/tools.ts`, `apps/server/src/app.ts` (`GET /v1/tools/:name/versions`, `POST /v1/tools/:name/rollback`), `apps/cli/src/commands/tools.ts` (`tools versions`, `tools rollback`), tests
- [x] **3.10 `runtime`: hold during heal.** Hold the call for up to 5 minutes while the heal runs, then return a structured error with the job ID; record `runs.heal_job_id`.
  Files: `packages/engine/src/engine.ts`, `packages/db/src/repos/tools.ts` (`runs.heal_job_id`), tests
- [x] **3.11 Security sweep.** toolDrop keeps no request logs, so nothing needs log redaction (D-043). A saved login's values are masked in every build and heal prompt for its site. A test searches every prompt, REST answer, database byte and capture file of a signed-in flow for the fixture credentials.
  Files: `packages/llm/src/redact.ts`, `packages/engine/src/{sessions,builds,heals}.ts`, `packages/compiler/src/build.ts`, `packages/healer/src/heal.ts`, `apps/server/src/security.e2e.test.ts`
- [x] **3.12 `llm`: API key in the vault.** The OpenAI-compatible adapter reads its optional API key from the vault; `tooldrop init` asks for it and seals it.
  Files: `packages/llm/src/{openai-compatible,config}.ts`, `packages/auth/src/secret-files.ts`, `apps/cli/src/{home.ts,commands/init.ts}`, tests

**Gate:** *Login + 2FA*, *Self-heal*, *Rollback* and *Security* criteria. All four pass in CI with a scripted model: `packages/engine/src/{sessions,heals}.e2e.test.ts`, `packages/db/src/repos/repos.test.ts` and `apps/server/src/security.e2e.test.ts`.

## Phase 4: MVP differentiators

- [x] **4.1 `extension`: scaffold.** Manifest V3 built with Vite, unminified; a popup to start and finish recording; installed unpacked (D-017, D-046).
  Files: `apps/extension/{package.json,vite.config.ts,popup.html}`, `apps/extension/public/manifest.json`, `apps/extension/src/{background,popup,shared}.ts`, icons from `apps/extension/scripts/icons.ts`
- [x] **4.2 `extension`: action recorder.** The CLI recorder's page scripts, injected into the recorded tab after every page load; a review page to mark inputs; one shared way to build recordings (`@tooldrop/compiler/page`).
  Files: `apps/extension/src/{background,review}.ts`, `apps/extension/review.html`, `packages/compiler/src/recording/{assemble,page}.ts`, `packages/compiler/src/names.ts`, tests in Chromium with the unpacked extension
- [x] **4.3 `extension`: upload.** Recording v1 uploaded to `POST /v1/recordings`, a build started from the review page, or the file downloaded. Network capture through `chrome.debugger` waits until builds can use a HAR without replaying (D-046).
  Files: `apps/extension/src/{review,shared}.ts`, `apps/extension/src/extension.e2e.test.ts`
- [x] **4.4 `watches`: scheduler and diff.** A 30-second timer with a lease per watch (D-044), a 5-minute minimum interval, row hashes, diff by key field into `created`, `updated` and `deleted`; an `/__fixture/invoices` control that adds a row.
  Files: `packages/watches/src/diff.ts`, `packages/engine/src/watches.ts`, `packages/db/src/repos/watches.ts`, `packages/db/migrations/0004_*`, `fixtures/kit/src/switches.ts`, tests
- [x] **4.5 `watches`: delivery.** HMAC-SHA256 signatures with a timestamp, retries with backoff, MCP log notifications, `create_watch`, `list_watches` and `delete_watch`, `POST`, `GET` and `DELETE /v1/watches`; the scheduler runs in `serve` and `mcp`.
  Files: `packages/watches/src/deliver.ts`, `apps/server/src/app.ts`, `apps/mcp/src/server.ts`, `apps/cli/src/commands/{serve,mcp}.ts`, tests
- [x] **4.6 Safe mode: previews and approvals.** Commit steps in recipes; previews (fields, page, screenshot) that stop before the commit; approvals used once (D-045); `approve_action`, `/v1/approvals` and `tooldrop approvals`; a payment form on the HTML fixture and a `record_payment` tool file.
  Files: `packages/core/src/{approval,tool}.ts`, `packages/runtime/src/{write,runtime}.ts`, `packages/runtime/src/executors/{browser,http}.ts`, `packages/engine/src/approvals.ts`, `packages/db/migrations/0005_*`, `apps/server/src/app.ts`, `apps/mcp/src/server.ts`, `apps/cli/src/commands/{approvals,run}.ts`, `fixtures/html-app/src/payments.ts`, tests
- [x] **4.7 Safe mode: policies and audit.** Policies on one input ("amount < 100") from REST or the CLI only, the dry-run flag, and the approvals table as the audit log with screenshots before and after.
  Files: `packages/core/src/approval.ts`, `packages/db/src/repos/approvals.ts`, `packages/engine/src/approvals.ts`, `apps/cli/src/commands/approvals.ts`, tests
- [x] **4.8 `dashboard`: tools and runs.** A Next.js static export served by `tooldrop serve` (D-047); sign-in with an API key; tool pages with schema, a cURL example, versions with rollback and recent runs; the run log.
  Files: `apps/dashboard/{package.json,next.config.ts}`, `apps/dashboard/app/{layout,page}.tsx`, `apps/dashboard/app/{tool,runs}/page.tsx`, `apps/dashboard/components/*`, `apps/dashboard/lib/*`, `apps/server/src/app.ts` (static files, `/v1/tools/:name`, `/v1/runs`, `/v1/jobs`), `apps/cli/{build.ts,src/home.ts}`
- [x] **4.9 `dashboard`: logins, approvals, 2FA, heals.** Masked logins and a form to save one; writes waiting for approval with their screenshot, and the audit log; questions such as 2FA codes with an answer box; the heal log and recent builds.
  Files: `apps/dashboard/app/{logins,approvals,jobs}/page.tsx`, `apps/dashboard/test/dashboard.e2e.test.ts`
- [x] **4.10 `auth`: identity providers and captchas.** A login is typed only on the site or an identity provider the person allowed once (`human_needed`, D-048); a captcha stops the sign-in, and `tooldrop logins verify --by-hand` lets the person sign in in a visible browser. The login fixture gets `ssoLogin` and `captcha` switches.
  Files: `packages/runtime/src/{sign-in-guard,runtime}.ts`, `packages/runtime/src/executors/browser.ts`, `packages/compiler/src/login/build-login.ts`, `packages/engine/src/sessions.ts`, `packages/db/src/repos/sessions.ts`, `apps/cli/src/commands/logins.ts`, `fixtures/login-totp/src/server.ts`, tests
- [x] **4.11 Recording behind a sign-in.** `tooldrop record` signs in with the saved login first, so its window opens signed in.
  Files: `apps/cli/src/commands/record.ts`, `packages/compiler/src/recording/recorder.ts`, tests

**Gate:** *Watches*, *Safe mode* and *Recording* (through the extension) criteria; a dashboard smoke test.

## Phase 5 and later

Items marked "split first" are broken into day-sized tasks before work starts.

**Self-hosted mode**

- [x] **5.1 `db`: Postgres.** The Postgres side of the database layer (D-015, D-051): the Postgres schema and its migrations, one set of async queries for both databases, `TOOLDROP_DATABASE_URL`, a parity test, and the database tests on both, with PGlite in the main job and a Postgres 18 service in CI.
  Files: `packages/db/src/*`, `packages/db/migrations-pg/*`, `apps/cli/src/home.ts`, `.github/workflows/ci.yml`, and every caller, now awaiting the database
- [x] **5.2 Queue on Valkey.** A BullMQ implementation of the queue interface, which now carries job IDs so any process can run a job; SMS codes on Valkey too; `TOOLDROP_VALKEY_URL`; CI runs the Valkey tests against a Valkey 8.1 service (D-010, D-052).
  Files: `packages/engine/src/{queue,job-holds,builds,heals,engine}.ts`, `packages/auth/src/twofa/sms.ts`, `apps/server/src/{jobs/bullmq-queue,valkey-sms}.ts`, `apps/cli/src/home.ts`, `.github/workflows/ci.yml`, tests
- [x] **5.3 Compose stack.** `compose.yaml` with `app`, `postgres`, `valkey`, `ollama` and the model download (Ollama by default, D-012), the master key and the database password as Compose secrets, volumes, health checks, telemetry off (D-053). The image stays as D-033 built it.
  Files: `compose.yaml`, `.dockerignore`, `.gitignore`, `apps/cli/src/home.ts`, `packages/db/src/client.ts`, `scripts/zero-cost-e2e.ts`, docs
- [ ] **5.4 Zero-cost check.** A script that, on a clean machine with no API keys, runs `docker compose up`, builds and runs a fixture tool.
  Files: `scripts/zero-cost-e2e.sh`
- [ ] **5.5 Multi-user, roles, audit logs** (split first).

**More 2FA methods**

- [x] **5.6 Email OTP over IMAP.** Read the code from a connected inbox, read-only, matched by sender and time (D-050); `tooldrop email connect` and `logins add --email`.
  Files: `packages/auth/src/twofa/email.ts`, `packages/engine/src/{engine,sessions}.ts`, `apps/cli/src/commands/{email,logins}.ts`, tests with Hoodiecrow, a local IMAP test server
- [x] **5.7 SMS webhook.** `POST /v1/sms/inbound` with HMAC or bearer verification, stale and duplicate rejection, code extraction, waiting logins, the local network listener, codes in memory for 5 minutes (D-049); `tooldrop sms enable` and `logins add --sms`.
  Files: `packages/auth/src/twofa/sms.ts`, `packages/engine/src/{engine,sessions}.ts`, `packages/runtime/src/{runtime,executors/browser}.ts`, `apps/server/src/app.ts`, `apps/cli/src/commands/{sms,serve,logins}.ts`, tests
- [x] **5.8 SMS fixture mode.** The login fixture sends its code "by SMS" to a forwarder URL that tests set, signed as SMS to URL Forwarder signs.
  Files: `fixtures/login-totp/src/server.ts`, `apps/server/src/sms.e2e.test.ts`

**Later features** (split first)

- [x] **5.9 Transparency dashboard**, split into:
  - [x] **5.9a Figures per tool.** `GET /v1/tools/:name/stats`: calls, success rate, p50 and p95 latency and strategies over a window, and the tool's builds and heals with their model use; `tooldrop tools stats`.
  - [x] **5.9b Version recipes.** `GET /v1/tools/:name/versions/:version`, for comparing versions.
  - [x] **5.9c Dashboard.** Call figures, builds and repairs, model use, and a line diff of any version against the current one, next to rollback.
  Files: `packages/db/src/repos/{stats,tools}.ts`, `packages/engine/src/engine.ts`, `apps/server/src/app.ts`, `apps/dashboard/{components/transparency.tsx,lib/diff.ts,app/tool/page.tsx}`, `apps/cli/src/commands/tools.ts`, tests
- [ ] **5.10 URL-first discovery**
- [ ] **5.11 Multi-site workflows**
- [ ] **5.12 Code export**
- [ ] **5.13 Write builds from recordings** (split first; moved from Phase 4, whose gate does not need it). Compile a recorded form submission into a write recipe whose submit is the commit step. Captures, validation and heals must stop before the submit, since replaying it would make the write.
  Files: `packages/compiler/src/{build,capture/capture}.ts`, `packages/compiler/src/recording/replay.ts`, `packages/compiler/src/generate/draft.ts`, tests

**Gate:** *SMS 2FA* and *Zero cost* criteria, plus each feature's own tests.

## Open-source release track

From your release plan (2026-10-26). It runs alongside the phases: each item needs the features of the phase named.

- [x] **R1 License and community files.** Apache-2.0 (D-027), README, CONTRIBUTING, Code of Conduct, SECURITY, CHANGELOG, issue and PR templates, Dependabot.
- [x] **R2 Docs site.** VitePress in `docs/`, deployed to GitHub Pages once Pages is enabled (D-029).
- [x] **R3 Community recipe library.** `recipes/` with format checks and gitleaks in CI (D-028).
- [x] **R4 MCP directory listings.** `server.json` (validated), `glama.json`, `smithery.yaml`, `listings/README.md`; not submitted.
- [x] **R5 Install path A (npx), C (global CLI) and D (from source).** Tested from clean folders with the packed package.
- [x] **R6 Release automation.** Changesets; a tag-triggered workflow with npm provenance, a multi-arch image on ghcr.io signed with cosign, and a GitHub release (D-033). Runs for the first time at your first tag.
- [x] **R7 Install path B (Docker Compose).** The image and `compose.yaml` (app, Postgres, Valkey, Ollama, model download), with the dashboard on port 3000. CI builds and runs the image on every push; the zero-cost workflow runs the whole stack (5.4).
- [x] **R8 Bring your own model.** `tooldrop init` sizes and pulls Ollama models, and accepts any OpenAI-compatible endpoint; a key is sealed in the vault.
- [ ] **R9 Main use case: the Demo Shop.** Steps 1 to 4 pass end to end with a scripted model (`apps/server/src/demo-shop.e2e.test.ts`): save the login, build `list_orders` from the shop's own API behind sign-in and TOTP, and answer which orders have not arrived in under 2 seconds. The watch, the dashboard and the demo GIF need Phase 4.
- [ ] **R10 Chrome extension release zip and store listing.** The extension, its icons and its privacy policy (`docs/privacy.md`) are done, and the release workflow zips it at your first tag. Still needed: store screenshots and the listing, which you submit.
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

### Phase 2: Build pipeline, done 2026-10-28

- **Shipped:**
  - `@tooldrop/llm`: Ollama and OpenAI-compatible providers, strict JSON with retries, masking and PII redaction, prompt budgets, and usage per job.
  - `@tooldrop/compiler`: capture, prompt builders, the traffic analyzer, drafts, the recipe writer, schemas, double validation, the explore agent, recordings and the recorder.
  - Build jobs in the engine: `build_tool`, `get_job` and `answer_question` over MCP and REST, plus `POST /v1/recordings`.
  - `tooldrop record` and `tooldrop build`.
- **Results:**
  - Every gate criterion passes in CI with a scripted model: *Build (JSON API fixture)*, *Build (HTML fixture)*, *Recording*, *LLM output* and *Privacy*.
  - One real model call: `qwen2.5-coder:7b` wrote a valid recipe for the JSON-API fixture on its first try, with Ollama holding it to the recipe schema. It took about 4 minutes on the development machine, whose 2 GB GPU leaves the model mostly on the CPU.
  - Testing on that machine found that Node's fetch gives up on model calls after 5 minutes; fixed (D-038).
- **Commits:** `168a363` (llm), `c04baf8` (capture and prompts), `40ace21` (recordings), `b3b740f` and `4a32b7f` (analyzer, generator, validation, explore agent), `f3c9343` (jobs), `a8e6f27` (interfaces), `798aedc` (record and build commands), plus the acceptance tests.
- **Still open:** full builds with real models (`pnpm test:llm`) on a machine with a GPU, and the replies they record for CI (D-039).

### Phase 3: Auth and self-healing, done 2026-10-28

- **Shipped:**
  - `@tooldrop/auth`: the vault (libsodium secretbox) with its master key in the OS keychain or a key file, saved logins with masked previews, and TOTP codes.
  - Login recipes built by signing in once. Sessions are sealed in the vault and renewed within the call when they expire. Codes from a person come through job questions or `tooldrop logins verify`.
  - `@tooldrop/healer`:
    - Selectors that drifted are refreshed without a model.
    - A broken fast path is rebuilt in the background while the browser answers.
    - A broken step is repaired while the call waits.
    - Every repair is tested before it is published.
  - Version history and rollback over REST and the CLI, and a daily health check.
  - The model endpoint's API key, sealed in the vault. A saved login's values are masked in every prompt.
- **Results:**
  - All four gate criteria pass with a scripted model: *Login + 2FA*, *Self-heal*, *Rollback* and *Security*.
  - The Demo Shop's main use case passes steps 1 to 4 end to end (R9). `list_orders` is built from the shop's own API behind sign-in and TOTP, and answers in under 2 seconds.
  - 305 tests pass in 41 files. Format, lint and typecheck are clean. The license check passes for 525 packages.
  - Found and fixed on the way:
    - The masker hid `$.token` and `Bearer {{vars.token}}` from the model reviewing a recipe.
    - The browser fallback claimed columns whose cells only contain the value.
    - On Linux without a Secret Service, the keychain library would have kept the master key in memory only, losing it at reboot.
    - A sealed endpoint key would have been sent to the next endpoint `init` set up.
- **Commits:** `4354fe1` (vault), `a80d1ed` (logins), `8691f81` (login recipes, 2FA, sessions), `e41c8d4` (versions and rollback), `1470785` (self-healing), plus the security sweep and the endpoint key.
- **Still open:** approving identity providers and pausing for captchas, which this phase's plan missed, are now task 4.10. Recording behind a sign-in is task 4.11.

### Phase 4: MVP differentiators, done 2026-10-28

- **Shipped:**
  - Watches: a read tool runs on an interval and its changes go out as signed webhooks and MCP log messages, with retries. A lease keeps processes that share a database from running a watch twice.
  - Safe mode: recipes mark their submit as the commit step. A write shows a preview with a screenshot and submits once, only after an approval. Dry runs, policies (REST and CLI only), and the approvals table as the write audit log.
  - The toolDrop Recorder Chrome extension: the same recordings as `tooldrop record`, a review page, and upload or build from there.
  - The dashboard: a Next.js static export served by `tooldrop serve`, with tools, runs, approvals, questions and repairs, and logins.
  - Sign-in safeguards: a login is typed only on the site or an identity provider allowed once, a captcha goes to a person (`tooldrop logins verify --by-hand`), and `tooldrop record` opens signed in.
- **Results:**
  - The gate passes with a scripted model: *Watches* (exactly one signed `created` webhook within one interval), *Safe mode* (no submit without an approval, and a rejected preview changes nothing), *Recording* through the extension (a working tool with no exploration calls), and the dashboard smoke test.
  - 342 tests pass in 47 files. Format, lint and typecheck are clean. The license check passes for 564 packages.
  - Found on the way:
    - Next.js 16.4.0 had critical advisories, so the dashboard pins 16.4.1. Its build also printed instructions addressed to AI agents, which were not followed (D-047).
    - A write the site refused after the submit was reported as made. It now says the write was submitted and to check the site.
- **Commits:** `6b2fe14` (watches), `b68bdb4` (safe mode), `debe52e` (extension), `1cd005e` (dashboard), plus the sign-in safeguards.
- **Still open:** write builds from recordings (5.13); network capture in the extension, until builds can use it (D-046); and the store listing (R10).
