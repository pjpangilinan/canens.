import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import current_user_id, require_token
from app.models import Backup

router = APIRouter(
    prefix="/api/backup",
    tags=["backup"],
    dependencies=[Depends(require_token)],
)

MAX_SNAPSHOT_ROWS = 5000


class SnapshotIn(BaseModel):
    goals: list[dict[str, Any]] = Field(default_factory=list)
    tasks: list[dict[str, Any]] = Field(default_factory=list)


class SnapshotOut(BaseModel):
    exists: bool
    goals: list[dict[str, Any]] = []
    tasks: list[dict[str, Any]] = []
    saved_at: datetime | None = None


@router.get("", response_model=SnapshotOut)
async def download_backup(
    db: AsyncSession = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> SnapshotOut:
    result = await db.execute(select(Backup).where(Backup.user_id == user_id))
    backup = result.scalars().first()
    if backup is None:
        return SnapshotOut(exists=False)
    return SnapshotOut(
        exists=True,
        goals=backup.goals,
        tasks=backup.tasks,
        saved_at=backup.saved_at,
    )


@router.put("", response_model=SnapshotOut)
async def upload_backup(
    snapshot: SnapshotIn,
    db: AsyncSession = Depends(get_db),
    user_id: uuid.UUID = Depends(current_user_id),
) -> SnapshotOut:
    total = len(snapshot.goals) + len(snapshot.tasks)
    if total > MAX_SNAPSHOT_ROWS:
        raise HTTPException(
            status_code=413,
            detail=f"Snapshot too large: {total} rows, limit is {MAX_SNAPSHOT_ROWS}",
        )

    for row in [*snapshot.goals, *snapshot.tasks]:
        if not isinstance(row.get("id"), str) or not row.get("title"):
            raise HTTPException(
                status_code=422, detail="Every row needs a string id and a title"
            )

    result = await db.execute(select(Backup).where(Backup.user_id == user_id))
    backup = result.scalars().first()
    if backup is None:
        backup = Backup(user_id=user_id)
        db.add(backup)

    backup.goals = snapshot.goals
    backup.tasks = snapshot.tasks
    await db.commit()
    await db.refresh(backup)

    return SnapshotOut(
        exists=True,
        goals=backup.goals,
        tasks=backup.tasks,
        saved_at=backup.saved_at,
    )
