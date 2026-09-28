from pydantic import BaseModel
from datetime import datetime
import uuid

class GoalOut(BaseModel):
    id: uuid.UUID
    title: str
    status: str
    created_at: datetime
    
    model_config = {"from_attributes": True}
