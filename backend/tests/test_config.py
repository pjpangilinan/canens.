"""The shared-token guard, the health check, and the CORS contract."""
import pytest

from app.config import settings

pytestmark = pytest.mark.asyncio


async def test_health_is_reachable_without_a_token(async_client):
    response = await async_client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_routes_are_open_when_no_token_is_configured(async_client, monkeypatch):
    """Local development should not require configuring a secret."""
    monkeypatch.setattr(settings, "api_token", None)

    response = await async_client.post(
        "/api/goals/next-steps", json={"goal_title": "Anything"}
    )
    assert response.status_code != 401


async def test_missing_token_is_rejected_when_configured(async_client, monkeypatch):
    monkeypatch.setattr(settings, "api_token", "s3cret")

    response = await async_client.post(
        "/api/goals/next-steps", json={"goal_title": "Anything"}
    )
    assert response.status_code == 401


async def test_wrong_token_is_rejected(async_client, monkeypatch):
    monkeypatch.setattr(settings, "api_token", "s3cret")

    response = await async_client.post(
        "/api/goals/next-steps",
        json={"goal_title": "Anything"},
        headers={"X-Canens-Token": "guess"},
    )
    assert response.status_code == 401


async def test_correct_token_is_accepted(async_client, monkeypatch):
    monkeypatch.setattr(settings, "api_token", "s3cret")

    response = await async_client.post(
        "/api/goals/next-steps",
        json={"goal_title": "Anything"},
        headers={"X-Canens-Token": "s3cret"},
    )
    assert response.status_code != 401


async def test_backup_is_guarded_too(async_client, monkeypatch):
    monkeypatch.setattr(settings, "api_token", "s3cret")

    assert (await async_client.get("/api/backup")).status_code == 401
    assert (
        await async_client.put("/api/backup", json={"goals": [], "tasks": []})
    ).status_code == 401
