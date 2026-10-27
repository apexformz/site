"""Provision NEW project-owned private S3 buckets and monitoring. No existing bucket mutation."""
from __future__ import annotations
import argparse
import json
import pathlib
import secrets
import subprocess
import sys
import boto3
from botocore.config import Config


def aws_session(profile: str, region: str):
    # CLI supports browser-login refresh. Never print or persist the credential response.
    result = subprocess.run(["aws", "configure", "export-credentials", "--profile", profile, "--format", "process"],
                            capture_output=True, text=True, check=True)
    credentials = json.loads(result.stdout)
    return boto3.Session(aws_access_key_id=credentials["AccessKeyId"],
                         aws_secret_access_key=credentials["SecretAccessKey"],
                         aws_session_token=credentials.get("SessionToken"), region_name=region)


def provision(session, region, output):
    config = Config(retries={"total_max_attempts": 3, "mode": "standard"}, connect_timeout=5, read_timeout=30)
    account = session.client("sts", config=config).get_caller_identity()["Account"]
    bucket = f"apexformz-brain-{account}-{secrets.token_hex(4)}"
    logs = bucket + "-logs"
    s3 = session.client("s3", config=config)
    # Record each created resource immediately, so partial failure is recoverable.
    receipt = {"account_id": account, "region": region, "bucket": bucket, "log_bucket": logs, "status": "creating", "created": []}
    def save():
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    save()
    for name in (bucket, logs):
        args = dict(Bucket=name, ObjectOwnership="BucketOwnerEnforced")
        if region != "us-east-1":
            args["CreateBucketConfiguration"] = {"LocationConstraint": region}
        s3.create_bucket(**args)
        receipt["created"].append(name)
        save()
        s3.put_public_access_block(Bucket=name, PublicAccessBlockConfiguration={
            "BlockPublicAcls": True, "IgnorePublicAcls": True, "BlockPublicPolicy": True, "RestrictPublicBuckets": True})
        s3.put_bucket_encryption(Bucket=name, ServerSideEncryptionConfiguration={
            "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]})
        s3.put_bucket_tagging(Bucket=name, Tagging={"TagSet": [
            {"Key": "Project", "Value": "ApexFormzBrain"}, {"Key": "ManagedBy", "Value": "provision_s3.py"}]})
        statements = [{"Sid": "RequireTLS", "Effect": "Deny", "Principal": "*", "Action": "s3:*",
                       "Resource": [f"arn:aws:s3:::{name}", f"arn:aws:s3:::{name}/*"],
                       "Condition": {"Bool": {"aws:SecureTransport": "false"}}}]
        if name == logs:
            statements.append({"Sid": "ServerAccessLogs", "Effect": "Allow", "Principal": {"Service": "logging.s3.amazonaws.com"},
                               "Action": "s3:PutObject", "Resource": f"arn:aws:s3:::{logs}/access/*",
                               "Condition": {"StringEquals": {"aws:SourceAccount": account},
                                             "ArnLike": {"aws:SourceArn": f"arn:aws:s3:::{bucket}"}}})
        s3.put_bucket_policy(Bucket=name, Policy=json.dumps({"Version": "2012-10-17", "Statement": statements}))
    s3.put_bucket_versioning(Bucket=bucket, VersioningConfiguration={"Status": "Enabled"})
    s3.put_bucket_logging(Bucket=bucket, BucketLoggingStatus={"LoggingEnabled": {"TargetBucket": logs, "TargetPrefix": "access/"}})
    # Metadata retention worker is authoritative; lifecycle is a cleanup backstop.
    rules = []
    for prefix, days in (("assets/", 31), ("backups/", 35), ("telemetry/", 30), ("releases/", 180), ("canary/", 180)):
        rules.append({"ID": prefix.rstrip("/"), "Status": "Enabled", "Filter": {"Prefix": prefix},
                      "Expiration": {"Days": days}, "NoncurrentVersionExpiration": {"NoncurrentDays": 1},
                      "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 1}})
    s3.put_bucket_lifecycle_configuration(Bucket=bucket, LifecycleConfiguration={"Rules": rules})
    s3.put_bucket_lifecycle_configuration(Bucket=logs, LifecycleConfiguration={"Rules": [{
        "ID": "logs-90d", "Status": "Enabled", "Filter": {"Prefix": ""}, "Expiration": {"Days": 90}}]})
    s3.put_bucket_metrics_configuration(Bucket=bucket, Id="assets", MetricsConfiguration={"Id": "assets", "Filter": {"Prefix": "assets/"}})
    cw = session.client("cloudwatch", config=config)
    dimensions = [{"Name": "Deployment", "Value": bucket}]
    alarms = []
    for metric, threshold, comparison in (
        ("Healthy", 1, "LessThanThreshold"), ("QueueDepth", 100, "GreaterThanThreshold"),
        ("ExpiredLeases", 0, "GreaterThanThreshold"), ("BackupAgeHours", 25, "GreaterThanThreshold"),
        ("PendingDeletions", 0, "GreaterThanThreshold")):
        name = bucket + "-" + metric
        # Names include the just-created unique bucket; no pre-existing alarm may be replaced.
        if cw.describe_alarms(AlarmNames=[name])["MetricAlarms"]:
            raise RuntimeError("Refusing to overwrite existing alarm")
        cw.put_metric_alarm(AlarmName=name, Namespace="ApexFormz/Operations", MetricName=metric,
                            Dimensions=dimensions, Statistic="Maximum", Period=60, EvaluationPeriods=3,
                            DatapointsToAlarm=3, Threshold=threshold, ComparisonOperator=comparison, TreatMissingData="breaching")
        alarms.append(name)
    receipt.update(status="ready", alarms=alarms, deletion_ledger_retention="indefinite; required when restoring older backups",
                   cloudtrail_data_events="not enabled; configure account audit trail before public production")
    save()
    return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--out", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise SystemExit("Refusing to replace a provisioning receipt; inspect existing resources first")
    receipt = provision(aws_session(args.profile, args.region), args.region, args.out)
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()

