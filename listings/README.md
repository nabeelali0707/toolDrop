# MCP directory listings

Everything needed to list toolDrop in MCP directories. **Nothing here has been submitted.** A maintainer does each step by hand, after the first release is on npm.

| Directory | File in this repo | Submitted by |
| --- | --- | --- |
| [Official MCP Registry](https://registry.modelcontextprotocol.io) | [`server.json`](../server.json) | `mcp-publisher` CLI |
| [Glama](https://glama.ai/mcp/servers) | [`glama.json`](../glama.json) | Glama's website |
| [Smithery](https://smithery.ai) | [`smithery.yaml`](../smithery.yaml) | Smithery's website |
| [mcp.so](https://mcp.so) | none | mcp.so's submission form |

## Before any listing

1. The `tooldrop` package is published on npm.
2. Its `package.json` contains `"mcpName": "io.github.nabeelali0707/tooldrop"`, exactly the `name` in `server.json`. The registry checks this.
3. Both `version` fields in `server.json` equal the published npm version.

## Copy

**Name:** toolDrop

**Short description** (the registry allows 100 characters; this is 95):

> Turn website tasks into fast, self-healing MCP tools. Free and local, built with Ollama models.

**Long description:**

> toolDrop turns a task on any website into a typed MCP tool. Describe it once ("list my orders with status and delivery date") or record it, and a local model builds a declarative recipe, tests it and publishes it. After that, every call runs as plain code in a few seconds, with no model involved. When the website changes, toolDrop repairs only the failing step and publishes a new version. It runs entirely on your machine with free Ollama models, keeps credentials in an encrypted vault, and asks before any write. Apache-2.0.

**Categories:** Browser automation, Developer tools, Web data

**Tags:** web-automation, browser, playwright, self-healing, local-first, ollama, mcp-tools

**Links:** repository `https://github.com/nabeelali0707/toolDrop`, docs `https://nabeelali0707.github.io/toolDrop/`, npm `https://www.npmjs.com/package/tooldrop`

**Install:**

```json
{ "mcpServers": { "tooldrop": { "command": "npx", "args": ["-y", "tooldrop", "mcp"] } } }
```

## 1. Official MCP Registry

1. Install the publisher CLI ([official quickstart](https://modelcontextprotocol.io/registry/quickstart)):
   - macOS and Linux:
     ```sh
     curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
     ```
   - or Homebrew: `brew install mcp-publisher`.
   - Windows: see the quickstart for the PowerShell command.
2. From the repository root, sign in with the GitHub account that owns the repo: `mcp-publisher login github`. The `io.github.nabeelali0707/` namespace requires this account.
3. Publish: `mcp-publisher publish`. It reads `server.json` from the current directory.
4. Check the listing:
   ```sh
   curl "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.nabeelali0707/tooldrop"
   ```

For each later release, bump both versions in `server.json` and publish again. This can move into the release workflow later with GitHub OIDC, which needs no stored token.

## 2. Glama

Glama indexes public GitHub MCP servers on its own.

1. Sign in at [glama.ai](https://glama.ai) with the GitHub account that owns the repository.
2. Find toolDrop under MCP servers. If it is not there yet, use **Add server** with the repository URL.
3. Claim the listing. For a repo on a personal account, signing in with GitHub is enough; `glama.json` also names the maintainers.
4. Paste the long description and the tags above if Glama asks.

## 3. Smithery

1. Sign in at [smithery.ai](https://smithery.ai) with GitHub.
2. Add a server and choose the `toolDrop` repository. Smithery reads `smithery.yaml`: toolDrop runs locally over stdio with `npx -y tooldrop mcp` and needs no configuration.
3. Paste the copy above.

Smithery's configuration format has changed over time. If it rejects `smithery.yaml`, follow the current format in [Smithery's docs](https://smithery.ai/docs) and update the file.

## 4. mcp.so

1. Open [mcp.so](https://mcp.so) and choose **Submit**.
2. Enter the name, the short description, the repository URL, the category and the install JSON above.
