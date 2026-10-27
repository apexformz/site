# Production sport-pack signing

Production trust uses Ed25519 public keys provisioned independently of downloaded packs. A signature
authenticates the complete manifest and its asset hashes; it does not approve coaching criteria,
prove recognition accuracy, grant model licences, or change release eligibility.

`security/pack-trust.production.json` contains the locally generated production public key
`apexformz-release-20261026`. Its raw-public-key SHA-256 fingerprint is
`a7f660a6c68c075693704da977f10e9f5b86bff0cbfb6e2c2e5dbf1ab4f53346`.
The matching private key is stored only at
`data/local-signing/apexformz-release-20261026.private.pem`, under the ignored local-data tree.
The directory blocks inherited access and grants only the current Windows user and SYSTEM; those
ACLs were verified before creation and on the resulting private file. No private bytes were printed,
committed, put into a release artifact, or transferred to a remote service.

## Trust registry

```json
{
  "schema_version": "1.0.0",
  "keys": [
    {
      "key_id": "release-2026-01",
      "algorithm": "ed25519",
      "public_key": "64 lowercase hexadecimal characters encoding the 32-byte raw public key",
      "status": "active",
      "purpose": "production"
    }
  ]
}
```

The example is schematic; its placeholder is rejected. A registry accepts only public fields.
Duplicate key IDs, malformed keys, unknown keys and revoked keys fail closed. Production rejects
`purpose: "test"`, unsigned packs and HMAC packs even if development flags or HMAC keys are supplied.
Production/test policy also forces SHA-256 asset verification. Revocation affects new pack loads;
already running sessions retain their pinned pack until ended. Distribute a new registry/build and
terminate affected sessions when revoking a compromised key. The registry itself must be delivered
through the trusted application/deployment channel, not accepted from the pack being verified.

The Ed25519 signature is lowercase hex over UTF-8:

```text
ApexFormz sport-pack Ed25519 v1\n<RFC8785({"key_id": keyId, "manifest": manifestWithoutSignature})>
```

Every manifest field except `signature` is covered. `signed_fields` is rejected for Ed25519, so a
publisher cannot request partial verification. The browser uses WebCrypto, the offline Node signer
uses Node crypto, and Python uses `cryptography` with `rfc8785`. Shared vectors exercise Unicode,
numeric formatting, key ordering, signature tampering and test-key rejection. See
[RFC 8785](https://www.rfc-editor.org/rfc/rfc8785) and the
[Python canonicalization implementation](https://pypi.org/project/rfc8785/).

## Sign and verify a release

Keep the Ed25519 PKCS#8 PEM private key outside this repository and outside the staged release.
The public key selected in the registry must match that private key. Run from the repository root:

```sh
npx tsx packages/sport-runtime/scripts/sign-release-packs.ts --source sport-packs --out /new/release/sport-packs --registry /trusted/public-registry.json --key-id release-2026-01 --private-key-file /secure/release-key.pem
npx tsx packages/sport-runtime/scripts/verify-release-packs.ts --pack-root /new/release/sport-packs --registry /trusted/public-registry.json
```

The output directory must be new and its parent must exist. All packs are verified before output is
created. Source packs are preserved. The alternative `--private-key-env VARIABLE_NAME` reads the PEM
from the named environment variable; pass the variable's name, never the key on the command line.
Neither command prints private material. The signer copies declared JSON pack assets; movement ONNX
models continue through their separately digest-verified deployment/bundle mechanism. Binary model
entries in a production sport pack are rejected rather than silently omitted.

## Runtime configuration

| Component | Configuration |
|---|---|
| Browser build | `NEXT_PUBLIC_PACK_TRUST_MODE=production`; `NEXT_PUBLIC_PACK_TRUST_REGISTRY_JSON` contains the public registry JSON |
| Backend / frontend server | `APEXFORMZ_PACK_TRUST_MODE=production`; `APEXFORMZ_PACK_TRUST_REGISTRY_PATH` points to an independently provisioned public registry |
| Python service | Same `APEXFORMZ_PACK_TRUST_MODE` and registry path; `APEXFORMZ_ENV=production` also selects the default production policy |
| Pack files | `SPORT_PACKS_DIR` points to the isolated signed release directory |

Servers also accept `APEXFORMZ_PACK_TRUST_REGISTRY_JSON` instead of a file; supplying both is rejected.
`NODE_ENV=production` defaults server policy to production. An explicit `development` mode is needed
to run local HMAC packs with a production-optimized Next build. For that local mode, set both browser
build and server trust variables to `development`. Coaching strict/development controls do not
change the build's trust policy. Python now verifies development HMAC signatures as well as hashes.

The frontend generates identical `src/lib/brain/pack-trust.generated.json` and `public/pack-trust.json`
at build/development-server time. The client imports this metadata, including mode, public registry,
registry SHA-256 and key IDs. Production startup does not regenerate it. Release receipts must bind
these files to the `.next` build; changing shell variables after building cannot promote a development
client into a production client. Rebuild to change browser trust roots or revocations.

## Local evidence and remaining operator work

All six packs were signed under the production policy into
`data/audit/production-signed-packs-20261026`. The TypeScript and Python verifiers accepted all six.
`data/audit/production-signing-20261026.json` records public fingerprints, manifest hashes and the
checks that original development packs and all unsigned metadata/assets remain unchanged. A repeated
key-bootstrap invocation was rejected, preserving the existing identity.

The reusable `tools/create_local_release_key.mjs` bootstrap refuses a nonempty signing directory or
nonempty trust registry. It verifies the protected directory before writing an exclusive-create
PKCS#8 PEM file, then records only public identity/custody metadata. On Windows it uses PowerShell 7
(`pwsh.exe`, or `APEXFORMZ_POWERSHELL_EXE`) to verify the ACL; on POSIX it requires ownership by the
current user and directory mode 0700. It does not silently change permissions or rotate an existing
key. Future rotation requires a new protected key directory and an explicitly reviewed registry
update that retains/revokes prior keys as intended.

`npx tsx tools/demo_pack_signing.ts <new-evidence-directory>` generates an ephemeral test key in memory,
signs copies of all six packs through the actual CLI, verifies them in TypeScript and Python, and
confirms that production rejects the test key. Only public material, signed copies and the report
are persisted. No private key is saved. The demonstration does not produce a production release.

Before remote operation, establish protected backup/recovery and key rotation/revocation ownership,
provision managed-secret custody if remote signing is needed, and configure the registry/pack mounts
and browser build variables. The local release key is usable locally; it is not yet in a managed
secret store or remote CI signing service.
Promotion still requires the independently enforced approval, model/data and licence gates. New data
collection, coach validation and physical-device validation remain separate deferred work.
