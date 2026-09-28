"""Amazon Bedrock client for goal breakdown and starter-goal generation.

Replaces a Groq-then-Ollama chain that, on total failure, returned a
hardcoded placeholder task. That fallback was a reasonable shortcut on a
flat-rate API key; on per-token billing it hides both the cost and the
failure, so a provider error now propagates instead.
"""
import json
import logging

import boto3
from botocore.exceptions import BotoCoreError, ClientError
from pydantic import BaseModel, Field

from app.config import settings

logger = logging.getLogger(__name__)

MAX_TASKS = 5
MIN_TASKS = 3


class ProviderError(RuntimeError):
    """The model provider could not produce a usable response."""


class ProposedTask(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class NextSteps(BaseModel):
    """The model's proposal for a Goal.

    ``status`` is ``"done"`` when the model believes the objective is
    achieved. Completing a Goal is destructive to the active list, so this
    is a proposal the user confirms; it is never acted on server-side.
    """

    status: str
    tasks: list[ProposedTask] = []


class StarterGoals(BaseModel):
    goals: list[ProposedTask] = []


NEXT_STEPS_PROMPT = """\
You break a single long-running objective down into the next concrete actions.

Goal: {goal_title}

The user has already recorded these steps, with their current status:
{tasks_context}

Produce the NEXT {min_tasks} to {max_tasks} actions that make progress towards
the goal right now. Choose the most useful next step, not the whole plan.

If the recorded steps already achieve the goal, return status "done" and an
empty task list. Otherwise return status "more" and the next steps.

Rules:
- Each title is a short imperative action, at most 15 words.
- Do not repeat anything in the recorded steps.
- Do not include ordering, priorities, durations or commentary.

Return only raw JSON, no prose and no code fence:
{{"status": "more" | "done", "tasks": [{{"title": "..."}}]}}
"""

STARTER_GOALS_PROMPT = """\
A new user is setting up a personal goal tracker. Suggest {count} goals they
might plausibly want to work towards, based on what they told you.

What they said:
{answers}

Rules:
- Each title is a short, concrete objective, at most 15 words.
- Vary the categories. Do not suggest goals about building this app.
- No numbering, no commentary.

Return only raw JSON, no prose and no code fence:
{{"goals": [{{"title": "..."}}]}}
"""


class BedrockClient:
    def __init__(self) -> None:
        self._client = None

    @property
    def client(self):
        if self._client is None:
            self._client = boto3.client("bedrock-runtime", region_name=settings.aws_region)
        return self._client

    def _converse(self, system_prompt: str, user_prompt: str) -> str:
        try:
            response = self.client.converse(
                modelId=settings.bedrock_model_id,
                system=[{"text": system_prompt}],
                messages=[{"role": "user", "content": [{"text": user_prompt}]}],
                inferenceConfig={
                    "temperature": 0.1,
                    "maxTokens": settings.bedrock_max_tokens,
                },
            )
        except (ClientError, BotoCoreError) as exc:
            logger.exception("Bedrock converse failed")
            raise ProviderError(f"Bedrock request failed: {exc}") from exc

        usage = response.get("usage", {})
        logger.info(
            "bedrock call model=%s in=%s out=%s",
            settings.bedrock_model_id,
            usage.get("inputTokens"),
            usage.get("outputTokens"),
        )

        content = response.get("output", {}).get("message", {}).get("content", [])
        for block in content:
            text = block.get("text")
            if text:
                return text
        raise ProviderError("Bedrock returned no text content")

    @staticmethod
    def _parse_json(raw: str) -> dict:
        text = raw.strip()
        if text.startswith("```"):
            text = text.removeprefix("```json").removeprefix("```")
            text = text.removesuffix("```").strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise ProviderError(f"Model returned invalid JSON: {raw[:200]}") from exc

    def next_steps(self, goal_title: str, existing_tasks: list[dict]) -> NextSteps:
        context = json.dumps(existing_tasks, indent=2) or "[]"
        system_prompt = NEXT_STEPS_PROMPT.format(
            goal_title=goal_title,
            tasks_context=context,
            min_tasks=MIN_TASKS,
            max_tasks=MAX_TASKS,
        )
        raw = self._converse(system_prompt, goal_title)

        try:
            parsed = NextSteps(**self._parse_json(raw))
        except ValueError as exc:
            raise ProviderError(f"Model output did not match the schema: {exc}") from exc

        if parsed.status not in ("more", "done"):
            raise ProviderError(f"Model returned an unknown status: {parsed.status!r}")
        if parsed.status == "done":
            return NextSteps(status="done", tasks=[])
        if not parsed.tasks:
            raise ProviderError("Model asked for more steps but returned none")
        return NextSteps(status="more", tasks=parsed.tasks[:MAX_TASKS])

    def starter_goals(self, answers: str, count: int = 4) -> StarterGoals:
        system_prompt = STARTER_GOALS_PROMPT.format(count=count, answers=answers)
        raw = self._converse(system_prompt, answers)

        try:
            parsed = StarterGoals(**self._parse_json(raw))
        except ValueError as exc:
            raise ProviderError(f"Model output did not match the schema: {exc}") from exc

        if not parsed.goals:
            raise ProviderError("Model returned no starter goals")
        return StarterGoals(goals=parsed.goals[:count])


bedrock = BedrockClient()
