# The dashboard

::: info Status
Since Phase 4. The transparency dashboard, with latency, token use and version diffs per tool, comes with Phase 5.
:::

`tooldrop serve` serves a dashboard next to the REST API, at [http://127.0.0.1:3000](http://127.0.0.1:3000) by default; the Docker image serves it on the same port.

## Sign in

The dashboard uses the REST API with an API key, as any client does. Paste the key `tooldrop serve` printed when it first started, or make one with `tooldrop keys create`. The key stays in your browser until you click **Sign out**. A key limited to some tools shows only those tools.

## What it shows

- **Tools:** every published tool. Each tool's page shows its input and output schema, a ready cURL example, its versions and repairs with a button to roll back, and its recent runs.
- **Runs:** the latest calls: which tool, which version, how it ran (API, HTML or browser), how long it took and how it went. Results are never kept.
- **Approvals:** writes waiting for your decision, each with the fields it will fill and a screenshot of the filled form. Approving makes the write at once; rejecting changes nothing. Below it, every past write with who decided and how it went. See [Safe mode](./safe-mode).
- **Questions and repairs:** builds and sign-ins waiting for an answer, such as a 2FA code, with a box to answer. Then the latest repairs and builds.
- **Logins:** saved logins with masked usernames, and a form to save a new one into the encrypted vault. See [Auth and 2FA](./auth-and-2fa).
