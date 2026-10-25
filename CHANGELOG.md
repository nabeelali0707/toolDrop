# Changelog

All notable changes to toolDrop. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file covers the project as a whole. From the first release on, the published `tooldrop` package also gets its own changelog, written by Changesets from the change descriptions in each pull request.

## [Unreleased]

### Added

- The specification for a zero-cost, local-first toolDrop: local models through Ollama, SMS codes from your own phone, self-hosting with Docker Compose, and a rule that no feature may need a paid plan or paid API key ([SPEC.md](SPEC.md)).
- The build plan ([PLAN.md](PLAN.md)) and the decision log ([DECISIONS.md](DECISIONS.md)).
- The workspace: pnpm and Turborepo on Node 24, TypeScript 6.0, ESLint, Prettier, Vitest and GitHub Actions CI.
- A license check that enforces the zero-cost rule on every installed package.
- `@tooldrop/core`: the recipe format, and the tool, job, run and recipe-library schemas.
- `@tooldrop/db`: the database schema for every table in the spec, with its first migration.
- Fixture sites that all tests run against: a JSON-API app, a server-rendered app, a login with TOTP, and the Demo Shop.
- The community recipe library, with format validation and secret scanning in CI.
- Open-source project files: the Apache-2.0 license, a contributing guide, the Contributor Covenant, a security policy, issue and pull request templates, and Dependabot.
