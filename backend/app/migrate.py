"""Apply database migrations.

Run this as a deployment step, before the new code starts serving traffic:

    python -m app.migrate

Nothing runs migrations automatically. A fresh database therefore has no
tables, and the first request to any route fails. On Lambda this is a one-off
invocation of the same command against the function's environment; in compose
it is a `docker compose run --rm api python -m app.migrate`.

Alembic's env.py calls asyncio.run() internally, so this runs on its own
thread rather than inside a running loop.
"""
import asyncio

from alembic import command
from alembic.config import Config

from app.config import settings


def main() -> None:
    print(f"Migrating {settings.database_url.rsplit('@')[-1]}")

    def _upgrade() -> None:
        command.upgrade(Config("alembic.ini"), "head")

    asyncio.run(asyncio.to_thread(_upgrade))
    print("Migrations applied.")


if __name__ == "__main__":
    main()
