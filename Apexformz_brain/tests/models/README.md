# Reproducible model checks

`npm test` runs without the private capture dataset, training checkpoints, or installed model binaries.
The unit suite executes real ONNX Runtime inference on two small arithmetic graphs in
`tests/fixtures/onnx_arithmetic.json`. Their outputs depend on both inputs and masks, or on normalized
RGB channels. These cover tensor preprocessing, batch splitting, and the asynchronous worker
protocol. They are not sport accuracy measurements. Regenerate them with
`python tools/generate_onnx_test_fixtures.py` when intentionally changing the fixture contract.

`npm run test:models` is a separate **required-assets** suite. It fails if any file is absent or differs
from `installed-models.lock.json`; it never skips a missing model. The lock pins ten exact files:
static and dynamic ONNX models, deployment configs, model cards, their index, the re-ID config and
weights, and the pose model referenced by the trained models. The suite checks:

- Both squash models against CPU PyTorch reference logits from their exact training checkpoints.
- Both squash models through inline ORT and the real asynchronous inference protocol handlers.
- The installed OSNet re-ID model against the existing Python pixel-to-embedding reference.

The browser audit separately exercises actual browser workers and the camera/UI lifecycle. The
asynchronous test worker here is a paired in-process message transport, not an OS/browser thread.

## Local artifact bundle

With the intended models installed:

```sh
npm run models:verify
npm run models:export -- --out data/audit/browser-models-20261026
```

The export destination must be new and its parent must exist. A verified 12.6 MB development bundle
was exported at that path on 2026-10-26. It contains only the ten locked artifacts and the lock, with
no capture media or athlete poses. Keep it with the corresponding source revision. Restore into a
checkout using:

```sh
npm run models:restore -- --from /path/to/browser-models-20261026
npm run test:models
```

Restore verifies every source byte before writing, refuses a different lock, and refuses to replace
different existing files unless `--replace` is explicitly supplied. Matching files are left as-is.
`--root <checkout>` permits restoration/verification in a second checkout. Export does not publish
anything. The re-ID weights remain development-only under the licensing notes in `reid/reid.json`.

CI's default checks use the committed arithmetic graphs. A manual CI run can additionally supply
`model_artifact_run_id` for a same-repository `browser-models` artifact containing this bundle.
That job restores the exact pinned set and runs all installed-model tests, failing if the bundle is
missing, corrupt or from a different source revision. No bundle has been uploaded by this work.

## Intentional model updates

Regenerate PyTorch references from the new records, then pin the new installed artifacts:

```sh
python tools/generate_model_parity_fixtures.py --dynamic-summary ml/runs/squash/ensemble_identity_20261025/ensemble_summary.json --static-record ml/runs/squash/static_identity_20261025/static_pose/tcn-1792952301195117500.json
python tools/pin_browser_model_artifacts.py --artifact-set squash-identity-20261025-reid-osnet-development
npm run test:models
```

Review changes to the lock and expected outputs together with the training records. The static and
dynamic parity inputs are deterministic arithmetic, and the checked-in references contain no
athlete recordings. None of these checks approves thresholds, supplies a held-out athlete, grants
commercial re-ID rights, or changes `production_eligible`.
