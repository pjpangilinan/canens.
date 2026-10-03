"""The AI routes are a proxy, and must stay that one.

The previous spec required asserting that requesting next steps does not
trigger generation by itself. That test was never written. It is cheap to
assert here because neither route writes a goal or a task; the only thing
they persist is the call counted against the daily cap.
"""
import pytest

from app.config import settings
from app.routers import ai
from app.services.bedrock import ProviderError

pytestmark = pytest.mark.asyncio


class _StubBedrock:
    def __init__(self, result=None, error=None):
        self._result = result
        self._error = error
        self.calls = []

    def next_steps(self, goal_title, existing_tasks):
        self.calls.append((goal_title, existing_tasks))
        if self._error:
            raise self._error
        return self._result

    def next_steps_stream(self, goal_title, existing_tasks):
        self.calls.append((goal_title, existing_tasks))
        if self._error:
            raise self._error
        yield {"type": "token", "text": "Drafting "}
        yield {
            "type": "done",
            "status": self._result.get("status", "more"),
            "tasks": self._result.get("tasks", []),
        }

    def starter_goals(self, answers, count=4):
        self.calls.append((answers, count))
        if self._error:
            raise self._error
        return self._result


@pytest.fixture
def stub(monkeypatch):
    def _install(result=None, error=None):
        stub = _StubBedrock(result=result, error=error)
        monkeypatch.setattr(ai, "bedrock", stub)
        return stub

    return _install


async def test_next_steps_returns_proposed_tasks(async_client, stub):
    stub({"status": "more", "tasks": ["Draft the outline", "Review it"]})

    response = await async_client.post(
        "/api/goals/next-steps",
        json={
            "goal_title": "Write a book",
            "existing_tasks": [{"title": "Choose a topic", "status": "Completed"}],
        },
    )

    assert response.status_code == 200
    assert response.json() == {"status": "more", "tasks": ["Draft the outline", "Review it"]}
    assert "x-ratelimit-limit" in response.headers
    assert "x-ratelimit-remaining" in response.headers


async def test_next_steps_passes_existing_tasks_through(async_client, stub):
    installed = stub({"status": "more", "tasks": ["Next"]})

    await async_client.post(
        "/api/goals/next-steps",
        json={
            "goal_title": "Ship it",
            "existing_tasks": [{"title": "One thing", "status": "Pending"}],
        },
    )

    goal_title, existing = installed.calls[0]
    assert goal_title == "Ship it"
    assert existing == [{"title": "One thing", "status": "Pending"}]


async def test_next_steps_writes_no_domain_rows(async_client, stub, s3):
    """Generation is a proposal. Nothing is saved until the user accepts it."""
    stub({"status": "more", "tasks": ["Do the thing"]})

    before = dict(s3.objects)
    response = await async_client.post(
        "/api/goals/next-steps", json={"goal_title": "Never stored"}
    )
    assert response.status_code == 200

    assert s3.objects == before, "a model call must not write the snapshot"


async def test_provider_failure_is_surfaced_not_substituted(async_client, stub, dynamodb):
    """A failure must reach the user, and the reserved attempt must be refunded."""
    from tests.conftest import TEST_USER
    from app.services import usage

    stub(error=ProviderError("bedrock unavailable"))
    key = f"c#{TEST_USER}#{usage.today().isoformat()}"
    before_calls = dynamodb.calls_for(key)

    response = await async_client.post(
        "/api/goals/next-steps", json={"goal_title": "Anything"}
    )

    assert response.status_code == 502
    assert "unavailable" in response.json()["detail"]
    assert dynamodb.calls_for(key) == before_calls


async def test_done_status_is_reported_for_the_user_to_confirm(async_client, stub):
    stub({"status": "done", "tasks": []})

    response = await async_client.post(
        "/api/goals/next-steps", json={"goal_title": "Already finished"}
    )

    assert response.status_code == 200
    assert response.json() == {"status": "done", "tasks": []}


async def test_starter_goals_returns_titles(async_client, stub):
    stub({"goals": ["Run a marathon"]})

    response = await async_client.post(
        "/api/onboarding/starter-goals", json={"answers": "I want to get fit"}
    )

    assert response.status_code == 200
    assert response.json() == {"goals": ["Run a marathon"]}


