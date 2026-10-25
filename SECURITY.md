# Security policy

toolDrop signs in to websites on your behalf. It stores passwords, session cookies, API keys and 2FA secrets, and it runs automation against sites where you are signed in. A security bug here can expose someone's accounts, so please report problems privately and give us a chance to fix them first.

## Report a vulnerability privately

**Do not open a public issue, pull request or discussion about a security problem.**

Use GitHub's private reporting: **[report a vulnerability](https://github.com/nabeelali0707/toolDrop/security/advisories/new)**. Only the maintainers can see the report.

Please include:

- what an attacker could do, and what they need first (local access, a malicious website, a crafted recipe, a position on the network);
- steps to reproduce, ideally against the local fixture sites (`pnpm fixtures`), never a real account;
- the toolDrop version or commit, your OS and, if relevant, the model configuration.

**Never put real credentials in a report.** No passwords, session cookies, API keys, TOTP secrets or 2FA codes, not even your own, and not in screenshots or logs. Use the fixtures' test account or redact. If you found real secrets exposed somewhere, tell us where they appear, not what they are.

What happens next:

- We aim to acknowledge your report within 5 working days and to send a first assessment within 14 days.
- We agree on a fix and a disclosure date with you. Please wait 90 days, or until a fixed release ships, before disclosing publicly.
- With your permission, we credit you in the release notes.

## Supported versions

toolDrop is before 1.0. Security fixes go into the latest release only.

## Scope

In scope, for example:

- a credential, cookie, token or 2FA secret that ends up in plain text on disk, in a log, an error, an API response or a prompt to a model;
- reading vault contents without the master key, or getting the master key from a file, environment or log where it should not be;
- a recipe, including one from the community library, that runs code, reads local files or reaches hosts it should not;
- a write action that runs without the approval safe mode requires;
- REST or MCP endpoints that work without a valid API key, or keys that work beyond their scopes;
- a forged webhook or a forged forwarded SMS that toolDrop accepts as genuine;
- content on a website that makes the model leak secrets or publish a harmful recipe (prompt injection through captured pages).

Out of scope:

- a website blocking automation, or a tool breaking because a site changed: please open a normal issue;
- attacks that need an already compromised machine or a stolen master key;
- scanner output without a demonstrated impact.

## How toolDrop protects secrets

These are design rules from [SPEC.md](SPEC.md). toolDrop is in early development, and each protection ships with the phase that builds it (see [PLAN.md](PLAN.md)).

- **Encrypted vault.** Credentials are encrypted at rest with libsodium. The master key lives in the OS keychain, or in a key file mounted at runtime when self-hosted. It is never baked into an image, passed in an environment variable, logged or stored in the database.
- **Nothing returned, nothing logged.** No API returns a stored secret, only masked previews. Logs, errors and prompts never contain credentials, which a test checks by searching the logs.
- **Local by default.** Browsers, vault, runtime and models run on your machine; nothing leaves it unless you configure an external model API. Credentials and tokens are masked in every prompt, and personal data is redacted from anything sent to an external API.
- **Recipes are data, not code.** A recipe is declarative JSON run by toolDrop's executor. Code written by a model is never evaluated.
- **Writes need approval.** Write tools need explicit authority when they are built and an approval when they run (safe mode).
- **Signed inbound and outbound messages.** Outgoing webhooks are signed with HMAC-SHA256 and a timestamp; forwarded SMS must carry a valid signature.

## Running toolDrop safely

- Keep `tooldrop serve` on loopback (the default). For remote access, put it behind a TLS reverse proxy and treat API keys like passwords.
- Make the master key file readable by the toolDrop user only, and never commit it.
- Read a community recipe before you run it. Safe mode previews every write.
- Set your SMS forwarder's sender filter so only 2FA messages leave your phone.
