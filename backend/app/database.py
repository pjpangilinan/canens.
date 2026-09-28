from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.pool import NullPool

from app.config import settings

# NullPool because this runs on Lambda, where a warm container can outlive its
# database connections. Pooling is either RDS Proxy's job or unnecessary at
# this request volume, and a stale pooled connection is a 500 at random.
engine = create_async_engine(settings.database_url, poolclass=NullPool)

SessionLocal = async_sessionmaker(
    autocommit=False, autoflush=False, bind=engine, expire_on_commit=False
)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with SessionLocal() as session:
        yield session
