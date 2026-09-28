"""The AI routes are a proxy, and must stay that way.

The previous spec required asserting that requesting next steps does not
trigger generation by itself. That test was never written. It is cheap to
assert here because the route has no database dependency at all, so the
absence of persistence is structural rather than a promise.
"""
import pytest

from app.routers import ai
from app.services.bedrock import NextSteps, ProposedTask, ProviderError, StarterGoals

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
    stub(
        NextSteps(
            status="more",
            tasks=[ProposedTask(title="Draft the outline"), ProposedTask(title="Review it")],
        )
    )

    response = await async_client.post(
        "/api/goals/next-steps",
        json={
            "goal_title": "Write a book",
            "existing_tasks": [{"title": "Choose a topic", "status": "Completed"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "more"
    assert [t["title"] for t in body["tasks"]] == ["Draft the outline", "Review it"]


async def test_next_steps_passes_existing_tasks_through(async_client, stub):
    installed = stub(NextSteps(status="more", tasks=[ProposedTask(title="Next")]))

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


async def test_next_steps_does_not_persist_anything(async_client, stub, db_session):
    """Generation is a proposal. Nothing is written until the user accepts it."""
    from sqlalchemy import func, select

    from app.models import Goal, Task

    stub(NextSteps(status="more", tasks=[ProposedTask(title="Do the thing")]))

    response = await async_client.post(
        "/api/goals/next-steps", json={"goal_title": "Never stored"}
    )
    assert response.status_code == 200

    goals = (await db_session.execute(select(func.count(Goal.id)))).scalar_one()
    tasks = (await db_session.execute(select(func.count(Task.id)))).scalar_one()

    assert goals == 0
    assert tasks == 0


async def test_provider_failure_is_surfaced_not_substituted(async_client, stub):
    """A failure must reach the user. The old code returned a fake task instead."""
    stub(error=ProviderError("bedrock unavailable"))

    response = await async_client.post(
        "/api/goals/next-steps", json={"goal_title": "Anything"}
    )

    assert response.status_code == 502
    assert "unavailable" in response.json()["detail"]


async def test_done_status_is_reported_for_the_user_to_confirm(async_client, stub):
    stub(NextSteps(status="done", tasks=[]))

    response = await async_client.post(
        "/api/goals/next-steps", json={"goal_title": "Already finished"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "done"
    assert body["tasks"] == []


async def test_starter_goals_returns_titles(async_client, stub):
    stub(StarterGoals(goals=[ProposedTask(title="Run a marathon")]))

    response = await async_client.post(
        "/api/onboarding/starter-goals", json={"answers": "I want to get fit"}
    )

    assert response.status_code == 200
    assert response.json() == {"goals": [{"title": "Run a marathon"}]}
