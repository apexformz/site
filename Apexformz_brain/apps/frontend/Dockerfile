# Build from the monorepo root with the locked model files restored.
FROM node:24-bookworm-slim AS builder
WORKDIR /app
COPY . .
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_SOCKET_URL
ARG NEXT_PUBLIC_PACK_TRUST_MODE=production
ARG NEXT_PUBLIC_PACK_TRUST_REGISTRY_JSON
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL
ENV NEXT_PUBLIC_PACK_TRUST_MODE=$NEXT_PUBLIC_PACK_TRUST_MODE NEXT_PUBLIC_PACK_TRUST_REGISTRY_JSON=$NEXT_PUBLIC_PACK_TRUST_REGISTRY_JSON
RUN npm ci && npm run models:verify && npm run build:frontend
FROM node:24-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 SPORT_PACKS_DIR=/app/sport-packs
COPY --from=builder --chown=node:node /app/apps/frontend/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=builder --chown=node:node /app/apps/frontend/public ./apps/frontend/public
COPY --from=builder --chown=node:node /app/sport-packs ./sport-packs
USER node
EXPOSE 3000
CMD ["node", "apps/frontend/server.js"]
