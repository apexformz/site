import hashlib
import io
import json
from pathlib import Path

import pytest

from ml.ingestion.capture import _document_indexes, capture_head, download_record, inventory, normalize_record, read_json_object, squash_documents


KEY = "raw/squash/SESSION_ABC/front/CAP_1/squash_static_expert_ready-position_front_ATH_0001.jpg"
MEDIA = b"real-image-fixture-bytes"
DIGEST = hashlib.sha256(MEDIA).hexdigest()


def head(**changes):
    value = {"ContentLength": len(MEDIA), "VersionId": "v1", "ETag": '"etag"', "ServerSideEncryption": "AES256",
             "Metadata": {"capture_id": "CAP_1", "session_id": "SESSION_ABC", "athlete_id": "ATH_0001", "movement_id": "squash.static.ready", "direction": "FRONT", "sha256": DIGEST}}
    value.update(changes)
    return value


def doc(data, kind="CAPTURE", revision=1):
    return {"payload": {"schema": "apexformz.datacapture.archive.v1", "kind": kind, "revision": revision, "data": data},
            "source": {"bucket": "labels", "key": f"manifests/{kind}/{revision}.json", "version_id": f"m{revision}", "sha256": "a" * 64}}


def capture(**changes):
    value = {"capture_id": "CAP_1", "session_id": "SESSION_ABC", "athlete_id": "ATH_0001", "movement_id": "squash.static.ready", "direction": "FRONT", "s3_key": KEY, "s3_version_id": "v1", "upload_state": "UPLOADED", "sha256": DIGEST, "bytes": len(MEDIA), "source_display_name": "Ready position", "revision": 1}
    value.update(changes)
    return value


def record(documents=None, **changes):
    return normalize_record("media", KEY, head(**changes), _document_indexes(documents or []))


def test_exact_capture_metadata_preserved_without_inventing_training_consent():
    result = record([doc(capture()), doc({"athlete_id": "ATH_0001", "consent_status": "GRANTED"}, "ATHLETE")])
    assert result["source_movement_id"] == "squash.static.ready"
    assert result["source_movement_name"] == "Ready position"
    assert result["athlete_id"] == "ATH_0001"
    assert result["view"] == "front"
    assert result["validation"]["eligible_media"]
    assert result["consent"] == {"status": "GRANTED", "purpose": [], "retention_until": None}
    assert result["synchronization"] == "not_established"


def test_newest_archive_prevents_importing_superseded_capture():
    documents = [doc(capture(superseded=True), revision=5), doc(capture(), revision=2)]
    result = record(documents)
    assert not result["validation"]["eligible_media"]
    assert "superseded_capture" in result["validation"]["blockers"]


def test_withdrawn_athlete_blocks_media_even_when_original_upload_was_valid():
    result = record([doc(capture()), doc({"athlete_id": "ATH_0001", "consent_status": "GRANTED"}, "ATHLETE", 1),
                     doc({"athlete_id": "ATH_0001", "consent_status": "WITHDRAWN"}, "ATHLETE", 2)])
    assert "consent_withdrawn" in result["validation"]["blockers"]


def test_metadata_conflicts_are_blockers_not_silent_identity_rewrites():
    result = record([doc(capture(athlete_id="ATH_0099", s3_version_id="old-version"))])
    assert {"conflicting_athlete_id", "source_version_mismatch"} <= set(result["validation"]["blockers"])


def test_multiple_views_share_conservative_split_group_only():
    one = record()
    two_key = KEY.replace("/front/CAP_1/", "/right/CAP_2/").replace("_front_", "_right_")
    two_head = head(Metadata={**head()["Metadata"], "capture_id": "CAP_2", "direction": "RIGHT"})
    two = normalize_record("media", two_key, two_head, _document_indexes([]))
    assert one["split_group_id"] == two["split_group_id"]
    assert one["record_id"] != two["record_id"]
    assert "execution_id" not in one


def test_sorter_documents_cannot_supply_labels_or_media_to_capture_import():
    key = "sorted/squash/dynamic/SQUASH-DYN-01/expert/hash/attempt/squash_expert_drive_front.mp4"
    labels = {"status": "completed", "destinationKey": key, "destinationVersionId": "v1", "sourceKey": "unsorted/clip.mp4", "movementId": "SQUASH-DYN-01", "movementName": "Forehand drive", "type": "dynamic", "cameraDirection": "front", "mastery": "expert", "workerId": "person-who-labeled"}
    indexes = _document_indexes([{"payload": labels, "source": {"bucket": "sorter", "key": "system/processing-status/a.json"}}])
    assert indexes == ({}, {}, {})
    with pytest.raises(ValueError, match="Only squash DataCapture"):
        normalize_record("sorter", key, head(Metadata={}), indexes)


class FakeClient:
    def __init__(self):
        self.downloads = []
        self.gets = []
        self.body = None

    def download_file(self, bucket, key, target, ExtraArgs):
        self.downloads.append((bucket, key, ExtraArgs))
        Path(target).write_bytes(MEDIA)

    def get_object(self, **args):
        self.gets.append(args)
        self.body = io.BytesIO(MEDIA)
        return {"Body": self.body, "ContentLength": len(MEDIA), "ETag": '"etag"'}


def test_cache_pins_version_preserves_extension_and_verifies_hash(tmp_path):
    client = FakeClient()
    entry = record()
    first = download_record(client, entry, tmp_path)
    assert first.suffix == ".jpg" and first.is_relative_to(tmp_path)
    assert client.downloads == [("media", KEY, {"VersionId": "v1"})]
    assert entry["local_sha256"] == DIGEST
    assert download_record(client, record(), tmp_path) == first
    assert len(client.downloads) == 1
    first.write_bytes(b"corrupt")
    download_record(client, record(), tmp_path)
    assert len(client.downloads) == 2


