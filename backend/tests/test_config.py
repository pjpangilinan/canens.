"""The shared-token guard, the health check, and the CORS contract."""
import pytest
from fastapi import HTTPException

from app.config import settings

# Individual async tests are marked where they need it; the settings tests at
# the bottom are sync, so there is no module-level mark to misapply to them.


@pytest.fixture
def stub(monkeypatch):
    """Stand in for the model so tests can assert on what never reached it."""

    class _Stub:
        def __init__(self):
            self.calls = []

        def next_steps(self, goal_title, existing_tasks):
            self.calls.append((goal_title, existing_tasks))
            return {"status": "more", "tasks": ["Step"]}

    installed = _Stub()
    monkeypatch.setattr("app.routers.ai.bedrock", installed)
    return installed


pytest.mark.asyncio
async def test_health_is_reachable_without_a_token(async_client):
    response = await async_client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


pytest.mark.asyncio
async def test_routes_are_open_when_no_token_is_configured(async_client, monkeypatch):
    """Local development should not require configuring a secret."""
    monkeypatch.setattr(settings, "api_token", None)

    response = await async_client.post(
        "/api/goals/next-steps", json={"goal_title": "Anything"}
    )
    assert response.status_code != 401


pytest.mark.asyncio
async def test_missing_token_is_rejected_when_configured(async_client, monkeypatch):
    monkeypatch.setattr(settings, "api_token", "s3cret")

    response = await async_client.post(
        "/api/goals/next-steps", json={"goal_title": "Anything"}
    )
    assert response.status_code == 401


pytest.mark.asyncio
async def test_wrong_token_is_rejected(async_client, monkeypatch):
    monkeypatch.setattr(settings, "api_token", "s3cret")

    response = await async_client.post(
        "/api/goals/next-steps",
        json={"goal_title": "Anything"},
        headers={"X-Canens-Token": "guess"},
    )
    assert response.status_code == 401


pytest.mark.asyncio
async def test_a_non_ascii_token_is_rejected_not_crashed(monkeypatch):
    """compare_digest raises TypeError on non-ASCII str operands, and Starlette
    decodes header bytes as latin-1, so a high byte in the header would
    otherwise turn the guard into an unauthenticated 500.

    Exercised by calling the dependency directly: an HTTP client refuses to
    encode a non-ASCII header value at all, so the transport cannot reproduce
    what a raw request would do.
    """
    from app.deps import require_token

    monkeypatch.setattr(settings, "api_token", "s3cret")

    for bad in ("é", "s3crét", "\x80\x81", "s3cret\xff"):
        with pytest.raises(HTTPException) as caught:
            await require_token(x_canens_token=bad)
        assert caught.value.status_code == 401, f"{bad!r} produced {caught.value.status_code}"


pytest.mark.asyncio
async def test_a_missing_token_is_rejected(monkeypatch):
    from app.deps import require_token

    monkeypatch.setattr(settings, "api_token", "s3cret")

    for bad in (None, ""):
        with pytest.raises(HTTPException) as caught:
            await require_token(x_canens_token=bad)
        assert caught.value.status_code == 401


pytest.mark.asyncio
async def test_the_correct_token_passes_the_guard(monkeypatch):
    from app.deps import require_token

    monkeypatch.setattr(settings, "api_token", "s3cret")
    await require_token(x_canens_token="s3cret")


pytest.mark.asyncio
async def test_an_oversized_task_list_is_rejected(async_client, monkeypatch, stub):
    """The list is interpolated into the prompt and billed as input tokens.
    Unbounded, a caller could post tens of thousands of entries and exhaust
    the daily allowance on calls that can only fail."""

    response = await async_client.post(
        "/api/goals/next-steps",
        json={
            "goal_title": "Anything",
            "existing_tasks": [{"title": f"t{i}", "status": "Pending"} for i in range(500)],
        },
    )

    assert response.status_code == 422
    assert stub.calls == []


pytest.mark.asyncio
async def test_correct_token_is_accepted(async_client, monkeypatch):
    monkeypatch.setattr(settings, "api_token", "s3cret")

    response = await async_client.post(
        "/api/goals/next-steps",
        json={"goal_title": "Anything"},
        headers={"X-Canens-Token": "s3cret"},
    )
    assert response.status_code != 401


class TestFailClosed:
    """Without this, forgetting API_TOKEN in production silently publishes an
    unauthenticated, billable endpoint to the internet."""

    def test_production_without_a_token_fails_at_startup(self, monkeypatch):
        from pydantic import ValidationError

        from app.config import Settings

        monkeypatch.delenv("API_TOKEN", raising=False)
        monkeypatch.delenv("GROQ_API_KEY", raising=False)

        with pytest.raises(ValidationError, match="API_TOKEN must be set"):
            Settings(app_env="production")

    def test_production_with_a_token_is_fine(self, monkeypatch):
        from app.config import Settings

        monkeypatch.setenv("API_TOKEN", "s3cret")
        assert Settings(app_env="production").api_token == "s3cret"

    def test_development_does_not_require_one(self, monkeypatch):
        from app.config import Settings

        monkeypatch.delenv("API_TOKEN", raising=False)
        assert Settings(app_env="development").api_token is None


class TestCORS:
    def test_no_wildcard_origin_is_allowed(self):
        from app.config import Settings

        settings = Settings(allowed_origins="https://example.github.io,http://localhost:3000")
        assert settings.origin_list == [
            "https://example.github.io",
            "http://localhost:3000",
        ]

    def test_blank_entries_are_discarded(self):
        from app.config import Settings

        assert Settings(allowed_origins="https://example.com, ,").origin_list == [
            "https://example.com"
        ]
