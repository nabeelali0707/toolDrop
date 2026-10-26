# Self-hosting

::: info Status
`tooldrop serve` and the Docker image work today: the REST API and remote MCP on port 3000, with SQLite. The dashboard arrives with Phase 4, and Postgres and Valkey join the Compose stack with Phase 5.
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

Today this starts:

- **`app`**: the REST API and remote MCP on http://localhost:3000, published on the loopback address only. Its data, in SQLite, lives on the `tooldrop-data` volume.
- **`ollama`**, with its models on the `ollama-models` volume.
- **`models`**: a one-off service that downloads `qwen2.5-coder:7b` and `llama3.1:8b` on first start, then exits. With 16 GB of RAM or more, set `TOOLDROP_CODE_MODEL=qwen2.5-coder:14b`. Weights are never baked into an image.

On first start, the app creates an API key and prints it once; read it with `docker compose logs app`. Make more with `docker compose exec app tooldrop keys create`.

The app image is signed with [cosign](https://docs.sigstore.dev/) (keyless, with GitHub's identity). To verify it:

```sh
cosign verify ghcr.io/nabeelali0707/tooldrop:latest \
  --certificate-identity-regexp '^https://github.com/nabeelali0707/toolDrop/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

With self-hosted mode (Phase 5), `postgres` and `valkey` join the stack, and the vault's master key comes from a file of 32 random bytes mounted at `/run/secrets/tooldrop_master_key`. `tooldrop init` will generate it. Keep it readable only by the toolDrop user, and never commit it.

## Platform notes

- **Any container runtime works:** Docker Engine with Compose, or Podman. Docker Desktop is not required; larger companies need a paid subscription for it.
- **macOS:** Docker has no access to the Apple GPU, so run Ollama natively and start only the app: `OLLAMA_HOST=http://host.docker.internal:11434 docker compose up app`.
- **NVIDIA GPUs on Linux** need the free NVIDIA Container Toolkit.

## Remote access

The app listens on loopback by default. To reach it from other machines, put it behind a reverse proxy with TLS, for example Caddy with free Let's Encrypt certificates, and treat API keys like passwords.

## Privacy

toolDrop sends no telemetry, and the build tools' telemetry (Next.js, Turborepo) is turned off in its scripts and images.
