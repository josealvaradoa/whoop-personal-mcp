FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY src/ ./src/
RUN pnpm run build

FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist/ ./dist/
COPY whoop-mcp.config.example.json ./whoop-mcp.config.example.json
RUN mkdir -p data && chmod 700 data && chown -R node:node /app/data
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
