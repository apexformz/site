import hashlib
import io
import json
from unittest.mock import Mock
import pytest
from app.brain.assets import AssetDescriptor, decode_asset, download_asset
from app.brain.retrospective import AnalysisError
import app.brain.assets as assets
from botocore.response import StreamingBody


def descriptor(data=b"[]", **changes):
    values = dict(bucket="private-test", key="assets/00000000-0000-0000-0000-000000000001",
                  version_id="immutable-version", sha256=hashlib.sha256(data).hexdigest(),
                  content_type="application/json", byte_size=len(data))
    return AssetDescriptor(**(values | changes))


def mock_store(monkeypatch, data, **metadata):
    monkeypatch.setenv("APEXFORMZ_S3_BUCKET", "private-test")
    body = StreamingBody(io.BytesIO(data), len(data))
    client = Mock()
    client.get_object.return_value = dict(Body=body, ContentLength=len(data), ContentType="application/json") | metadata
    monkeypatch.setattr(assets, "s3_client", lambda: client)
    return client


def test_pins_exact_version_and_checks_integrity(monkeypatch):
    client = mock_store(monkeypatch, b"[]")
    assert download_asset(descriptor()) == b"[]"
    assert client.get_object.call_args.kwargs["VersionId"] == "immutable-version"


@pytest.mark.parametrize("changes", [{"bucket": "someone-else"}, {"key": "../secret"}, {"key": "https://localhost/private"}])
def test_rejects_foreign_buckets_and_urls_before_network(monkeypatch, changes):
    client = mock_store(monkeypatch, b"[]")
    with pytest.raises(AnalysisError, match="outside"):
        download_asset(descriptor(**changes))
    client.get_object.assert_not_called()


@pytest.mark.parametrize("changes", [{"sha256": "0" * 64}, {"byte_size": 3}, {"content_type": "video/mp4"}])
def test_rejects_corrupt_asset(monkeypatch, changes):
    mock_store(monkeypatch, b"[]")
    with pytest.raises(AnalysisError):
        download_asset(descriptor(**changes))


def test_decodes_contract_bundle(monkeypatch, lunge_bundle):
    data = json.dumps(lunge_bundle).encode()
    mock_store(monkeypatch, data)
    assert decode_asset(descriptor(data), "asset-test") == lunge_bundle


@pytest.mark.parametrize("data", [b"[]", b"{}", b"not json", b"[{}]"])
def test_rejects_invalid_bundle(monkeypatch, data):
    mock_store(monkeypatch, data)
    with pytest.raises((AnalysisError, ValueError)):
        decode_asset(descriptor(data), "asset-test")


def test_remote_deletion_fences_late_worker_results():
    from app.routes import brain_jobs
    brain_jobs._JOBS['late-worker'] = {'status': 'RUNNING'}
    brain_jobs.delete_job('late-worker')
    brain_jobs._set('late-worker', status='COMPLETED', output={'private': 'result'})
    assert brain_jobs._JOBS['late-worker']['status'] == 'DELETED'
    assert brain_jobs._JOBS['late-worker']['output'] is None


def test_transient_remote_failure_can_retry_but_deletion_cannot(monkeypatch, lunge_bundle):
    from app.routes import brain_jobs
    from fastapi import BackgroundTasks, Response
    request = brain_jobs.JobRequest(job_id='retry-storage', sport_pack_id='badminton', sport_pack_version='1.0.0',
        movement_id='badminton.lunge', consent_scope='deep_analysis', feature_bundle=lunge_bundle)
    brain_jobs._JOBS[request.job_id] = {'status': 'FAILED', 'error': {'retryable': True}, 'finished_at': 0}
    background = BackgroundTasks()
    assert brain_jobs.create_job(request, background, Response())['status'] == 'QUEUED'
    assert len(background.tasks) == 1
    brain_jobs.delete_job(request.job_id)
    background = BackgroundTasks()
    assert brain_jobs.create_job(request, background, Response())['status'] == 'DELETED'
    assert len(background.tasks) == 0


def test_production_requires_internal_token(monkeypatch):
    from fastapi.testclient import TestClient
    from main import app
    monkeypatch.setenv('APEXFORMZ_ENV', 'production')
    monkeypatch.setenv('APEXFORMZ_SERVICE_TOKEN', 'x' * 40)
    with TestClient(app) as client:
        assert client.get('/health').status_code == 200
        assert client.get('/v1/analysis/jobs/unknown').status_code == 401
        assert client.get('/v1/analysis/jobs/unknown', headers={'x-service-token': 'x' * 40}).status_code == 404

