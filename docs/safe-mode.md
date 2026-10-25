# Safe mode

::: info Status
Planned for Phase 4.
:::

Tools that change something (submit a form, approve an invoice, cancel an order) have `write` authority. toolDrop treats them with care twice: once when they are built, and again every time they run.

## When a write tool is built

Building a tool with `write` authority needs your explicit approval. MCP clients are told to ask you before they call `build_tool` with `authority: write`.

## When a write tool runs

1. **Preview.** The call returns a preview instead of acting: the fields it will fill, the page it will submit, and a screenshot of the filled form.
2. **Approve.** You approve or reject it with `approve_action`, in the dashboard, or with `POST /v1/approvals/:id`. A policy can approve routine cases for you, for example "auto-approve payments under $100".
3. **Act and record.** Only then does toolDrop submit. Every write is logged with evidence from before and after.

A rejected preview changes nothing on the site. Every write tool also takes a `dry_run` flag that stops after the preview.

## Good habits

- Build and test the read tools for a site first.
- Keep policies narrow and specific.
- Review the audit log in the dashboard from time to time.
