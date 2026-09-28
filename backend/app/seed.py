import asyncio
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
import uuid

from app.config import settings
from app.models import Base, User, Goal

async def seed():
    engine = create_async_engine(settings.DATABASE_URL)
    SessionLocal = async_sessionmaker(autocommit=False, autoflush=False, bind=engine)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    async with SessionLocal() as session:
        user = User(id=uuid.uuid4(), email="test@canens.app")
        goal = Goal(id=uuid.uuid4(), user_id=user.id, title="Launch MVP in 2 weeks", status="Active")
        
        session.add(user)
        session.add(goal)
        await session.commit()
        print("Database seeded with test user and goal.")

if __name__ == "__main__":
    asyncio.run(seed())
