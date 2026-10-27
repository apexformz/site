# syntax=docker/dockerfile:1
# Main context: Apexformz. Named context brain_source: Apexformz_brain.
# COPY lists are deliberate: no capture datasets, training runs, host dependencies, or secrets.
FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS brain-source
WORKDIR /workspace/Apexformz_brain
COPY --from=brain_source /package.json /package-lock.json /tsconfig.base.json /tsconfig.json ./
COPY --from=brain_source /packages/contracts ./packages/contracts
COPY --from=brain_source /packages/signal ./packages/signal
COPY --from=brain_source /packages/features ./packages/features
COPY --from=brain_source /packages/perception ./packages/perception
COPY --from=brain_source /packages/sport-runtime ./packages/sport-runtime
COPY --from=brain_source /packages/analysis ./packages/analysis
COPY --from=brain_source /packages/scoring ./packages/scoring
COPY --from=brain_source /packages/coaching ./packages/coaching
COPY --from=brain_source /packages/runtime ./packages/runtime
COPY --from=brain_source /packages/brain-client ./packages/brain-client
COPY --from=brain_source /packages/legacy-types ./packages/legacy-types
COPY --from=brain_source /tests/contracts/package.json ./tests/contracts/package.json
COPY --from=brain_source /tests/golden/package.json ./tests/golden/package.json
COPY --from=brain_source /tests/performance/package.json ./tests/performance/package.json
COPY --from=brain_source /apps/frontend/package.json ./apps/frontend/package.json
COPY --from=brain_source /apps/backend/package.json /apps/backend/tsconfig.json ./apps/backend/
COPY --from=brain_source /apps/backend/src ./apps/backend/src
COPY --from=brain_source /apps/backend/scripts ./apps/backend/scripts
COPY --from=brain_source /apps/backend/prisma ./apps/backend/prisma
COPY --from=brain_source /sport-packs ./sport-packs
RUN npm ci && npm run db:generate --workspace=apps/backend

FROM brain-source AS backend-build
RUN npm run build:backend

FROM base AS backend
WORKDIR /workspace/Apexformz_brain
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4000 SPORT_PACKS_DIR=/workspace/Apexformz_brain/sport-packs
COPY --from=backend-build --chown=node:node /workspace/Apexformz_brain/apps/backend/dist/server.cjs ./server.cjs
COPY --from=backend-build --chown=node:node /workspace/Apexformz_brain/node_modules/@prisma ./node_modules/@prisma
COPY --from=backend-build --chown=node:node /workspace/Apexformz_brain/node_modules/.prisma ./node_modules/.prisma
COPY --from=backend-build --chown=node:node /workspace/Apexformz_brain/sport-packs ./sport-packs
COPY --chown=node:node infrastructure/docker/container-entrypoint.mjs ./container-entrypoint.mjs
USER node
EXPOSE 4000
CMD ["node", "container-entrypoint.mjs", "/workspace/Apexformz_brain/server.cjs"]

FROM brain-source AS database-setup
COPY --from=brain_source /tools/web-backend.mjs ./tools/web-backend.mjs
COPY apps/backend/package.json /workspace/Apexformz/apps/backend/package.json
COPY infrastructure/docker/container-entrypoint.mjs ./container-entrypoint.mjs
CMD ["node", "container-entrypoint.mjs", "/workspace/Apexformz_brain/tools/web-backend.mjs", "--web-root", "/workspace/Apexformz", "db:prepare"]

FROM brain-source AS frontend-build
COPY --from=brain_source /tools/prepare-web-interface.mjs /tools/browser_model_artifacts.ts ./tools/
COPY --from=brain_source /tests/models/installed-models.lock.json ./tests/models/installed-models.lock.json
COPY --from=brain_source /apps/frontend/src/components/brain ./apps/frontend/src/components/brain
COPY --from=brain_source /apps/frontend/src/lib/brain ./apps/frontend/src/lib/brain
COPY --from=brain_source /apps/frontend/src/workers ./apps/frontend/src/workers
COPY --from=brain_source /apps/frontend/src/app/api/brain ./apps/frontend/src/app/api/brain
COPY --from=brain_source /apps/frontend/scripts/prepare-brain-runtime-assets.mjs /apps/frontend/scripts/prepare-pack-trust.mjs ./apps/frontend/scripts/
COPY --from=brain_source /apps/frontend/public/models/pose_landmarker_full.task ./apps/frontend/public/models/pose_landmarker_full.task
COPY --from=brain_source /apps/frontend/public/models/squash ./apps/frontend/public/models/squash
COPY --from=brain_source /apps/frontend/public/models/reid ./apps/frontend/public/models/reid
RUN npm run models:verify

WORKDIR /workspace/Apexformz
COPY package.json package-lock.json ./
COPY apps/frontend/package.json apps/frontend/tsconfig.json apps/frontend/next-env.d.ts apps/frontend/next.config.mjs apps/frontend/tailwind.config.ts apps/frontend/postcss.config.mjs ./apps/frontend/
COPY apps/backend/package.json ./apps/backend/package.json
COPY packages/types ./packages/types
COPY scripts/brain-paths.mjs scripts/prepare-brain.mjs scripts/brain-backend.mjs ./scripts/
# The web root postinstall launches Prisma generation; the canonical client was generated above.
RUN npm ci --ignore-scripts
COPY apps/frontend/src ./apps/frontend/src
COPY apps/frontend/public ./apps/frontend/public
ARG NEXT_PUBLIC_API_URL=/api
ARG NEXT_PUBLIC_SOCKET_URL=http://localhost:4000
ARG APEXFORMZ_API_ORIGIN=http://backend:4000
ARG NEXT_PUBLIC_PACK_TRUST_MODE=production
ARG NEXT_PUBLIC_PACK_TRUST_REGISTRY_JSON
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_SOCKET_URL=$NEXT_PUBLIC_SOCKET_URL APEXFORMZ_API_ORIGIN=$APEXFORMZ_API_ORIGIN
ENV NEXT_PUBLIC_PACK_TRUST_MODE=$NEXT_PUBLIC_PACK_TRUST_MODE NEXT_PUBLIC_PACK_TRUST_REGISTRY_JSON=$NEXT_PUBLIC_PACK_TRUST_REGISTRY_JSON
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build:frontend

FROM base AS frontend
WORKDIR /workspace
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1 SPORT_PACKS_DIR=/workspace/Apexformz_brain/sport-packs
COPY --from=frontend-build --chown=node:node /workspace/Apexformz/apps/frontend/.next/standalone ./
COPY --from=frontend-build --chown=node:node /workspace/Apexformz/apps/frontend/.next/static ./Apexformz/apps/frontend/.next/static
COPY --from=frontend-build --chown=node:node /workspace/Apexformz/apps/frontend/public ./Apexformz/apps/frontend/public
COPY --from=frontend-build --chown=node:node /workspace/Apexformz_brain/sport-packs ./Apexformz_brain/sport-packs
USER node
EXPOSE 3000
CMD ["node", "Apexformz/apps/frontend/server.js"]
