"""Amazon Bedrock client for goal breakdown and starter-goal generation.

Uses the Converse API's tool-use facility rather than asking for raw JSON.
The model is given a tool whose input schema is the response, so what comes
back is schema-conformant by construction. Prompting for JSON and parsing it
means a chatty model can return prose or a truncated object, which then has to
be detected and reported as a failure.

Replaces an earlier Groq-then-Ollama chain which, on total failure, returned a
hardcoded placeholder task. That fallback was a reasonable shortcut on a
flat-rate API key; on per-token billing it hides both the cost and the
failure, so a provider error now propagates.
"""
import logging

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.config import settings

logger = logging.getLogger(__name__)

MAX_TASKS = 5
MIN_TASKS = 3

# Stop reasons Bedrock actually returns. These are snake_case. The
# camelCase spelling is the *request* field inferenceConfig.maxTokens, which is
# a different thing entirely, and comparing against it means a guard written to
# catch truncated output never fires.
STOP_REASON_MAX_TOKENS = "max_tokens"
# The model produced something the tool schema could not represent. Whatever
# came back is not trustworthy, so it is refused rather than parsed.
STOP_REASONS_MALFORMED = frozenset(
    {"malformed_model_output", "malformed_tool_use"}
)

NEXT_STEPS_TOOL = "propose_next_steps"
STARTER_GOALS_TOOL = "propose_starter_goals"

NEXT_STEPS_PROMPT = f"""\
You break a single long-running objective down into the next concrete actions.

Produce the NEXT {MIN_TASKS} to {MAX_TASKS} actions that make progress towards the
goal right now. Choose the most useful next step, not the whole plan.

Decide whether the goal is already achieved:

- If the steps the user has already recorded achieve the goal, call
  {NEXT_STEPS_TOOL} with status "done" and an empty task list. Do not invent
  further work.
- Otherwise call {NEXT_STEPS_TOOL} with status "more" and the next steps.

Rules:
- Each title is a short imperative action, at most 15 words.
- Do not repeat anything the user has already recorded.
- Do not include ordering, priorities, durations or commentary.
"""

STARTER_GOALS_PROMPT = f"""\
A new user is setting up a personal goal tracker. Suggest goals they might
plausibly want to work towards, based on what they told you.

Vary the categories. Do not suggest goals about building a goal tracker.
When you have your suggestions, call {STARTER_GOALS_TOOL}.
"""

_TITLE_FIELD = {
    "type": "string",
    "description": "A short imperative action, at most 15 words.",
}

_NEXT_STEPS_SCHEMA = {
    "json": {
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "enum": ["more", "done"],
                "description": "'done' when the recorded steps already achieve the goal.",
            },
            "tasks": {
                "type": "array",
                "maxItems": MAX_TASKS,
                "items": {
                    "type": "object",
                    "properties": {"title": _TITLE_FIELD},
                    "required": ["title"],
                },
            },
        },
        "required": ["status", "tasks"],
    }
}

_STARTER_GOALS_SCHEMA = {
    "json": {
        "type": "object",
        "properties": {
            "goals": {
                "type": "array",
                "maxItems": 8,
                "items": {
                    "type": "object",
                    "properties": {"title": _TITLE_FIELD},
                    "required": ["title"],
                },
            }
        },
        "required": ["goals"],
    }
}


class ProviderError(RuntimeError):
    """The model provider could not produce a usable response."""


