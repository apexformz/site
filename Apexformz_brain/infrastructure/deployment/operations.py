"""S3-backed operational snapshots and verified PostgreSQL backups. Runs inside Compose."""
from __future__ import annotations
import datetime as dt
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import time
import urllib.request
import uuid
import boto3
from botocore.config import Config

CONFIG = Config(retries={"total_max_attempts": 3, "mode": "standard"}, connect_timeout=5, read_timeout=30)


def clients():
    session = boto3.Session(region_name=os.environ["AWS_REGION"])
    return session.client("s3", config=CONFIG), session.client("cloudwatch", config=CONFIG)


def put_json(s3, key, value):
    body = json.dumps(value, sort_keys=True).encode()
    return s3.put_object(Bucket=os.environ["APEXFORMZ_S3_BUCKET"], Key=key, Body=body, ContentType="application/json",
                         ServerSideEncryption="AES256", ChecksumSHA256=__import__("base64").b64encode(hashlib.sha256(body).digest()).decode())


def pg(command, *args, database=None, stdout=None):
    env = dict(os.environ)
    if database:
        env["PGDATABASE"] = database
    return subprocess.run([command, *args], env=env, stdout=stdout, stderr=subprocess.PIPE, check=True)


def table_counts(database=None):
    result = pg("psql", "-Atc", "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename", database=database, stdout=subprocess.PIPE)
    counts = {}
    for table in result.stdout.decode().splitlines():
        if not table.replace("_", "").isalnum():
            raise ValueError("Unexpected table identifier")
        result = pg("psql", "-Atc", f'SELECT COUNT(*) FROM "{table}"', database=database, stdout=subprocess.PIPE)
        counts[table] = int(result.stdout)
    return counts


def replay_deletions(s3, database):
    """An old backup must not resurrect consented media or derived job output."""
    count = 0
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=os.environ["APEXFORMZ_S3_BUCKET"], Prefix="deletions/"):
        for item in page.get("Contents", []):
            with s3.get_object(Bucket=os.environ["APEXFORMZ_S3_BUCKET"], Key=item["Key"])["Body"] as body:
                entry = json.loads(body.read())
            asset = str(uuid.UUID(entry["asset_id"]))  # safe SQL literal after UUID validation
            sql = f"""BEGIN;
UPDATE "ObjectAsset" SET status='DELETING', delete_after=NOW() WHERE id='{asset}';
UPDATE "AnalysisJob" SET status='FAILED', error='ASSET_DELETED', request=NULL, output=NULL,
output_ref=NULL, remote_id=NULL, lease_token=NULL, lease_expires_at=NULL WHERE asset_ref='{asset}';
COMMIT;"""
            pg("psql", "-v", "ON_ERROR_STOP=1", "-c", sql, database=database, stdout=subprocess.DEVNULL)
            count += 1
    return count


def backup(s3):
    now = dt.datetime.now(dt.timezone.utc).isoformat().replace(":", "-")
    key = f"backups/{now}.pgdump"
    bucket = os.environ["APEXFORMZ_S3_BUCKET"]
    restore_db = "apexformz_restore_" + uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="apexformz-backup-") as directory:
        archive = pathlib.Path(directory) / "database.pgdump"
        downloaded = pathlib.Path(directory) / "restored.pgdump"
        pg("pg_dump", "--format=custom", "--no-owner", "--no-privileges", "--file", str(archive))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        s3.upload_file(str(archive), bucket, key, ExtraArgs={"ServerSideEncryption": "AES256", "Metadata": {"sha256": digest}})
        head = s3.head_object(Bucket=bucket, Key=key)
        s3.download_file(bucket, key, str(downloaded), ExtraArgs={"VersionId": head["VersionId"]})
        if hashlib.sha256(downloaded.read_bytes()).hexdigest() != digest:
            raise RuntimeError("Downloaded S3 backup hash mismatch")
        # Restore only to a generated isolated database. Never touch the live database.
        pg("createdb", restore_db)
        try:
            pg("pg_restore", "--exit-on-error", "--no-owner", "--no-privileges", "--dbname", restore_db, str(downloaded))
            counts = table_counts(restore_db)
            deleted = replay_deletions(s3, restore_db)
            receipt = {"created_at": dt.datetime.now(dt.timezone.utc).isoformat(), "key": key, "version_id": head["VersionId"],
                       "sha256": digest, "restore_verified": True, "restored_table_counts": counts, "deletion_tombstones_applied": deleted}
            put_json(s3, "backups/latest.json", receipt)
            return receipt
        finally:
            # restore_db is generated locally above; never comes from user data.
            pg("dropdb", "--if-exists", restore_db)


def snapshot(s3, cw, last_backup):
    healthy = 1
    metrics = {}
    try:
        for url in ("http://backend:4000/ready", "http://ai-service:8000/health", "http://frontend:3000/"):
            with urllib.request.urlopen(url, timeout=15) as response:
                if response.status != 200:
                    healthy = 0
        request = urllib.request.Request("http://backend:4000/internal/metrics", headers={"X-Service-Token": os.environ["APEXFORMZ_SERVICE_TOKEN"]})
        with urllib.request.urlopen(request, timeout=15) as response:
            metrics = json.load(response)
    except (OSError, ValueError):
        healthy = 0
    age = (time.time() - last_backup) / 3600 if last_backup else 9999
    values = {"Healthy": healthy, "QueueDepth": metrics.get("queued_jobs", 0), "ExpiredLeases": metrics.get("expired_leases", 0),
              "PendingDeletions": metrics.get("pending_deletions", 0), "BackupAgeHours": age}
    now = dt.datetime.now(dt.timezone.utc)
    cw.put_metric_data(Namespace="ApexFormz/Operations", MetricData=[
        {"MetricName": name, "Dimensions": [{"Name": "Deployment", "Value": os.environ["APEXFORMZ_S3_BUCKET"]}],
         "Value": value, "Timestamp": now} for name, value in values.items()])
    put_json(s3, "telemetry/" + now.strftime("%Y/%m/%d/%H-%M-%S") + ".json", {"time": now.isoformat(), "metrics": metrics, **values})
    print(json.dumps({"time": now.isoformat(), **values}), flush=True)


def main():
    s3, cw = clients()
    last_backup = 0
    while True:
        try:
            if time.time() - last_backup > 86400:
                backup(s3)
                last_backup = time.time()
            snapshot(s3, cw, last_backup)
        except Exception as error:
            # Do not emit URLs, credentials or database connection details.
            print(json.dumps({"operations_error": type(error).__name__}), flush=True)
            try:
                snapshot(s3, cw, last_backup)
            except Exception:
                pass  # Missing heartbeat itself alarms in CloudWatch.
        if os.environ.get("OPERATIONS_ONCE") == "true":
            if not last_backup:
                raise SystemExit(1)
            return
        time.sleep(60)


if __name__ == "__main__":
    main()

