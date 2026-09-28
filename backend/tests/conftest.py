import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
import uuid

from app.main import app
from app.database import Base, get_db
from app.models import User, Goal

SQLALCHEMY_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

engine = create_async_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
TestingSessionLocal = async_sessionmaker(autocommit=False, autoflush=False, bind=engine)

async def override_get_db():
    async with TestingSessionLocal() as session:
        yield session

app.dependency_overrides[get_db] = override_get_db

@pytest_asyncio.fixture(autouse=True)
async def setup_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)

@pytest_asyncio.fixture
async def async_client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client

@pytest_asyncio.fixture
async def seed_data():
    async with TestingSessionLocal() as session:
        user_id = uuid.uuid4()
        user = User(id=user_id, email="test@canens.app")
        goal = Goal(id=uuid.uuid4(), user_id=user_id, title="Launch MVP in 2 weeks", status="Active")
        session.add(user)
        session.add(goal)
        await session.commit()
        await session.refresh(goal)
        return {"user": user, "goal": goal}
