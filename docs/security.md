# Security

toolDrop signs in to websites for you, so it holds your passwords, session cookies and 2FA secrets. These are the rules it is built on. Each one ships with the phase that builds it.

- **Encrypted at rest.** The vault encrypts every credential with libsodium. The master key stays in your OS keychain, or in a key file when self-hosted.
- **Never shown, never logged.** No API returns a saved secret. Logs, errors and prompts never contain credentials, and a test checks this by searching the logs.
- **Local by default.** With local models, nothing leaves your machine. Credentials and tokens are masked in every prompt, and personal data is redacted from anything sent to an external API.
- **Recipes are data.** A recipe is declarative JSON that toolDrop's own executor runs. Code written by a model is never run.
- **Writes need you.** Write tools need your approval to build, and preview every change before it happens ([safe mode](./safe-mode)).
- **Signed messages.** Webhooks are signed with HMAC-SHA256 and a timestamp, and forwarded SMS must carry a valid signature.
- **Community recipes are constrained.** They are read-only, need no sign-in, can only reach their own site, and are scanned for secrets in CI.

## Running it safely

- Keep the server on loopback, the default. For remote access, use TLS and treat API keys like passwords.
- Make the master key file readable only by the toolDrop user.
- Read a community recipe before running it.
- Keep your SMS forwarder's sender filter narrow.

## Reporting a vulnerability

Please report privately through [GitHub's vulnerability reporting](https://github.com/nabeelali0707/toolDrop/security/advisories/new), and never include real credentials. The full policy is in [SECURITY.md](https://github.com/nabeelali0707/toolDrop/blob/main/SECURITY.md).
