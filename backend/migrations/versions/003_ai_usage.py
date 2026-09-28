"""Add a daily model call counter.

Revision ID: 003
Revises: 002
Create Date: 2026-09-28 00:00:00.000000

The AI endpoints are public and each call costs money. A cap in the
application is the reliable ceiling, because an in-process counter resets
whenever Lambda discards an execution environment.
"""
from alembic import op
import sqlalchemy as sa

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_usage",
        sa.Column(
            "user_id",
            sa.Uuid(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("day", sa.Date(), primary_key=True),
        sa.Column("calls", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_table("ai_usage")
