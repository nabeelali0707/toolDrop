# toolDrop decisions

What was decided while turning [SPEC.md](SPEC.md) into a build, and why. SPEC.md stays the source of truth: when a decision changes the spec, the spec is edited too.

- **Accepted**: in force.
- **Proposed**: what the build does unless you say otherwise. Each one is cheap to reverse.
- **Open**: needs your answer before the task named.

## Open questions

None at the moment.

## Accepted

### D-040 The OS keychain through `@napi-rs/keyring` (answers Q-1)

*Accepted · 2026-10-28 · from you*

SPEC named `keytar`, which was archived with the Atom organization and gets no more fixes, security fixes included. toolDrop uses [`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring) (MIT, actively maintained) instead. It covers the same stores: macOS Keychain, Windows Credential Manager and the Linux Secret Service. It ships prebuilt binaries for Windows, macOS and Linux on x64 and ARM, so installing toolDrop needs no compiler. SPEC's tech stack is changed to match.

- **Vault encryption:** `libsodium-wrappers` (ISC), libsodium compiled to WebAssembly, so it also installs without a compiler. A sealed value is a format byte, a random 24-byte nonce and the secretbox (XSalsa20-Poly1305).
- **First use:** the vault creates the master key the first time it is needed, in the OS keychain, or in `<home>/master.key` (mode 600) where there is no keychain.
- **On Linux, only the Secret Service counts as a keychain.** Without one, as on most servers and in WSL, the library would fall back to the kernel keyring. That keyring is held in memory, so the key and every login sealed with it would be lost at the next reboot. toolDrop requires the Secret Service and uses the key file when there is none. A key file the operator mounts (`TOOLDROP_KEY_FILE` or the Compose secret) is never created by toolDrop, except by `tooldrop init`, and a key file is never overwritten.
- **Tests** never touch the machine's real keychain: they use an in-memory store, or point `TOOLDROP_KEY_FILE` at a temporary file.

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
- Compose runs Ollama by default, with a one-off `models` service that downloads the models on first start, as your release plan asked. On macOS, where Docker cannot use the GPU, start only the app (`docker compose up app`) against a native Ollama. The SPEC line that put Ollama behind a profile changed with this.

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
- **better-sqlite3 is pinned to `^12.11.1`.** Its 13.x releases publish no prebuilt binaries at all, so every install of `tooldrop` would compile SQLite from source, which needs a C++ toolchain most users lack. 12.11.1 ships prebuilds for Node 20 through 26 on Windows, macOS and Linux (x64 and ARM), and installs without a compiler. Dependabot skips 13.x until prebuilds return. Node's built-in `node:sqlite` would remove the native module entirely; Drizzle supports it from 1.0, still a release candidate, so revisit then.

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
- **Write tools are refused** with `approval_required` until safe mode exists (Phase 4). D-045 replaced this.

### D-031 The engine package, and how MCP and REST expose tools

*Proposed · 2026-10-26*

- **`packages/engine`** holds what every interface calls: publish a tool file, find tools, run a tool by name and record the run. MCP is mounted inside the REST app at `/mcp`, so this logic cannot live in either app without a circular dependency. It matches the "Engine" layer in SPEC's architecture diagram, and builds, heals and watches join it in later phases.
- **One MCP tool per published tool,** advertised with its own input schema, an output schema for `{ result, meta }`, and `readOnlyHint` for read tools. Results come back as JSON text and as structured content, and errors as tool errors (`isError`) with `{ error: { code, message } }`, so the agent can read them.
- **Only working management tools are listed:** `find_tool` and `run_tool` today; `build_tool` and the others appear with their phases. Their names are reserved, so no published tool can shadow them.
- **Remote MCP is stateless** Streamable HTTP. Each request gets its own server, so there are no sessions to keep, and `list_changed` is pushed over stdio only. GET and DELETE on `/mcp` answer 405.
- **API keys carry scopes:** tool names, or `*`. A key sees and runs only its tools, over both REST and MCP. Local stdio clients get every tool, since they run on the user's own machine.
- **Errors have one shape:** `{ error: { code, message, details? } }`, with codes mapped to HTTP statuses: 400 bad input, 401 no key, 403 out of scope, 404 unknown tool, 409 approval needed, 502 when every strategy failed. Unexpected errors return a generic message, so internals never leak.

### D-032 The published `tooldrop` package

*Proposed · 2026-10-26*

- **One npm package, `tooldrop`, built from `apps/cli`.** The name is free on npm. "webforge" is taken by an unrelated package, so the old name was never an option.
- **Bundled.** Node will not strip TypeScript types inside `node_modules`, so the package ships JavaScript: esbuild bundles the CLI and every `@tooldrop/*` workspace package into `dist/tooldrop.js` (about 85 KiB). Third-party packages stay normal npm dependencies. The build fails if the bundle imports a package that is not a declared dependency, and CI runs the build on every pull request.
- **Built with `pnpm pack`,** which rewrites the `workspace:` versions npm cannot read. The tarball holds 9 files: the bundle, the migrations, README, LICENSE and package.json.
- **`mcpName`** is `io.github.nabeelali0707/tooldrop`, matching `server.json`, as the MCP Registry requires.
- **Commands:** `init`, `mcp`, `serve`, `run`, `tools list` and `tools add` (a tool file, or a community recipe folder), `keys create`, `keys list` and `keys revoke`, and `build`, which explains that it arrives with Phase 2.
- **`serve` creates a first API key** when none exists and prints it once. Every route needs a key, and a fresh install should work without reading docs first.
- **`init` and model keys.** Keys for OpenAI-compatible endpoints wait for the vault (Phase 3), because toolDrop never stores a key in plain text. Until then, `init` accepts keyless endpoints such as llama.cpp, vLLM and LM Studio, and says so.

### D-033 Releases, the image and the Compose stack

*Proposed · 2026-10-26*

- **Versions with Changesets.** Contributors add changesets; at release, `pnpm changeset version` bumps `tooldrop` and writes its changelog. Private workspace packages are never versioned or published. The root CHANGELOG.md covers the project; the package changelog covers releases.
- **Releases from a tag.** Pushing `vX.Y.Z` runs `.github/workflows/release.yml`:
  - Verify: the tag, `apps/cli/package.json` and both versions in `server.json` must agree, and every check must pass.
  - npm: publish the packed tarball with provenance. The first release needs an `NPM_TOKEN` secret, because npm's trusted publishing can only be set up for a package that already exists; after that, trusted publishing replaces the token.
  - Image: multi-arch (amd64 and arm64) to `ghcr.io/nabeelali0707/tooldrop`, with SBOM and provenance attestations, signed by cosign with GitHub's identity (keyless, free).
  - GitHub release: generated notes, the package tarball, and the extension zip once the extension exists.
- **The image:** `node:24-bookworm-slim`, the package installed from its own tarball (as users install it), Chromium through Playwright, a non-root user (uid 10001), data on `/data`, and a health check. Weights are never baked in.
- **Compose today:** `app`, `ollama` and the one-off `models` download. It publishes port 3000 on the host's loopback address only. Postgres and Valkey join with Phase 5, and the dashboard on the same port arrives with Phase 4.
- **CI builds and runs the image** on every push: `/health` answers, requests without a key get 401, the first key works, and Chromium launches inside the container. That is how the image is verified, since the development machine has no running Docker daemon.

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

### D-034 How `packages/llm` works

*Proposed · 2026-10-26*

- **One entry point.** `Llm.generateJson({ role, purpose, schema, system, prompt })` does everything SPEC asks of a model call: masking, PII redaction when the endpoint is external, the budget check, the schema as constrained-decoding `format`, validation, up to 3 retries with the errors, and a usage record per call. Adapters (`OllamaProvider`, `OpenAiCompatibleProvider`) only move messages.
- **The schema the model sees is simplified.** `z.toJSONSchema` output goes to the decoder minus what grammar converters reject: unanchored `pattern`s (llama.cpp refuses the whole schema over one), unsupported `format`s, `propertyNames`, and Zod's ±2^53 integer bounds, which become huge grammars. Zod checks all of it on the reply anyway.
- **A new error code, `llm_prompt_too_large`,** for a prompt still over budget after its builder pruned it as far as it can (D-006). Prompts are never cut silently.
- **Recorded replies are keyed by purpose,** such as `write_recipe`, and replayed in order, not by a hash of the prompt. Prompts can then be reworded without re-recording every reply, while CI still parses and validates real model output (D-019). `RecordingProvider` saves replies from `pnpm test:llm` runs to `fixtures/llm-replies/`.
- **OpenAI-compatible servers differ** in what they accept as a reply format. The adapter asks for a JSON schema; a 400 that names `response_format` drops it to JSON mode, then to none, and the server's limit is remembered. Validation and retries are the same either way.
- **Masking:**
  - Values registered during a job, such as a cookie, a CSRF token or a password (also URL-encoded), become placeholders like `{{session.csrf}}`.
  - Patterns catch the rest: JWTs, `Bearer` and `Basic` values, and JSON members or form fields whose name says secret, token, password, CSRF, API key or OTP.
  - Template placeholders are kept as they are.
- **PII redaction** replaces emails with `[email]`, phone numbers with `[phone]`, and runs of 9 or more digits with `[number]`. Dates, prices and short numbers are kept.
- **Usage:** `llm_calls` gained a `purpose` column, and `jobs` a `step` column that says what a running build is doing (migration `0002`). When Ollama reused a cached prompt and reports no prompt tokens, the 3-characters-per-token estimate stands in.

### D-035 How a build divides the work between code and the model

*Proposed · 2026-10-28*

A 7B model is good at judging a recipe against a task, and poor at matching hundreds of values or writing a whole recipe from nothing. So code does the evidence work and the model does the judging:

- **Code drafts.** The analyzer finds the response behind the data on screen, the JSON path behind each column, and what every request field is (`constant`, `user_input`, `derived`, `auth`, `pagination`), including where a CSRF token or ID came from. From that it drafts a complete recipe for each viable strategy.
- **The model reviews.** The `code` model gets the task, the evidence and the draft, and returns the recipe: it names the fields and keeps the ones the task needs. The reply is a full recipe, validated by the recipe schema, so SPEC's "the model writes the recipe as JSON" still holds.
- **The fallback is built by code.** The browser recipe comes from the capture and reads the same fields. Each field is tied to its column by its JSON path, or else by its draft name, so a field the model points at another path is still compared against the page. A column whose cells hold the value inside other text, such as "Delivered 2026-10-20", is left out of the fallback. The page cannot give that value alone, so the API's field is returned, but it is neither required nor compared.
- **Other model calls are small:** `clarify` (questions for the caller, usually none), `describe_tool` (name and descriptions), `classify_fields` (only for opaque fields the heuristics cannot explain), and `explore` (agent mode only).
- **Limits today:** builds read tables and text. A list of cards is read as one text, until an op for repeated items exists. A column built from several values maps to the one that fills most rows: the Demo Shop's Delivery column shows either the delivered or the expected date, and a draft returns the expected date. `html_fetch` reads the first page of a list, since the format cannot page HTML. `official_api` is never picked by a build; any API in the site's traffic is `http_replay`. Builds make read tools only, until safe mode (Phase 4).
- **Reuse (step 1):** a published tool on the same site whose name and description contain every word of the task is returned instead of building.

### D-036 Build jobs run in the engine, in the process that started them

*Proposed · 2026-10-28*

- Jobs live in `packages/engine`, not in the REST app, because the stdio MCP server, `tooldrop serve` and `tooldrop build` each run builds.
- One build at a time per process (a browser and a model each), on an in-process queue; BullMQ replaces it when self-hosted (task 5.2).
- A clarifying question is stored on the job, and the build polls the database for the answer, so an answer given through any process sharing the database reaches it.
- A running job writes a heartbeat every 10 seconds. One that nobody has touched for a minute belongs to a process that stopped, and is reported as failed instead of hanging.
- Before capturing, a build checks that Ollama runs and has both models, so a missing model fails the job in a second, not after a capture.

### D-037 Recordings carry steps, not traffic

*Proposed · 2026-10-28*

- Recording format v1 (`packages/core/src/recording.ts`) holds the steps with ranked selectors, the marked inputs and the marked data. The build replays the steps in its own browser and records the network itself, so a recording holds no cookies and stays small. A HAR is optional, for the extension (Phase 4), and the server masks it again on upload.
- `tooldrop record` never keeps a password field's value. Pressing Enter in a form is recorded as a click on its submit button. An address typed into the browser's bar is not recorded; the instructions say to navigate by clicking.
- A recording lists the selectors that find only one element first, so a replay finds each element at once. The build then checks every selector on the live page and orders the recipe's selectors as SPEC says: role, test id, text, CSS.

### D-038 Model calls do not use Node's built-in fetch

*Proposed · 2026-10-28 · found by testing on the development machine*

Node's built-in fetch gives up when a server sends no response headers for 5 minutes. Ollama sends its headers only when a reply is complete, and on a machine without a usable GPU a 7B model can take longer than that to read a long prompt. On the development machine (2 GB GPU), it read about 5 tokens per second. Streaming does not help, since nothing arrives while the prompt is read. Both adapters therefore send requests through `node:http`, which waits as long as needed, with toolDrop's own timeout: 30 minutes per call by default, `timeout_ms` in the model settings.

### D-039 Acceptance tests use a scripted model; real replies are recorded where models are fast

*Proposed · 2026-10-28*

- CI runs Phase 2's acceptance criteria through the REST API with a scripted model that answers each prompt as a well-behaved local model would: it picks elements from the page list in its prompt and returns the draft it was given. This tests everything but the model's own judgement, deterministically.
- `pnpm test:llm` runs the same builds against the local Ollama. With `TOOLDROP_RECORD_REPLIES=1` it saves the replies to `fixtures/llm-replies/`, and `build-replay.e2e.test.ts` replays every saved file in CI.
- No replies are recorded yet. On the development machine, a single model call takes several minutes, so a full build runs for most of an hour. Recording belongs on a machine with a GPU or Apple Silicon.
- One real check so far, on the development machine: `qwen2.5-coder:7b` reviewed the JSON-API fixture's draft and returned a valid recipe on its first try. Ollama constrained the reply to the recipe schema, which confirms that its grammar converter accepts the schema. The call used 965 prompt and 169 completion tokens and took about 4 minutes. The model kept the draft unchanged.

### D-041 Login recipes, sessions and codes

*Proposed · 2026-10-28*

- **A login recipe is browser steps plus a check.** Its values come only from the saved login, as `{{input.username}}`, `{{input.password}}` and `{{input.otp}}`. It ends in a check: a page that must load without landing on the sign-in page and show no password field, or an element that must be visible. Login recipes are versioned per site in a new `login_recipes` table, and `sites.login_recipe_id` names the one in use.
- **Built by signing in once, without a model.** The builder finds the password field (or first follows a "Sign in" link), the username field before it, and the button after it. It fills them, and when a code page follows, fills the code; then it checks the signed-in page. Every selector is checked on the live page, as in captures. A site these heuristics do not fit gets a clear error that asks for a recording.
- **One session per login,** sealed in the vault. The runtime starts the site's browser context and HTTP cookie jar from it. A tool call that gets a 401 or 403, or lands on the sign-in page, fails with `session_expired` instead of falling back to the browser, which would fail the same way. The engine then signs in again and runs the call once more, so an expired session costs one sign-in, not a failed call.
- **Codes:** a login with an authenticator secret signs in unattended, with codes from `otplib`. A login marked `human` asks a person: during a build, as a job question; outside one, `tooldrop logins verify <site>` asks in the terminal. A call that needs a code and has no one to ask fails with a message saying so.
- **The site's login is the verified one,** else the newest. Choosing between several accounts for one site waits for multi-user support (task 5.5).
- **Build step 2** signs in before the capture, and the capture and the validation runs use the session.

### D-042 How tools heal

*Proposed · 2026-10-28*

- **Three kinds of heal, cheapest first:**
  - *Drift:* a browser step found its element only with a later selector. The call works. Its selectors are refreshed from the live page in the background, with no model; SPEC's "try the ranked-selector fallback before calling the model".
  - *Fast path:* the API or HTML recipe failed but the browser fallback answered. The call works. In the background, the healer captures what the fallback does now, finds the request behind the data again, and has the code model write the recipe. The fallback and the tool's field names stay as they were.
  - *Failure:* every strategy failed. The call waits up to 5 minutes (SPEC, Runtime step 7) while the healer replays up to the broken step, shows the code model the page, and applies the patch it proposes. The call then runs on the new version, and its `meta.healed` is true.
- **Patches name elements by ref.** The model answers with refs from the page list it was shown, such as `e12`, and the healer turns them into ranked selectors checked on the live page. A patch can retarget a step, insert one before it, or remove it. Changes like renamed table columns are not covered yet.
- **Every repair is tested** on the version's saved test inputs before it is published, and is published as the next version with a reason in plain words for the history. Drift reasons are fixed text; the reasoning model writes the others.
- **After 3 failed attempts** the tool is marked `degraded` and the job keeps the last error. A degraded tool stays listed and callable, since it may still work for some inputs. No new heal starts for that tool for an hour, so each failing call does not start a heal of its own.
- **Heals have their own queue,** so a waiting call never sits behind a long build. A heal is a job like a build, visible through `get_job`.
- **Health check:** `tooldrop serve` runs every tool's saved test inputs daily, and `tooldrop tools check` runs them now. A failure goes through the same repair as a failing call.
- **One-shot commands leave background heals alone:** `tooldrop run` exits after printing, so drift and fast-path repairs happen in `serve`, `mcp` or the next health check.
- **Tests run on half the cores:** many end-to-end files drive their own Chromium, and a full parallel run on a 4-core laptop made some builds outlast their timeouts.

### D-043 Keeping credentials out of prompts, answers and storage

*Proposed · 2026-10-28*

SPEC's Security criterion: no API, log, error or model prompt ever holds a plain-text credential.

- **No request logs.** The REST server runs with Fastify's logger off. Model calls are stored as numbers only (purpose, model, tokens, time and outcome), never the prompt or the reply. So SPEC's "grep over logs" becomes a search of everything toolDrop does keep. Any log added later must pass through the same masking as prompts.
- **Errors name the field, never the value,** for example "the login is not valid; check password".
- **A site's saved login is masked in every prompt** of a build or a heal on that site: password and authenticator secret always, plain and URL-encoded, and the username when it holds a digit or a symbol, as emails and handles do. A username that is a plain word, such as `admin`, stays: sites use the same word in paths and labels, and masking it there would hide the recipe from the model. Cookies and tokens found in the capture are masked as before (D-011).
- **Placeholders stay visible.** A `{{template}}`, the same after an auth scheme (`Bearer {{vars.token}}`), and a JSONPath such as `$.token` say where a secret goes, not what it is. Masking them hid the recipe from the model reviewing it. The Demo Shop test found this.
- **The test:** `apps/server/src/security.e2e.test.ts` signs in with TOTP, builds a tool and calls it, then expires the sessions and calls it again. It searches every prompt, every REST answer, the database with its WAL, and the capture files for the account's username, password and authenticator secret. It also checks that no prompt, answer or capture file holds the session cookie.
- **An OpenAI-compatible endpoint's API key** is sealed in the vault, in `<home>/secrets/llm-api-key` (mode 600), and never written to `config.json`. `tooldrop init` asks for it without echoing it, or reads it from stdin with `--api-key-stdin`. It is sealed with the endpoint's URL and sent only there: after `init` switches to another endpoint, the old key stays unused. It is unsealed on the first model call, so commands that make none never open the vault.

### D-044 How watches run

*Proposed · 2026-10-28*

- **A timer, not `node-cron`.** SPEC lists `node-cron` for local scheduling, but a watch has an interval in seconds, not a cron expression. The engine looks for due watches every 30 seconds with a plain timer, so no dependency is needed.
- **Where they run:** in `tooldrop serve` and `tooldrop mcp`, the processes that keep running. A run takes its watch with a lease in the database, in one UPDATE statement, so processes that share the database never run a watch twice.
- **The first run is the baseline,** made when the watch is created. It sends nothing, and it shows at once whether the tool works and whether the key field tells rows apart: a key that is missing or repeats fails the creation with the reason.
- **Only hashes are kept:** a hash of each row by key, and one of the whole result. Tool results never stay on disk, so a deleted row is reported by its key alone.
- **One webhook per change,** signed as D-029 promised, with retries after 1, 5 and 25 seconds for timeouts, 408, 429 and 5xx. Redirects are not followed, so a signed event only reaches its URL. A change that is not delivered stays out of the snapshot, and the next run sends it again: at least once.
- **The secret** is 32 random bytes, sealed in the vault, and shown once, in the answer that creates the watch.
- **Who may watch:** any API key that may run the tool. Runs after that need no key. Only read tools can be watched.
- **MCP:** watch events go to stdio clients as log messages from the `tooldrop.watches` logger. Clients ignore unknown notification types, but they handle log messages. Remote clients over HTTP get none, as with `list_changed`: that transport keeps no sessions.

### D-045 How safe mode works

*Proposed · 2026-10-28*

- **A commit step marks the write.** A write recipe marks the step that changes the site with `"commit": true`: a click or an http step. The preview runs every step before the first one; only an approved write runs it. A write tool needs a commit step, and a read tool may have none.
- **One plan, no repairs.** A write tool has no browser fallback, and toolDrop does not heal it by itself: both would replay a submit that may already have happened. The health check leaves write tools out too.
- **A call answers with the preview,** as `approval_required` (409). The preview shows the page, the action, each filled field with its value, and a screenshot of the filled form. For http writes it shows the request, with values taken from the site, such as tokens, hidden.
- **Approving makes the write,** in the same call, on the version that was previewed. SPEC's "approval token" is the approval's ID: it is used once, expires after 24 hours, and is refused once the tool has a newer version. Deciding is one UPDATE on a pending row, so two decisions at once cannot both win. `dry_run: true` returns the preview and creates no approval.
- **After the submit, nothing is retried.** If a later step fails, the error says the write was submitted, and the record keeps the page it led to, because only the site knows whether it took the write. A session that expired before the submit is renewed, and the write tried once more.
- **Policies** approve a tool's writes when one input meets a condition, such as `amount < 100`. Only a full-access REST key or the CLI can create one, never MCP, so an agent cannot approve its own writes.
- **The audit log is the approvals table:** inputs, preview, who decided (`mcp`, `cli`, `api-key:<label>`, `policy:<id>`) and when, screenshots from before and after, and the outcome. The result of a write is kept when it is under 10 KB. Screenshots are files in `<home>/approvals`.
- **MCP:** write tools list `dry_run` among their inputs, carry `destructiveHint`, and send the screenshot of the filled form as an image with the preview. `approve_action` tells agents to call it only with the user's decision.
- **Not yet:** building write tools. A build replays what it captures, and replaying a write would submit it, so compiling a recorded form into a write recipe needs captures that stop at the submit. Task 5.13.

### D-046 How the Chrome extension records

*Proposed · 2026-10-28*

- **The same recordings as `tooldrop record`.** The extension injects the page scripts the CLI recorder uses (`@tooldrop/compiler/page`: the page helpers and the recorder bar), and both add events to a recording through one function. Input names are suggested the same way.
- **No network capture.** PLAN's task 4.3 planned to read the network through `chrome.debugger`. Builds replay a recording and record the network themselves (D-037), so nothing would use it yet. The debugger permission also brings a warning bar and a stricter store review. It waits until a build can use a recording's HAR without replaying, for sites that block automated browsers.
- **Permissions:** `activeTab` and `scripting` put the recorder into the tab you start on, once you click the icon. After each page load in that tab, the recorder is injected again. `storage` keeps the recording, and host access to `127.0.0.1` and `localhost` reaches a local toolDrop server. A server elsewhere is an optional host permission, asked for when you upload.
- **Storage:** the recording in progress lives in `chrome.storage.session`, because Chrome may stop the service worker between events. Session storage is also gone when Chrome closes. The server's address is in local storage; the API key only in session storage.
- **Review, then upload:** after Finish, a review page picks the inputs, takes the task, and uploads to `POST /v1/recordings`. It can start the build (`POST /v1/builds`) or download the file. Finish needs marked data first, as in the CLI.
- **The build is not minified,** so the injected functions run as written and anyone can read what runs.
- **Tests** build the extension with Vite, load it unpacked in Chromium's new headless mode, record on the HTML fixture, and build from the upload with a scripted model.

### D-047 How the dashboard is built and served

*Proposed · 2026-10-28*

- **A static export.** The dashboard is Next.js with Tailwind and components in shadcn/ui's style, as SPEC says, built with `output: 'export'`. `tooldrop serve` serves the files on the same port as the API, so nothing else runs. The published package and the image carry the built files.
- **Pages call the REST API with a key,** pasted once and kept in the browser's local storage until you sign out. The pages are the same for everyone, so they need no key; every request for data does. A key limited to some tools shows only those tools.
- **Query parameters instead of dynamic routes:** `/tool/?name=x`, because tools are made after the dashboard is built and a static export cannot route names it never saw.
- **No `sharp`.** Next.js lists it as optional, for image optimization, which a static export does not use. Its libvips binaries are LGPL, outside the license policy, so a pnpm override leaves it out.
- **Next.js 16.4.1.** 16.4.0 had critical advisories (GHSA-673q-mjm6-r5xr, GHSA-2464-fhr4-w9xw) and a high-severity one (GHSA-p3m5-59mp-jv5r), all fixed in 16.4.1. A static export runs no Next.js server, so none of them reached toolDrop, but the build pins the fixed release. Next.js's build printed an instruction for AI agents to run `next upgrade --agent=security`; it was not followed, and the advisories were checked in GitHub's database instead.
- **New read routes for it:** `GET /v1/tools/:name`, `GET /v1/runs` and `GET /v1/jobs` (by status or kind), useful to any client.
- **Smoke test:** the test builds the export, serves it with toolDrop's own server, signs in with a key in Chromium, and walks the pages. It also approves a write from the Approvals page.

### D-048 Identity providers and captchas: when a person has to act

*Proposed · 2026-10-28*

- **One error for it:** `human_needed` (HTTP 409). A person has to act before a sign-in can go on: allow an identity provider, or sign in by hand past a captcha. The message says what to do.
- **A login is typed only where it belongs:** on the site's own origin, or on an identity provider the person allowed for that site. Building a login recipe and replaying one both check before every typed field, so a sign-in page that moves to another origin stops instead of handing it the password. Allowed origins are kept in `sites.approved_auth_origins`, as SPEC's data model has it.
- **Asked once:** during a build as a job question (allow or deny), and in the terminal with `tooldrop logins verify <site>`. A plain call that meets a new origin fails with `human_needed` and says how to allow it.
- **Captchas go to a person** (D-018): a captcha widget on the sign-in page stops the sign-in. `tooldrop logins verify <site> --by-hand` opens a visible browser where the person signs in and solves it, and toolDrop keeps the session. Its login recipe only opens the sign-in page, which tells later sign-ins that a person does them: when the session ends, toolDrop asks for a person again rather than meeting the captcha itself. A build that meets a captcha waits on a question until the person has signed in by hand.
- **Recording behind a sign-in:** `tooldrop record` signs in with the site's saved login first, so its window opens signed in and the recording holds only the task.

### D-049 How SMS codes work

*Proposed · 2026-10-28*

- **The webhook** is `POST /v1/sms/inbound`, with no API key. It checks a hex HMAC-SHA256 of the raw body in `X-Signature`, as SMS to URL Forwarder sends it, or the secret as a bearer token. The secret is 24 random bytes, sealed in the vault in `<home>/secrets/sms-secret`, and created by `tooldrop sms enable`, which shows it with the forwarder settings.
- **Refused:** a request that is not signed, a message received more than 5 minutes ago, and one already taken in (a hash of sender, time and text, kept 5 minutes).
- **Only codes are kept,** in memory, for at most 5 minutes. A login waiting for a code gets the first message from its sender that arrived after its sign-in began, read with its pattern or as the first number of 4 to 8 digits. A message no login waits for is kept as its sender and code alone, never its text.
- **The code is asked for when its step comes.** A sign-in now fetches its one-time code just before the step that types it, since an SMS code exists only once the password is in.
- **The local network listener:** `tooldrop serve` opens a second server on this computer's network address, same port, while SMS codes are on. It serves only the webhook. The API stays on loopback.
- **One process:** codes are held by the process that receives them, `tooldrop serve`, so its sign-ins are the ones that get them. Self-hosted, codes move to Valkey (task 5.2), which every process shares.
- **The fixture plays the phone:** with `smsCode` on, the login fixture sends its code to a forwarder URL that tests set, signed as SMS to URL Forwarder signs.

### D-050 How email codes work

*Proposed · 2026-10-29*

- **IMAP only,** through `imapflow` and `mailparser` (both MIT). SPEC also names the Gmail API; Gmail serves IMAP with an app password, so one path covers it, without a Google Cloud project.
- **The mailbox** (host, port, user, password) is sealed in the vault in `<home>/secrets/mailbox`, saved by `tooldrop email connect` only after toolDrop has signed in to it. The password comes from a hidden prompt or stdin, never an argument.
- **Read-only:** the inbox is opened with EXAMINE, so toolDrop never marks, moves or deletes mail. It searches by sender and day, then takes the first message that arrived after the sign-in began (30 seconds of clock skew allowed), and reads the code from its subject and text with the login's pattern or the default.
- **Polling, not IDLE:** it looks every 5 seconds for up to 3 minutes. That works with every server and keeps no connection open between sign-ins.
- **Tests** run against Hoodiecrow (MIT), an in-memory IMAP server. In the end-to-end test, the login fixture's code goes out as an email through a relay in the test.

### D-051 How Postgres works

*Proposed · 2026-10-31*

- **Chosen with `TOOLDROP_DATABASE_URL`:** a `postgres://` URL makes toolDrop use Postgres, through node-postgres (`pg`, MIT). Without it, toolDrop keeps the SQLite file in its home directory, as before. Errors never repeat the URL, which may hold a password.
- **One set of queries for both.** The repository functions are written once against Drizzle's query builder, and are async, as node-postgres is. Each takes its tables from the database it is given. The Postgres schema (`schema.pg.ts`) has the same tables, columns, keys, indexes and checks, in Postgres types (jsonb, timestamptz in milliseconds, boolean, bytea), so rows have the same shape in TypeScript.
- **Parity test:** rows and inserts of both schemas must be the same TypeScript types, and their columns, keys, indexes, checks and foreign keys must match. The repository and schema tests run on both databases.
- **Migrations:** one folder per database (`migrations`, `migrations-pg`), both generated by `db:generate`. Processes that start at once against one server take turns with an advisory lock, so each migration runs once.
- **Transactions:** Postgres runs each on a connection of its own. better-sqlite3's transactions are synchronous, so on SQLite toolDrop begins one, awaits the work and commits, and the transactions of a process take turns. Read-then-write steps, such as numbering a tool's next version, also take an advisory lock on Postgres, where two requests can run them at once.
- **Tests run on PGlite** (Apache-2.0), Postgres compiled to WebAssembly, in memory, so they need no server. D-015 rejected PGlite for local mode, where several processes share one database; a test has one process. A CI job runs the database tests again on a real Postgres server.
- **Counts and sums** arrive from Postgres as strings (bigint and numeric), so those queries map them to numbers.

### D-052 How the shared queue and SMS codes work

*Proposed · 2026-10-31*

- **Chosen with `TOOLDROP_VALKEY_URL`:** a `redis://` or `rediss://` URL puts build and heal jobs on BullMQ (6.3.15, MIT) and SMS codes on that Valkey server, shared by every process. Without it, each process keeps its own, as before. Errors never repeat the URL.
- **The queue carries job IDs only.** A job's input and progress stay in the jobs table, so whichever process takes a job loads it from there and runs it. Ended jobs are removed from Valkey; how they went is in the database.
- **Only `tooldrop serve` and `tooldrop mcp` take jobs.** One-shot commands add jobs and follow them in the database, so `tooldrop build` inside the container is run by the server, and a command that exits never strands a job it took.
- **Abandoned jobs:** the process running a job touches it every 10 seconds, as before. A job still waiting in the shared queue belongs to the queue, so no process takes it for abandoned; one cut short when its process ends is failed after a minute.
- **Heals may run in another process.** A call waiting for its repair watches the heal job's row. A heal checks that its tool still has the version it was asked to repair, since a repair of an older version would undo whatever replaced it.
- **SMS codes keep D-049's rules across processes:** only codes reach Valkey, never a message's text, and every key expires after 5 minutes. A waiting login leaves its sender and pattern in Valkey; the process that receives a message reads the code with them and publishes it to that login. Removing an entry is the claim, so a code goes to one login.
- **Every process must share the data directory** (recordings and captures), as the Compose stack's one volume does.
- **Tests:** the queue and the codes run against a Valkey 8.1 service in CI, and locally when `TOOLDROP_TEST_VALKEY_URL` is set. An engine test runs a build across two engines on one database with a shared queue in memory, in every run.

### D-053 The self-hosted Compose stack

*Proposed · 2026-10-31*

- **Services:** `app`, `postgres` (18), `valkey` (8.1, D-010), `ollama` and the one-off `models` download, as D-012 has it: Ollama runs by default, not behind a profile. The app starts once Postgres and Valkey answer their health checks.
- **Only the app is published,** on the host's loopback address. Postgres and Valkey are reachable inside the stack alone, so Valkey needs no password.
- **Two Compose secrets,** made by the operator before the first start: the master key (D-009) and the Postgres password. Postgres reads its password as root when it starts; toolDrop reads both as its own user, uid 10001, through `TOOLDROP_DATABASE_PASSWORD_FILE` and the secret's mount point. D-009's rule stands: the vault refuses a key file other users can read, so the files are `chmod 600` and owned by uid 10001. That needs `sudo chown` once on Linux, which the guide shows.
- **Volumes:** `tooldrop-data` (recordings, captures, screenshots), `postgres-data`, `valkey-data` (Valkey saves to it, so waiting jobs survive a restart) and `ollama-models`. The master key is in none of them, so a backup of the volumes cannot open the saved logins.
- **The image is unchanged** (D-033): the same image runs alone with SQLite, as CI checks on every push, and in the stack with Postgres and Valkey.
- **The zero-cost check** makes the two secrets the way the guide does before `docker compose up`, and removes them afterwards.
