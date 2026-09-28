import secrets
import uuid

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import MVP_USER_ID, settings
from app.database import get_db
from app.models import User


async def require_token(
    x_canens_token: str | None = Header(default=None),
) -> None:
    """Guard the routes that cost money or hold data.

    This is not authentication. The token is inlined into the client bundle,
    so anyone who can load the page has it. It exists to stop casual abuse of
    a public endpoint, and must be paired with API Gateway throttling and an
    account-level spend limit.
    """
    if settings.api_token is None:
        return
    if x_canens_token is None or not secrets.compare_digest(
        x_canens_token, settings.api_token
    ):
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
