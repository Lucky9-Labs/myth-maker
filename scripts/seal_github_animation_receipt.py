#!/usr/bin/env python3
"""Seal a GUI worker receipt with GitHub's post-upload artifact identity."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


sys.path.insert(0, str(Path(__file__).parents[1] / "modal"))
from cloud_draft_execution import seal_github_actions_artifact_receipt


def seal_document(document: dict, *, artifact_id: str, artifact_url: str,
                  artifact_digest: str) -> dict:
    state = document.get("worker_state")
    if not isinstance(state, dict) or not isinstance(state.get("provider_receipt"), dict):
        raise ValueError("animation receipt omitted its runner receipt")
    result = dict(document)
    result["worker_state"] = dict(state)
    result["worker_state"]["provider_receipt"] = seal_github_actions_artifact_receipt(
        state["provider_receipt"], artifact_id=artifact_id,
        artifact_url=artifact_url, artifact_digest=artifact_digest,
    )
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--artifact-id", required=True)
    parser.add_argument("--artifact-url", required=True)
    parser.add_argument("--artifact-digest", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    document = json.loads(args.receipt.read_text(encoding="utf-8"))
    sealed = seal_document(document, artifact_id=args.artifact_id,
                           artifact_url=args.artifact_url, artifact_digest=args.artifact_digest)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(sealed, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(sealed["worker_state"]["provider_receipt"]["storage"], sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
