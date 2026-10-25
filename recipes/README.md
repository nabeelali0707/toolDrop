# Community recipe library

Ready-made toolDrop tools for public websites. A recipe here can be installed and run by anyone, without building it first and without a model.

The library is for **public data that needs no sign-in**. For a site you sign in to, build the tool locally with toolDrop: your credentials and the recipe stay on your machine.

## Layout

Each recipe is a folder named after the site's host and the tool's name:

```
recipes/
  hn.algolia.com/
    hn_front_page/
      manifest.json      what the tool is, who maintains it
      recipe.json        the steps toolDrop runs
      schema.json        input and output JSON Schemas
      test-inputs.json   2 or more inputs that must work
      README.md          what it does, for people
```

Copy [`_template/`](_template) to start, and see [`hn.algolia.com/hn_front_page`](hn.algolia.com/hn_front_page) for a complete example.

## Files

**`manifest.json`**

| Field | Meaning |
| --- | --- |
| `name` | The tool name agents call: lowercase snake_case, the same as the folder name |
| `title` | A short human title |
| `description` | What the tool returns and when to use it, written for the agent |
| `site` | The site's `https://` origin. The recipe may reach only this origin |
| `authority` | Always `read`: community recipes never change anything |
| `sign_in` | Always `none`: community recipes use public data only |
| `maintainers` | GitHub usernames of the people who keep it working |
| `tags` | Optional, lowercase |
| `terms_reviewed` | `true` once you have checked that the site's terms allow this automated access |

**`recipe.json`** follows the recipe format in [SPEC.md](../SPEC.md#data-models): a strategy and a list of declarative steps. URLs start with `{{site}}`, inputs are `{{input.<name>}}`, and page loops use `{{loop.<var>}}`. Prefer the cheapest strategy that works: `official_api`, then `http_replay`, then `html_fetch`, then `browser_script`.

**`schema.json`** holds `input` (an object schema whose properties are the tool's arguments) and `output`.

**`test-inputs.json`** lists at least 2 inputs. Each must match the input schema, and each must work against the real site when you test it locally.

## Rules

CI rejects a recipe that breaks any of these:

- **No credentials.** No passwords, cookies, tokens or API keys, and no `Authorization`, `Cookie` or API-key header or query value that is not a template. CI also runs gitleaks over the repository.
- **No personal data.** No email addresses, phone numbers, names of private people or account details, in test inputs or anywhere else.
- **One site only.** Every request goes to the manifest's `site`.
- **Read only, no sign-in.** `{{session.*}}` references are not allowed.
- **The format is valid:** the manifest, the recipe, the schemas, every test input against the input schema, and every `{{input.*}}` reference against the input schema.

Run the same checks locally:

```sh
pnpm check:recipes
```

Also respect the site: keep requests few (toolDrop rate-limits to 1 request per second by default), follow `robots.txt` for pages that are not APIs, and do not work around paywalls or access controls.
