# syntax=docker/dockerfile:1

FROM node:26-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY scripts/clean.mjs ./scripts/clean.mjs
COPY src/ ./src/
RUN pnpm run build && CI=true pnpm prune --prod

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    BIND_HOST=0.0.0.0 \
    DATA_DIR=/app/data

LABEL org.opencontainers.image.title="WHOOP Personal MCP" \
      org.opencontainers.image.description="Single-user, self-hosted WHOOP MCP server" \
      org.opencontainers.image.source="https://github.com/josealvaradoa/whoop-personal-mcp" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.josealvaradoa/whoop-personal-mcp"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=node:node --from=builder /app/node_modules/ ./node_modules/
COPY --chown=node:node --from=builder /app/dist/ ./dist/
COPY --chown=node:node whoop-mcp.config.example.json ./
COPY --chown=node:node LICENSE DISCLAIMER.md PRIVACY.md ./
RUN mkdir -p data && chmod 700 data && chown -R node:node /app/data

EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "dist/index.js"]
