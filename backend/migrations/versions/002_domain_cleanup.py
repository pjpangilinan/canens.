"""Drop the removed energy-scheduling domain.

Revision ID: 002
Revises: 001
Create Date: 2026-09-28 00:00:00.000000

The energy-adaptive scheduling product was removed before this table set was
ever deployed anywhere other than a local development database. These drops
exist so that an existing development database converges on the current
schema rather than silently keeping tables the application no longer knows
about.
"""
from alembic import op
import sqlalchemy as sa

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None

_LEGACY_TABLES = ("biometric_logs", "work_block_tasks", "work_blocks")


def _table_exists(table: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(table)


def _column_exists(table: str, column: str) -> bool:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(table):
        return False
    return any(c["name"] == column for c in inspector.get_columns(table))


def upgrade() -> None:
    for table in _LEGACY_TABLES:
        if _table_exists(table):
            op.drop_table(table)

    if _column_exists("users", "current_energy_level"):
        op.drop_column("users", "current_energy_level")
    if _column_exists("tasks", "requires_high_energy"):
        op.drop_column("tasks", "requires_high_energy")

    # goals.deleted_at is no longer part of the model: a whole-store snapshot
    # backup needs no tombstone, and archiving is expressed as status.
    if _column_exists("goals", "deleted_at"):
        op.drop_column("goals", "deleted_at")
    if _column_exists("tasks", "deleted_at"):
        op.drop_column("tasks", "deleted_at")

    # tasks.estimated_minutes existed only to feed the deleted scheduler.
    if _column_exists("tasks", "estimated_minutes"):
        op.drop_column("tasks", "estimated_minutes")

    # The original 001 omitted tasks.user_id; older development databases that
    # were patched by hand now have it, but a database created from the
    # pre-rewrite 001 does not.
    if not _column_exists("tasks", "user_id"):
        op.add_column(
            "tasks",
            sa.Column("user_id", sa.Uuid(), nullable=True),
        )
        op.create_foreign_key(
            "fk_tasks_user_id", "tasks", "users", ["user_id"], ["id"], ondelete="CASCADE"
        )
        op.execute("UPDATE tasks SET user_id = (SELECT id FROM users LIMIT 1)")
        op.alter_column("tasks", "user_id", nullable=False)


def downgrade() -> None:
    op.add_column(
        "tasks", sa.Column("estimated_minutes", sa.Integer(), nullable=False, server_default="30")
    )
    op.add_column("goals", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("tasks", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "tasks", sa.Column("requires_high_energy", sa.Boolean(), server_default=sa.text("false"))
    )
    op.add_column(
        "users",
        sa.Column("current_energy_level", sa.String(length=50), server_default="Neutral"),
    )
    op.create_table(
        "work_blocks",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE")),
        sa.Column("start_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("end_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.String(length=50), server_default="Upcoming"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            onupdate=sa.text("now()"),
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
