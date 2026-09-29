"""Per-user daily model-call allowance.

Sign-up is open, so the server is public to strangers and every one of them can
call a model. Two things bound that.

The allowance is per user, and it starts small. A new account gets a handful of
calls and ramps up over the first few days, so an account created an hour ago to
try the app cannot cost anything meaningful, while a real person's allowance
reaches its steady state in under a week. The ramp is in `settings`.

The count lives in DynamoDB rather than in the process because Lambda discards
execution environments: a counter in memory resets to zero whenever a container
is replaced, which looks like a working ceiling and is not one. The increment and
the check are a single conditional update, so the ceiling holds when two requests
arrive together rather than being a read followed by a hopeful write.

The account's age is measured from its first recorded call, not from when the
user signed up, so it does not depend on anything Cognito reports and cannot be
backdated by a client.
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

#: Partition key prefix for the one record describing an account.
_USER_PREFIX = "u#"
#: Partition key prefix for a day's counter.
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


def _user_key(user_id: uuid.UUID) -> str:
    return f"{_USER_PREFIX}{user_id}"


def _first_seen(user_id: uuid.UUID) -> date:
    """When this account was first seen, recording it if it is new.

    Two accounts racing to create the same record is not a problem worth a
    transaction: both write the same value, and the loser re-reads. The loser of
    the race is the only one that pays for the extra read.
    """
    table = client()
    key = _user_key(user_id)

    response = table.get_item(Key={"pk": key})
    item = response.get("Item")
    if item and item.get("first_seen"):
        return date.fromisoformat(item["first_seen"])

    today_iso = today().isoformat()
    try:
        table.put_item(
            Item={"pk": key, "first_seen": today_iso},
            ConditionExpression="attribute_not_exists(pk)",
        )
        return today()
    except ClientError as exc:
        if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        # Someone else created it first; their value is the real one.
        existing = table.get_item(Key={"pk": key}).get("Item") or {}
        return date.fromisoformat(existing.get("first_seen", today_iso))


def allowance(user_id: uuid.UUID) -> int:
    """Today's cap for this account."""
    age_days = (today() - _first_seen(user_id)).days
    return settings.daily_cap_for(age_days)


def reserve_call(user_id: uuid.UUID) -> int | None:
    """Claim one call for today. Returns the new count, or None if disabled.

    Raises DailyCapReached once today's allowance is spent.
    """
    limit = allowance(user_id)
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
