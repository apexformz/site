# Local Docker interface + Brain

The primary local workflow remains `npm run dev` from the web project. This optional Docker recipe builds the updated web interface and the canonical sibling Brain backend. It uses two explicit source contexts and never includes the parent directory, captured athlete media, training datasets, host dependencies, or environment files in image layers.

The existing PostgreSQL container (`smartcoach-db`) must already be running and exposing its database on the host. This compose file defines no database service or volume and does not manage or replace that container. Existing accounts use the database and JWT secrets in `apps/backend/.env`. Loopback database hostnames in that file are translated to `host.docker.internal` inside the backend container; the database name, credentials, port, and schema options are preserved. For a remote database, its hostname is retained.

From the `Apexformz` web directory:

```powershell
docker compose -f docker-compose.brain.yml config --quiet
docker compose -f docker-compose.brain.yml build
# Only if Brain database tables have not already been prepared through npm:
docker compose -f docker-compose.brain.yml --profile setup run --rm db-prepare
docker compose -f docker-compose.brain.yml up -d backend frontend
```

The interface is at `http://localhost:3001`; the API binds to loopback port 4000. Stop a local backend already using 4000 before launching this backend, or set `APEXFORMZ_DOCKER_API_PORT` to an available port. If legacy WebSocket sports are used with a changed API port, also set `APEXFORMZ_DOCKER_SOCKET_URL` before building. Squash uses same-origin `/api` through the frontend's baked `http://backend:4000` rewrite.

Optional environment overrides:

- `APEXFORMZ_BRAIN_CONTEXT`: the Brain source directory, default `../Apexformz_brain`.
- `APEXFORMZ_DOCKER_WEB_PORT`: published interface port, default `3001`.
- `APEXFORMZ_DOCKER_WEB_ORIGIN`: matching allowed origin, default `http://localhost:3001`.
- `APEXFORMZ_DOCKER_API_PORT`: published backend port, default `4000`.
- `APEXFORMZ_DOCKER_SOCKET_URL`: browser-reachable legacy socket origin, default `http://localhost:4000`.

`db-prepare` uses the Brain's guarded additive bootstrap: it creates missing tables and their indexes/foreign keys in one transaction, refuses changes to existing tables, and does not reset data or change migration history. Keep a backup before schema changes. It runs only when explicitly invoked, never as a startup dependency.

This recipe explicitly enables development pack trust and local backend mode. It is for local development only. The Dockerfile itself defaults to production trust and production backend validation; a production deployment needs signed packs, a trusted public registry, strong secrets, and its own protected infrastructure configuration. See the Brain repository's `infrastructure/deployment` recipe. Do not expose this local compose file as a public deployment.

Build requirements: Docker Compose with `additional_contexts` support (2.17 or newer), restored local Brain model files matching its lock, and network access for the locked npm dependencies and frontend font download. The model checksum verification runs during the frontend build. No model is downloaded by this recipe.

Validation performed for this integration: Compose configuration and the database-URL adapter. Images have not been built or started as part of adding this recipe.
