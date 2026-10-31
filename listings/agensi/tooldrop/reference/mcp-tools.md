# toolDrop MCP tools

Besides these, every published tool and workflow is listed as its own MCP tool, named after it, with its own input schema.

## Using tools

| Tool | Inputs | What it does |
| --- | --- | --- |
| `find_tool` | `site`, `task` (both optional) | Searches published tools. Returns each match's name, description, site, authority and input schema. |
| `run_tool` | `name`, `input` | Runs a published tool by name. Calling the tool directly does the same. |
| `approve_action` | `approval_id`, `decision` (`approve` or `reject`) | Decides on a write's preview. Approving makes the write at once. Use only with the user's decision. |

A read tool returns `{ result, meta }`. `meta` has `strategy` (`official_api`, `http_replay`, `html_fetch` or `browser_script`), `duration_ms`, `recipe_version` and `healed`.

A workflow chains tools across sites. Calling one starts a run and returns a job: follow it with `get_job`.

## Building tools

| Tool | Inputs | What it does |
| --- | --- | --- |
| `build_tool` | `url`, `task`, `authority` (`read` or `write`); optional `inputs_hint`, `recording_id` | Starts a build job and returns it at once. A write build needs `recording_id`. |
| `discover_tools` | `url`; optional `max_pages` (1 to 50, default 12) | Looks around a site from one URL and proposes tools to build. Returns a job. |
| `get_job` | `job_id` | The job's status, its questions, and when it succeeds, the new tool with sample results. |
| `answer_question` | `job_id`, `question_id`, `answer` | Answers a job waiting with status `waiting_for_answer`. When the question has options, the answer must be one of them. |

## Logins

| Tool | Inputs | What it does |
| --- | --- | --- |
| `list_logins` | `site` (optional) | Saved logins with masked usernames. Never shows passwords or secrets. |
| `add_login` | `site`, `username`, `password`; optional `label`, `totp_secret`, `twofa: "human"` | Saves a login, encrypted on the machine. Prefer asking the user to run `tooldrop logins add <site>` instead. |

For 2FA: `totp_secret` lets toolDrop make authenticator codes itself. `twofa: "human"` makes toolDrop ask for each code through a job question. The CLI also supports codes by SMS (`tooldrop sms enable`) and email (`tooldrop email connect`).

## Watches

| Tool | Inputs | What it does |
| --- | --- | --- |
| `create_watch` | `tool`, `interval_s` (at least 300), `key_field`, `webhook_url`; optional `inputs` | Runs a read tool on a schedule and POSTs changed rows, signed with HMAC-SHA256. The first run is the baseline. The secret is shown once. |
| `list_watches` | none | Watches, with their last run and last error. |
| `delete_watch` | `watch_id` | Stops a watch. |

## Useful CLI commands

The user runs these in a terminal:

- `tooldrop logins add <site>`: save a login without sharing it with the agent.
- `tooldrop record <url> --task "..."`: do a task once in a browser, for the most reliable builds and for write tools.
- `tooldrop tools list`, `tooldrop tools versions <tool>`, `tooldrop tools rollback <tool> <version>`: inspect and roll back tools.
- `tooldrop approvals`: writes waiting for approval.
- `tooldrop serve`: the REST API and dashboard on http://127.0.0.1:3000.
