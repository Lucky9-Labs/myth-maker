#!/usr/bin/env python3
"""Stage immutable inputs and invoke one deployed GUI-only Blender cloud job."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from typing import Any
from datetime import datetime, timedelta, timezone


ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "modal"))
from draft_support import validate_input_names


VOLUME_NAME = "myth-maker-encounter-submissions"
APP_NAME = "myth-maker-encounter-draft"
FUNCTION_NAME = "run_draft_from_volume_manifest"
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def collect_inputs(specs: list[str]) -> dict[str, tuple[Path, bytes]]:
    result: dict[str, tuple[Path, bytes]] = {}
    for spec in specs:
        name, separator, raw_path = spec.partition("=")
        if not separator or not name or name in result:
            raise ValueError("each --input must be one unique NAME=PATH")
        path = Path(raw_path).resolve()
        before = path.stat()
        data = path.read_bytes()
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise RuntimeError(f"input changed while snapshotting: {name}")
        result[name] = (path, data)
    validate_input_names({name: item[1] for name, item in result.items()})
    return result


def build_manifest(inputs: dict[str, tuple[Path, bytes]], *, input_root: str) -> dict[str, Any]:
    root = PurePosixPath(input_root)
    if root.is_absolute() or ".." in root.parts or "." in root.parts:
        raise ValueError("input root must be a safe relative Volume path")
    return {
        "schema_version": "1",
        "volume_name": VOLUME_NAME,
        "input_root": str(root),
        "files": {
            name: {"sha256": digest(data), "bytes": len(data)}
            for name, (_, data) in sorted(inputs.items())
        },
    }


def build_work_order(work_id: str, lane: str, instruction: str, *, attempt: int) -> dict[str, Any]:
    if not SAFE_ID.fullmatch(work_id) or not SAFE_ID.fullmatch(lane):
        raise ValueError("work and lane IDs must be stable lowercase kebab-case")
    if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1:
        raise ValueError("attempt must be positive")
    if not instruction.strip():
        raise ValueError("instruction is required")
    return {
        "schema_version": "1", "work_id": work_id, "encounter_id": "reef-skitter",
        "lane": lane, "attempt": attempt, "instruction": instruction,
    }


def validate_deployment_receipt(receipt: dict[str, Any], *, source_sha: str,
                                environment: str, function_id: str) -> None:
    health = ((receipt.get("details") or {}).get("provider_evidence") or {}).get("health") or {}
    if (receipt.get("format") != "myth-maker.deployment-receipt/v1"
            or receipt.get("provider") != "modal" or receipt.get("status") != "success"
            or receipt.get("environment") != environment or receipt.get("source_sha") != source_sha
            or health.get("volume_draft_function_id") != function_id):
        raise RuntimeError("trusted Modal deployment receipt does not match this source and function")


def stage_inputs(inputs: dict[str, tuple[Path, bytes]], manifest: dict[str, Any], *, environment: str) -> None:
    for name, (path, _) in sorted(inputs.items()):
        remote = f"{manifest['input_root']}/{name}"
        subprocess.run(
            ["modal", "volume", "put", "--env", environment, VOLUME_NAME, str(path), remote],
            check=True,
        )


def invoke(order: dict[str, Any], manifest: dict[str, Any], *, project_id: str,
           environment: str, source_sha: str, deployment_receipt: dict[str, Any]) -> dict[str, Any]:
    import modal

    function = modal.Function.from_name(APP_NAME, FUNCTION_NAME, environment_name=environment)
    function.hydrate()
    if not function.object_id:
        raise RuntimeError("deployed GUI worker has no provider identity")
    validate_deployment_receipt(deployment_receipt, source_sha=source_sha, environment=environment,
                                function_id=function.object_id)
    approved_at = datetime.now(timezone.utc)
    provenance = {
        "source_sha": source_sha,
        "execution_boundary": "github-actions-to-modal-cloud",
        "deployed_function_id": function.object_id,
        "worker_contract": {
            "asset": "reef-skitter",
            "lane": order["lane"],
            "source_manifest": manifest,
            "geometry_and_animation_authoring": "visible Blender GUI only",
            "output_owner": order["work_id"],
        },
        "concept_first_lineage": {
            "kind": "reuse_maintenance_waiver",
            "waiver": {
                "kind": "maintenance",
                "bounded_reason": "User-authorized animation of the existing hash-pinned Reef Skitter source; no new concept or geometry generation.",
                "approver": "user",
                "approved_at": approved_at.isoformat().replace("+00:00", "Z"),
                "expires_at": (approved_at + timedelta(days=30)).isoformat().replace("+00:00", "Z"),
                "asset_ids": ["reef-skitter-source", "reef-skitter-animation"],
            },
        },
    }
    state = function.remote(order, manifest, provenance, project_id)
    if not isinstance(state, dict) or state.get("status") != "ready_for_review":
        raise RuntimeError("GUI worker did not leave a resumable native checkpoint: " + json.dumps(state)[:2000])
    native = order["work_id"] + ".blend"
    artifact = (state.get("files") or {}).get(native)
    if not isinstance(artifact, dict) or not re.fullmatch(r"[a-f0-9]{64}", artifact.get("sha256", "")):
        raise RuntimeError("GUI worker omitted its hash-bound native artifact")
    return state


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment", default="dev")
    parser.add_argument("--project-id", default="reef-skitter-animation")
    parser.add_argument("--run-scope", required=True)
    parser.add_argument("--work-id", required=True)
    parser.add_argument("--lane", required=True)
    parser.add_argument("--attempt", type=int, default=1)
    parser.add_argument("--instruction", required=True)
    parser.add_argument("--deployment-receipt", type=Path, required=True)
    parser.add_argument("--input", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not SAFE_ID.fullmatch(args.run_scope) or not SAFE_ID.fullmatch(args.project_id):
        raise ValueError("run scope and project ID must be stable lowercase kebab-case")
    source_sha = os.environ.get("GITHUB_SHA", "")
    if (os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != "Lucky9-Labs/myth-maker"
            or os.environ.get("GITHUB_REF") != "refs/heads/main" or not re.fullmatch(r"[a-f0-9]{40}", source_sha)):
        raise RuntimeError("cloud animation dispatch requires the trusted GitHub Actions main context")
    inputs = collect_inputs(args.input)
    input_root = f"cloud-animation/{args.run_scope}/{args.work_id}/inputs"
    manifest = build_manifest(inputs, input_root=input_root)
    order = build_work_order(args.work_id, args.lane, args.instruction, attempt=args.attempt)
    stage_inputs(inputs, manifest, environment=args.environment)
    deployment_receipt = json.loads(args.deployment_receipt.read_text(encoding="utf-8"))
    state = invoke(order, manifest, project_id=args.project_id, environment=args.environment,
                   source_sha=source_sha, deployment_receipt=deployment_receipt)
    result = {"work_order": order, "input_manifest": manifest, "worker_state": state}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"work_id": order["work_id"], "job_id": state.get("job_id"),
                      "status": state.get("status"), "native": state["files"][order["work_id"] + ".blend"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
