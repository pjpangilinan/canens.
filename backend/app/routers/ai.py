from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.deps import require_token
from app.services.bedrock import ProviderError, bedrock

router = APIRouter(
    prefix="/api",
    tags=["ai"],
    dependencies=[Depends(require_token)],
)


class ExistingTask(BaseModel):
    title: str
    status: str


class NextStepsRequest(BaseModel):
    goal_title: str = Field(min_length=1, max_length=500)
    existing_tasks: list[ExistingTask] = []


class NextStepsResponse(BaseModel):
    status: str
    tasks: list[dict[str, Any]]


class StarterGoalsResponse(BaseModel):
    goals: list[dict[str, Any]]


class StarterGoalsRequest(BaseModel):
    answers: str = Field(min_length=1, max_length=2000)
    count: int = Field(default=4, ge=1, le=8)


@router.post("/goals/next-steps", response_model=NextStepsResponse)
async def next_steps(req: NextStepsRequest) -> NextStepsResponse:
    """Propose the next actions for a goal.

    This endpoint deliberately takes a goal title rather than a goal id. The
    browser owns the store, so the backend has no goal to look up, and the
    route has no database access at all. That is what makes "generation never
    persists anything" a structural property rather than a promise.
    """
    try:
        result = bedrock.next_steps(
            req.goal_title,
            [t.model_dump() for t in req.existing_tasks],
        )
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return NextStepsResponse(
        status=result.status,
        tasks=[t.model_dump() for t in result.tasks],
    )


@router.post("/onboarding/starter-goals", response_model=StarterGoalsResponse)
async def starter_goals(req: StarterGoalsRequest) -> StarterGoalsResponse:
    try:
        result = bedrock.starter_goals(req.answers, req.count)
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return StarterGoalsResponse(goals=[g.model_dump() for g in result.goals])