def test_malicious_remote_key_cannot_escape_cache(tmp_path):
    client = FakeClient()
    entry = record()
    entry["source"]["key"] = "../../outside.jpg"
    path = download_record(client, entry, tmp_path / "cache")
    assert path.is_relative_to(tmp_path / "cache")
    assert not (tmp_path / "outside.jpg").exists()


def test_unversioned_download_uses_etag_condition_and_closes_body(tmp_path):
    client = FakeClient()
    entry = record(VersionId=None)
    download_record(client, entry, tmp_path)
    assert client.gets[0]["IfMatch"] == '"etag"'
    assert client.body.closed


def test_s3_null_version_is_unversioned_and_uses_etag_identity(tmp_path):
    client = FakeClient()
    entry = record(VersionId="null")
    assert entry["source"]["version_id"] is None
    changed = record(VersionId="null", ETag='"changed"')
    assert entry["record_id"] != changed["record_id"]
    download_record(client, entry, tmp_path)
    assert client.gets[0]["IfMatch"] == '"etag"'
    assert not client.downloads


def test_corrupt_cache_receipt_is_rebuilt(tmp_path):
    client = FakeClient()
    path = download_record(client, record(), tmp_path)
    path.with_suffix(".jpg.source.json").write_text("{bad-json", encoding="utf-8")
    download_record(client, record(), tmp_path)
    assert len(client.downloads) == 2


def test_wrong_hash_never_promotes_partial_file(tmp_path):
    entry = record()
    entry["source"]["sha256"] = "0" * 64
    with pytest.raises(ValueError, match="SHA-256"):
        download_record(FakeClient(), entry, tmp_path)
    assert not list(tmp_path.rglob("*.jpg"))
    assert not list(tmp_path.rglob("*.partial"))


def test_small_metadata_read_closes_body_when_rejected():
    client = FakeClient()
    with pytest.raises(ValueError, match="exceeds"):
        read_json_object(client, "labels", "large.json", max_bytes=2)
    assert client.body.closed


def test_inventory_uses_all_paginator_pages_and_ignores_nonmedia():
    class ListingClient(FakeClient):
        def get_paginator(self, operation):
            assert operation == "list_objects_v2"
            return self

        def paginate(self, **kwargs):
            assert kwargs == {"Bucket": "media", "Prefix": "raw/squash/"}
            yield {"Contents": [{"Key": KEY}]}
            yield {"Contents": [{"Key": "raw/squash/readme.json"}, {"Key": KEY.replace("CAP_1", "CAP_2")}]}

        def head_object(self, **kwargs):
            return head()

    result = inventory(ListingClient(), "media", "raw/squash/")
    assert len(result["records"]) == 2
    assert result["summary"]["production_ready"] is False
    from jsonschema import Draft202012Validator
    schema = json.loads(Path(__file__).with_name("capture_inventory.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator(schema).validate(result)


def test_importer_rejects_sorter_and_other_sport_scope_before_network_calls():
    for prefix, sport in [("sorted/squash/", "squash"), ("raw/badminton/", "badminton"), ("raw/", "squash")]:
        with pytest.raises(ValueError, match="scoped to squash"):
            inventory(object(), "bucket", prefix, sport=sport)


def test_catalog_filter_keeps_only_squash_and_its_athletes():
    documents = [doc(capture()), doc(capture(capture_id="CAP_B", athlete_id="ATH_0002", movement_id="badminton.static.ready")),
                 doc({"athlete_id": "ATH_0001", "consent_status": "GRANTED"}, "ATHLETE"),
                 doc({"athlete_id": "ATH_0002", "consent_status": "GRANTED"}, "ATHLETE"),
                 {"source": {"key": "catalog/1.json"}, "payload": {"movements": [{"movement_id": "squash.static.ready", "name": "Ready"}, {"movement_id": "badminton.static.ready", "name": "Ready"}]}}]
    scoped = squash_documents(documents)
    captures, athletes, movements = _document_indexes(scoped)
    assert set(captures) == {"CAP_1"}
    assert set(athletes) == {"ATH_0001"}
    assert set(movements) == {"squash.static.ready"}


def test_verified_manifest_pins_original_bytes_after_later_s3_overwrite():
    class VersionedClient:
        def __init__(self):
            self.calls = []

        def head_object(self, **kwargs):
            self.calls.append(kwargs)
            return head(VersionId=kwargs.get("VersionId", "new-unverified"))

    client = VersionedClient()
    indexes = _document_indexes([doc(capture())])
    pinned = capture_head(client, "media", KEY, indexes)
    result = normalize_record("media", KEY, pinned, indexes)
    assert result["validation"]["eligible_media"]
    assert result["source"]["version_id"] == "v1"
    assert result["source"]["latest_version_id"] == "new-unverified"
    assert client.calls[-1]["VersionId"] == "v1"


def test_missing_verified_version_does_not_accept_unverified_latest():
    from botocore.exceptions import ClientError

    class MissingVersionClient:
        def head_object(self, **kwargs):
            if "VersionId" in kwargs:
                raise ClientError({"Error": {"Code": "NoSuchVersion"}}, "HeadObject")
            return head(VersionId="unverified-latest")

    indexes = _document_indexes([doc(capture())])
    pinned = capture_head(MissingVersionClient(), "media", KEY, indexes)
    result = normalize_record("media", KEY, pinned, indexes)
    assert "source_version_mismatch" in result["validation"]["blockers"]
    assert not result["validation"]["eligible_media"]
