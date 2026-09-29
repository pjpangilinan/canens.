"""Test fixtures.

There is no database. The two pieces of server state are an S3 object and a
DynamoDB table, and both are faked at the boto3 client boundary - the same seam
test_bedrock.py stubs for Bedrock. The fakes hold real state so a round trip is
a real round trip, and they record the parameters that were sent so a test can
assert on the request, not only on the response.

Set CANENS_TEST=1 to talk to real AWS instead. It is off by default so the suite
cannot spend money or write to a real bucket by accident.
"""
import json
import os
from io import BytesIO

import pytest
import pytest_asyncio
from botocore.exceptions import ClientError
from httpx import ASGITransport, AsyncClient

from app import storage
from app.main import app
from app.services import usage

USE_REAL_AWS = os.environ.get("CANENS_TEST") == "1"

#: The subject API Gateway would have verified and put in the request header.
TEST_USER = "11111111-1111-1111-1111-111111111111"
OTHER_USER = "22222222-2222-2222-2222-222222222222"

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

    def delete_object(self, Bucket, Key, **kwargs):  # noqa: N803
        self.objects.pop(Key, None)
        return {}


class FakeDynamoDB:
    """A conditional counter, and the parameters seen.

    Only UpdateItem exists on purpose. The fake covers exactly the operations the
    application is allowed to make, so an extra call - and therefore a missing
    IAM grant - fails the suite here instead of failing in Lambda with an opaque
    ClientError, which is how the GetItem/PutItem omission presented last time.

    Two things are deliberate, both learned the hard way:

    * The condition is the whole point of the design - it is what stops two
      concurrent requests from both getting past the limit - so it is
      implemented rather than ignored.
    * The types are validated. The real resource interface accepts native
      Python types and the low-level one does not, and a fake that accepts
      either will pass a test for code that raises ParamValidationError against
      the real service.
    """

    def __init__(self) -> None:
        self.items: dict[str, dict] = {}
        self.updates: list[dict] = []

    def __getattr__(self, name: str):
        if name in ("get_item", "put_item", "delete_item", "query", "scan"):
            raise AssertionError(
                f"the application called {name}, which is not in the function's "
                f"IAM policy - add it to the template or do not make the call"
            )
        raise AttributeError(name)

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
        vals = kwargs["ExpressionAttributeValues"]
        calls = self.items.get(key, {}).get("calls", 0)
        if ":limit" in vals:
            limit = vals[":limit"]
            if calls >= limit:
                raise ClientError(
                    {
                        "Error": {
                            "Code": "ConditionalCheckFailedException",
                            "Message": "The conditional request failed",
                        }
                    },
                    "UpdateItem",
                )
            merged = {**self.items.get(key, {}), "calls": calls + 1}
            self.items[key] = merged
            return {"Attributes": {"calls": merged["calls"]}}
        elif ":minus_one" in vals:
            if calls <= 0:
                raise ClientError(
                    {
                        "Error": {
                            "Code": "ConditionalCheckFailedException",
                            "Message": "The conditional request failed",
                        }
                    },
                    "UpdateItem",
                )
            merged = {**self.items.get(key, {}), "calls": max(0, calls - 1)}
            self.items[key] = merged
            return {"Attributes": {"calls": merged["calls"]}}
        return {"Attributes": {"calls": calls}}

    def calls_for(self, key: str) -> int:
        return self.items.get(key, {}).get("calls", 0)


class StubBedrock:
    """Stands in for the model, and records what it was asked for."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def next_steps(self, goal_title, existing_tasks):
        self.calls.append((goal_title, existing_tasks))
        return {"status": "more", "tasks": ["Step"]}

    def starter_goals(self, answers, count=4):
        self.calls.append((answers, count))
        return {"goals": ["A goal"]}


@pytest.fixture(autouse=True)
def no_bedrock(monkeypatch, request):
    """No test may reach Bedrock, so CI cannot spend money.

    Autouse, because the alternative is each test remembering. Two of these were
    written without a stub and reached the real client: they passed on a machine
    with AWS credentials and failed in CI on NoCredentialsError, which is the
    whole failure mode this fixture exists to make impossible.

    A test that genuinely needs the provider asks for it by requesting
    ``real_bedrock``, and that is only honoured when CANENS_TEST=1.
    """
    if os.environ.get("CANENS_TEST") == "1" and "real_bedrock" in request.fixturenames:
        yield None
        return

    stub = StubBedrock()
    monkeypatch.setattr("app.routers.ai.bedrock", stub)
    yield stub


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


def _client_for(store, user: str):
    """An HTTP client that presents itself as a signed-in user."""
    return AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
        headers={"x-canens-user": user},
    )


@pytest_asyncio.fixture
async def async_client(s3, dynamodb):
    """Signed in, with one snapshot already stored."""
    s3.objects[storage.snapshot_key(TEST_USER)] = {
        "goals": SEEDED_GOALS,
        "tasks": SEEDED_TASKS,
        "saved_at": "2026-01-01T00:00:00+00:00",
    }
    async with _client_for(s3, TEST_USER) as client:
        yield client


@pytest_asyncio.fixture
async def empty_client(s3, dynamodb):
    """Signed in, with nothing stored yet: a user on their first visit."""
    async with _client_for(s3, TEST_USER) as client:
        yield client


@pytest_asyncio.fixture
async def anonymous_client(s3, dynamodb):
    """No identity header at all, which is what an unsigned-in browser sends."""
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


@pytest_asyncio.fixture
async def other_user_client(s3, dynamodb):
    """A different signed-in user, sharing the same server."""
    s3.objects[storage.snapshot_key(OTHER_USER)] = {
        "goals": [{"id": "goal-9", "title": "Someone else's goal"}],
        "tasks": [],
        "saved_at": "2026-01-01T00:00:00+00:00",
    }
    async with _client_for(s3, OTHER_USER) as client:
        yield client
