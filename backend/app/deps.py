import secrets
import uuid

from fastapi import Depends, Header, HTTPException, status

from app.config import MVP_USER_ID, settings
from app.services.usage import DailyCapReached, reserve_call


async def require_token(
    x_canens_token: str | None = Header(default=None),
) -> None:
    """Guard the routes that cost money or hold data.

    This is not authentication. The token is inlined into the client bundle,
    so anyone who can load the page has it. It exists to stop casual abuse of
    a public endpoint, and must be paired with the daily call cap below and
    an account-level budget alarm.
    """
    if settings.api_token is None:
        return
    if not x_canens_token or not x_canens_token.isascii():
        # compare_digest raises TypeError on non-ASCII str operands, and
        # Starlette decodes header bytes as latin-1, so a request carrying a
        # high byte would otherwise turn a 401 into a 500.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    if not secrets.compare_digest(x_canens_token.encode(), settings.api_token.encode()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


async def current_user_id() -> uuid.UUID:
    """The single MVP user.

    Real accounts are out of scope. The id is still threaded through every
    store key so that adding them later is not a data migration.
    """
    return uuid.UUID(MVP_USER_ID)


def enforce_daily_ai_cap(
    user_id: uuid.UUID = Depends(current_user_id),
) -> None:
    """Reserve one model call, refusing once the day's allowance is spent.

    The reservation is committed before the model is called: a refused request
    costs nothing, and a call that then fails still consumed an attempt, which
    is the behaviour you want from a ceiling.

    Sync on purpose. boto3 blocks, and FastAPI only runs a dependency in its
    threadpool when it is a plain ``def``; as ``async def`` it would block the
    event loop for the length of the DynamoDB round trip.
    """
    try:
        reserve_call(str(user_id), settings.ai_daily_cap)
    except DailyCapReached as exc:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)
        ) from exc