class TestDailyCap:
    """The endpoint is public and each call costs money, so the ceiling is in
    the application rather than relying on a budget alarm alone."""

    async def test_calls_below_the_cap_are_allowed(self, async_client, stub, monkeypatch):
        stub({"status": "more", "tasks": ["Step"]})

        for _ in range(3):
            response = await async_client.post(
                "/api/goals/next-steps", json={"goal_title": "Anything"}
            )
            assert response.status_code == 200

    async def test_calls_beyond_the_cap_are_refused(self, async_client, stub, monkeypatch):
        monkeypatch.setattr(settings, "ai_daily_cap", 2)
        installed = stub({"status": "more", "tasks": ["Step"]})

        for _ in range(2):
            response = await async_client.post(
                "/api/goals/next-steps", json={"goal_title": "Anything"}
            )
            assert response.status_code == 200

        refused = await async_client.post(
            "/api/goals/next-steps", json={"goal_title": "Anything"}
        )
        assert refused.status_code == 429
        assert "limit reached" in refused.json()["detail"]

        # The refused call must not have reached the model.
        assert len(installed.calls) == 2

    async def test_the_cap_can_be_disabled(self, async_client, stub, monkeypatch):
        monkeypatch.setattr(settings, "ai_daily_cap", 0)
        stub({"status": "more", "tasks": ["Step"]})

        for _ in range(5):
            response = await async_client.post(
                "/api/goals/next-steps", json={"goal_title": "Anything"}
            )
            assert response.status_code == 200

    async def test_usage_is_recorded_against_today(self, async_client, stub, dynamodb):
        from app.services.usage import today

        stub({"status": "more", "tasks": ["Step"]})
        await async_client.post("/api/goals/next-steps", json={"goal_title": "Anything"})

        assert len(dynamodb.updates) == 1
        update = dynamodb.updates[0]
        assert update["Key"]["pk"].endswith(f"#{today().isoformat()}")
        assert dynamodb.items[update["Key"]["pk"]]["calls"] == 1

    async def test_the_counter_is_one_item_per_user_per_day(
        self, async_client, stub, dynamodb
    ):
        stub({"status": "more", "tasks": ["Step"]})
        for _ in range(3):
            await async_client.post(
                "/api/goals/next-steps", json={"goal_title": "Anything"}
            )

        # Exactly one item: the counter. There is no account record - a ramp
        # would have needed one to date itself, and the cap is flat.
        assert len(dynamodb.items) == 1
        assert list(dynamodb.items.values()) == [{"calls": 3}]

    async def test_the_limit_is_enforced_by_a_condition_not_a_read(
        self, async_client, stub, dynamodb
    ):
        """The ceiling has to hold under concurrency.

        A read-then-write would let two requests both see calls=1 and both
        proceed. The update carries the limit as a condition, so the storage
        layer refuses the one that would exceed it.
        """
        stub({"status": "more", "tasks": ["Step"]})
        await async_client.post("/api/goals/next-steps", json={"goal_title": "Anything"})

        condition = dynamodb.updates[0]["ConditionExpression"]
        assert "attribute_not_exists" in condition
        assert ":limit" in condition, condition

    async def test_usage_expires_by_ttl(self, async_client, stub, dynamodb):
        """One item per day would grow forever without a TTL."""
        stub({"status": "more", "tasks": ["Step"]})
        await async_client.post("/api/goals/next-steps", json={"goal_title": "Anything"})

        update = dynamodb.updates[0]
        expression = update["UpdateExpression"]
        assert "expires" in expression, expression
        assert int(update["ExpressionAttributeValues"][":expires"]) > 0

    async def test_usage_records_against_client_local_date(
        self, async_client, stub, dynamodb
    ):
        from datetime import timedelta
        from app.services.usage import today
        client_date = (today() - timedelta(days=1)).isoformat()
        stub({"status": "more", "tasks": ["Step"]})
        await async_client.post(
            "/api/goals/next-steps",
            json={"goal_title": "Anything"},
            headers={"X-Canens-Date": client_date},
        )

        assert len(dynamodb.updates) == 1
        update = dynamodb.updates[0]
        assert update["Key"]["pk"].endswith(f"#{client_date}")

    async def test_next_steps_stream_yields_sse(self, async_client, stub):
        stub({"status": "more", "tasks": ["Streaming Step 1", "Streaming Step 2"]})
        response = await async_client.post(
            "/api/goals/next-steps/stream",
            json={"goal_title": "Build a rocket"},
        )
        assert response.status_code == 200
        assert "text/event-stream" in response.headers["content-type"]
        body = response.text
        assert "event: done" in body
        assert "Streaming Step 1" in body
