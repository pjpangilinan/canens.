"""Who the server thinks you are.

Identity arrives in exactly one way: API Gateway's JWT authorizer validates the
token, and app/lambda_handler.py copies the verified subject into a request
header that the application reads. Every test here is about the edges of that
path, because the interesting failure is somebody reading somebody else's data.
"""
import uuid

import pytest
from fastapi import HTTPException

from app.config import settings
from app.deps import require_user
from app.lambda_handler import USER_HEADER, _verified_subject

VALID = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"


class TestRequireUser:
    pytestmark = pytest.mark.asyncio

    async def test_a_signed_in_caller_is_accepted(self):
        assert await require_user(x_canens_user=VALID) == uuid.UUID(VALID)

    async def test_no_identity_is_refused(self):
        for missing in (None, ""):
            with pytest.raises(HTTPException) as caught:
                await require_user(x_canens_user=missing)
            assert caught.value.status_code == 401

    async def test_something_that_is_not_a_subject_is_refused(self):
        """The subject becomes part of an S3 key and a DynamoDB key, so a value
        that is not a UUID must never reach one."""
        for forged in (
            "not-a-uuid",
            "11111111-1111-1111-1111-111111111111/../other",
            "../../snapshots/someone-else",
            "'; drop table goals; --",
        ):
            with pytest.raises(HTTPException) as caught:
                await require_user(x_canens_user=forged)
            assert caught.value.status_code == 401, forged


class TestVerifiedSubject:
    """What the handler reads out of the event."""

    def _event(self, claims, shape="jwt"):
        if shape == "jwt":
            authorizer = {"jwt": {"claims": claims}}
        else:
            authorizer = {"claims": claims}
        return {"requestContext": {"authorizer": authorizer}}

    def test_it_reads_the_cognito_claim(self):
        assert _verified_subject(self._event({"sub": VALID})) == VALID

    def test_it_also_reads_the_rest_api_shape(self):
        """An authorizer type change should not silently stop authentication."""
        assert _verified_subject(self._event({"sub": VALID}, "rest")) == VALID

    def test_no_token_means_no_subject(self):
        assert _verified_subject({}) is None
        assert _verified_subject({"requestContext": {}}) is None
        assert _verified_subject({"requestContext": {"authorizer": {}}}) is None

    def test_a_missing_or_wrong_typed_subject_is_none(self):
        assert _verified_subject(self._event({})) is None
        assert _verified_subject(self._event({"sub": 42})) is None
        assert _verified_subject(self._event({"sub": None})) is None

    def test_a_subject_that_is_not_a_uuid_is_refused(self):
        assert _verified_subject(self._event({"sub": "admin"})) is None

    def test_a_forged_sub_cannot_smuggle_a_key(self):
        assert _verified_subject(self._event({"sub": "../../snapshots/victim"})) is None


class TestHandlerOverwritesIdentity:
    """The header is the only channel identity arrives on, so a caller must not
    be able to set it."""

    @staticmethod
    def _capture(monkeypatch):
        """Replace the Mangum adapter and record the event it is handed.

        The assertion is about the headers the handler produced, so the adapter
        is a stub that reads the event rather than an attempt to reproduce
        Mangum's ASGI plumbing.
        """
        from app import lambda_handler

        seen: dict = {}

        def fake_adapter(event, context):
            seen.update(event.get("headers") or {})
            return {}

        monkeypatch.setattr(lambda_handler, "_adapter", fake_adapter)
        return seen

    def test_a_caller_supplied_header_is_replaced(self, monkeypatch):
        from app import lambda_handler

        seen = self._capture(monkeypatch)
        lambda_handler.handler(
            {
                "headers": {USER_HEADER: OTHER, "accept": "*/*"},
                "requestContext": {"authorizer": {"jwt": {"claims": {"sub": VALID}}}},
            },
            None,
        )

        assert seen[USER_HEADER] == VALID, seen
        assert seen["accept"] == "*/*", "unrelated headers must survive"

    def test_a_forged_header_with_no_token_is_dropped(self, monkeypatch):
        from app import lambda_handler

        seen = self._capture(monkeypatch)

        # No claims, so no verified identity. The caller's own header must not
        # survive to be believed.
        lambda_handler.handler({"headers": {USER_HEADER: OTHER}}, None)

        assert USER_HEADER not in seen, seen


