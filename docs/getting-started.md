# Getting started

::: info Status
The `tooldrop` package is not on npm yet: until the first release, run it [from source](https://github.com/nabeelali0707/toolDrop/blob/main/CONTRIBUTING.md). Running tools and building them work today, including behind a sign-in like the Demo Shop's below. See the [plan](https://github.com/nabeelali0707/toolDrop/blob/main/PLAN.md).
:::

toolDrop runs as an [MCP](https://modelcontextprotocol.io) server that your AI agent talks to. You need [Node.js](https://nodejs.org) 24 or newer, and [Ollama](https://ollama.com/download) for the local models.

## 1. Set up a model

```sh
npx -y tooldrop init
```

`init` checks that Ollama is installed and running, and explains how to install it if not. It then looks at your memory and recommends models:

| Your machine | Recipes and repairs | Reasoning |
| --- | --- | --- |
| Under 16 GB of RAM | `qwen2.5-coder:7b` | `llama3.1:8b` |
| 16 GB of RAM or more | `qwen2.5-coder:14b` | `llama3.1:8b` |

It downloads them, or lets you point toolDrop at your own OpenAI-compatible endpoint instead. See [Models](./models).

## 2. Add toolDrop to your MCP client

::: code-group

```json [Claude Desktop]
// claude_desktop_config.json
{ "mcpServers": { "tooldrop": { "command": "npx", "args": ["-y", "tooldrop", "mcp"] } } }
```

```sh [Claude Code]
claude mcp add tooldrop -- npx -y tooldrop mcp
```

```json [Cursor]
// ~/.cursor/mcp.json
{ "mcpServers": { "tooldrop": { "command": "npx", "args": ["-y", "tooldrop", "mcp"] } } }
```

```json [VS Code]
// .vscode/mcp.json
{ "servers": { "tooldrop": { "type": "stdio", "command": "npx", "args": ["-y", "tooldrop", "mcp"] } } }
```

:::

On Windows, if the client cannot find `npx`, use `"command": "cmd"` and `"args": ["/c", "npx", "-y", "tooldrop", "mcp"]`.

## 3. Build your first tool

Ask your agent, for example:

> Build a tool that lists my Demo Shop orders with status and delivery date. Read only.

toolDrop signs in, finds where the data comes from, builds `list_orders`, tests it and publishes it. Then ask a question that uses it:

> Which of my orders haven't been delivered yet?

The agent calls `list_orders`, which answers in a second or two without a model.

## Try it on the Demo Shop

The repository includes a practice shop, so you can try toolDrop without a real account:

```sh
git clone https://github.com/nabeelali0707/toolDrop.git
cd toolDrop && pnpm install && pnpm fixtures
```

The Demo Shop runs at `http://127.0.0.1:4104` with the test account `demo-shopper` / `demo-shop-password-not-real`. Its TOTP secret, printed by `pnpm fixtures`, is a public test value: add it to any authenticator app.

Before you ask for the tool, save the shop's login so toolDrop can sign in by itself. Type the password and the TOTP secret when asked:

```sh
npx -y tooldrop logins add http://127.0.0.1:4104 --username demo-shopper --totp
```

## Other ways to install

- **Global CLI:** `npm install -g tooldrop`, then `tooldrop serve` for the REST API and dashboard.
- **Docker Compose:** a self-hosted server; see [Self-hosting](./self-hosting).
- **From source:** `git clone`, `pnpm install`, `pnpm dev`; see the [contributing guide](https://github.com/nabeelali0707/toolDrop/blob/main/CONTRIBUTING.md).
- **Chrome extension:** to record a task by doing it once; see [Recording mode](./recording-mode).
