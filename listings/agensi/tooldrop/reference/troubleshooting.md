# Troubleshooting toolDrop

## The MCP server does not start or connect

- Check `node --version`: toolDrop needs Node.js 24 or newer.
- Run `npx -y tooldrop mcp` in a terminal. It should wait silently; stop it with Ctrl+C. An error printed there is the cause.
- The first start downloads the package, which can take about 30 seconds. Restart the client if it timed out.
- Claude Desktop logs MCP servers in `%APPDATA%\Claude\logs` (Windows) or `~/Library/Logs/Claude` (macOS).

## Error codes

Errors come back as `{ "error": { "code", "message", "details" } }`.

| Code | Meaning | What to do |
| --- | --- | --- |
| `invalid_input` | The inputs do not match the tool's schema. | Check the tool's input schema with `find_tool` and call it again. |
| `not_found` | No tool, job, watch or approval with that name or id. | Use `find_tool` or `list_watches` to get the right name. |
| `forbidden` | The API key or role does not allow this. | Tell the user; an admin can change the key's scopes or the user's role. |
| `approval_required` | A write is waiting for approval. | Show the preview to the user and call `approve_action` with their decision. |
| `conflict` | The approval was already decided or expired, or the tool changed since. | Call the tool again for a fresh preview. |
| `human_needed` | A person must act first, e.g. sign in by hand past a captcha. | Tell the user what the message says; do not try to get around it. |
| `session_expired` | The site's session expired and signing in again failed. | Ask the user to run `tooldrop logins verify <site>`. |
| `strategy_failed` | Every way of running the tool failed. | Run `tooldrop tools check` to repair, or rebuild the tool. |
| `heal_timeout` | A repair did not finish within 5 minutes. | Try again later; check `tooldrop tools versions <tool>`. |
| `rate_limited` | Too many calls. | Wait and call again less often. |
| `llm_unavailable` | Ollama is not running or cannot be reached. | Ask the user to start Ollama, or run `npx -y tooldrop init`. |
| `llm_invalid_output` | The model's answers failed checks after every retry. | Build again with a clearer task or an `inputs_hint`, or record the task with `tooldrop record`. |
| `llm_prompt_too_large` | The page is too big for the model. | Start from a more specific URL. |
| `vault_unavailable` | The master key cannot be read. | On a server, check the mounted key file; locally, check the OS keychain. |

## A build fails or gives the wrong data

- Start from the page that shows the data, not the home page.
- Name the fields you want in `task`, e.g. "order number, status, delivery date".
- Record the task once with `tooldrop record <url> --task "..."` and pass the recording's id as `recording_id`. Recorded builds are the most reliable.
