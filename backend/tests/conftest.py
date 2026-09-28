import pytest
import pytest_asyncio
import uuid

from httpx import AsyncClient, ASGITransport
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.config import MVP_USER_ID, settings
from app.database import Base, get_db
from app.main import app
from app.models import Backup, Goal, Task, User  # noqa: F401  - register mappers

engine = create_async_engine(settings.database_url, poolclass=NullPool)
TestingSessionLocal = async_sessionmaker(autocommit=False, autoflush=False, bind=engine, expire_on_commit=False)


async def override_get_db():
    async with TestingSessionLocal() as session:
        yield session


app.dependency_overrides[get_db] = override_get_db


@pytest_asyncio.fixture
async def prepared_database():
    """Create the schema once per session and truncate between tests.

    Truncating is far faster than dropping and recreating. It also cannot
    paper over a migration that disagrees with the models the way
    ``create_all`` alone would; ``test_migrations.py`` asserts that agreement
    separately.
    """
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with engine.begin() as conn:
        for table in reversed(Base.metadata.sorted_tables):
            await conn.execute(table.delete())


@pytest_asyncio.fixture
async def db_session(prepared_database):
    """A session bound to the test database, for tests that bypass HTTP."""
    async with TestingSessionLocal() as session:
        yield session


@pytest_asyncio.fixture
async def async_client(prepared_database):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client


@pytest_asyncio.fixture
async def seed_data(prepared_database):
    async with TestingSessionLocal() as session:
        user = User(id=uuid.UUID(MVP_USER_ID), email="owner@canens.app")
        session.add(user)
        # Flush before the rows that reference it. user_id is set as a plain
        # UUID rather than through a relationship, so the unit of work cannot
        # infer the ordering on its own.
        await session.flush()

        goal = Goal(user_id=user.id, title="Launch the MVP", status="Active")
        session.add(goal)
        await session.flush()

        session.add_all(
            [
                Task(user_id=user.id, goal_id=goal.id, title="Write the spec", status="Pending"),
                Task(user_id=user.id, goal_id=goal.id, title="Ship the landing page", status="Pending"),
            ]
        )
        await session.commit()

        tasks = (
            await session.execute(select(Task).where(Task.goal_id == goal.id))
        ).scalars().all()

        return {
            "user_id": user.id,
            "goal_id": goal.id,
            "task_ids": [t.id for t in tasks],
        }

