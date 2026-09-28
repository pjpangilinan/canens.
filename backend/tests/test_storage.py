"""The snapshot store, away from HTTP.

The routes are in test_backup.py. What is left here is the storage itself: the
key it derives, and the two failure modes S3 has that a fake would hide.
"""
import json
from io import BytesIO

import pytest
from botocore.exceptions import ClientError

from app import storage


def _raw_get_object(payload: bytes):
    class _Raw:
        def get_object(self, **kwargs):
            return {"Body": BytesIO(payload)}

    return _Raw()


def test_snapshot_key_includes_the_user():
    assert storage.snapshot_key("abc") == "snapshots/abc.json"
    assert storage.snapshot_key("abc") != storage.snapshot_key("def")


def test_a_missing_object_is_absent_not_an_error(s3):
    """A first-time user has no snapshot. That is not a failure."""
    s3.objects.clear()
    assert storage.load_snapshot("nobody") is None


def test_a_corrupt_object_is_an_error_not_an_empty_snapshot(s3):
    """Silently returning nothing would look like data loss to the user.

    It would also be indistinguishable from "never backed up", which is the one
    answer the client must get right: it auto-restores on that basis.
    """
    s3.get_object = _raw_get_object(b"__not json__").get_object
    with pytest.raises(json.JSONDecodeError):
        storage.load_snapshot("u")


def test_absent_fields_default_to_empty(s3):
    s3.objects["snapshots/u.json"] = {}
    assert storage.load_snapshot("u") == {"goals": [], "tasks": [], "saved_at": None}


def test_save_then_load_is_a_faithful_round_trip(s3):
    goals = [{"id": "g1", "title": "A", "status": "Active"}]
    tasks = [{"id": "t1", "title": "B", "goal_id": "g1"}]

    saved = storage.save_snapshot("u", goals, tasks)
    loaded = storage.load_snapshot("u")

    assert loaded["goals"] == goals
    assert loaded["tasks"] == tasks
    assert loaded["saved_at"] == saved["saved_at"]


def test_save_overwrites_rather_than_appending(s3):
    storage.save_snapshot("u", [{"id": "g1", "title": "First"}], [])
    storage.save_snapshot("u", [{"id": "g2", "title": "Second"}], [])

    assert len(s3.objects) == 1
    assert [g["title"] for g in storage.load_snapshot("u")["goals"]] == ["Second"]


def test_the_saved_at_stamp_is_utc(s3):
    """A laptop and Lambda disagree about the local date; UTC does not."""
    saved = storage.save_snapshot("u", [], [])
    assert saved["saved_at"].endswith("+00:00")


def test_unexpected_s3_errors_are_not_swallowed(s3):
    def boom(**kwargs):
        raise ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "no"}}, "GetObject"
        )

    s3.get_object = boom
    with pytest.raises(ClientError):
        storage.load_snapshot("u")


def test_access_denied_is_not_reported_as_no_backup(s3):
    """The two must stay distinguishable.

    S3 answers a GetObject for a missing key with 403 rather than 404 when the
    caller cannot list the bucket, so a deployment missing the ListBucket grant
    would otherwise report "you have no backup" to a user who does. That is the
    answer the client acts on most destructively: it auto-restores.
    """
    def denied(**kwargs):
        raise ClientError(
            {"Error": {"Code": "AccessDenied", "Message": "no"}}, "GetObject"
        )

    s3.get_object = denied
    with pytest.raises(ClientError) as caught:
        storage.load_snapshot("u")
    assert caught.value.response["Error"]["Code"] == "AccessDenied"


def test_a_body_that_is_not_a_dict_is_rejected(s3):
    """Stored data is written by another process. Trusting its shape is how a
    bad document turns into a confusing error three layers up."""
    s3.get_object = _raw_get_object(json.dumps(["not", "a", "dict"]).encode()).get_object
    with pytest.raises(AttributeError):
        storage.load_snapshot("u")
