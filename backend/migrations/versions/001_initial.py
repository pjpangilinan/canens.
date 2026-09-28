"""Initial schema

Revision ID: 001
Revises: 
Create Date: 2026-07-25 14:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

# revision identifiers, used by Alembic.
revision = '001'
down_revision = None
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.create_table(
        'users',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('email', sa.String(length=255), nullable=False, unique=True),
        sa.Column('current_energy_level', sa.String(length=50), nullable=True, server_default='Neutral'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()')),
    )
    
    op.create_table(
        'goals',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE')),
        sa.Column('title', sa.Text(), nullable=False),
        sa.Column('status', sa.String(length=50), server_default='Active'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()')),
    )

    op.create_table(
        'tasks',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('goal_id', UUID(as_uuid=True), sa.ForeignKey('goals.id', ondelete='CASCADE')),
        sa.Column('title', sa.Text(), nullable=False),
        sa.Column('requires_high_energy', sa.Boolean(), server_default='false'),
        sa.Column('estimated_minutes', sa.Integer(), nullable=False),
        sa.Column('status', sa.String(length=50), server_default='Pending'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()')),
    )

    op.create_table(
        'work_blocks',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE')),
        sa.Column('start_time', sa.DateTime(timezone=True), nullable=False),
        sa.Column('end_time', sa.DateTime(timezone=True), nullable=False),
        sa.Column('status', sa.String(length=50), server_default='Upcoming'),
    )

    op.create_table(
        'work_block_tasks',
        sa.Column('work_block_id', UUID(as_uuid=True), sa.ForeignKey('work_blocks.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('task_id', UUID(as_uuid=True), sa.ForeignKey('tasks.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('order_index', sa.Integer(), nullable=False),
    )

    op.create_table(
        'biometric_logs',
        sa.Column('id', UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE')),
        sa.Column('energy_level', sa.String(length=50), nullable=False),
        sa.Column('logged_at', sa.DateTime(timezone=True), server_default=sa.text('now()')),
        sa.Column('source', sa.String(length=50), server_default='Manual_Check_In'),
    )

def downgrade() -> None:
    op.drop_table('biometric_logs')
    op.drop_table('work_block_tasks')
    op.drop_table('work_blocks')
    op.drop_table('tasks')
    op.drop_table('goals')
    op.drop_table('users')
