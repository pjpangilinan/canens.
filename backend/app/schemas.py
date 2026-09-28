from pydantic import BaseModel
from datetime import datetime
import uuid
from typing import Optional

class GoalCreate(BaseModel):
    title: str
    user_id: uuid.UUID

class GoalOut(BaseModel):
    id: uuid.UUID
    title: str
    status: str
    created_at: datetime
    tasks: list['TaskOut'] = []
    
    model_config = {"from_attributes": True}

class TaskOut(BaseModel):
    id: uuid.UUID
    goal_id: Optional[uuid.UUID] = None
    title: str
    estimated_minutes: int
    status: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
