import secrets
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import MVP_USER_ID, settings
from app.database import get_db
from app.models import AiUsage, User


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


async def current_user_id(
    db: AsyncSession = Depends(get_db),
) -> uuid.UUID:
    """Resolve the single MVP user, creating it on first use.

    Real accounts are out of scope. The id is still threaded through every
    model and query so that adding them later does not mean reworking the
    data access.
    """
    user_id = uuid.UUID(MVP_USER_ID)
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalars().first()
    if user is None:
        user = User(id=user_id, email="owner@canens.app")
        db.add(user)
        await db.commit()
    return user_id


async def enforce_daily_ai_cap(
    user_id: uuid.UUID = Depends(current_user_id),
    db: AsyncSession = Depends(get_db),
) -> None:
    """Reserve one model call, refusing once the day's allowance is spent.

    The reservation is a single atomic upsert, so two concurrent requests
    cannot both slip past the limit. It is committed before the model is
    called: a refused request costs nothing, and a call that then fails still
    consumed an attempt, which is the behaviour you want from a ceiling.
    """
    limit = settings.ai_daily_cap
    if limit <= 0:
        return

    today = datetime.now(timezone.utc).date()  # not date.today(): Lambda is UTC, a laptop is not
    table = AiUsage.__table__
    statement = (
        pg_insert(AiUsage)
        .values(user_id=user_id, day=today, calls=1)
        .on_conflict_do_update(
            index_elements=[table.c.user_id, table.c.day],
            set_={"calls": table.c.calls + 1},
        )
        .returning(table.c.calls)
    )
    calls = (await db.execute(statement)).scalar_one()
    await db.commit()

    if calls > limit:
        tomorrow = today + timedelta(days=1)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"Daily model call limit reached ({limit}). "
                f"Try again after {tomorrow.isoformat()}."
            ),
        )
