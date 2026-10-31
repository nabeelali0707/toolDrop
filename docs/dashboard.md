# The dashboard

::: info Status
Since Phase 4; the transparency figures, with latency, token use and version diffs per tool, since Phase 5.
:::

`tooldrop serve` serves a dashboard next to the REST API, at [http://127.0.0.1:3000](http://127.0.0.1:3000) by default; the Docker image serves it on the same port.

## Sign in

The dashboard uses the REST API with an API key, as any client does. Paste the key `tooldrop serve` printed when it first started, or make one with `tooldrop keys create`. The key stays in your browser until you click **Sign out**. A key limited to some tools shows only those tools.

## What it shows

- **Tools:** every published tool. Each tool's page shows:
  - how its calls went over the last 30 days: how many, the share that worked, p50 and p95 latency, which strategy answered, and how many waited for a repair;
  - its input and output schema, and a ready cURL example;
  - its versions, with what changed against the current one and a button to roll back;
  - its builds and repairs: why each ran, how it ended, and its model time;
  - the model calls, tokens and time its builds and repairs took;
  - its recent runs.
- **Runs:** the latest calls: which tool, which version, how it ran (API, HTML or browser), how long it took and how it went. Results are never kept.
- **Approvals:** writes waiting for your decision, each with the fields it will fill and a screenshot of the filled form. Approving makes the write at once; rejecting changes nothing. Below it, every past write with who decided and how it went. See [Safe mode](./safe-mode).
- **Questions and repairs:** builds and sign-ins waiting for an answer, such as a 2FA code, with a box to answer. Then the latest repairs and builds.
- **Logins:** saved logins with masked usernames, and a form to save a new one into the encrypted vault. See [Auth and 2FA](./auth-and-2fa).

The same figures come from `GET /v1/tools/:name/stats` (with `?days=` from 1 to 365) and, in the terminal, `tooldrop tools stats <tool>`; one version's recipe from `GET /v1/tools/:name/versions/:version`. Both need a key with access to every tool.
