"""Bedrock response parsing.

The client is stubbed at the transport boundary, so these exercise the part
that actually decides whether a model response is usable: finding the tool
call, and refusing the cases where there is nothing to read.
"""
import gzip
import json
import os

import botocore
import pytest
from botocore.exceptions import ClientError

from app.config import settings
from app.services import bedrock as bedrock_module
from app.services.bedrock import BedrockClient, ProviderError


def _real_stop_reasons() -> set[str]:
    """The stop reasons Bedrock actually returns, read from its own model.

    A test that hardcodes these can agree with a bug in the code it is meant
    to catch - which is exactly how a guard comparing against "maxTokens"
    passed for as long as it did. That spelling is the *request* field
    inferenceConfig.maxTokens, not a stop reason.
    """
    base = os.path.join(
        os.path.dirname(botocore.__file__), "data", "bedrock-runtime", "2023-09-30"
    )
    with gzip.open(os.path.join(base, "service-2.json.gz"), "rt", encoding="utf-8") as fh:
        model = json.load(fh)
    operation = model["operations"]["Converse"]
    output = model["shapes"][operation["output"]["shape"]]
    return set(model["shapes"][output["members"]["stopReason"]["shape"]]["enum"])


MAX_TOKENS_REASON = "max_tokens"


class _FakeRuntime:
    def __init__(self, response=None, error=None):
        self._response = response
        self._error = error
        self.calls = []

    def converse(self, **kwargs):
        self.calls.append(kwargs)
        if self._error:
            raise self._error
        return self._response


def _client(response=None, error=None):
    client = BedrockClient()
    client._client = _FakeRuntime(response=response, error=error)
    return client


def _response(content, stop_reason="tool_use"):
    return {
        "stopReason": stop_reason,
        "usage": {"inputTokens": 10, "outputTokens": 20},
        "output": {"message": {"content": content}},
    }


@pytest.fixture
def no_api_token():
    original = settings.api_token
    settings.api_token = None
    yield
    settings.api_token = original


