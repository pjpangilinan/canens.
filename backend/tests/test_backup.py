"""Snapshot backup and restore.

Replaces a two-way sync protocol. A snapshot is replaced wholesale, so there is
no merge and therefore no conflict to get wrong. It is one S3 object rather than
a row, so "replaced wholesale" is also literally what happens to the storage.
"""
import pytest

from app import storage
from tests.conftest import TEST_USER

pytestmark = pytest.mark.asyncio

KEY = storage.snapshot_key(TEST_USER)

GOAL_ID = "11111111-1111-1111-1111-111111111111"
TASK_ID = "22222222-2222-2222-2222-222222222222"


async def test_download_reports_nothing_before_the_first_upload(empty_client):
    response = await empty_client.get("/api/backup")

    assert response.status_code == 200
    body = response.json()
    assert body["exists"] is False
    assert body["goals"] == []
    assert body["tasks"] == []
    assert body["saved_at"] is None


async def test_download_returns_what_was_stored(async_client):
    body = (await async_client.get("/api/backup")).json()

    assert body["exists"] is True
    assert [g["title"] for g in body["goals"]] == ["Launch the MVP"]
    assert [t["title"] for t in body["tasks"]] == ["Write the spec"]


async def test_snapshot_round_trips(async_client, s3):
    payload = {
        "goals": [
            {
                "id": GOAL_ID,
                "title": "Launch the MVP",
                "status": "Active",
                "created_at": "2026-09-01T09:00:00Z",
                "updated_at": "2026-09-01T09:00:00Z",
            }
        ],
        "tasks": [
            {
                "id": TASK_ID,
                "goal_id": GOAL_ID,
                "title": "Write the spec",
                "status": "Completed",
            }
        ],
    }

    upload = await async_client.put("/api/backup", json=payload)
    assert upload.status_code == 200
    assert upload.json()["goals"] == payload["goals"]

    download = await async_client.get("/api/backup")
    assert download.status_code == 200
    body = download.json()

    assert body["exists"] is True
    assert body["goals"] == payload["goals"]
    assert body["tasks"] == payload["tasks"]
    assert body["saved_at"] is not None


async def test_upload_replaces_the_previous_snapshot(async_client, s3):
    await async_client.put(
        "/api/backup", json={"goals": [{"id": GOAL_ID, "title": "Old goal"}], "tasks": []}
    )
    await async_client.put(
        "/api/backup", json={"goals": [{"id": TASK_ID, "title": "New goal"}], "tasks": []}
    )

    body = (await async_client.get("/api/backup")).json()
    assert [g["title"] for g in body["goals"]] == ["New goal"]


async def test_deletions_survive_a_round_trip(async_client):
    """A deleted record is absent from the payload, so it stays deleted.

    This is why the snapshot needs no tombstone column.
    """
    kept = {"id": GOAL_ID, "title": "Kept"}
    doomed = {"id": TASK_ID, "title": "Doomed"}

    await async_client.put("/api/backup", json={"goals": [kept], "tasks": []})
    await async_client.put("/api/backup", json={"goals": [kept, doomed], "tasks": []})
    await async_client.put("/api/backup", json={"goals": [kept], "tasks": []})

    body = (await async_client.get("/api/backup")).json()
    assert [g["title"] for g in body["goals"]] == ["Kept"]


async def test_upload_rejects_rows_without_an_id_or_title(async_client):
    response = await async_client.put(
        "/api/backup", json={"goals": [{"title": "no id"}], "tasks": []}
    )
    assert response.status_code == 422


async def test_upload_rejects_a_row_with_a_non_string_id(async_client):
    response = await async_client.put(
        "/api/backup", json={"goals": [{"id": 7, "title": "numeric id"}], "tasks": []}
    )
    assert response.status_code == 422


async def test_upload_rejects_an_oversized_snapshot(async_client):
    rows = [
        {"id": f"{i:08d}-0000-0000-0000-000000000000", "title": f"Goal {i}"}
        for i in range(5001)
    ]
    response = await async_client.put("/api/backup", json={"goals": rows, "tasks": []})
    assert response.status_code == 413


async def test_rejected_upload_writes_nothing(async_client, s3):
    before = dict(s3.objects)

    await async_client.put(
        "/api/backup", json={"goals": [{"title": "no id"}], "tasks": []}
    )

    assert s3.objects == before
    assert s3.puts == []


async def test_each_upload_writes_the_same_key(async_client, s3):
    await async_client.put(
        "/api/backup", json={"goals": [{"id": GOAL_ID, "title": "A"}], "tasks": []}
    )
    await async_client.put(
        "/api/backup", json={"goals": [{"id": TASK_ID, "title": "B"}], "tasks": []}
    )

    assert [p["key"] for p in s3.puts] == [KEY, KEY]
    assert len(s3.objects) == 1, "a second object means the key is not derived"


async def test_stored_object_is_json_under_the_configured_bucket(async_client, s3):
    await async_client.put(
        "/api/backup", json={"goals": [{"id": GOAL_ID, "title": "A"}], "tasks": []}
    )

    put = s3.puts[-1]
    assert put["content_type"] == "application/json"
    assert put["bucket"]
    assert set(put["body"]) == {"goals", "tasks", "saved_at", "tombstones"}


async def test_delete_backup_removes_snapshot(async_client, s3):
    await async_client.put(
        "/api/backup", json={"goals": [{"id": GOAL_ID, "title": "To Delete"}], "tasks": []}
    )
    assert KEY in s3.objects

    response = await async_client.delete("/api/backup")
    assert response.status_code == 204
    assert KEY not in s3.objects

    # Subsequent GET returns exists: False
    get_res = await async_client.get("/api/backup")
    assert get_res.json()["exists"] is False


async def test_export_backup_returns_data(async_client):
    await async_client.put(
        "/api/backup", json={"goals": [{"id": GOAL_ID, "title": "Exported Goal"}], "tasks": []}
    )
    response = await async_client.get("/api/backup/export")
    assert response.status_code == 200
    body = response.json()
    assert body["goals"][0]["title"] == "Exported Goal"
    assert "exported_at" in body


async def test_backup_persists_and_returns_tombstones(async_client):
    response = await async_client.put(
        "/api/backup",
        json={
            "goals": [{"id": GOAL_ID, "title": "Goal"}],
            "tasks": [],
            "tombstones": {"deleted-task-1": "2026-09-29T12:00:00Z"},
        },
    )
    assert response.status_code == 200
    assert response.json()["tombstones"] == {"deleted-task-1": "2026-09-29T12:00:00Z"}

    get_res = await async_client.get("/api/backup")
    assert get_res.json()["tombstones"] == {"deleted-task-1": "2026-09-29T12:00:00Z"}

