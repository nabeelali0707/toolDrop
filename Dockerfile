# syntax=docker/dockerfile:1
# toolDrop's app image: the REST API and remote MCP on port 3000.
# Self-hosting guide: https://nabeelali0707.github.io/toolDrop/self-hosting

# Build: bundle the `tooldrop` package from the workspace.
FROM node:24-bookworm-slim AS build
WORKDIR /src
ENV DO_NOT_TRACK=1 TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && cd apps/cli \
 && pnpm pack --pack-destination /out

# Run: the package as users install it, Chromium for the browser strategy,
# and a non-root user. Model weights are never baked in (SPEC, Self-hosting).
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    TOOLDROP_HOME=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DO_NOT_TRACK=1
COPY --from=build /out/tooldrop-*.tgz /tmp/
RUN npm install --global /tmp/tooldrop-*.tgz \
 && rm /tmp/tooldrop-*.tgz \
 && node "$(npm root --global)/tooldrop/node_modules/playwright/cli.js" install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 tooldrop \
 && mkdir -p /data \
 && chown tooldrop /data
USER tooldrop
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Listens on all interfaces inside the container; compose.yaml publishes it on 127.0.0.1 only.
CMD ["tooldrop", "serve", "--host", "0.0.0.0", "--port", "3000"]
