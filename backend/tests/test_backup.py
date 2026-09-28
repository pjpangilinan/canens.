"""Snapshot backup and restore.

Replaces a two-way sync protocol. A snapshot is replaced wholesale, so there
is no merge and therefore no conflict to get wrong.
"""
import pytest
from sqlalchemy import select

from app.models import Backup

pytestmark = pytest.mark.asyncio


async def test_download_reports_nothing_before_the_first_upload(async_client):
    response = await async_client.get("/api/backup")

    assert response.status_code == 200
    body = response.json()
    assert body["exists"] is False
    assert body["goals"] == []
    assert body["tasks"] == []


async def test_snapshot_round_trips(async_client, seed_data):
    payload = {
        "goals": [
            {
                "id": "11111111-1111-1111-1111-111111111111",
                "title": "Launch the MVP",
                "status": "Active",
                "created_at": "2026-09-01T09:00:00Z",
                "updated_at": "2026-09-01T09:00:00Z",
            }
        ],
        "tasks": [
            {
                "id": "22222222-2222-2222-2222-222222222222",
                "goal_id": "11111111-1111-1111-1111-111111111111",
                "title": "Write the spec",
                "status": "Completed",
            }
        ],
    }

    upload = await async_client.put("/api/backup", json=payload)
    assert upload.status_code == 200

    download = await async_client.get("/api/backup")
    assert download.status_code == 200
    body = download.json()

    assert body["exists"] is True
    assert body["goals"] == payload["goals"]
    assert body["tasks"] == payload["tasks"]
    assert body["saved_at"] is not None


async def test_upload_replaces_the_previous_snapshot(async_client):
    first = {
        "goals": [{"id": "11111111-1111-1111-1111-111111111111", "title": "Old goal"}],
        "tasks": [],
    }
    second = {
        "goals": [{"id": "33333333-3333-3333-3333-333333333333", "title": "New goal"}],
        "tasks": [],
    }

    await async_client.put("/api/backup", json=first)
    await async_client.put("/api/backup", json=second)

    body = (await async_client.get("/api/backup")).json()
    assert [g["title"] for g in body["goals"]] == ["New goal"]


async def test_deletions_survive_a_round_trip(async_client):
    """A deleted record is absent from the payload, so it stays deleted.

    This is why the snapshot needs no tombstone column.
    """
    await async_client.put(
        "/api/backup",
        json={
            "goals": [
                {"id": "11111111-1111-1111-1111-111111111111", "title": "Kept"},
            ],
            "tasks": [],
        },
    )
    await async_client.put(
        "/api/backup",
        json={
            "goals": [
                {"id": "11111111-1111-1111-1111-111111111111", "title": "Kept"},
                {"id": "44444444-4444-4444-4444-444444444444", "title": "Doomed"},
            ],
            "tasks": [],
        },
    )
    await async_client.put(
        "/api/backup",
        json={
            "goals": [
                {"id": "11111111-1111-1111-1111-111111111111", "title": "Kept"},
            ],
            "tasks": [],
        },
    )

    body = (await async_client.get("/api/backup")).json()
    assert [g["title"] for g in body["goals"]] == ["Kept"]


async def test_upload_rejects_rows_without_an_id_or_title(async_client):
    response = await async_client.put(
        "/api/backup", json={"goals": [{"title": "no id"}], "tasks": []}
    )
    assert response.status_code == 422


async def test_upload_rejects_an_oversized_snapshot(async_client):
    rows = [
        {"id": f"{i:08d}-0000-0000-0000-000000000000", "title": f"Goal {i}"}
        for i in range(5001)
    ]
    response = await async_client.put("/api/backup", json={"goals": rows, "tasks": []})
    assert response.status_code == 413


async def test_only_one_snapshot_is_stored_per_user(async_client, db_session):
    await async_client.put(
        "/api/backup", json={"goals": [{"id": "1" * 8 + "-0000-0000-0000-000000000000", "title": "A"}], "tasks": []}
    )
    await async_client.put(
        "/api/backup", json={"goals": [{"id": "2" * 8 + "-0000-0000-0000-000000000000", "title": "B"}], "tasks": []}
    )

    rows = (await db_session.execute(select(Backup))).scalars().all()
    assert len(rows) == 1
