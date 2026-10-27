"""Narrow the generated IAM baseline and refresh short-lived local Compose credentials."""
import argparse
import datetime as dt
import json
import pathlib
import time
from provision_s3 import aws_session


def scoped_policy(bucket, baseline_paths):
    generated = set()
    for path in baseline_paths:
        for policy in json.loads(path.read_text(encoding="utf-8-sig"))["Policies"]:
            for statement in policy["Policy"]["Statement"]:
                generated.update(statement["Action"])
    # Remove Autopilot's optional ACL/KMS/Object-Lambda/retention permissions.
    required = {"s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObjectVersion",
                "s3:ListBucket", "s3:ListBucketVersions", "cloudwatch:PutMetricData"}
    if not required.issubset(generated):
        raise ValueError("Generated policy does not cover required runtime operations")
    arn = "arn:aws:s3:::" + bucket
    return {"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Action": sorted(required & {"s3:ListBucket", "s3:ListBucketVersions"}), "Resource": arn},
        {"Effect": "Allow", "Action": sorted(required & {"s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"}),
         "Resource": [arn + "/" + prefix + "/*" for prefix in ("assets", "deletions", "backups", "telemetry", "releases", "canary")]},
        {"Effect": "Allow", "Action": "s3:DeleteObjectVersion", "Resource": arn + "/assets/*"},
        {"Effect": "Allow", "Action": "cloudwatch:PutMetricData", "Resource": "*",
         "Condition": {"StringEquals": {"cloudwatch:namespace": "ApexFormz/Operations"}}},
    ]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="apexformz-owner")
    parser.add_argument("--config", type=pathlib.Path, default=pathlib.Path("infrastructure/deployment/aws-storage.json"))
    parser.add_argument("--directory", type=pathlib.Path, default=pathlib.Path("data/local-aws"))
    parser.add_argument("--create-role", action="store_true")
    parser.add_argument("--loop", action="store_true")
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    session = aws_session(args.profile, config["region"])
    if args.create_role:
        if config.get("runtime_role"):
            raise SystemExit("Runtime role already recorded; refusing to replace its policy")
        iam = session.client("iam")
        owner_role = iam.get_role(RoleName="AccountFullAccessRole")["Role"]["Arn"]
        policy = scoped_policy(config["bucket"], [pathlib.Path("data/audit/operations/iam-typescript.json"), pathlib.Path("data/audit/operations/iam-python.json")])
        name = "ApexFormzRuntime-" + config["bucket"].rsplit("-", 1)[1]
        role = iam.create_role(RoleName=name, AssumeRolePolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": [
            {"Effect": "Allow", "Principal": {"AWS": owner_role}, "Action": "sts:AssumeRole"}
        ]}), Description="Private S3 operations for ApexFormz local verified stack", Tags=[{"Key": "Project", "Value": "ApexFormzBrain"}])
        config["runtime_role"] = role["Role"]["Arn"]
        args.config.write_text(json.dumps(config, indent=2) + "\n")
        iam.put_role_policy(RoleName=name, PolicyName="ProjectStorageOperations", PolicyDocument=json.dumps(policy))
        pathlib.Path("infrastructure/deployment/runtime-policy.json").write_text(json.dumps(policy, indent=2) + "\n")
        time.sleep(10)
    args.directory.mkdir(parents=True, exist_ok=True)
    (args.directory / "credentials").write_text("[default]\ncredential_process = /bin/cat /run/secrets/aws_session\n")
    while True:
        session = aws_session(args.profile, config["region"])
        credential = session.client("sts").assume_role(RoleArn=config["runtime_role"], RoleSessionName="apexformz-local-operations",
                                                     DurationSeconds=3600)["Credentials"]
        payload = {"Version": 1, "AccessKeyId": credential["AccessKeyId"], "SecretAccessKey": credential["SecretAccessKey"],
                   "SessionToken": credential["SessionToken"], "Expiration": credential["Expiration"].isoformat()}
        # Write in place: a Compose file bind mount keeps its inode during refresh.
        (args.directory / "session.json").write_text(json.dumps(payload))
        print(json.dumps({"refreshed": True, "expires_at": payload["Expiration"], "role": config["runtime_role"]}), flush=True)
        if not args.loop:
            return
        time.sleep(2400)


if __name__ == "__main__":
    main()

