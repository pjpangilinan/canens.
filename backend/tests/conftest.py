"""Test fixtures.

There is no database. The two pieces of server state are an S3 object and a
DynamoDB item, and both are faked at the boto3 client boundary - the same seam
test_bedrock.py stubs for Bedrock. The fakes hold real state so a round trip is
a real round trip, and they record the parameters that were sent so a test can
assert on the request, not only on the response.

Set CANENS_TEST=1 to talk to real AWS instead. It is off by default so the suite
cannot spend money or write to a real bucket by accident.
"""
import json
import os
from io import BytesIO

import boto3
import pytest
import pytest_asyncio
from botocore.exceptions import ClientError
from httpx import ASGITransport, AsyncClient

from app import storage
from app.config import MVP_USER_ID
from app.main import app
from app.services import usage

USE_REAL_AWS = os.environ.get("CANENS_TEST") == "1"

SEEDED_GOALS = [{"id": "goal-1", "title": "Launch the MVP"}]
SEEDED_TASKS = [
    {"id": "task-1", "title": "Write the spec", "goal_id": "goal-1"},
]


class FakeS3:
    """Just the two operations app/storage.py uses."""

    def __init__(self) -> None:
        self.objects: dict[str, dict] = {}
        self.puts: list[dict] = []

    def get_object(self, Bucket, Key, **kwargs):  # noqa: N803 - boto3 casing
        if Key not in self.objects:
            raise ClientError(
                {"Error": {"Code": "NoSuchKey", "Message": "not found"}}, "GetObject"
            )
        body = json.dumps(self.objects[Key]).encode("utf-8")
        return {"Body": BytesIO(body)}

    def put_object(self, Bucket, Key, Body, ContentType=None, **kwargs):  # noqa: N803
        payload = json.loads(Body.decode("utf-8"))
        self.objects[Key] = payload
        self.puts.append({"bucket": Bucket, "key": Key, "body": payload,
                          "content_type": ContentType})
        return {}


class FakeDynamoDB:
    """Implements the conditional counter, and records the parameters.

    Two things here are deliberate and were both learned the hard way:

    * The condition is the whole point of the design - it is what stops two
      concurrent requests from both getting past the limit - so it is
      implemented rather than ignored.
    * The types are validated. The real resource interface accepts native
      Python types and the low-level one does not, and a fake that accepts
      either will pass a test for code that raises ParamValidationError against
      the real service.
    """

    def __init__(self) -> None:
        self.items: dict[str, int] = {}
        self.updates: list[dict] = []

    def update_item(self, **kwargs):
        for name, value in kwargs["ExpressionAttributeValues"].items():
            assert not isinstance(value, dict), (
                f"{name} was sent in wire format ({value!r}). The resource "
                f"interface takes native types; wire format is what the "
                f"low-level client needs, and passing it to one of the two that "
                f"does not want it is a runtime ParamValidationError."
            )
        for name, value in kwargs["Key"].items():
            assert isinstance(value, str), f"Key.{name} must be a string, got {value!r}"

        self.updates.append(kwargs)
        key = kwargs["Key"]["pk"]
        limit = kwargs["ExpressionAttributeValues"][":limit"]
        current = self.items.get(key, 0)
        if current >= limit:
            raise ClientError(
                {
                    "Error": {
                        "Code": "ConditionalCheckFailedException",
                        "Message": "The conditional request failed",
                    }
                },
                "UpdateItem",
            )
        self.items[key] = current + 1
        return {"Attributes": {"calls": current + 1}}


@pytest.fixture
def s3():
    fake = FakeS3()
    if not USE_REAL_AWS:
        storage._client = fake
    try:
        yield fake
    finally:
        storage._client = None


@pytest.fixture
def dynamodb():
    fake = FakeDynamoDB()
    if not USE_REAL_AWS:
        usage._client = fake
    try:
        yield fake
    finally:
        usage._client = None


@pytest_asyncio.fixture
async def async_client(s3, dynamodb):
    """An HTTP client over the app, with AWS faked and one snapshot already stored."""
    s3.objects[storage.snapshot_key(MVP_USER_ID)] = {
        "goals": SEEDED_GOALS,
        "tasks": SEEDED_TASKS,
        "saved_at": "2026-01-01T00:00:00+00:00",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client


@pytest_asyncio.fixture
async def empty_client(s3, dynamodb):
    """The same, with nothing stored yet."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client


@pytest.fixture(scope="session")
def aws_region():
    return boto3.session.Session().region_name or "us-east-1"
