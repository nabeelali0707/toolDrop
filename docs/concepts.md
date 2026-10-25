# Concepts

toolDrop uses a model as a **compiler**, to build and repair tools, and never as the **runtime** that answers each call. Building a tool is slow and careful; running it is plain code and fast.

## Architecture

```
Callers      AI agents (MCP) · apps and scripts (REST) · dashboard · CLI
Interfaces   MCP server (stdio + Streamable HTTP) · REST API
Engine       Compiler (model) · Runtime (no model) · Healer (model) · Watches
Services     Vault + sessions · Browser pool · Model provider (Ollama) · Queue · Database
Targets      Websites: official APIs · internal JSON APIs · server-rendered HTML · browser UI
```

The model sits only in the compiler and the healer. Every normal call goes through the runtime.

## Terms

| Term | Meaning |
| --- | --- |
| **Site** | A website origin and how to sign in to it |
| **Tool** | One typed operation, e.g. `list_orders(status) -> Order[]` |
| **Recipe** | The compiled, versioned program behind a tool: a list of declarative steps, never code |
| **Strategy** | How a recipe runs: `official_api`, `http_replay`, `html_fetch` or `browser_script` |
| **Capture** | What a build or recording saw: network traffic, page snapshots, accessibility trees, user actions |
| **Authority** | What a tool may do: `read`, or `write`, which needs your approval |
| **Session** | Saved cookies and tokens for a login, reused across calls |
| **Heal** | A repair of a recipe that broke, published as a new tested version |
| **Watch** | A scheduled run of a tool that sends a webhook when the result changes |

## Strategies, cheapest first

1. **`official_api`:** the site's documented public API.
2. **`http_replay`:** the site's own internal JSON API, the one its pages call, replayed with your session.
3. **`html_fetch`:** the server-rendered HTML, fetched and parsed.
4. **`browser_script`:** a real browser that clicks and reads like you would.

A build picks the cheapest strategy that passes validation. At run time, a call that fails falls back to the browser, and if that fails too, a heal starts while the call waits for up to 5 minutes.

## A recipe

```json
{
  "strategy": "http_replay",
  "steps": [
    { "op": "http", "method": "GET", "url": "{{site}}/api/session/token", "save": { "token": "$.token" } },
    {
      "op": "http", "method": "GET", "url": "{{site}}/api/v1/orders",
      "headers": { "authorization": "Bearer {{vars.token}}" },
      "query": { "status": "{{input.status}}", "page": "{{loop.page}}" },
      "paginate": { "var": "page", "start": 1, "until": "$.meta.hasNextPage == false" }
    },
    { "op": "map", "path": "$.data[*]", "fields": { "id": "$.orderId", "status": "$.fulfillment.status" } }
  ]
}
```

::: v-pre
Templates fill in the site (`{{site}}`), the call's inputs (`{{input.*}}`), the session (`{{session.*}}`), the page loop (`{{loop.*}}`) and values saved by earlier steps (`{{vars.*}}`). Because a recipe is data, toolDrop can diff it, test it and repair one step without touching the others.
:::
