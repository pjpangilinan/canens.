"""The whole-store snapshot, as one object in S3.

The browser owns the data. This is a copy, not a sync: one object per user,
overwritten on every upload, and nothing is merged. That is the whole reason it
can be an object store rather than a database - there are no queries to run and
no rows to join, so there is nothing a relational engine would be buying.

The calls are blocking boto3, so the routes that use this are ``def`` rather
than ``async def`` and FastAPI runs them in its threadpool. An ``async def``
route calling boto3 directly blocks the event loop for the length of the
request.
"""
import json
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

from app.config import settings

# A snapshot is one JSON document. Keep it well under the 5 MB single-request
# limit S3 enforces; the route's own row limit is the tighter of the two.
MAX_SNAPSHOT_ROWS = 5000

_client: Any = None


def client() -> Any:
    global _client
    if _client is None:
        _client = boto3.client("s3", region_name=settings.aws_region)
    return _client


def reset_client() -> None:
    """Drop the cached client. Tests use it to swap in a stubbed one."""
    global _client
    _client = None


def snapshot_key(user_id: str) -> str:
    # The user id stays in the key so that adding accounts later is a change to
    # this function and not to the data model.
    return f"snapshots/{user_id}.json"


def load_snapshot(user_id: str) -> dict[str, Any] | None:
    """Return the stored snapshot, or None if there has never been one."""
    try:
        response = client().get_object(
            Bucket=settings.snapshot_bucket, Key=snapshot_key(user_id)
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return None
        raise

    body = json.loads(response["Body"].read())
    return {
        "goals": body.get("goals", []),
        "tasks": body.get("tasks", []),
        "tombstones": body.get("tombstones", {}),
        "saved_at": body.get("saved_at"),
    }


def save_snapshot(
    user_id: str,
    goals: list[dict[str, Any]],
    tasks: list[dict[str, Any]],
    tombstones: dict[str, str] | None = None,
) -> dict[str, Any]:
    saved_at = datetime.now(timezone.utc)
    document = {
        "goals": goals,
        "tasks": tasks,
        "tombstones": tombstones or {},
        "saved_at": saved_at.isoformat(),
    }
    client().put_object(
        Bucket=settings.snapshot_bucket,
        Key=snapshot_key(user_id),
        Body=json.dumps(document).encode("utf-8"),
        ContentType="application/json",
    )
    return {
        "goals": goals,
        "tasks": tasks,
        "tombstones": tombstones or {},
        "saved_at": saved_at.isoformat(),
    }


def delete_snapshot(user_id: str) -> None:
    """Delete the user's snapshot from S3."""
    client().delete_object(
        Bucket=settings.snapshot_bucket,
        Key=snapshot_key(user_id),
    )
