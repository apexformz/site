# Local release candidates and production gates

The release tools can build and verify an engineering candidate on this system. A candidate is explicitly **not production approved**. Model validation, coach review and physical-device work remain separate requirements; none is inferred from passing software tests. Current model cards, pack criteria and the re-ID weight licence intentionally block promotion.

The candidate contains checked sources, standalone frontend output, bundled backend output, AI-service sources, Prisma migrations, deployment configuration, public assets and only the exact model files in `tests/models/installed-models.lock.json`. Raw captures, training runs, `.env` files and private signing-key files are excluded. RTMO, the older lite pose file and legacy AI-service weights are not in the current release lock and are not shipped. Optional RTMO selection therefore still requires its separately provisioned model and can fall back to MediaPipe; legacy learned AI scoring remains unavailable without a separately approved model.

1. Install the locked Node dependencies with `npm ci`. Provision Python test dependencies, `pip-audit==2.10.1`, and the hash-locked service dependencies from `apps/ai-service/requirements.lock`; install local contracts with `--no-deps`. Restore a locally held model bundle with `npm run models:restore -- --from <bundle>`, then run `npm run models:verify`. The bundle must exactly match the checked-in lock; missing or changed model bytes fail.

2. Provide a dedicated local test database using `APEXFORMZ_TEST_DATABASE_URL`. The PostgreSQL runner creates a random isolated schema, applies real migrations, verifies ingestion/transactions and real AI job recovery, exercises `pg_dump`/`pg_restore`, and removes only its own schema. Provide matching PostgreSQL tools via `APEXFORMZ_POSTGRES_BIN` if they are not on PATH. Never point this check at the production database. Set `APEXFORMZ_RELEASE_PYTHON` to the intended interpreter; it is also forwarded to the PostgreSQL suite's AI fixture host.

3. Run all required checks and preserve a new receipt:

   ```text
   npm run release:check -- --out data/audit/release-checks-current.json
   ```

   This runs both builds, TypeScript, unit/golden/contract suites, signed pack integrity, strict installed-model parity, real PostgreSQL integration, Python suites, an npm high/critical audit and the Python service dependency audit. No failure is converted to a warning. The frontend builds with explicit development trust by default. The receipt binds sources before the builds, generated trust metadata after the builds, complete build outputs and selected pack bytes. Source changes during checks, missing check results and extra build files invalidate the receipt.

4. Stage and verify a new local directory:

   ```text
   npm run release:candidate -- --out data/releases/candidate-current --checks data/audit/release-checks-current.json
   npm run release:verify -- --root data/releases/candidate-current
   ```

   `inventory.json` is a sorted SHA-256/size inventory with no wall-clock timestamps or machine-specific absolute paths. Identical file bytes produce the same inventory independent of traversal order. This is an integrity guarantee, not a claim that Next.js or container builds are byte-for-byte reproducible. Unexpected files, changed bytes, unsafe paths and unlisted additions fail verification. Existing output directories and receipts are never overwritten.

5. Where a Docker engine is available, build the three images from the exact candidate directory:

   ```text
   npm run release:containers -- --root data/releases/candidate-current --out data/audit/candidate-current-containers.json
   ```

   This keeps images local and records their Docker image IDs against the candidate inventory. No image is pushed or deployed. The receipt stays outside the immutable candidate. A machine without a working Docker engine can create an engineering candidate but cannot satisfy the production container gate.

6. For a future production build, first supply externally reviewed Ed25519 public keys in `security/pack-trust.production.json` and use the offline signing procedure in `PRODUCTION_PACK_SIGNING.md`. Keep private keys outside the checkout and candidate. Test/demo registries are not production registries. Build with `release:check --production --pack-root <signed-packs> --registry security/pack-trust.production.json`, then stage using the same `--pack-root`. Production trust is embedded at build time in the frontend; changing an environment variable after a development build does not promote it.

7. After actual model, coach, device and operational validation, register the approved evidence files and SHA-256 digests in `infrastructure/release/readiness.json`. Do not change pending entries or model eligibility flags merely to make a gate pass. Production checking is explicit:

   ```text
   npm run release:promote -- --root <production-candidate> --registry security/pack-trust.production.json --containers <matching-container-receipt>
   ```

   Promotion rechecks the complete inventory and check receipt, the built public trust registry, Ed25519 signatures and key policy, approved criteria, validated model/calibration metadata, model licence clearance, readiness evidence and all three container image builds. It rejects the current provisional installation. A passing command still does not publish or deploy anything.

Ordinary `.github/workflows/ci.yml` uses Node 24, immutable action commit pins, real PostgreSQL 16, CPU Python tests and enforcing dependency audits. It does not require private model files; its ONNX protocol fixtures are self-contained. The optional real-model release workflow uses a dedicated trusted Linux runner labelled `apexformz-release`, with a local, operator-provisioned model bundle, signed-pack directory, Python environment, PostgreSQL test database and output directory. Python dependencies must be installed on that runner before dispatch. Do not allow pull requests or untrusted users to execute on it.

Set runner variables `APEXFORMZ_LOCAL_MODEL_BUNDLE`, `APEXFORMZ_LOCAL_SIGNED_PACKS`, `APEXFORMZ_LOCAL_RELEASE_OUTPUT`, `APEXFORMZ_POSTGRES_BIN`, and `APEXFORMZ_RELEASE_PYTHON`; keep the isolated database URL in the `APEXFORMZ_TEST_DATABASE_URL` environment secret. Configure the `production-release` environment with required reviewers and **Prevent self-review**, plus protected release branches. Workflow YAML cannot create those protections itself; available environment controls depend on the repository plan. See [GitHub's environment protection documentation](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

Private candidates and model bundles remain on the local runner. There are no artifact upload/download, approval API, image push, deployment or publication steps. Automated private artifact transfer was not authorized for an identified remote destination, so it is intentionally absent. This checkout has no verified Git remote; locally verified workflow configuration is not evidence that hosted CI has run.
