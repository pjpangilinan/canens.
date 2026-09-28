"""Create the schema and insert the single MVP user.

Schema creation goes through Alembic rather than ``Base.metadata.create_all``.
Using ``create_all`` here is what let the migrations and the models drift
apart unnoticed for as long as they did: it builds whatever the models say and
reports success either way.
"""
import asyncio
import uuid

from alembic import command
from alembic.config import Config
from sqlalchemy import select

from app.config import MVP_USER_ID, settings
from app.database import SessionLocal
from app.models import User


async def seed() -> None:
    command.upgrade(Config("alembic.ini"), "head")

    async with SessionLocal() as session:
        user_id = uuid.UUID(MVP_USER_ID)
        existing = (
            await session.execute(select(User).where(User.id == user_id))
        ).scalars().first()
        if existing is not None:
            print("MVP user already present; nothing to seed.")
            return

        session.add(User(id=user_id, email="owner@canens.app"))
        await session.commit()
        print(f"Seeded MVP user {user_id} against {settings.database_url}.")


if __name__ == "__main__":
    asyncio.run(seed())
