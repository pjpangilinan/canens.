from datetime import date
import uuid

from fastapi import Depends, Header, HTTPException, Response, status

from app.config import settings
from app.services.usage import DailyCapReached, reserve_call


async def require_user(
    x_canens_user: str | None = Header(default=None),
) -> uuid.UUID:
    """The authenticated user, from the subject API Gateway verified.

    The header is set by app/lambda_handler.py from the JWT claims and is
    overwritten on every invocation, so a caller cannot forge it. A request that
    reaches the function without a valid token never gets here - the authorizer
    rejects it first - so a missing header means the function was invoked
    without one, which is a configuration mistake rather than a hostile request.
    It is refused either way.
    """
    if not x_canens_user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not signed in"
        )
    try:
        return uuid.UUID(x_canens_user)
    except (ValueError, AttributeError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Not signed in"
        ) from None


def enforce_daily_ai_cap(
    response: Response,
    user_id: uuid.UUID = Depends(require_user),
    x_canens_date: str | None = Header(default=None),
) -> None:
    """Reserve one model call, refusing once today's allowance is spent.

    The allowance depends on how old the account is, because sign-up is open and
    every new account is a stranger. The reservation is made before the model is
    called: a refused request costs nothing, and a call that then fails has still
    consumed an attempt, which is the behaviour you want from a ceiling.

    Sync on purpose. boto3 blocks, and FastAPI only runs a dependency in its
    threadpool when it is a plain ``def``; as ``async def`` it would block the
    event loop for the length of the DynamoDB round trip.
    """
    limit = settings.ai_daily_cap
    client_date: date | None = None
    if x_canens_date:
        try:
            client_date = date.fromisoformat(x_canens_date.strip())
        except (ValueError, TypeError):
            client_date = None

    try:
        calls = reserve_call(user_id, client_date=client_date)
        if calls is not None and limit > 0:
            response.headers["X-RateLimit-Limit"] = str(limit)
            response.headers["X-RateLimit-Remaining"] = str(max(0, limit - calls))
    except DailyCapReached as exc:
        if limit > 0:
            response.headers["X-RateLimit-Limit"] = str(limit)
            response.headers["X-RateLimit-Remaining"] = "0"
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)
        ) from exc
