# Self-hosting

::: info Status
Local mode arrives with the first release. The Docker Compose stack is planned for Phase 5.
:::

toolDrop is self-host only: there is no managed cloud version, and no setup uses a paid cloud service.

| | Local | Self-hosted |
| --- | --- | --- |
| Runs with | `tooldrop serve` on one machine | `docker compose up` |
| Database | SQLite | Postgres |
| Job queue | In-process | BullMQ on Valkey |
| Master key | OS keychain | Key file, mounted as a Compose secret |
| Models | Ollama on the same machine | The `ollama` service |

## Docker Compose

```sh
curl -O https://raw.githubusercontent.com/nabeelali0707/toolDrop/main/compose.yaml
docker compose up
```

This starts four services: `app` (the REST API, the MCP server over HTTP, the job workers and the dashboard, on http://localhost:3000), `postgres`, `valkey` and `ollama`. A model is downloaded on first start; weights are never baked into an image.

The master key is a file of 32 random bytes, mounted at `/run/secrets/tooldrop_master_key`. `tooldrop init` generates it. Keep it readable only by the toolDrop user, and never commit it.

## Platform notes

- **Any container runtime works:** Docker Engine with Compose, or Podman. Docker Desktop is not required; larger companies need a paid subscription for it.
- **macOS:** Docker has no access to the Apple GPU, so run Ollama natively and point toolDrop at `http://host.docker.internal:11434`. The `ollama` service sits behind a Compose profile.
- **NVIDIA GPUs on Linux** need the free NVIDIA Container Toolkit.

## Remote access

The app listens on loopback by default. To reach it from other machines, put it behind a reverse proxy with TLS, for example Caddy with free Let's Encrypt certificates, and treat API keys like passwords.

## Privacy

toolDrop sends no telemetry, and the build tools' telemetry (Next.js, Turborepo) is turned off in its scripts and images.
