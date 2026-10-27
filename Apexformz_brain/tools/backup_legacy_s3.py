"""Back up the identified legacy DB to private S3 and test its reviewed delta on a disposable clone."""
import datetime as dt
import hashlib
import json
import pathlib
import subprocess
import tempfile
import uuid
from provision_s3 import aws_session

ROOT = pathlib.Path(__file__).resolve().parents[1]
TARGET = "apexformz-ops-postgres-1"
TABLES = ["Achievement", "Circle", "CircleActivity", "CircleMember", "EnhancedStreak", "LeaderboardEntry",
          "PoseFrame", "RefreshToken", "TrainingSession", "User", "UserStats"]


def run(args, **kwargs):
    return subprocess.run(args, check=True, stderr=subprocess.PIPE, **kwargs)


def psql(database, sql):
    r = run(["docker", "exec", "-i", TARGET, "psql", "-U", "apexformz", "-d", database, "-v", "ON_ERROR_STOP=1", "-At"],
            input=sql.encode(), stdout=subprocess.PIPE)
    return r.stdout.decode().strip()


def snapshot(database):
    result = {}
    for table in TABLES:
        result[table] = psql(database, f"""SELECT COUNT(*) || ':' || COALESCE(md5(string_agg(h, '' ORDER BY h)), '') FROM
(SELECT md5(row_to_json(t)::text) AS h FROM "{table}" t) rows;""")
    return result


def main():
    config = json.loads((ROOT / "infrastructure/deployment/aws-storage.json").read_text())
    s3 = aws_session("apexformz-owner", config["region"]).client("s3")
    database = "apexformz_legacy_" + uuid.uuid4().hex
    key = "backups/legacy/smartcoach-db-" + dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".pgdump"
    created = False
    try:
        with tempfile.TemporaryDirectory(prefix="apexformz-legacy-") as directory:
            archive = pathlib.Path(directory) / "legacy.pgdump"
            downloaded = pathlib.Path(directory) / "download.pgdump"
            with archive.open("wb") as f:
                run(["docker", "exec", "smartcoach-db", "sh", "-c",
                     'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges'], stdout=f)
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            s3.upload_file(str(archive), config["bucket"], key, ExtraArgs={"ServerSideEncryption": "AES256", "Metadata": {"sha256": digest}})
            head = s3.head_object(Bucket=config["bucket"], Key=key)
            s3.download_file(config["bucket"], key, str(downloaded), ExtraArgs={"VersionId": head["VersionId"]})
            assert hashlib.sha256(downloaded.read_bytes()).hexdigest() == digest
            run(["docker", "exec", TARGET, "createdb", "-U", "apexformz", database])
            created = True
            with downloaded.open("rb") as f:
                run(["docker", "exec", "-i", TARGET, "pg_restore", "-U", "apexformz", "--dbname", database,
                     "--exit-on-error", "--no-owner", "--no-privileges"], stdin=f, stdout=subprocess.DEVNULL)
            before = snapshot(database)
            sql = (ROOT / "data/audit/operations/legacy-additive-delta.sql").read_text()
            psql(database, "BEGIN;\n" + sql + "\nCOMMIT;")
            after = snapshot(database)
            assert before == after, "Legacy rows changed during additive migration"
            receipt = {"status": "passed", "source": "smartcoach-db", "source_modified": False, "bucket": config["bucket"],
                       "key": key, "version_id": head["VersionId"], "sha256": digest, "bytes": head["ContentLength"],
                       "s3_download_restore_verified": True, "legacy_table_hashes_before_after_match": True,
                       "tables": before, "clone_removed": True}
            out = ROOT / "data/audit/operations/legacy-s3-backup-and-migration.json"
            out.write_text(json.dumps(receipt, indent=2) + "\n")
            s3.upload_file(str(out), config["bucket"], "backups/legacy/" + out.name, ExtraArgs={"ServerSideEncryption": "AES256"})
            print(json.dumps(receipt, indent=2))
    finally:
        if created:
            run(["docker", "exec", TARGET, "dropdb", "-U", "apexformz", database])


if __name__ == "__main__":
    main()

