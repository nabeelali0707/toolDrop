# Self-hosting

::: info Status
Self-hosted mode works: `docker compose up` starts toolDrop with Postgres, Valkey and Ollama. `tooldrop serve` works on its own too, with SQLite or [Postgres](#postgres), and optionally [Valkey](#valkey).
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

Get the stack and make its two secrets: the vault's master key, and the database password. toolDrop runs as uid 10001 in its container, so the files belong to that user and nobody else can read them:

```sh
mkdir tooldrop && cd tooldrop
curl -O https://raw.githubusercontent.com/nabeelali0707/toolDrop/main/compose.yaml
mkdir secrets
openssl rand -base64 32 > secrets/tooldrop_master_key
openssl rand -hex 24 > secrets/postgres_password
chmod 600 secrets/*
sudo chown 10001 secrets/*
docker compose up
```

This starts:

- **`app`**: the REST API, the dashboard and remote MCP on http://localhost:3000, published on the loopback address only. Recordings and captures live on the `tooldrop-data` volume.
- **`postgres`**: the database, on the `postgres-data` volume.
- **`valkey`**: the job queue and SMS codes, on the `valkey-data` volume, so jobs waiting in the queue survive a restart.
- **`ollama`**, with its models on the `ollama-models` volume.
- **`models`**: a one-off service that downloads `qwen2.5-coder:7b` and `llama3.1:8b` on first start, then exits. With 16 GB of RAM or more, set `TOOLDROP_CODE_MODEL=qwen2.5-coder:14b`. Weights are never baked into an image.

Postgres and Valkey are reachable only inside the stack. On first start, the app creates an API key and prints it once; read it with `docker compose logs app`. Make more with `docker compose exec app tooldrop keys create`.

The master key seals every saved login, and nothing can open them without it. Back it up apart from the volumes, never commit it, and never reuse it elsewhere. The vault refuses a key file that other users can read. On macOS and Windows, keep the stack's folder where Docker sees Linux file permissions: inside WSL2 on Windows.

The app image is signed with [cosign](https://docs.sigstore.dev/) (keyless, with GitHub's identity). To verify it:

```sh
cosign verify ghcr.io/nabeelali0707/tooldrop:latest   --certificate-identity-regexp '^https://github.com/nabeelali0707/toolDrop/'   --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

The image also runs on its own, without the stack: `docker run -p 127.0.0.1:3000:3000 -v tooldrop-data:/data ghcr.io/nabeelali0707/tooldrop:latest`. It keeps its data in SQLite and creates the master key in `/data/master.key`, in the same volume as the database, so anyone who can read that volume, or a backup of it, can open the saved logins.

## Users and roles

Each person gets a user with a role, and API keys of their own. Run the commands inside the app's container:

```sh
docker compose exec app tooldrop users add alice --role editor
```

| Role | May |
| --- | --- |
| `viewer` | See tools, runs, jobs, approvals, watches and workflows, and run read tools |
| `editor` | Also build and discover tools, publish and roll back, run write tools and approve writes, answer questions, and manage watches and workflows |
| `admin` | Also save logins, set approval policies, and read the audit log |

A key's scopes still limit which tools it may use. A key of no user, such as the first one `tooldrop serve` prints, acts as an admin. `tooldrop users list`, `tooldrop users role <name> <role>` and `tooldrop users remove <name>` (which removes their keys too) manage them; `tooldrop keys create --user <name>` gives someone another key.

**The audit log** records every change made over the REST API and remote MCP: who, what, on which tool or job, and the outcome, including refused attempts. Reads are not logged, and a request's body never is. Admins read it on the dashboard's Audit log page, with `GET /v1/audit`, or with `tooldrop audit`. Writes keep their own, fuller record in the approvals: inputs, preview, screenshots and outcome.

The terminal and local MCP clients act as the machine's owner, outside roles.

## Postgres

toolDrop uses Postgres when `TOOLDROP_DATABASE_URL` holds a Postgres URL, for `tooldrop serve`, the Docker image and every other command:

```sh
TOOLDROP_DATABASE_URL=postgres://tooldrop:<password>@db.internal:5432/tooldrop tooldrop serve
```

The password may instead come from a file, as the Compose stack does: `TOOLDROP_DATABASE_PASSWORD_FILE=/run/secrets/postgres_password`, with the URL left without one.

It creates and updates its tables at start, so an empty database is enough. Without the variable, it keeps using SQLite. CI tests it on Postgres 18, and it needs no extension.

Saved logins and sessions are sealed by the vault before they reach the database, as with SQLite, but the database still says which sites have logins. Give toolDrop a database and user of its own, and keep the URL out of shell history and logs, since it holds the password.

## Valkey

With `TOOLDROP_VALKEY_URL` set to a Valkey (or Redis-compatible) server, every toolDrop process shares one job queue and the SMS codes:

```sh
TOOLDROP_VALKEY_URL=redis://valkey.internal:6379 tooldrop serve
```

- Builds and repairs wait in the queue, and `tooldrop serve` (or `tooldrop mcp`) runs them; a build asked for from any process may run in another. Other commands, such as `tooldrop build`, only add jobs and follow them, so keep a server running.
- An SMS code forwarded to any process reaches the sign-in waiting for it in another. Only the code goes to Valkey, never the message, and it expires after 5 minutes.
- Every process needs the same data directory (`TOOLDROP_HOME`), where recordings and captures are kept.

Valkey 8.1 is what CI tests. Without the variable, each process keeps its own queue and codes in memory.

## Platform notes

- **Any container runtime works:** Docker Engine with Compose, or Podman. Docker Desktop is not required; larger companies need a paid subscription for it.
- **macOS:** Docker has no access to the Apple GPU, so run Ollama natively and start only the app: `OLLAMA_HOST=http://host.docker.internal:11434 docker compose up app`.
- **NVIDIA GPUs on Linux** need the free NVIDIA Container Toolkit.

## Remote access

The app listens on loopback by default. To reach it from other machines, put it behind a reverse proxy with TLS, for example Caddy with free Let's Encrypt certificates, and treat API keys like passwords.

## Privacy

toolDrop sends no telemetry, and the build tools' telemetry (Next.js, Turborepo) is turned off in its scripts and images.
