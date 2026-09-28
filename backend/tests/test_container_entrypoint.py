"""The container entrypoint has to be a process Lambda can start.

A container image cannot use an exec form CMD to name a Python attribute,
because Lambda runs CMD as a program: "app.lambda_handler.handler" is looked
for on disk, is not there, and every invocation fails with
Runtime.InvalidEntrypoint. Nothing in the unit suite can see that, because it
only appears once the image is running in Lambda, so it is checked here instead.
"""
import importlib
import json
import re
from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parent.parent / "Dockerfile"


def _cmd() -> list[str]:
    text = DOCKERFILE.read_text(encoding="utf-8")
    match = re.search(r"^CMD\s+(.+)$", text, re.MULTILINE)
    assert match, "Dockerfile has no CMD, so the image has no entrypoint"
    raw = match.group(1).strip()
    # A JSON list is exec form, which is the only form Lambda honours for a
    # container image. A bare string is shell form.
    assert raw.startswith("["), f"CMD is shell form, not exec form: {raw}"
    return json.loads(raw)


def test_cmd_is_exec_form() -> None:
    # A list is passed to the kernel. A bare string is shell form, which Lambda
    # does not run for container images.
    assert _cmd()[0] == "python", _cmd()


def test_cmd_entrypoint_is_importable() -> None:
    # python -m <ric module> <dotted handler path>
    parts = _cmd()
    assert parts[1] == "-m", parts
    importlib.import_module(parts[2])
    assert parts[3] == "app.lambda_handler.handler", parts
    module_name, attribute = parts[3].rsplit(".", 1)
    assert callable(getattr(importlib.import_module(module_name), attribute))


def test_runtime_interface_client_is_pinned() -> None:
    # The entrypoint is the RIC's CLI. An unpinned major bump can change it, and
    # that surfaces only as Runtime.InvalidEntrypoint in a deployed function.
    requirements = (DOCKERFILE.parent / "requirements.txt").read_text(encoding="utf-8")
    assert re.search(r"^awslambdaric==\S+", requirements, re.MULTILINE), requirements
