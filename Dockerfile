# Build JavaScript on the native build host, never under QEMU.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS build
WORKDIR /usr/src/app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts
COPY . .
RUN bun run build

# Cross-install target bindings while the security scanner runs natively.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS deps
WORKDIR /usr/src/app
COPY package.json bun.lock bunfig.toml ./
COPY --from=build /usr/src/app/node_modules/@socketsecurity/bun-security-scanner ./node_modules/@socketsecurity/bun-security-scanner
ARG TARGETOS
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) echo x64 ;; \
      arm64) echo arm64 ;; \
      *) echo "Unsupported TARGETARCH '$TARGETARCH': expected amd64 or arm64" >&2; exit 1 ;; \
    esac > .bun-cpu
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --production --omit=peer --frozen-lockfile --ignore-scripts \
      --os="$TARGETOS" --cpu="$(cat .bun-cpu)"
COPY scripts/install-otel.ts ./scripts/
ARG OTEL_ENABLED=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    if [ "$OTEL_ENABLED" = "true" ]; then \
      bun scripts/install-otel.ts --os="$TARGETOS" --cpu="$(cat .bun-cpu)"; \
    fi
COPY scripts/prune-musl-packages.ts ./scripts/
RUN bun scripts/prune-musl-packages.ts
RUN rm -rf node_modules/@socketsecurity/bun-security-scanner

# The runtime contains target dependencies and platform-independent JavaScript.
FROM oven/bun:1.4.2-slim AS production
WORKDIR /usr/src/app
ENV NODE_ENV=production
ARG APP_VERSION
LABEL org.opencontainers.image.title="@cyanheads/treasury-fiscaldata-mcp-server"
LABEL org.opencontainers.image.description="MCP server for US Treasury Fiscal Data — national debt, interest rates, exchange rates, and federal revenue/spending."
LABEL org.opencontainers.image.source="https://github.com/cyanheads/treasury-fiscaldata-mcp-server"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.version="${APP_VERSION}"
COPY package.json ./
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist
RUN mkdir -p /var/log/treasury-fiscaldata-mcp-server && chown -R bun:bun /var/log/treasury-fiscaldata-mcp-server
USER bun
ARG PORT
ENV MCP_HTTP_PORT=${PORT:-3010}
ENV MCP_HTTP_HOST="0.0.0.0"
ENV MCP_TRANSPORT_TYPE="http"
ENV MCP_SESSION_MODE="stateless"
ENV MCP_LOG_LEVEL="info"
ENV LOGS_DIR="/var/log/treasury-fiscaldata-mcp-server"
EXPOSE ${MCP_HTTP_PORT}
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD bun -e "fetch('http://localhost:'+(process.env.MCP_HTTP_PORT??'3010')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "run", "dist/index.js"]
