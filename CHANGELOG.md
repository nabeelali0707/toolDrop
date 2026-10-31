# Changelog

All notable changes to toolDrop. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file covers the project as a whole. From the first release on, the published `tooldrop` package also gets its own changelog, written by Changesets from the change descriptions in each pull request.

## [Unreleased]

### Added

- The specification for a zero-cost, local-first toolDrop: local models through Ollama, SMS codes from your own phone, self-hosting with Docker Compose, and a rule that no feature may need a paid plan or paid API key ([SPEC.md](SPEC.md)).
- The build plan ([PLAN.md](PLAN.md)) and the decision log ([DECISIONS.md](DECISIONS.md)).
- The workspace: pnpm and Turborepo on Node 24, TypeScript 6.0, ESLint, Prettier, Vitest and GitHub Actions CI.
- A license check that enforces the zero-cost rule on every installed package.
- `@tooldrop/core`: the recipe format, and the tool, job, run and recipe-library schemas.
- `@tooldrop/db`: the database schema for every table in the spec, with its first migration.
- Fixture sites that all tests run against: a JSON-API app, a server-rendered app, a login with TOTP, and the Demo Shop.
- The community recipe library, with format validation and secret scanning in CI.
- Open-source project files: the Apache-2.0 license, a contributing guide, the Contributor Covenant, a security policy, issue and pull request templates, and Dependabot.
- The runtime runs published tools without a model. It uses an official API, the site's own JSON API, its HTML, or a real browser, and falls back to the browser when the faster strategy breaks.
- An MCP server (stdio for local clients, Streamable HTTP for remote ones): every published tool is its own MCP tool, plus `find_tool` and `run_tool`.
- A REST API with scoped API keys: `GET /v1/tools`, `POST /v1/tools/:name/run` and `/health`.
- The `tooldrop` CLI, as an npm package:
  - `init` picks models for your machine, checks Ollama and installs the browser.
  - `mcp`, `serve`, `run`, `tools add` (tool files and community recipes) and `keys`.
- A Docker image and `compose.yaml` with Ollama and a first-start model download.
- Release automation: Changesets, npm provenance, multi-arch images on ghcr.io signed with cosign, and generated release notes.
- The documentation site, and listing files for the MCP Registry, Glama and Smithery.
- Building tools (Phase 2): describe a task, or record it once, and toolDrop builds, validates and publishes a tool with local models.
  - `packages/llm`: Ollama and OpenAI-compatible providers, strict JSON checked by schema with up to 3 retries, masking of credentials in every prompt, PII redaction for external endpoints, prompt budgets, and token and duration logging per job.
  - `packages/compiler`: capture of the network, the page and the steps; traffic analysis; recipe drafts that the local model reviews; inferred input and output schemas; validation of every recipe against the browser on 2 to 3 input sets; and an explore agent for builds without a recording.
  - Build jobs with clarifying questions: `build_tool`, `get_job` and `answer_question` over MCP; `POST /v1/builds`, `GET /v1/jobs/:id`, `POST /v1/jobs/:id/answers` and `POST /v1/recordings` over REST.
  - `tooldrop record` to do a task once in a browser, and `tooldrop build` to build in the terminal.
- Signing in and self-healing (Phase 3):
  - An encrypted vault (libsodium) for credentials, with its master key in the OS keychain or a key file.
  - Saved logins: `add_login` and `list_logins` over MCP, `POST /v1/logins` and `GET /v1/logins` over REST, and `tooldrop logins add`, `list` and `verify`. Saved values are never returned, only masked previews.
  - Login recipes built by signing in once, TOTP codes, codes typed by a person through job questions, and sessions that are renewed when they expire, without failing the call.
  - Self-healing:
    - Selectors that drifted are refreshed without a model.
    - A broken API or HTML recipe is rebuilt in the background while the browser answers.
    - A broken step is repaired while the call waits up to 5 minutes.
    - Every repair is tested, then published as a new version with its reason.
  - A daily health check in `tooldrop serve`, and `tooldrop tools check` to run it now.
  - Version history and rollback: `GET /v1/tools/:name/versions` and `POST /v1/tools/:name/rollback`, and `tooldrop tools versions` and `tooldrop tools rollback`.
  - API keys for OpenAI-compatible endpoints, sealed in the vault.
