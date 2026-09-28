"""Alembic and the models must describe the same schema.

Four files in this repository used to declare a version of the database
schema, and all four disagreed: the models, the initial migration, a
hand-maintained schema.sql, and the live development database. Nothing
detected it, because the application never ran a migration - the seed
script called ``create_all``, which builds whatever the models say and
reports success regardless of what the migrations claim.

This test runs the migrations against a real Postgres database and compares
the result to the model metadata, so the two cannot drift apart again.

These tests are deliberately synchronous. Alembic's env.py calls
asyncio.run() internally, which fails if a loop is already running.
"""
import asyncio

import sqlalchemy as sa
from alembic import command
from alembic.config import Config
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from app.config import settings
from app.database import Base
from app.models import Backup, Goal, Task, User  # noqa: F401  - register mappers

SCRATCH_DB = "canens_migration_check"


def _url_for(database: str) -> str:
    return settings.database_url.rsplit("/", 1)[0] + f"/{database}"


async def _recreate_scratch() -> None:
    engine = create_async_engine(
        _url_for("postgres"), isolation_level="AUTOCOMMIT", poolclass=NullPool
    )
    async with engine.connect() as conn:
        await conn.execute(sa.text(f'DROP DATABASE IF EXISTS "{SCRATCH_DB}"'))
        await conn.execute(sa.text(f'CREATE DATABASE "{SCRATCH_DB}"'))
    await engine.dispose()


async def _reflect() -> dict[str, set[str]]:
    engine = create_async_engine(_url_for(SCRATCH_DB), poolclass=NullPool)

    def _inspect(conn):
        inspector = sa.inspect(conn)
        return {
            name: {c["name"] for c in inspector.get_columns(name)}
            for name in inspector.get_table_names()
        }

    async with engine.connect() as conn:
        schema = await conn.run_sync(_inspect)
    await engine.dispose()

    schema.pop("alembic_version", None)
    return schema


def _migrated_schema() -> dict[str, set[str]]:
    asyncio.run(_recreate_scratch())

    config = Config("alembic.ini")
    config.attributes["canens_database_url"] = _url_for(SCRATCH_DB)
    command.upgrade(config, "head")

    return asyncio.run(_reflect())


def test_migrations_match_the_models():
    actual = _migrated_schema()
    expected = {
        name: {column.name for column in table.columns}
        for name, table in Base.metadata.tables.items()
    }

    extra = sorted(set(actual) - set(expected))
    missing = sorted(set(expected) - set(actual))
    assert not extra and not missing, (
        f"migrations create tables the models do not declare: {extra}; "
        f"models declare tables the migrations do not create: {missing}"
    )

    for name in sorted(expected):
        assert actual[name] == expected[name], (
            f"column mismatch on {name}: "
            f"migrations have {sorted(actual[name] - expected[name])} "
            f"that the models do not, and are missing "
            f"{sorted(expected[name] - actual[name])}"
        )


def test_migrations_removed_the_deleted_domain():
    """The energy-scheduling domain must not come back."""
    schema = _migrated_schema()

    for gone in ("work_blocks", "work_block_tasks", "biometric_logs"):
        assert gone not in schema

    assert "current_energy_level" not in schema["users"]
    assert "requires_high_energy" not in schema["tasks"]
    assert "estimated_minutes" not in schema["tasks"]
    assert "deleted_at" not in schema["tasks"]
    assert "deleted_at" not in schema["goals"]
    assert "user_id" in schema["tasks"]
