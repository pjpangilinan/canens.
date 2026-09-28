from sqlalchemy import String, Boolean, Integer, DateTime, ForeignKey, Text
from sqlalchemy.orm import mapped_column
from sqlalchemy.types import Uuid
from sqlalchemy.sql import func
import uuid

from app.database import Base

class User(Base):
    __tablename__ = "users"
    id = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = mapped_column(String(255), unique=True, nullable=False)
    current_energy_level = mapped_column(String(50), default="Neutral")
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())

class Goal(Base):
    __tablename__ = "goals"
    id = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    title = mapped_column(Text, nullable=False)
    status = mapped_column(String(50), default="Active")
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())

class Task(Base):
    __tablename__ = "tasks"
    id = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    goal_id = mapped_column(Uuid(as_uuid=True), ForeignKey("goals.id", ondelete="CASCADE"))
    title = mapped_column(Text, nullable=False)
    requires_high_energy = mapped_column(Boolean, default=False)
    estimated_minutes = mapped_column(Integer, nullable=False)
    status = mapped_column(String(50), default="Pending")
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())

class WorkBlock(Base):
    __tablename__ = "work_blocks"
    id = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    start_time = mapped_column(DateTime(timezone=True), nullable=False)
    end_time = mapped_column(DateTime(timezone=True), nullable=False)
    status = mapped_column(String(50), default="Upcoming")

class WorkBlockTask(Base):
    __tablename__ = "work_block_tasks"
    work_block_id = mapped_column(Uuid(as_uuid=True), ForeignKey("work_blocks.id", ondelete="CASCADE"), primary_key=True)
    task_id = mapped_column(Uuid(as_uuid=True), ForeignKey("tasks.id", ondelete="CASCADE"), primary_key=True)
    order_index = mapped_column(Integer, nullable=False)

class BiometricLog(Base):
    __tablename__ = "biometric_logs"
    id = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = mapped_column(Uuid(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    energy_level = mapped_column(String(50), nullable=False)
    logged_at = mapped_column(DateTime(timezone=True), server_default=func.now())
    source = mapped_column(String(50), default="Manual_Check_In")
