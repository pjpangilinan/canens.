import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.deps import enforce_daily_ai_cap, require_user
from app.services.bedrock import ProviderError, bedrock
from app.services.usage import refund_call

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


# Plain `def`, not `async def`. bedrock calls block on boto3, and FastAPI runs
# plain `def` endpoints in its threadpool so the asyncio event loop is not stalled.
@router.post(
    "/goals/next-steps",
    response_model=NextStepsResponse,
    dependencies=[Depends(enforce_daily_ai_cap)],
)
def next_steps(
    req: NextStepsRequest, user_id: uuid.UUID = Depends(require_user)
) -> NextStepsResponse:
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
        refund_call(user_id)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return NextStepsResponse(status=result["status"], tasks=result["tasks"])


@router.post(
    "/goals/next-steps/stream",
    dependencies=[Depends(enforce_daily_ai_cap)],
)
def next_steps_stream(
    req: NextStepsRequest, user_id: uuid.UUID = Depends(require_user)
) -> StreamingResponse:
    def event_stream():
        try:
            for event in bedrock.next_steps_stream(
                req.goal_title,
                [t.model_dump() for t in req.existing_tasks],
            ):
                if event["type"] == "token":
                    yield f"event: token\ndata: {json.dumps({'text': event['text']})}\n\n"
                elif event["type"] == "done":
                    yield f"event: done\ndata: {json.dumps({'status': event['status'], 'tasks': event['tasks']})}\n\n"
        except ProviderError as exc:
            refund_call(user_id)
            yield f"event: error\ndata: {json.dumps({'detail': str(exc)})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post(
    "/onboarding/starter-goals",
    response_model=StarterGoalsResponse,
    dependencies=[Depends(enforce_daily_ai_cap)],
)
def starter_goals(
    req: StarterGoalsRequest, user_id: uuid.UUID = Depends(require_user)
) -> StarterGoalsResponse:
    try:
        result = bedrock.starter_goals(req.answers, req.count)
    except ProviderError as exc:
        refund_call(user_id)
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return StarterGoalsResponse(goals=result["goals"])
