"""The daily model-call counter.

It is a counter rather than a row in a table because the only thing the server
needs to remember is how many times it has called a model today, and the thing
that makes it hard is not storage - it is that Lambda discards execution
environments, so an in-process counter resets to zero whenever a container is
replaced. A value that silently resets is worse than no ceiling at all, because
it looks like it is working.

DynamoDB gives an atomic increment with a condition, so two concurrent requests
cannot both slip past the limit, and one item per user per day expires by TTL.
On-demand capacity makes the whole thing a rounding error in the bill.
"""
import time
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


def _key(user_id: str, day: date) -> str:
    return f"{user_id}#{day.isoformat()}"


def reserve_call(user_id: str, limit: int) -> int | None:
    """Claim one call for today. Returns the new count, or None if disabled.

    Raises DailyCapReached once the day's allowance is spent. The increment and
    the check are a single conditional update, so the ceiling holds under
    concurrency rather than being a read followed by a hopeful write.
    """
    if limit <= 0:
        return None

    day = today()
    # Two days of grace, so a counter written just before midnight is not
    # deleted while it is still today's.
    expires = int(time.time()) + 2 * 24 * 60 * 60

    try:
        response = client().update_item(
            Key={"pk": _key(user_id, day)},
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
