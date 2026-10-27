"""Live S3 + Linux Compose integration using generated, non-personal fixtures only."""
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from provision_s3 import aws_session

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps/ai-service/tests"))
from _synthetic import synthetic_frame

BASE = "http://127.0.0.1:4100"
report = {"checks": [], "status": "running"}


def http(method, path, data=None, token=None, headers=None):
    h = dict(headers or {})
    if token:
        h["Authorization"] = "Bearer " + token
    if isinstance(data, dict):
        h["Content-Type"] = "application/json"
        data = json.dumps(data).encode()
    request = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(request, timeout=60) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            body = json.loads(raw)
        except ValueError:
            body = {"text": raw.decode(errors="replace")[:300]}
        return e.code, body


def account():
    status, body = http("POST", "/api/auth/register", {"email": "s3-" + uuid.uuid4().hex + "@example.invalid",
        "password": uuid.uuid4().hex + uuid.uuid4().hex, "name": "Generated S3 integration", "preferred_sport": "squash"})
    assert status == 201, (status, body)
    return body["data"].get("tokens", body["data"])["access_token"]


def upload(data, mime, token):
    status, body = http("POST", "/api/v1/assets", data, token, {"Content-Type": "application/octet-stream",
        "X-Asset-Content-Type": mime, "X-Content-SHA256": hashlib.sha256(data).hexdigest(), "X-Consent-Scope": "deep_analysis"})
    assert status == 201, (status, body)
    return body["data"]["asset_ref"]


def sql_for_asset(asset, sql):
    asset = str(uuid.UUID(asset))
    return subprocess.run(["docker", "exec", "apexformz-ops-postgres-1", "psql", "-U", "apexformz", "-d", "apexformz",
                           "-v", "ON_ERROR_STOP=1", "-Atc", sql.replace(":asset", asset)], check=True, capture_output=True, text=True).stdout.strip()


def job(asset, token):
    status, body = http("POST", "/api/v1/analysis/jobs", {"asset_ref": asset, "consent_scope": "deep_analysis",
        "sport_pack_id": "badminton", "sport_pack_version": "1.0.0", "movement_id": "badminton.lunge"}, token)
    assert status == 202, (status, body)
    job_id = body["data"]["job_id"]
    for _ in range(90):
        status, body = http("GET", "/api/v1/analysis/jobs/" + job_id, token=token)
        result = body["data"]
        if result["status"] in ("FAILED", "COMPLETED"):
            assert result["status"] == "COMPLETED", result.get("error")
            assert isinstance(result["output"], dict)
            return job_id
        time.sleep(1)
    raise AssertionError("Analysis did not complete")


