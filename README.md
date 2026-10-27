# ApexFormz

ApexFormz contains the web interface, account and session services, the ApexFormz Brain, and the sports engines in one repository. The live squash studio runs pose tracking and the Brain in browser workers; the Brain API stores signed-in sessions and results. The legacy Python AI service supports other sports.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/frontend` | Next.js interface, squash setup, studio, and session review |
| `apps/backend` | Legacy account and other-sport source; local squash startup delegates to the Brain API |
| `apps/ai-service` | Legacy Python sports analysis |
| `Apexformz_brain/packages` | Perception, features, scoring, coaching, runtime, contracts, and browser client |
| `Apexformz_brain/sport-packs` | Squash and other sport catalogues, criteria, and installed reference models |
| `Apexformz_brain/apps` | Brain API and maintained browser adapter source |
| `Apexformz_brain/ml`, `Apexformz_brain/tests` | Training code, model metadata, and verification code |

Installed browser model files are under `Apexformz_brain/apps/frontend/public/models`. Original athlete recordings, private pose data, training runs, local database, credentials, and generated browser runtime files are excluded from Git. The installed dynamic reference bank is included with the squash sport pack.

## Local setup

Requires Node.js 22.12 or newer, npm, and PostgreSQL. From the repository root:

```powershell
npm ci --ignore-scripts
npm ci --prefix Apexformz_brain --ignore-scripts
npm run db:generate
# Configure apps/backend/.env from apps/backend/.env.example
npm run db:plan
npm run db:prepare
npm run dev
```

The web interface opens at `http://localhost:3000`. PostgreSQL must be available at `DATABASE_URL` in `apps/backend/.env`. The additive Brain database setup refuses changes to existing tables. For a local development build, set both `NEXT_PUBLIC_PACK_TRUST_MODE` and `APEXFORMZ_PACK_TRUST_MODE` to `development` before building. Production pack signing and deployment requirements are documented in `Apexformz_brain/docs`.

The root `prepare:brain` command stages the maintained Brain browser adapter and model assets into the web app. The staged copies and browser runtimes are generated during development and builds. Edit the source under `Apexformz_brain`, then run `npm run prepare:brain`.

The optional `docker-compose.brain.yml` is a local recipe that reuses an existing PostgreSQL service. `npm run demo` is a Windows convenience command for an existing `smartcoach-db` container.

## Squash coaching coverage

The squash catalogue includes static positions and dynamic movements. Dynamic comparison uses the installed recorded reference bank. The current bank has 110 dynamic movements with at least partial recorded sequences; 13 have uninterrupted captured sequences according to the extractor. These recordings are from one right-handed athlete. Four catalogue movements have no usable recording. The interface reports reference coverage, view and hand requirements, and unavailable scoring rather than inventing a technique verdict. See `BRAIN_INTEGRATION.md` and `Apexformz_brain/docs` for architecture and limitations.
