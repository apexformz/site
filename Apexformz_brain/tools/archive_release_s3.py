"""Archive an inventory-verified engineering candidate to the project's private S3 bucket."""
import argparse
import hashlib
import json
import pathlib
import subprocess
import tarfile
import tempfile
from provision_s3 import aws_session


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=pathlib.Path)
    parser.add_argument("--name", required=True)
    parser.add_argument("--profile", default="apexformz-owner")
    parser.add_argument("--verify-existing", action="store_true")
    args = parser.parse_args()
    if not args.name.replace("-", "").isalnum():
        raise SystemExit("Use an alphanumeric/hyphen artifact name")
    subprocess.run(["node", "node_modules/tsx/dist/cli.mjs", "tools/release_artifacts.ts", "verify", "--root", str(args.root)], check=True)
    for path in args.root.rglob("*"):
        if path.is_symlink() or path.name.startswith(".env") or path.suffix.lower() in {".pem", ".key"}:
            raise SystemExit("Refusing a candidate with secrets or symbolic links")
    config = json.loads(pathlib.Path("infrastructure/deployment/aws-storage.json").read_text())
    s3 = aws_session(args.profile, config["region"]).client("s3")
    key = "releases/" + args.name + ".tar.gz"
    with tempfile.TemporaryDirectory(prefix="apexformz-release-") as directory:
        archive = pathlib.Path(directory) / "candidate.tar.gz"
        if args.verify_existing:
            sha = s3.head_object(Bucket=config["bucket"], Key=key)["Metadata"]["sha256"]
        else:
            with tarfile.open(archive, "w:gz") as tar:
                tar.add(args.root, arcname="candidate")
            sha = digest(archive)
            s3.upload_file(str(archive), config["bucket"], key, ExtraArgs={"ServerSideEncryption": "AES256",
                "Metadata": {"sha256": sha, "production-eligible": "false"}})
        head = s3.head_object(Bucket=config["bucket"], Key=key)
        remote = hashlib.sha256()
        with s3.get_object(Bucket=config["bucket"], Key=key, VersionId=head["VersionId"])["Body"] as body:
            for chunk in iter(lambda: body.read(1024 * 1024), b""):
                remote.update(chunk)
        assert remote.hexdigest() == sha
        receipt = {"status": "passed", "bucket": config["bucket"], "key": key, "version_id": head["VersionId"],
                   "sha256": sha, "bytes": head["ContentLength"], "production_eligible": False, "source": str(args.root),
                   "note": "Previously verified engineering baseline; not a promotion or verification of newer source changes."}
        pathlib.Path("data/audit/operations/release-s3-archive.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()

