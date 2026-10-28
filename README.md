# toolDrop

**Turn any website task into a fast, self-healing tool your AI agent can call. Free, local and open source.**

[![CI](https://github.com/nabeelali0707/toolDrop/actions/workflows/ci.yml/badge.svg)](https://github.com/nabeelali0707/toolDrop/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/tooldrop.svg)](https://www.npmjs.com/package/tooldrop)
[![Docs](https://img.shields.io/badge/docs-online-informational.svg)](https://nabeelali0707.github.io/toolDrop/)

> **Status: early development, not on npm yet.** toolDrop builds tools from a task description or a recording, with local models, and runs them for your agent over MCP, REST and the CLI, with an automatic browser fallback. It signs in with saved logins and TOTP, repairs a tool when its site changes, watches tools for changes, asks before any write, records tasks in your own Chrome, and has a dashboard. [PLAN.md](PLAN.md) shows what is done and what is next.

<!-- Demo GIF: docs/public/demo.gif, recorded for the first release (build a tool, ask a question, watch it heal). -->

Describe a task once, such as "list my orders with status and delivery date", and toolDrop builds a typed tool for it. From then on, calls run as plain code in a few seconds, with no model involved, and when the website changes, the tool repairs itself.

## Quick start in 1 minute

1. **Set up a model:** run `npx -y tooldrop init`. It checks for [Ollama](https://ollama.com/download), recommends a model for your machine and downloads it.
2. **Add toolDrop to your MCP client.** For Claude Desktop, add this to `claude_desktop_config.json` ([other clients](#install)):
   ```json
   { "mcpServers": { "tooldrop": { "command": "npx", "args": ["-y", "tooldrop", "mcp"] } } }
   ```
3. **Ask your agent:** "Build a tool that lists my Demo Shop orders with status and delivery date. Read only."

## How it works

toolDrop uses a model as a **compiler**, never as the runtime. Building a tool is the only step that needs a model; running it is plain code.

1. **Build.** toolDrop signs in to the site, then records what you do, or explores the site itself. It finds the cheapest way to get the data: an official API, the site's own JSON API, its HTML, or the browser. It writes a declarative recipe, checks it with two to three sets of inputs, and publishes it as an MCP tool and a REST endpoint.
2. **Run.** Calls go straight to the fastest working strategy, typically 1 to 5 seconds over HTTP. If a strategy fails, the call falls back to the next one.
3. **Heal.** When the site changes, toolDrop repairs only the failing step, tests the fix and publishes a new version while the call waits. The dashboard shows why, e.g. "Date filter moved into a new Search options panel".

See [the architecture](SPEC.md#system-architecture) and [concepts](https://nabeelali0707.github.io/toolDrop/concepts).

## Install

| Option | Command | Best for |
| --- | --- | --- |
| **npx** (recommended) | Add to your MCP client, below | Using toolDrop from an AI agent |
| **Docker Compose** | `docker compose up` | A self-hosted server with the dashboard on http://localhost:3000 |
| **Global CLI** | `npm install -g tooldrop`, then `tooldrop serve` | The REST API and dashboard on your machine |
| **From source** | `git clone`, `pnpm install`, `pnpm dev` | Contributing |
| **Chrome extension** | "Load unpacked" from the zip in each [release](https://github.com/nabeelali0707/toolDrop/releases) | Recording a task by doing it once |

### MCP clients

**Claude Desktop:** add to `claude_desktop_config.json`:

```json
{ "mcpServers": { "tooldrop": { "command": "npx", "args": ["-y", "tooldrop", "mcp"] } } }
```

**Claude Code:**

```sh
claude mcp add tooldrop -- npx -y tooldrop mcp
```

**Cursor:** add to `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "tooldrop": { "command": "npx", "args": ["-y", "tooldrop", "mcp"] } } }
```

**VS Code:** add to `.vscode/mcp.json`:

```json
{ "servers": { "tooldrop": { "type": "stdio", "command": "npx", "args": ["-y", "tooldrop", "mcp"] } } }
```

On Windows, if your client cannot find `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "tooldrop", "mcp"]`.

### Docker Compose

```sh
curl -O https://raw.githubusercontent.com/nabeelali0707/toolDrop/main/compose.yaml
docker compose up
```

This starts toolDrop, Postgres, Valkey and Ollama, and downloads a model on first start. Docker Desktop is not required: Docker Engine or Podman work too. See [self-hosting](https://nabeelali0707.github.io/toolDrop/self-hosting).

## Choose a model

toolDrop runs on free local models through [Ollama](https://ollama.com). `tooldrop init` picks them for you:

| Your machine | Recipes and repairs | Reasoning |
| --- | --- | --- |
| Under 16 GB of RAM | `qwen2.5-coder:7b` | `llama3.1:8b` |
| 16 GB of RAM or more | `qwen2.5-coder:14b` | `llama3.1:8b` |

You can also bring your own model: any OpenAI-compatible endpoint, such as llama.cpp, vLLM, LM Studio or a free-tier hosted API. `tooldrop init` asks for the URL and key, and stores the key encrypted in the vault. Nothing requires a paid API. See [models](https://nabeelali0707.github.io/toolDrop/models).

## Security

toolDrop handles your credentials, so it is built to keep them on your machine:

- Credentials are encrypted in a local vault and never returned by any API or written to logs.
- With local models, nothing leaves your machine. If you configure an external API, credentials are masked and personal data is redacted before anything is sent.
- Recipes are declarative JSON, never code written by a model.
- Tools that change data need your approval to build, and preview every write before it runs.

Found a vulnerability? Please report it privately, as described in [SECURITY.md](SECURITY.md).

## Community recipes

[`recipes/`](recipes/README.md) holds ready-made tools for public websites that anyone can install. Contributions are welcome; CI checks the format and scans every recipe for secrets.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up the repo and send a change, and follow the [Code of Conduct](CODE_OF_CONDUCT.md). The design lives in [SPEC.md](SPEC.md), the build order in [PLAN.md](PLAN.md) and the reasoning in [DECISIONS.md](DECISIONS.md).

## License

[Apache-2.0](LICENSE).
