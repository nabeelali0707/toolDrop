# Agensi skill

[Agensi](https://www.agensi.io) lists agent skills (a `SKILL.md` with reference files), not MCP servers. The skill in [`tooldrop/`](tooldrop/SKILL.md) teaches an agent to set up toolDrop and use its MCP tools. **It has not been submitted.**

## Package it

From the repository root:

```sh
cd listings/agensi && zip -r ../../tooldrop-skill.zip tooldrop
```

The zip has `tooldrop/SKILL.md` and `tooldrop/reference/`. It has no scripts.

## Submit it

1. Sign in at [agensi.io](https://www.agensi.io) and open the creator dashboard.
2. Upload `tooldrop-skill.zip`.
3. Price: **free**. toolDrop is free and open source; a paid listing would also need a payout account and KYC.
4. Paste the copy below. Review takes 24 to 48 hours.

## Copy

**Name:** toolDrop

**Short description:**

> Turn any website task into a fast, self-healing tool your agent can call. Free and local.

**Long description:**

> This skill teaches your agent to use toolDrop, a free, open-source MCP server. Describe a task on a website once ("list my orders with status and delivery date"), and a local model builds a typed tool for it. After that, every call runs as plain code in a few seconds, with no model involved, and the tool repairs itself when the site changes. The skill covers setup, building and running tools, sign-ins and 2FA, approvals before any write, and watches that post changes to a webhook. Everything runs on your machine with free Ollama models; no paid API or service.

**Network use** (Agensi asks skills to disclose it): the skill installs `tooldrop` from npm, `tooldrop init` downloads a model through Ollama and Chromium through Playwright, and toolDrop visits only the websites the user names.

**Tags:** web-automation, mcp, browser, scraping, local-first, ollama

**Links:** repository `https://github.com/nabeelali0707/toolDrop`, docs `https://nabeelali0707.github.io/toolDrop/`, npm `https://www.npmjs.com/package/tooldrop`

## Keep it current

When toolDrop's MCP tools change (`apps/mcp/src/server.ts`), update `tooldrop/reference/mcp-tools.md` and upload a new zip.
