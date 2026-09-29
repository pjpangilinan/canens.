"""Per-user daily model-call allowance.

Sign-up is open, so the server is public to strangers and every one of them can
call a model. One number bounds that: `AI_DAILY_CAP` calls per account per day.

The count lives in DynamoDB rather than in the process because Lambda discards
execution environments: a counter in memory resets to zero whenever a container
is replaced, which looks like a working ceiling and is not one. The increment and
the check are a single conditional update, so the ceiling holds when two requests
arrive together rather than being a read followed by a hopeful write.

One item per account per day, removed by TTL. There is no second item and no
extra read: an earlier version dated the account so the allowance could ramp, and
once the cap was a flat number the whole of that existed to choose between 10
and 25.
"""
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

from app.config import settings


class DailyCapReached(Exception):
    def __init__(self, day: date, limit: int) -> None:
        tomorrow = day + timedelta(days=1)
        super().__init__(
            f"Daily model call limit reached ({limit}). "
            f"Try again after {tomorrow.isoformat()}."
        )
        self.day = day
        self.limit = limit


_client: Any = None

#: Partition key prefix for a day's counter. Namespaced so the table can hold
#: other kinds of item later without a migration.
_COUNTER_PREFIX = "c#"


def client() -> Any:
    """The DynamoDB table.

    Uses the resource interface, which takes native Python types. The low-level
    client does not, and rejects a bare int or str with a ParamValidationError
    that only appears at runtime: a test that fakes the client and accepts
    whatever it is handed will pass while the deployed function cannot count
    anything at all.
    """
    global _client
    if _client is None:
        resource = boto3.resource("dynamodb", region_name=settings.aws_region)
        _client = resource.Table(settings.usage_table)
    return _client


def reset_client() -> None:
    global _client
    _client = None


def today() -> date:
    # not date.today(): Lambda runs in UTC and a laptop does not.
    return datetime.now(timezone.utc).date()


def _counter_key(user_id: uuid.UUID, day: date) -> str:
    return f"{_COUNTER_PREFIX}{user_id}#{day.isoformat()}"


def reserve_call(user_id: uuid.UUID) -> int | None:
    """Claim one call for today. Returns the new count, or None if disabled.

    Raises DailyCapReached once today's allowance is spent.
    """
    limit = settings.ai_daily_cap
    if limit <= 0:
        return None

    day = today()
    # Two days of grace, so a counter written just before midnight is not
    # deleted while it is still today's.
    expires = int(time.time()) + 2 * 24 * 60 * 60

    try:
        response = client().update_item(
            Key={"pk": _counter_key(user_id, day)},
            UpdateExpression="ADD #calls :one SET #expires = :expires",
            # Fails once calls has reached the limit, so exactly `limit` calls
            # get through.
            ConditionExpression="attribute_not_exists(#calls) OR #calls < :limit",
            ExpressionAttributeNames={"#calls": "calls", "#expires": "expires"},
            ExpressionAttributeValues={
                ":one": 1,
                ":limit": limit,
                ":expires": expires,
            },
            ReturnValues="UPDATED_NEW",
        )
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise DailyCapReached(day, limit) from exc
        raise

    return int(response["Attributes"]["calls"])
