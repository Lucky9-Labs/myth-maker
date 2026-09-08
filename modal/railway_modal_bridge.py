"""One stdin/stdout bridge from Railway's Node receiver to ModalDraftBackend.

The only accepted input is a closed v1 work-order envelope.  The five immutable
reference files arrive through a Railway secret as base64 JSON; neither their
contents nor Modal credentials are emitted to stdout/stderr.
"""
from __future__ import annotations

import base64
import json
import os
import sys
from collections.abc import Mapping
from typing import Any

from modal_dispatch_backend import REQUIRED_INPUTS, ModalDraftBackend


def input_package() -> dict[str, bytes]:
    encoded = os.environ.get("MODAL_INPUT_PACKAGE_BASE64")
    if not encoded:
        raise ValueError("MODAL_INPUT_PACKAGE_BASE64 is not configured")
    try:
        value = json.loads(encoded)
    except json.JSONDecodeError as error:
        raise ValueError("MODAL_INPUT_PACKAGE_BASE64 is not JSON") from error
    if not isinstance(value, Mapping) or set(value) != REQUIRED_INPUTS:
        raise ValueError("MODAL_INPUT_PACKAGE_BASE64 must contain exactly the five draft inputs")
    result: dict[str, bytes] = {}
    for name, data in value.items():
        if not isinstance(data, str):
            raise ValueError("MODAL_INPUT_PACKAGE_BASE64 values must be base64 strings")
        try:
            result[name] = base64.b64decode(data, validate=True)
        except ValueError as error:
            raise ValueError("MODAL_INPUT_PACKAGE_BASE64 contains invalid base64") from error
    return result


def main() -> int:
    try:
        request: Any = json.load(sys.stdin)
        order = request.get("work_order") if isinstance(request, Mapping) else None
        backend = ModalDraftBackend(
            project_id=os.environ.get("MODAL_PROJECT_ID", "myth-maker"),
            inputs=input_package(),
            provenance={"source": "railway-dispatcher", "modal_app": os.environ.get("MODAL_APP_NAME", "myth-maker-encounter-draft")},
            cloud_execution_enabled=os.environ.get("MODAL_CLOUD_EXECUTION_ENABLED") == "true",
        )
        result = backend.run(order)
        print(json.dumps({"worker_id": "modal-draft", "events": result.events, "source_artifact": result.source_artifact.to_record() if result.source_artifact else None}))
        return 0
    except Exception as error:
        # This is an internal process diagnostic; do not include environment
        # values or decoded input data in it.
        print(f"modal bridge: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
