from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.deps import require_user
from app.storage import (
    MAX_SNAPSHOT_ROWS,
    delete_snapshot,
    load_snapshot,
    save_snapshot,
)

router = APIRouter(
    prefix="/api/backup",
    tags=["backup"],
    dependencies=[Depends(require_user)],
)


class SnapshotIn(BaseModel):
    goals: list[dict[str, Any]] = Field(default_factory=list)
    tasks: list[dict[str, Any]] = Field(default_factory=list)
    tombstones: dict[str, str] = Field(default_factory=dict)


class SnapshotOut(BaseModel):
    exists: bool
    goals: list[dict[str, Any]] = []
    tasks: list[dict[str, Any]] = []
    tombstones: dict[str, str] = {}
    saved_at: datetime | None = None


# These two are plain `def`, not `async def`. They call boto3, which blocks, and
# FastAPI only hands a non-async endpoint to its threadpool. An `async def` here
# would stall the event loop for the length of the S3 round trip.
@router.get("", response_model=SnapshotOut)
def download_backup(user_id=Depends(require_user)) -> SnapshotOut:
    stored = load_snapshot(str(user_id))
    if stored is None:
        return SnapshotOut(exists=False)
    return SnapshotOut(exists=True, **stored)


@router.put("", response_model=SnapshotOut)
def upload_backup(snapshot: SnapshotIn, user_id=Depends(require_user)) -> SnapshotOut:
    total = len(snapshot.goals) + len(snapshot.tasks)
    if total > MAX_SNAPSHOT_ROWS:
        raise HTTPException(
            status_code=413,
            detail=f"Snapshot too large: {total} rows, limit is {MAX_SNAPSHOT_ROWS}",
        )

    for row in [*snapshot.goals, *snapshot.tasks]:
        row_id = row.get("id")
        row_title = row.get("title")
        if (
            not isinstance(row_id, str)
            or not row_id
            or len(row_id) > 128
            or not isinstance(row_title, str)
            or not row_title
            or len(row_title) > 1000
        ):
            raise HTTPException(
                status_code=422, detail="Every row needs a string id and a title"
            )
        for k, v in row.items():
            if isinstance(v, str) and len(v) > 2000:
                raise HTTPException(
                    status_code=422,
                    detail=f"Field '{k}' exceeds maximum length of 2000 characters",
                )

    if len(snapshot.tombstones) > 5000:
        raise HTTPException(status_code=413, detail="Too many tombstones")

    saved = save_snapshot(
        str(user_id),
        snapshot.goals,
        snapshot.tasks,
        snapshot.tombstones,
    )
    return SnapshotOut(exists=True, **saved)


@router.delete("", status_code=204)
def delete_backup(user_id=Depends(require_user)) -> None:
    delete_snapshot(str(user_id))


@router.get("/export")
def export_backup(user_id=Depends(require_user)) -> dict[str, Any]:
    stored = load_snapshot(str(user_id))
    return {
        "goals": stored.get("goals", []) if stored else [],
        "tasks": stored.get("tasks", []) if stored else [],
        "tombstones": stored.get("tombstones", {}) if stored else {},
        "saved_at": stored.get("saved_at") if stored else None,
        "exported_at": datetime.now().isoformat(),
    }
