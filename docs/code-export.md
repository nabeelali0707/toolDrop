# Code export

::: info Status
Since Phase 5.
:::

Any tool can leave toolDrop as a standalone npm package: no lock-in. The package runs on Node.js 24 or newer, without toolDrop, its database or its models.

```sh
tooldrop export list_invoices --out ./list_invoices
cd list_invoices
npm install
npx playwright install chromium   # when the tool uses a browser
```

```js
import { list_invoices } from './list_invoices/index.js';

console.log(await list_invoices({ status: 'overdue' }));
```

## What is inside

- `tool.json`: the tool's input and output schemas and its recipe, the steps that call the site.
- `runtime.js`: toolDrop's runtime, bundled into one file. It validates the input and the result, runs the recipe, and falls back to the browser when the faster strategy breaks, as toolDrop does.
- `index.js` and `index.d.ts`: the function to call, with its input and result typed from the schemas. `createTool()` gives an instance that keeps its browser and session between calls; call `close()` when done.
- `README.md` and `LICENSE` (Apache-2.0, the runtime's license).

Its only dependencies are open-source npm packages, such as Playwright and Cheerio. Nothing of toolDrop is a dependency.

## Signing in

A tool for a site that needs a login gets the steps toolDrop signs in with, never the login itself. Pass the login when you call it, read from the environment or your own secret store:

```js
await protected_invoices({}, {
  login: {
    username: process.env.SITE_USERNAME,
    password: process.env.SITE_PASSWORD,
    totp_secret: process.env.SITE_TOTP, // for sites that ask for a one-time code
  },
});
```

Instead of `totp_secret`, `otp` takes a function that returns the code, for example by asking a person. toolDrop must have signed in to the site once before the tool can be exported (`tooldrop logins verify <site>`).

## Write tools

A write tool exports `preview()` and `commit()` instead of one function. `preview()` fills the form and returns what it would submit, with a screenshot, and submits nothing; `commit()` makes the write. toolDrop's safe mode, with its approvals and policies, does not travel with the export: your code decides when to commit.

## What it does not do

An exported tool does not repair itself. When the site changes and calls start failing, export the tool again from toolDrop, where it heals, or edit the recipe in `tool.json`.

The same files come from `GET /v1/tools/:name/export` as a map of paths to contents, for a key with access to every tool.
