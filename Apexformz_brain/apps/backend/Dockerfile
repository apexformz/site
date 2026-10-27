# Build from the monorepo root, not apps/backend.
FROM node:24-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci && npm run db:generate --workspace=apps/backend && npm run build:backend
FROM builder AS migrate
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy", "--schema", "apps/backend/prisma/schema.prisma"]
FROM node:24-bookworm-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000 SPORT_PACKS_DIR=/app/sport-packs
COPY --from=builder --chown=node:node /app/apps/backend/dist/server.cjs ./server.cjs
COPY --from=builder --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=node:node /app/sport-packs ./sport-packs
USER node
EXPOSE 4000
CMD ["node", "server.cjs"]