class TestCallTool:
    def test_the_stop_reasons_we_check_are_real_ones(self, no_api_token):
        """Guards the guard. If someone reintroduces a camelCase spelling, the
        truncation handling silently stops working and no other test notices."""
        assert MAX_TOKENS_REASON in _real_stop_reasons()
        assert "maxTokens" not in _real_stop_reasons()
        assert bedrock_module.STOP_REASON_MAX_TOKENS in _real_stop_reasons()
        assert bedrock_module.STOP_REASONS_MALFORMED <= _real_stop_reasons()

    def test_reads_the_tool_input(self, no_api_token):
        client = _client(
            _response(
                [
                    {"text": "Let me think about that."},
                    {
                        "toolUse": {
                            "name": "propose_next_steps",
                            "input": {"status": "more", "tasks": [{"title": "A step"}]},
                        }
                    },
                ]
            )
        )

        result = client._call_tool(
            tool_name="propose_next_steps",
            tool_description="d",
            schema={"json": {}},
            system_prompt="s",
            user_prompt="u",
        )

        assert result == {"status": "more", "tasks": [{"title": "A step"}]}

    def test_forces_the_tool_so_prose_cannot_win(self, no_api_token):
        """toolChoice is what makes the schema guarantee hold.

        It belongs inside toolConfig. converse rejects it as a top-level
        parameter, which a permissive fake will happily accept, so the
        assertion checks the real nesting.
        """
        client = _client(_response([{"text": "here you go"}], stop_reason="end_turn"))

        with pytest.raises(ProviderError, match="did not call"):
            client._call_tool(
                tool_name="propose_next_steps",
                tool_description="d",
                schema={"json": {}},
                system_prompt="s",
                user_prompt="u",
            )

        call = client._client.calls[0]
        assert "toolChoice" not in call
        assert call["toolConfig"]["toolChoice"] == {"tool": {"name": "propose_next_steps"}}

    def test_ignores_a_differently_named_tool(self, no_api_token):
        client = _client(
            _response([{"toolUse": {"name": "something_else", "input": {}}}])
        )

        with pytest.raises(ProviderError, match="did not call"):
            client._call_tool(
                tool_name="propose_next_steps",
                tool_description="d",
                schema={"json": {}},
                system_prompt="s",
                user_prompt="u",
            )

    def test_truncation_is_reported_even_when_a_tool_block_is_present(self, no_api_token):
        """A call cut off by max_tokens can still carry a toolUse block, and its
        arguments are then a partial object. The schema cannot help there, so
        truncation has to be checked before the input is read."""
        client = _client(
            _response(
                [{"toolUse": {"name": "propose_next_steps", "input": {"status": "more"}}}],
                stop_reason=MAX_TOKENS_REASON,
            )
        )

        with pytest.raises(ProviderError, match="BEDROCK_MAX_TOKENS"):
            client._call_tool(
                tool_name="propose_next_steps",
                tool_description="d",
                schema={"json": {}},
                system_prompt="s",
                user_prompt="u",
            )

    @pytest.mark.parametrize(
        "reason", ["malformed_model_output", "malformed_tool_use"]
    )
    def test_malformed_output_is_refused_rather_than_parsed(self, no_api_token, reason):
        client = _client(
            _response(
                [{"toolUse": {"name": "propose_next_steps", "input": {"status": "more"}}}],
                stop_reason=reason,
            )
        )

        with pytest.raises(ProviderError, match="does not match the schema"):
            client._call_tool(
                tool_name="propose_next_steps",
                tool_description="d",
                schema={"json": {}},
                system_prompt="s",
                user_prompt="u",
            )

    def test_a_non_object_tool_input_is_refused(self, no_api_token):
        """Bedrock does not validate tool arguments against inputSchema for us,
        so a list or string can arrive where an object was expected. Indexing
        that with .get would be a 500 rather than a 502."""
        for bad in (["a", "b"], "nope", 7, None):
            client = _client(
                _response([{"toolUse": {"name": "propose_next_steps", "input": bad}}])
            )
            with pytest.raises(ProviderError):
                client._call_tool(
                    tool_name="propose_next_steps",
                    tool_description="d",
                    schema={"json": {}},
                    system_prompt="s",
                    user_prompt="u",
                )

    def test_bare_string_steps_do_not_crash_the_titles(self, no_api_token):
        client = _client(
            _response(
                [
                    {
                        "toolUse": {
                            "name": "propose_next_steps",
                            "input": {
                                "status": "more",
                                "tasks": ["Draft chapter one", 5, None, {"title": "Real step"}],
                            },
                        }
                    }
                ]
            )
        )

        result = client.next_steps("Anything", [])
        assert result["tasks"] == ["Draft chapter one", "Real step"]

    def test_a_provider_failure_becomes_a_provider_error(self, no_api_token):
        client = _client(
            error=ClientError(
                {"Error": {"Code": "AccessDeniedException", "Message": "no access"}},
                "InvokeModel",
            )
        )

        with pytest.raises(ProviderError, match="Bedrock request failed"):
            client._call_tool(
                tool_name="propose_next_steps",
                tool_description="d",
                schema={"json": {}},
                system_prompt="s",
                user_prompt="u",
            )

    def test_max_tokens_is_always_bounded(self, no_api_token):
        client = _client(_response([]))
        with pytest.raises(ProviderError):
            client._call_tool(
                tool_name="t",
                tool_description="d",
                schema={"json": {}},
                system_prompt="s",
                user_prompt="u",
            )
        assert client._client.calls[0]["inferenceConfig"]["maxTokens"] == settings.bedrock_max_tokens