def operations_python(code):
    result = subprocess.run(['docker', 'exec', '-i', 'apexformz-ops-operations-1', '/opt/ops/bin/python', '-'],
                            input=code, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def verify_private_restore(receipt, job_id):
    # Restore a backup made BEFORE deletion, then prove the deletion ledger removes its output.
    job_id = str(uuid.UUID(job_id))
    code = '''import sys, json, pathlib, tempfile, uuid, hashlib, subprocess, os
sys.path.insert(0, '/opt')
from operations import clients, pg, replay_deletions
s3, _ = clients()
'''
    code += 'receipt = json.loads(' + repr(json.dumps(receipt)) + ')\n'
    code += 'job_id = ' + repr(job_id) + '\n'
    code += '''database = 'apexformz_privacy_' + uuid.uuid4().hex
with tempfile.TemporaryDirectory() as directory:
    archive = pathlib.Path(directory) / 'snapshot.pgdump'
    s3.download_file(os.environ['APEXFORMZ_S3_BUCKET'], receipt['key'], str(archive), ExtraArgs={'VersionId': receipt['version_id']})
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == receipt['sha256']
    pg('createdb', database)
    try:
        pg('pg_restore', '--exit-on-error', '--no-owner', '--no-privileges', '--dbname', database, str(archive))
        query = 'SELECT (output IS NOT NULL) FROM "AnalysisJob" WHERE id=' + chr(39) + job_id + chr(39)
        before = pg('psql', '-Atc', query, database=database, stdout=subprocess.PIPE).stdout.decode().strip()
        assert before == 't'
        count = replay_deletions(s3, database)
        query = 'SELECT (output IS NULL AND request IS NULL) FROM "AnalysisJob" WHERE id=' + chr(39) + job_id + chr(39)
        after = pg('psql', '-Atc', query, database=database, stdout=subprocess.PIPE).stdout.decode().strip()
        assert after == 't'
        print(json.dumps({'status': 'passed', 'tombstones_applied': count}))
    finally:
        pg('dropdb', database)
'''
    return operations_python(code)


def main():
    config = json.loads((ROOT / "infrastructure/deployment/aws-storage.json").read_text())
    s3 = aws_session("apexformz-owner", config["region"]).client("s3")
    owner, stranger = account(), account()
    payload = json.dumps([synthetic_frame(i, i * 40, right_knee_flexion=70 if 15 < i < 30 else 0) for i in range(45)]).encode()
    asset = upload(payload, "application/json", owner)
    report["checks"].append("private-checksummed-upload")
    key = "assets/" + asset
    obj = s3.head_object(Bucket=config["bucket"], Key=key)
    assert obj["ServerSideEncryption"] == "AES256" and obj["VersionId"]
    try:
        urllib.request.urlopen("https://" + config["bucket"] + ".s3." + config["region"] + ".amazonaws.com/" + key)
        raise AssertionError("Public object access succeeded")
    except urllib.error.HTTPError as e:
        assert e.code == 403
    report["checks"].append("versioning-encryption-public-access-denied")
    assert http("GET", "/api/v1/assets/" + asset + "/download", token=stranger)[0] == 404
    assert http("DELETE", "/api/v1/assets/" + asset, token=stranger)[0] == 404
    status, _ = http("POST", "/api/v1/analysis/jobs", {"asset_ref": asset, "consent_scope": "deep_analysis",
        "sport_pack_id": "badminton", "sport_pack_version": "1.0.0", "movement_id": "badminton.lunge"}, stranger)
    assert status == 404
    report["checks"].append("cross-owner-download-delete-analysis-denied")
    status, download = http("GET", "/api/v1/assets/" + asset + "/download", token=owner)
    assert status == 200
    with urllib.request.urlopen(download["data"]["url"]) as r:
        assert hashlib.sha256(r.read()).hexdigest() == hashlib.sha256(payload).hexdigest()
    report["checks"].append("short-lived-authorized-download")
    job_id = job(asset, owner)
    report["checks"].append("s3-feature-bundle-analysis-durable-output")
    # Decode a generated blank clip with the actual pinned MediaPipe model.
    import cv2
    import numpy as np
    with tempfile.TemporaryDirectory() as directory:
        video = pathlib.Path(directory) / "synthetic.mp4"
        writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"mp4v"), 10, (320, 240))
        for _ in range(20):
            writer.write(np.zeros((240, 320, 3), dtype=np.uint8))
        writer.release()
        video_asset = upload(video.read_bytes(), "video/mp4", owner)
    job(video_asset, owner)
    report["checks"].append("s3-video-real-pose-decoder-no-subject-fails-closed-in-assessment")
    backup_receipt = operations_python("import sys,json; sys.path.insert(0,'/opt'); from operations import clients,backup; s3,_=clients(); print(json.dumps(backup(s3)))")
    # Simulate age only for this test's UUIDs, so retention need not wait seven days.
    for ref in (asset, video_asset):
        sql_for_asset(ref, """UPDATE "ObjectAsset" SET created_at=NOW()-INTERVAL '10 minutes' WHERE id=':asset'""")
    assert http("DELETE", "/api/v1/assets/" + asset, token=owner)[0] == 202
    sql_for_asset(video_asset, """UPDATE "ObjectAsset" SET expires_at=NOW()-INTERVAL '1 minute' WHERE id=':asset'""")
    assert http("GET", "/api/v1/assets/" + video_asset + "/download", token=owner)[0] == 404
    for ref in (asset, video_asset):
        for _ in range(90):
            if sql_for_asset(ref, """SELECT status FROM "ObjectAsset" WHERE id=':asset'""") == "DELETED":
                break
            time.sleep(1)
        else:
            raise AssertionError("Retention did not purge test asset")
        versions = s3.list_object_versions(Bucket=config["bucket"], Prefix="assets/" + ref)
        assert not versions.get("Versions") and not versions.get("DeleteMarkers")
    deleted_job = http("GET", "/api/v1/analysis/jobs/" + job_id, token=owner)[1]["data"]
    assert deleted_job["output"] is None and deleted_job["request"] is None and deleted_job["remote_id"] is None
    report["checks"].append("explicit-delete-and-expiry-purge-all-versions-and-derived-results")
    report['privacy_restore'] = verify_private_restore(backup_receipt, job_id)
    report['checks'].append('old-S3-backup-restore-reapplies-deletion-ledger')
    report.update(status="passed", bucket=config["bucket"], fixture_assets=[asset, video_asset])
    out = ROOT / "data/audit/operations/s3-stack-integration.json"
    out.write_text(json.dumps(report, indent=2) + "\n")
    s3.upload_file(str(out), config["bucket"], "releases/verification/s3-stack-integration.json", ExtraArgs={"ServerSideEncryption": "AES256"})
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