class BedrockClient:
    def __init__(self) -> None:
        self._client = None

    @property
    def client(self):
        if self._client is None:
            self._client = boto3.client(
                "bedrock-runtime",
                region_name=settings.aws_region,
                config=Config(
                    connect_timeout=5,
                    read_timeout=settings.bedrock_timeout_seconds,
                    retries={"max_attempts": 2, "mode": "standard"},
                ),
            )
        return self._client

    def _call_tool(
        self,
        *,
        tool_name: str,
        tool_description: str,
        schema: dict,
        system_prompt: str,
        user_prompt: str,
    ) -> dict:
        try:
            response = self.client.converse(
                modelId=settings.bedrock_model_id,
                system=[{"text": system_prompt}],
                messages=[{"role": "user", "content": [{"text": user_prompt}]}],
                toolConfig={
                    "tools": [
                        {
                            "toolSpec": {
                                "name": tool_name,
                                "description": tool_description,
                                "inputSchema": schema,
                            }
                        }
                    ],
                    # Forces the tool call, so the model cannot reply in prose
                    # and leave the caller with nothing to parse. This belongs
                    # inside toolConfig; converse rejects it as a top-level
                    # parameter.
                    "toolChoice": {"tool": {"name": tool_name}},
                },
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
            "bedrock model=%s tool=%s in=%s out=%s stop=%s",
            settings.bedrock_model_id,
            tool_name,
            usage.get("inputTokens"),
            usage.get("outputTokens"),
            response.get("stopReason"),
        )

        stop_reason = response.get("stopReason")
        content = response.get("output", {}).get("message", {}).get("content", [])

        # Checked before reading the tool input, not after. A response cut off
        # by max_tokens can still carry a toolUse block, and its arguments are
        # then a partial object - which is exactly the case the schema cannot
        # protect against, because the JSON never finished.
        if stop_reason == STOP_REASON_MAX_TOKENS:
            raise ProviderError(
                "The model ran out of output tokens before it finished. "
                "Raise BEDROCK_MAX_TOKENS."
            )
        if stop_reason in STOP_REASONS_MALFORMED:
            raise ProviderError(
                f"The model produced output that does not match the schema ({stop_reason})."
            )

        for block in content:
            tool_use = block.get("toolUse")
            if tool_use and tool_use.get("name") == tool_name:
                return self._as_object(tool_use.get("input"))

        raise ProviderError(f"The model did not call {tool_name} (stop reason: {stop_reason})")

    @staticmethod
    def _as_object(value) -> dict:
        """Coerce a tool input to a dict, or refuse it.

        Bedrock does not validate tool arguments against inputSchema for us; the
        schema is a prompt-level hint. A model can emit a list or a string
        where an object belongs, and indexing that with .get raises an
        AttributeError that would surface as a 500 rather than a 502.
        """
        if isinstance(value, dict):
            return value
        raise ProviderError(
            f"The model returned {type(value).__name__} where an object was expected."
        )

    @staticmethod
    def _titles(items, limit: int) -> list[str]:
        """Pull titles out of a list the model produced.

        Elements are not assumed to be objects. A truncated or malformed
        response can yield bare strings, and calling .get on one would raise.
        """
        titles = []
        if not isinstance(items, list):
            return titles
        for item in items:
            title = item.get("title") if isinstance(item, dict) else item
            if not isinstance(title, str):
                continue
            title = title.strip()
            if title:
                titles.append(title[:200])
        return titles[:limit]

    def next_steps(self, goal_title: str, existing_tasks: list[dict]) -> dict:
        """Propose the next actions. Returns {"status", "tasks"}."""
        context = "\n".join(
            f"- {t.get('title', '')} [{t.get('status', 'Pending')}]" for t in existing_tasks
        )
        user_prompt = (
            f"Goal: {goal_title}\n\n"
            f"Steps the user has already recorded:\n{context or '- none'}\n\n"
            f"Propose the next {MIN_TASKS} to {MAX_TASKS} steps, or report the goal as done."
        )

        result = self._call_tool(
            tool_name=NEXT_STEPS_TOOL,
            tool_description="Report the next steps for a goal, or that the goal is done.",
            schema=_NEXT_STEPS_SCHEMA,
            system_prompt=NEXT_STEPS_PROMPT,
            user_prompt=user_prompt,
        )

        status = result.get("status")
        if status not in ("more", "done"):
            raise ProviderError(f"The model returned an unknown status: {status!r}")

        if status == "done":
            return {"status": "done", "tasks": []}

        tasks = self._titles(result.get("tasks"), MAX_TASKS)
        if not tasks:
            raise ProviderError("The model asked for more steps but returned none")
        return {"status": "more", "tasks": tasks}

    def starter_goals(self, answers: str, count: int = 4) -> dict:
        """Suggest goals for a new user. Returns {"goals": [title]}."""
        count = max(1, min(count, 8))
        result = self._call_tool(
            tool_name=STARTER_GOALS_TOOL,
            tool_description="Suggest goals a new user might want to work towards.",
            schema=_STARTER_GOALS_SCHEMA,
            system_prompt=STARTER_GOALS_PROMPT,
            user_prompt=f"What the user told us:\n{answers}\n\nSuggest {count} goals.",
        )

        goals = self._titles(result.get("goals"), count)
        if not goals:
            raise ProviderError("The model returned no starter goals")
        return {"goals": goals}


bedrock = BedrockClient()