class TestNextSteps:
    def _call(self, client):
        return client.next_steps("Write a book", [{"title": "Pick a topic", "status": "Completed"}])

    def test_returns_titles(self, no_api_token):
        client = _client(
            _response(
                [
                    {
                        "toolUse": {
                            "name": "propose_next_steps",
                            "input": {
                                "status": "more",
                                "tasks": [{"title": "Draft chapter one"}],
                            },
                        }
                    }
                ]
            )
        )

        assert self._call(client) == {"status": "more", "tasks": ["Draft chapter one"]}

    def test_includes_existing_tasks_in_the_prompt(self, no_api_token):
        client = _client(
            _response(
                [{"toolUse": {"name": "propose_next_steps", "input": {"status": "done", "tasks": []}}}]
            )
        )
        self._call(client)

        prompt = client._client.calls[0]["messages"][0]["content"][0]["text"]
        assert "Write a book" in prompt
        assert "Pick a topic" in prompt

    def test_done_drops_any_tasks_the_model_attached(self, no_api_token):
        """A model that says done and suggests work anyway is contradicting
        itself, and the client must win."""
        client = _client(
            _response(
                [
                    {
                        "toolUse": {
                            "name": "propose_next_steps",
                            "input": {"status": "done", "tasks": [{"title": "More work"}]},
                        }
                    }
                ]
            )
        )

        assert self._call(client) == {"status": "done", "tasks": []}

    def test_more_with_no_tasks_is_an_error(self, no_api_token):
        client = _client(
            _response(
                [{"toolUse": {"name": "propose_next_steps", "input": {"status": "more", "tasks": []}}}]
            )
        )

        with pytest.raises(ProviderError, match="returned none"):
            self._call(client)

    def test_an_unknown_status_is_an_error(self, no_api_token):
        client = _client(
            _response(
                [
                    {
                        "toolUse": {
                            "name": "propose_next_steps",
                            "input": {"status": "maybe", "tasks": [{"title": "x"}]},
                        }
                    }
                ]
            )
        )

        with pytest.raises(ProviderError, match="unknown status"):
            self._call(client)

    def test_more_tasks_than_the_cap_are_trimmed(self, no_api_token):
        client = _client(
            _response(
                [
                    {
                        "toolUse": {
                            "name": "propose_next_steps",
                            "input": {
                                "status": "more",
                                "tasks": [{"title": f"Step {i}"} for i in range(12)],
                            },
                        }
                    }
                ]
            )
        )

        result = self._call(client)
        assert len(result["tasks"]) == bedrock_module.MAX_TASKS

    def test_blank_titles_are_discarded(self, no_api_token):
        client = _client(
            _response(
                [
                    {
                        "toolUse": {
                            "name": "propose_next_steps",
                            "input": {
                                "status": "more",
                                "tasks": [{"title": "  "}, {"title": "Real step"}],
                            },
                        }
                    }
                ]
            )
        )

        assert self._call(client)["tasks"] == ["Real step"]


class TestStarterGoals:
    def test_returns_titles(self, no_api_token):
        client = _client(
            _response(
                [
                    {
                        "toolUse": {
                            "name": "propose_starter_goals",
                            "input": {"goals": [{"title": "Run a marathon"}, {"title": "Learn piano"}]},
                        }
                    }
                ]
            )
        )

        assert client.starter_goals("I want to get fit", 2) == {
            "goals": ["Run a marathon", "Learn piano"]
        }

    def test_respects_the_requested_count(self, no_api_token):
        client = _client(
            _response(
                [
                    {
                        "toolUse": {
                            "name": "propose_starter_goals",
                            "input": {"goals": [{"title": f"G{i}"} for i in range(8)]},
                        }
                    }
                ]
            )
        )

        assert len(client.starter_goals("anything", 3)["goals"]) == 3

    def test_no_goals_is_an_error(self, no_api_token):
        client = _client(
            _response([{"toolUse": {"name": "propose_starter_goals", "input": {"goals": []}}}])
        )

        with pytest.raises(ProviderError, match="no starter goals"):
            client.starter_goals("anything")
