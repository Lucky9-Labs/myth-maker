#!/usr/bin/env python3
"""Dispatch one provider-observed Blender demo through the deployed Modal app."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sys


ROOT = Path(__file__).parents[1]
CONCEPT = ROOT / "assets/concepts/kraken-observable-swarm-v1.png"
SOURCE = ROOT / "evidence/build-room-kraken-high-fanout-stress.json.artifacts/261fc2b0-1cf2-4a17-8d1f-b10b97b8ff42/wg-8340e6fcb9c609d3ddc8281669373364/source/wg-8340e6fcb9c609d3ddc8281669373364.r1.7fbc0055dd2f702b19c267c122ea8129c7166d3fb63bc1500b10210e516edb9f.blend"
APP_NAME = "myth-maker-encounter-draft"
FUNCTION_NAME = "run_draft"
ENVIRONMENT = "dev"
WORK_ID = "kraken-cloud-observed-demo"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stable_read(path: Path) -> bytes:
    before = path.stat()
    data = path.read_bytes()
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise RuntimeError(f"input changed while snapshotting: {path}")
    return data


def inputs_and_provenance(source_sha: str) -> tuple[dict[str, bytes], dict]:
    source, concept = stable_read(SOURCE), stable_read(CONCEPT)
    if not source.startswith((b"BLENDER", b"\x28\xb5\x2f\xfd", b"\x1f\x8b")):
        raise RuntimeError("the pinned generic source is not a supported Blender native snapshot")
    input_map = {
        "source_scene.blend": source,
        "structure_reference.png": concept,
        "component_reference.png": concept,
        "primary_artwork.png": concept,
        "concept_reference.png": concept,
    }
    return input_map, {
        "source_sha": source_sha,
        "demo": "generic-encounter-kraken",
        "pinned_concept": {
            "repository_path": str(CONCEPT.relative_to(ROOT)),
            "sha256": digest(concept), "bytes": len(concept),
        },
        "source_snapshot": {
            "repository_path": str(SOURCE.relative_to(ROOT)),
            "sha256": digest(source), "bytes": len(source),
        },
        "reference_slot_policy": (
            "The exact pinned concept bytes intentionally occupy each required image slot; "
            "the demo does not invent auxiliary reference art."
        ),
        "files": {name: {"sha256": digest(data), "bytes": len(data)} for name, data in input_map.items()},
    }


def public_terminal_receipt(state: dict, *, source_sha: str, job_id: str) -> dict:
    provider = state.get("provider_receipt")
    if state.get("status") not in {"checkpointed_partial", "ready_for_review"}:
        raise RuntimeError(f"cloud Blender work order did not create a terminal source artifact: {state.get('status')!r}")
    if not isinstance(provider, dict) or provider.get("provider") != "modal":
        raise RuntimeError("cloud Blender work order omitted its provider receipt")
    native = provider.get("output_artifacts", {}).get(WORK_ID + ".blend")
    frames = provider.get("blender_window_frames", {})
    if not isinstance(native, dict) or not isinstance(frames.get("initial"), dict) or not isinstance(frames.get("final"), dict):
        raise RuntimeError("cloud Blender work order omitted its native artifact or observed desktop frames")
    return {
        "format": "myth-maker.observed-modal-blender-demo/v1",
        "source_sha": source_sha,
        "work_id": WORK_ID,
        "job_id": job_id,
        "status": state["status"],
        "provider_receipt": provider,
        "input_snapshot_unchanged": state.get("input_snapshot_unchanged"),
        "reference_snapshots_unchanged": state.get("reference_snapshots_unchanged"),
        "checkpoint_id": state.get("checkpoint_id"),
    }


def main() -> int:
    source_sha = os.environ.get("GITHUB_SHA", "")
    job_id = os.environ.get("OBSERVED_MODAL_JOB_ID", "")
    if len(source_sha) != 40 or any(char not in "0123456789abcdef" for char in source_sha):
        raise RuntimeError("GITHUB_SHA must be the trusted immutable main revision")
    if not job_id.startswith("draft-gui-kraken-cloud-observed-demo-"):
        raise RuntimeError("OBSERVED_MODAL_JOB_ID must be the workflow-derived bounded job identity")
    inputs, provenance = inputs_and_provenance(source_sha)
    import modal
    function = modal.Function.from_name(APP_NAME, FUNCTION_NAME, environment_name=ENVIRONMENT)
    state = function.remote(job_id, inputs, provenance, "kraken-encounter-demo", WORK_ID,
                            reviewed_score=4)
    receipt = public_terminal_receipt(state, source_sha=source_sha, job_id=job_id)
    output = ROOT / "provider-evidence" / "modal-blender-demo-receipt.json"
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as handle:
            handle.write(f"job_id={job_id}\nwork_id={WORK_ID}\nreceipt_path={output}\n")
    print(json.dumps({"work_id": WORK_ID, "job_id": job_id,
                      "function_call_id": receipt["provider_receipt"]["function_call_id"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