class TestRoutes:
    pytestmark = pytest.mark.asyncio

    async def test_health_needs_no_identity(self, anonymous_client):
        response = await anonymous_client.get("/api/health")
        assert response.status_code == 200

    async def test_the_snapshot_needs_an_identity(self, anonymous_client):
        assert (await anonymous_client.get("/api/backup")).status_code == 401

    async def test_generation_needs_an_identity(self, anonymous_client):
        response = await anonymous_client.post(
            "/api/goals/next-steps", json={"goal_title": "Anything"}
        )
        assert response.status_code == 401

    async def test_a_forged_identity_is_refused(self, anonymous_client):
        response = await anonymous_client.get(
            "/api/backup", headers={USER_HEADER: "not-a-uuid"}
        )
        assert response.status_code == 401


class TestIsolation:
    pytestmark = pytest.mark.asyncio

    """Two users, one bucket, one table."""

    async def test_a_user_only_sees_their_own_snapshot(self, async_client, other_user_client):
        mine = (await async_client.get("/api/backup")).json()
        theirs = (await other_user_client.get("/api/backup")).json()

        assert [g["title"] for g in mine["goals"]] == ["Launch the MVP"]
        assert [g["title"] for g in theirs["goals"]] == ["Someone else's goal"]

    async def test_writing_does_not_reach_the_other_user(self, s3, async_client, other_user_client):
        await async_client.put(
            "/api/backup", json={"goals": [{"id": "g", "title": "Mine"}], "tasks": []}
        )

        assert [g["title"] for g in s3.objects[f"snapshots/{VALID}.json"]["goals"]] == ["Mine"]
        assert [
            g["title"] for g in s3.objects[f"snapshots/{OTHER}.json"]["goals"]
        ] == ["Someone else's goal"]

    async def test_the_counters_are_separate(
        self, async_client, other_user_client, dynamodb
    ):
        from app.services.usage import _counter_key, today

        await async_client.post("/api/goals/next-steps", json={"goal_title": "A"})
        await other_user_client.post("/api/goals/next-steps", json={"goal_title": "B"})

        day = today()
        mine = _counter_key(uuid.UUID(VALID), day)
        theirs = _counter_key(uuid.UUID(OTHER), day)

        assert mine != theirs
        assert dynamodb.calls_for(mine) == 1
        assert dynamodb.calls_for(theirs) == 1

    async def test_one_user_exhausting_their_allowance_does_not_affect_another(
        self, async_client, other_user_client, monkeypatch
    ):
        """The cap is per account.

        They share a bucket and a table, so if the counter were keyed by anything
        but the subject, the first person to run out would lock everyone else
        out of a public app.
        """
        from app.config import settings

        monkeypatch.setattr(settings, "ai_daily_cap_ramp", (1, 1, 1))

        first = await async_client.post(
            "/api/goals/next-steps", json={"goal_title": "A"}
        )
        assert first.status_code == 200

        refused = await async_client.post(
            "/api/goals/next-steps", json={"goal_title": "A again"}
        )
        assert refused.status_code == 429

        other = await other_user_client.post(
            "/api/goals/next-steps", json={"goal_title": "B"}
        )
        assert other.status_code == 200, "the second user has their own allowance"


class TestAllowanceRamp:
    """Open sign-up means every account is a stranger, so the allowance starts
    small and climbs."""

    def test_a_new_account_gets_the_first_number(self):
        assert settings.daily_cap_for(0) == settings.ai_daily_cap_ramp[0]

    def test_the_allowance_never_decreases(self):
        ramp = settings.ai_daily_cap_ramp
        ages = [settings.daily_cap_for(d) for d in range(len(ramp) + 3)]
        assert ages == sorted(ages)

    def test_it_stops_at_the_steady_state(self):
        ramp = settings.ai_daily_cap_ramp
        assert settings.daily_cap_for(10_000) == ramp[-1]

    def test_a_negative_age_cannot_buy_a_bigger_allowance(self):
        assert settings.daily_cap_for(-5) == settings.ai_daily_cap_ramp[0]

    def test_the_steady_state_is_bounded(self):
        """The last rung is the number the old shared cap used, so no account
        is worse off for being multi-tenant."""
        assert settings.ai_daily_cap_ramp[-1] == 200