- Write builds from recordings (Phase 5): record a form submission once, and `tooldrop build --write` makes a write tool whose submit waits for approval. The build never submits: it previews the form instead.
- Users, roles and an audit log (Phase 5): viewers, editors and admins, each with their own API keys (`tooldrop users`), checked on every REST route and remote MCP call; every change over the API is logged with who made it (`tooldrop audit`, the dashboard's Audit log page).
- Multi-site workflows (Phase 5): chain tools on several sites into one, passing results between steps, with retries and compensating steps on failure. Writes still wait for approval. Workflows are MCP tools; also `/v1/workflows` and `tooldrop workflows`.
- URL-first discovery (Phase 5): give a URL only, and toolDrop looks around the site, signed in, and proposes tools to build. `discover_tools` over MCP, `POST /v1/discover`, `tooldrop discover`, and a Discover box on the dashboard.
- Code export (Phase 5): `tooldrop export <tool>` writes the tool as a standalone, typed npm package that runs without toolDrop, with toolDrop's runtime bundled in. A signed-in tool takes its login at call time; a write tool exports preview and commit.
- The transparency dashboard (Phase 5): each tool's page shows its calls, success rate, p50 and p95 latency and strategies, its builds and repairs with their model time and tokens, and a diff of any version against the current one. Also `GET /v1/tools/:name/stats` and `tooldrop tools stats`.
- Postgres (Phase 5): set `TOOLDROP_DATABASE_URL` to a Postgres URL and toolDrop keeps its data there instead of SQLite, creating its tables at start.
- The self-hosted Compose stack (Phase 5): `compose.yaml` now runs toolDrop with Postgres, Valkey and Ollama, with the master key and the database password as Compose secrets.
- A shared job queue (Phase 5): with `TOOLDROP_VALKEY_URL` set, builds and repairs wait on Valkey through BullMQ and run in whichever toolDrop server takes them, and SMS codes reach every process.
- Email codes (Phase 5): toolDrop reads a sign-in code from your inbox over IMAP, read-only, matched by sender and time. `tooldrop email connect` and `tooldrop logins add --email <sender>`.
- SMS codes from your own phone (Phase 5): an open-source forwarder app posts each SMS to toolDrop's signed webhook, and a sign-in waiting for a code takes it. `tooldrop sms enable` and `tooldrop logins add --sms <sender>`.
- Sign-in safeguards (Phase 4): toolDrop types a login only on the site or an identity provider you allowed once, and a captcha stops it: `tooldrop logins verify --by-hand` lets you sign in yourself and keeps the session. `tooldrop record` opens signed in on sites with a saved login.
- The dashboard (Phase 4), served by `tooldrop serve` on the same port as the API: tools with their schema, a cURL example, versions and rollback; runs; writes waiting for approval with screenshots, and the audit log; questions such as 2FA codes; repairs; and saved logins. New read routes: `GET /v1/tools/:name`, `GET /v1/runs` and `GET /v1/jobs`.
- The toolDrop Recorder Chrome extension (Phase 4): record a task once in your own Chrome, pick the inputs on a review page, and upload it to your toolDrop server or start the build from there. Installs unpacked.
- Safe mode (Phase 4): a write tool shows a preview with a screenshot of the filled form, and submits only once approved with `approve_action`, `POST /v1/approvals/:id` or `tooldrop approvals approve`. `dry_run`, policies such as "amount < 100", and an audit log of every write with screenshots from before and after.
- Watches (Phase 4): run a read tool every 5 minutes or more, and get each new, changed or removed row as a signed webhook and as an MCP log message. `create_watch`, `list_watches` and `delete_watch` over MCP, and `/v1/watches` over REST.
