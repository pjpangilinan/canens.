import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import Date, DateTime, ForeignKey, Integer, String, Text, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

__all__ = ["Base", "User", "Goal", "Task", "Backup", "AiUsage"]


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Goal(Base):
    """A user objective.

    A Goal is archived by setting ``status`` to ``Completed``. It is never
    deleted, so an archived Goal stays reachable in the Activity Log.
    """

    __tablename__ = "goals"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="Active", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    tasks: Mapped[list["Task"]] = relationship(
        "Task",
        back_populates="goal",
        cascade="all, delete-orphan",
        lazy="selectin",
    )


class Task(Base):
    """A single actionable step inside a Goal."""

    __tablename__ = "tasks"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    goal_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("goals.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(50), default="Pending", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    goal: Mapped["Goal"] = relationship("Goal", back_populates="tasks")


class Backup(Base):
    """A whole-store snapshot of one user's goals and tasks.

    Stored as a single JSONB document rather than as rows in ``goals`` and
    ``tasks``. A snapshot is replaced wholesale on restore and carries
    deletions implicitly, because a deleted record is simply absent from the
    payload. Modelling it as rows would reintroduce exactly the tombstone and
    merge machinery that this table exists to avoid.
    """

    __tablename__ = "backups"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    goals: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    tasks: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    saved_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AiUsage(Base):
    """A count of model calls made by one user on one day.

    Exists to put a hard ceiling on Bedrock spend. Generation is user
    triggered and bounded by maxTokens, so the natural exposure is low, but
    nothing in the application stops a loop of clicks, and the endpoint is
    public.

    The row is keyed by day rather than deleted, because an in-process counter
    is not a reliable ceiling: Lambda reuses and discards execution
    environments freely, so the count would reset behind a caller's back.
    """

    __tablename__ = "ai_usage"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    day: Mapped[date] = mapped_column(Date, primary_key=True)
    calls: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
