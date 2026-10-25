# Contributing to toolDrop

Thanks for helping. toolDrop turns tasks on websites into tools that AI agents can call, and it must stay free for everyone to run. This guide covers the rules, the setup and how changes land.

Before larger changes, read [SPEC.md](SPEC.md) (what we build), [PLAN.md](PLAN.md) (the order we build it in) and [DECISIONS.md](DECISIONS.md) (why things are the way they are). If your change contradicts one of them, open an issue first.

## Ground rules

1. **Zero cost.** Never add a dependency or service that needs a paid plan or a paid API key to run any feature. Every package must have an allowed license; `pnpm check:licenses` enforces it (DECISIONS.md, D-002).
2. **Local models first.** Every LLM call goes through `packages/llm`, and every feature must work with local Ollama models alone. Hosted APIs are optional.
3. **Recipes are data.** Recipes are declarative JSON executed by our runtime. Never `eval` or run code a model wrote.
4. **No real credentials, anywhere.** Not in code, tests, fixtures, recipes, logs, issues or screenshots. Tests use the fixture sites' test accounts.
5. **Tests touch only the fixtures.** Tests run against the local fixture sites in `fixtures/`, never real websites. CI never calls a real model.

## Set up

You need Node 24 (see `.nvmrc`) and pnpm 10.

```sh
git clone https://github.com/nabeelali0707/toolDrop.git
cd toolDrop
corepack enable   # provides the pnpm version pinned in package.json
pnpm install
pnpm check        # format, lint, typecheck, tests, license check
```

On Windows, `better-sqlite3` may compile from source during install, which needs a C++ toolchain (the free Visual Studio Build Tools with the "Desktop development with C++" workload).

Useful commands:

| Command | What it does |
| --- | --- |
| `pnpm test` | Unit and end-to-end tests (no real models) |
| `pnpm test:llm` | Tests against real Ollama models; run locally only |
| `pnpm lint` / `pnpm typecheck` / `pnpm format` | The individual checks |
| `pnpm check:licenses` | The zero-cost license check |
| `pnpm check:recipes` | Validates the community recipe library |
| `pnpm fixtures` | Starts the fixture sites on ports 4101 to 4104 |
| `pnpm docs:dev` | The documentation site on http://localhost:5173 |
| `pnpm changeset` | Describes your change for the next release |

## Code conventions

- TypeScript strict, ESM only. Node runs the `.ts` sources directly, so code must be erasable: no `enum`, `namespace` or constructor parameter properties; relative imports name the `.ts` file; type-only imports use `import type` (DECISIONS.md, D-024).
- Tests sit next to the code: `*.test.ts` for unit tests, `*.e2e.test.ts` for end-to-end tests, `*.llm.test.ts` for tests that need a real model.
- Match the code around you: its naming, its comment density, its error handling.

## Making a change

1. Open or pick an issue, and say you are working on it.
2. Create a branch, keep the change focused, and add tests.
3. Run `pnpm check`.
4. If the change affects people who install toolDrop, run `pnpm changeset` and describe it in one or two sentences. Choose `patch` for fixes and `minor` for features; before 1.0 there are no `major` changes.
5. Open a pull request. CI runs the checks and a secret scan; a maintainer reviews.

If your change alters behavior that SPEC.md describes, update SPEC.md in the same pull request, and record the reason in DECISIONS.md.

## Contributing a recipe

Recipes for public websites live in [`recipes/`](recipes/README.md). Each one is a folder with a manifest, the recipe, its schemas, test inputs and a README. CI validates the format and scans for secrets. Only add recipes for sites whose terms allow automated access, and never include credentials or personal data.

## Reporting bugs and asking for features

Use the issue forms. For anything security-related, follow [SECURITY.md](SECURITY.md) instead and report privately.

## Releases

Maintainers release from `main`:

1. `pnpm changeset version` applies the pending changesets: it bumps the `tooldrop` package version and updates its changelog.
2. Commit, then tag the commit `vX.Y.Z` and push the tag.
3. The release workflow builds and tests, publishes to npm with provenance, pushes the signed Docker image to `ghcr.io`, and attaches the Chrome extension zip and release notes to the GitHub release.

## License

toolDrop is licensed under [Apache-2.0](LICENSE). By contributing, you agree that your contribution is licensed under the same terms.

Everyone taking part follows our [Code of Conduct](CODE_OF_CONDUCT.md).
