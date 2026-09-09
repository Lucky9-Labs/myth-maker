"""One stdin/stdout bridge from Railway's Node receiver to ModalDraftBackend.

The only accepted input is a closed v1 work-order envelope.  The five immutable
reference files arrive through a Railway secret as base64 JSON; neither their
contents nor Modal credentials are emitted to stdout/stderr.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from collections.abc import Mapping
from typing import Any

from modal_dispatch_backend import ModalVolumeDraftBackend


def input_manifest() -> dict[str, Any]:
    path = Path(os.environ.get("MODAL_INPUT_MANIFEST_PATH", "modal/kraken_input_manifest.json"))
    value = json.loads(path.read_text())
    if not isinstance(value, Mapping):
        raise ValueError("Modal input manifest must be an object")
    return dict(value)


def main() -> int:
    try:
        request: Any = json.load(sys.stdin)
        order = request.get("work_order") if isinstance(request, Mapping) else None
        backend = ModalVolumeDraftBackend(
            project_id=os.environ.get("MODAL_PROJECT_ID", "myth-maker"),
            manifest=input_manifest(),
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
