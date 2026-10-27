"""Exercise a pinned backend image behind real weighted ingress, then roll back to stable."""
import argparse
import json
import os
import pathlib
import subprocess
import time
import urllib.request
from provision_s3 import aws_session

ROOT = pathlib.Path(__file__).resolve().parents[1]
ROUTE = ROOT / "infrastructure/deployment/gateway/default.conf"
COMPOSE = ["docker", "compose", "-p", "apexformz-ops", "-f", str(ROOT / "infrastructure/deployment/docker-compose.yml"),
           "--env-file", str(ROOT / "data/audit/operations/compose.env"), "--profile", "canary"]


def command(args, env=None):
    result = subprocess.run(args, env=env, capture_output=True, text=True, check=True)
    return result.stdout


def route(percent):
    # Fixed service names; no user-controlled Nginx directives.
    if not 0 <= percent <= 100:
        raise ValueError("Invalid percentage")
    split = f"split_clients $request_id $apex_upstream {{ {percent}% backend-canary:4000; * backend:4000; }}\n" if percent else "map $host $apex_upstream { default backend:4000; }\n"
    ROUTE.write_text(split + """server {
 listen 4000;
 resolver 127.0.0.11 valid=5s;
 location / {
  proxy_pass http://$apex_upstream;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  add_header X-ApexFormz-Upstream $apex_upstream always;
 }
}
""")
    command(COMPOSE + ["exec", "-T", "gateway", "nginx", "-t"])
    command(COMPOSE + ["exec", "-T", "gateway", "nginx", "-s", "reload"])


def probe(url):
    with urllib.request.urlopen(url, timeout=8) as response:
        return {"status": response.status, "upstream": response.headers.get("X-ApexFormz-Upstream")}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate-image", required=True)
    parser.add_argument("--seconds", type=int, default=30)
    parser.add_argument("--inject-failure", action="store_true")
    parser.add_argument("--profile", default="apexformz-owner")
    parser.add_argument("--out", type=pathlib.Path, required=True)
    args = parser.parse_args()
    image = command(["docker", "image", "inspect", "--format", "{{.Id}}", args.candidate_image]).strip()
    if not image.startswith("sha256:"):
        raise ValueError("Candidate must resolve to a local immutable image")
    env = dict(os.environ, CANARY_BACKEND_IMAGE=image)
    report = {"candidate_image": image, "status": "running", "traffic_percent": 10, "probes": [], "rollback_verified": False}
    original = ROUTE.read_text()
    try:
        command(COMPOSE + ["up", "-d", "--no-deps", "backend-canary", "gateway"], env)
        for _ in range(30):
            try:
                if probe("http://127.0.0.1:4101/ready")["status"] == 200:
                    break
            except OSError:
                time.sleep(1)
        else:
            raise RuntimeError("Candidate failed readiness")
        route(10)
        # Actual ingress probes must observe both weighted upstreams.
        for _ in range(120):
            report["probes"].append(probe("http://127.0.0.1:4102/health"))
        if not any(p["upstream"] == "backend-canary:4000" for p in report["probes"]):
            raise RuntimeError("Canary received no observed traffic")
        deadline = time.monotonic() + max(10, args.seconds)
        injected = False
        while time.monotonic() < deadline:
            if args.inject_failure and not injected:
                command(COMPOSE + ["stop", "backend-canary"])
                injected = True
            try:
                probe("http://127.0.0.1:4101/ready")
                report["probes"].append(probe("http://127.0.0.1:4102/ready"))
            except OSError:
                report["rollback_reason"] = "candidate health/ingress failure"
                break
            time.sleep(2)
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["error_type"] = type(error).__name__
        raise
    finally:
        # Always return this drill to the known stable service, even after interruption/failure.
        route(0)
        time.sleep(2)
        probes = [probe("http://127.0.0.1:4102/ready") for _ in range(20)]
        report["rollback_verified"] = all(p["status"] == 200 and p["upstream"] == "backend:4000" for p in probes)
        command(COMPOSE + ["stop", "backend-canary"])
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, indent=2) + "\n")
        config = json.loads((ROOT / "infrastructure/deployment/aws-storage.json").read_text())
        s3 = aws_session(args.profile, config["region"]).client("s3")
        s3.upload_file(str(args.out), config["bucket"], "canary/" + args.out.name, ExtraArgs={"ServerSideEncryption": "AES256"})
        print(json.dumps({k: v for k, v in report.items() if k != "probes"}))
    if not report["rollback_verified"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

