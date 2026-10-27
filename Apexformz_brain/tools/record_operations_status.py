"""Record verified infrastructure state without environment secrets."""
import datetime as dt
import hashlib
import json
import pathlib
import re
import subprocess
import urllib.request
from provision_s3 import aws_session


def main():
    root = pathlib.Path(__file__).resolve().parents[1]
    directory = root / "data/audit/operations"
    config = json.loads((root / "infrastructure/deployment/aws-storage.json").read_text())
    session = aws_session("apexformz-owner", config["region"])
    s3 = session.client("s3")
    cw = session.client("cloudwatch")
    bucket = config["bucket"]
    security = {
        "public_access_block": s3.get_public_access_block(Bucket=bucket)["PublicAccessBlockConfiguration"],
        "encryption": s3.get_bucket_encryption(Bucket=bucket)["ServerSideEncryptionConfiguration"],
        "versioning": s3.get_bucket_versioning(Bucket=bucket)["Status"],
        "access_logging": s3.get_bucket_logging(Bucket=bucket)["LoggingEnabled"],
        "lifecycle": s3.get_bucket_lifecycle_configuration(Bucket=bucket)["Rules"],
    }
    images = {}
    for name in ("backend", "frontend", "ai-service", "migrate", "operations"):
        images[name] = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", "apexformz-ops-" + name], text=True).strip()
    probes = {}
    for url in ("http://127.0.0.1:3100", "http://127.0.0.1:4100/ready", "http://127.0.0.1:4102/ready"):
        with urllib.request.urlopen(url, timeout=15) as response:
            probes[url] = response.status
    def load(name):
        path = directory / name
        return json.loads(path.read_text()) if path.exists() else None
    backend_tests = int(re.search(r"Tests\s+(\d+) passed", (directory / "backend-tests-final.log").read_text()).group(1))
    python_tests = re.search(r"(\d+) passed, (\d+) skipped", (directory / "python-tests-final.log").read_text())
    postgres_path = max((p for p in (root / "data/audit/postgres").glob("20*.json") if not p.name.endswith(".vitest.json")), key=lambda p: p.stat().st_mtime)
    postgres = json.loads(postgres_path.read_text())
    vulnerabilities = load("npm-audit.json")["metadata"]["vulnerabilities"]["total"]
    vulnerabilities += sum(len(d.get("vulns", [])) for d in load("python-audit.json")["dependencies"])
    report = {
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "status": "verification_incomplete",
        "docker": {"engine": subprocess.check_output(["docker", "info", "--format", "{{.ServerVersion}} {{.OSType}}"], text=True).strip(), "images": images, "http_checks": probes},
        "aws": config, "bucket_security": security,
        "verification": {"backend_tests_passed": backend_tests, "python_service_tests_passed": int(python_tests.group(1)), "python_optional_tests_skipped": int(python_tests.group(2)),
                         "postgres_tests_passed": postgres['tests']['passed'], "built_server_checks_passed": len(postgres['built_backend']['checks']), "dependency_vulnerabilities": vulnerabilities},
        "evidence_sha256": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in [postgres_path, *(directory / name for name in ("backend-tests-final.log", "python-tests-final.log", "npm-audit.json", "python-audit.json"))]},
        "legacy_baseline": load("legacy-baseline-review.json"),
        "legacy_backup": load("legacy-s3-backup-and-migration.json"),
        "canary": {k: v for k, v in (load("canary-rollback-final.json") or {}).items() if k != "probes"},
        "release_archive": load("release-s3-archive.json"),
        "operations_source_archive": load("operations-source-s3-archive.json"),
        "live_s3_integration": load("s3-stack-integration.json"),
        "storage_scope": {"s3": ["private runtime assets", "database backups", "telemetry", "deletion ledger", "release/source archives", "canary receipts"],
                          "postgresql": "Transactional metadata remains in PostgreSQL with verified backups on S3; S3 is not its live database filesystem.",
                          "historical_captures": "Existing private capture archives have not been bulk-migrated or deleted."},
        "remaining": ["Choose and approve actual legacy database cutover", "Configure a public production host, TLS, workload identity, least-privilege database accounts, on-call notifications, signing-key custody and account audit trail"],
        "deferred": ["new data collection", "coach validation", "physical-device testing"],
    }
    report['alarms'] = [{"name": a['AlarmName'], "state": a['StateValue']} for a in cw.describe_alarms(AlarmNames=config['alarms'])['MetricAlarms']]
    with s3.get_object(Bucket=bucket, Key='backups/latest.json')['Body'] as body:
        report['latest_verified_backup'] = json.loads(body.read())
    now = dt.datetime.now(dt.timezone.utc)
    report['live_health_samples'] = [{"time": p['Timestamp'].isoformat(), "healthy": p['Minimum']} for p in cw.get_metric_statistics(
        Namespace='ApexFormz/Operations', MetricName='Healthy', Dimensions=[{'Name': 'Deployment', 'Value': bucket}],
        StartTime=now-dt.timedelta(minutes=10), EndTime=now, Period=60, Statistics=['Minimum'])['Datapoints']]
    recent = sorted(report['live_health_samples'], key=lambda p: p['time'])[-3:]
    backup = report['latest_verified_backup']
    backup_age = (now - dt.datetime.fromisoformat(backup['created_at'])).total_seconds()
    checks = {
        's3_integration': (report['live_s3_integration'] or {}).get('status') == 'passed',
        'privacy_restore': (report['live_s3_integration'] or {}).get('privacy_restore', {}).get('status') == 'passed',
        'legacy_baseline': (report['legacy_baseline'] or {}).get('status') == 'passed',
        'legacy_backup': (report['legacy_backup'] or {}).get('status') == 'passed',
        'canary': report['canary'].get('status') == 'passed' and report['canary'].get('rollback_verified') is True and report['canary'].get('candidate_image') == images['backend'],
        'monitoring': len(report['alarms']) == 5 and all(a['state'] == 'OK' for a in report['alarms']),
        'recent_health': len(recent) == 3 and all(p['healthy'] == 1 for p in recent) and (now - dt.datetime.fromisoformat(recent[-1]['time'])).total_seconds() < 180,
        'backup': backup.get('restore_verified') is True and 0 <= backup_age < 25 * 3600,
        'postgres': postgres['status'] == 'passed' and postgres['backup_restore']['status'] == 'passed',
        'dependencies': vulnerabilities == 0,
    }
    report['completion_checks'] = checks
    report['status'] = 'local_operations_verified' if all(checks.values()) else 'verification_incomplete'
    out = directory / "operations-completion.json"
    out.write_text(json.dumps(report, indent=2) + "\n")
    s3.upload_file(str(out), bucket, "releases/verification/operations-completion.json", ExtraArgs={"ServerSideEncryption": "AES256"})
    print(json.dumps({"status": report["status"], "bucket": bucket, "http_checks": probes, "report": str(out)}))
    if not all(checks.values()):
        raise SystemExit(1)


if __name__ == "__main__":
    main()

