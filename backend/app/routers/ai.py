from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.deps import enforce_daily_ai_cap, require_user
from app.services.bedrock import ProviderError, bedrock

router = APIRouter(prefix="/api", tags=["ai"], dependencies=[Depends(require_user)])


class ExistingTask(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    status: str = Field(max_length=40)


class NextStepsRequest(BaseModel):
    goal_title: str = Field(min_length=1, max_length=500)
    # Bounded because the whole list is interpolated into the prompt and billed
    # as input tokens. Unbounded, a caller could post tens of thousands of
    # entries, blow the model's context window, and burn the daily allowance
    # on calls that can only fail.
    existing_tasks: list[ExistingTask] = Field(default_factory=list, max_length=50)


class NextStepsResponse(BaseModel):
    status: str
    tasks: list[str]


class StarterGoalsResponse(BaseModel):
    goals: list[str]


class StarterGoalsRequest(BaseModel):
    answers: str = Field(min_length=1, max_length=2000)
    count: int = Field(default=4, ge=1, le=8)


@router.post(
    "/goals/next-steps",
    response_model=NextStepsResponse,
    dependencies=[Depends(enforce_daily_ai_cap)],
)
async def next_steps(req: NextStepsRequest) -> NextStepsResponse:
    """Propose the next actions for a goal.

    This endpoint takes a goal title rather than a goal id. The browser owns
    the store, so the backend has no goal to look up and writes no goals or
    tasks. The only thing it persists is the call counted against the daily
    cap, which is not part of the domain.
    """
    try:
        result = bedrock.next_steps(
            req.goal_title,
            [t.model_dump() for t in req.existing_tasks],
        )
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return NextStepsResponse(status=result["status"], tasks=result["tasks"])


@router.post(
    "/onboarding/starter-goals",
    response_model=StarterGoalsResponse,
    dependencies=[Depends(enforce_daily_ai_cap)],
)
async def starter_goals(req: StarterGoalsRequest) -> StarterGoalsResponse:
    try:
        result = bedrock.starter_goals(req.answers, req.count)
    except ProviderError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return StarterGoalsResponse(goals=result["goals"])
