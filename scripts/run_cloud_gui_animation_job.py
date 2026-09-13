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


def build_work_order(work_id: str, lane: str, instruction: str, *, attempt: int,
                     run_scope: str = "run-1", continuation: int = 0,
                     resume_job: str = "", checkpoint_id: str = "",
                     motion_capture_frames: int = 0) -> dict[str, Any]:
    if not SAFE_ID.fullmatch(work_id) or not SAFE_ID.fullmatch(lane) or not SAFE_ID.fullmatch(run_scope):
        raise ValueError("work and lane IDs must be stable lowercase kebab-case")
    if not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1:
        raise ValueError("attempt must be positive")
    if not isinstance(continuation, int) or isinstance(continuation, bool) or not 0 <= continuation <= 4:
        raise ValueError("continuation must be between zero and four")
    if (not isinstance(motion_capture_frames, int) or isinstance(motion_capture_frames, bool)
            or not 0 <= motion_capture_frames <= 240):
        raise ValueError("motion capture frames must be between zero and 240")
    if bool(resume_job) != bool(checkpoint_id):
        raise ValueError("resume job and checkpoint ID must be supplied together")
    if resume_job and (not re.fullmatch(r"draft-gui-[a-z0-9-]{1,118}", resume_job)
                       or not re.fullmatch(r"cp-[0-9]{4}-[a-f0-9]{12}", checkpoint_id)):
        raise ValueError("resume identity is invalid")
    if not instruction.strip():
        raise ValueError("instruction is required")
    return {
        "schema_version": "1", "work_id": work_id, "encounter_id": "reef-skitter",
        "lane": lane, "attempt": attempt, "run_scope": run_scope,
        "continuation": continuation, "instruction": instruction,
        "resume_job": resume_job, "checkpoint_id": checkpoint_id,
        "motion_capture_frames": motion_capture_frames,
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


def continuation_available(state: dict[str, Any]) -> bool:
    error = str(state.get("error") or "").lower()
    return (
        state.get("status") in {"checkpointed_partial", "failed"}
        and bool(re.fullmatch(r"cp-[0-9]{4}-[a-f0-9]{12}", state.get("checkpoint_id") or ""))
        and "credit_balance_exhausted" not in error
        and "insufficient_quota" not in error
    )


def validate_resume_job(source: Path, *, part: str,
                        expected_input_hashes: dict[str, dict[str, Any]]) -> tuple[str, str]:
    source = source.resolve()
    if not source.is_dir() or not re.fullmatch(r"draft-gui-[a-z0-9-]{1,118}", source.name):
        raise ValueError("resume job directory is invalid")
    state = json.loads((source / "status.json").read_text(encoding="utf-8"))
    pointer = json.loads((source / "checkpoint-latest.json").read_text(encoding="utf-8"))
    checkpoint_id = pointer.get("checkpoint_id", "")
    package = source / "checkpoints" / checkpoint_id
    manifest = json.loads((package / "checkpoint.json").read_text(encoding="utf-8"))
    if (state.get("part") != part or manifest.get("schema_version") != 2
            or manifest.get("part") != part or manifest.get("checkpoint_id") != checkpoint_id
            or not continuation_available({"status": state.get("status"), "checkpoint_id": checkpoint_id})):
        raise ValueError("resume checkpoint does not match the requested part")
    files = manifest.get("files") or {}
    for name, expected in expected_input_hashes.items():
        if files.get("inputs/" + name) != expected:
            raise ValueError("resume checkpoint input hash mismatch: " + name)
    return source.name, checkpoint_id


def resume_stage_job_id(part: str, run_scope: str, attempt: int) -> str:
    candidate = f"draft-gui-resume-{part}-{run_scope}-a{attempt}"
    if (not SAFE_ID.fullmatch(part) or not re.fullmatch(r"run-[0-9]+", run_scope)
            or not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1
            or not re.fullmatch(r"draft-gui-[a-z0-9-]{1,118}", candidate)):
        raise ValueError("resume staging identity is invalid")
    return candidate


def stage_resume_job(source: Path, *, part: str, expected_input_hashes: dict[str, dict[str, Any]],
                     environment: str, staged_job_id: str,
                     already_staged: bool = False) -> tuple[str, str]:
    resume_job, checkpoint_id = validate_resume_job(
        source, part=part, expected_input_hashes=expected_input_hashes,
    )
    if not already_staged:
        if not re.fullmatch(r"draft-gui-[a-z0-9-]{1,118}", staged_job_id):
            raise ValueError("resume staging identity is invalid")
        subprocess.run(
            ["modal", "volume", "put", "--env", environment, VOLUME_NAME,
             str(source.resolve()), "/" + staged_job_id],
            check=True,
        )
        resume_job = staged_job_id
    return resume_job, checkpoint_id


def fetch_job(state: dict[str, Any], *, artifact_root: Path, environment: str) -> Path:
    job_id = state.get("job_id", "")
    provider = state.get("provider_receipt") or {}
    if (not re.fullmatch(r"draft-gui-[a-z0-9-]{1,118}", job_id)
            or provider.get("provider") != "modal" or provider.get("volume_name") != VOLUME_NAME
            or provider.get("app_name") != APP_NAME or provider.get("environment") != environment
            or provider.get("function_name") != FUNCTION_NAME):
        raise RuntimeError("Modal worker state has no trusted provider job identity")
    destination = (artifact_root.resolve() / "jobs" / job_id).resolve()
    root = artifact_root.resolve()
    if not destination.is_relative_to(root) or destination.exists():
        raise RuntimeError("Modal evidence destination is unsafe or already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["modal", "volume", "get", "--env", environment, VOLUME_NAME, job_id, str(destination)],
        check=True,
    )
    status = json.loads((destination / "status.json").read_text(encoding="utf-8"))
    if status.get("job_id") != job_id or status.get("part") != state.get("part"):
        raise RuntimeError("downloaded Modal job does not match its returned state")
    return destination


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
    if not isinstance(state, dict):
        raise RuntimeError("GUI worker returned no state")
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
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--motion-capture-frames", type=int, default=0)
    parser.add_argument("--max-continuations", type=int, default=2)
    parser.add_argument("--resume-job-dir", type=Path)
    parser.add_argument("--resume-already-staged", action="store_true")
    parser.add_argument("--input", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not SAFE_ID.fullmatch(args.run_scope) or not SAFE_ID.fullmatch(args.project_id):
        raise ValueError("run scope and project ID must be stable lowercase kebab-case")
    if not 0 <= args.max_continuations <= 4:
        raise ValueError("max continuations must be between zero and four")
    source_sha = os.environ.get("GITHUB_SHA", "")
    if (os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != "Lucky9-Labs/myth-maker"
            or os.environ.get("GITHUB_REF") != "refs/heads/main" or not re.fullmatch(r"[a-f0-9]{40}", source_sha)):
        raise RuntimeError("cloud animation dispatch requires the trusted GitHub Actions main context")
    run_id = os.environ.get("GITHUB_RUN_ID", "")
    run_attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "")
    if (not run_id.isdigit() or args.run_scope != f"run-{run_id}"
            or not run_attempt.isdigit() or args.attempt != int(run_attempt)):
        raise RuntimeError("run scope and attempt must match the trusted GitHub execution")
    inputs = collect_inputs(args.input)
    input_hashes = {
        name: {"bytes": len(data), "sha256": digest(data)}
        for name, (_, data) in sorted(inputs.items())
    }
    if args.resume_job_dir:
        resume_job, checkpoint_id = stage_resume_job(
            args.resume_job_dir, part=args.work_id, expected_input_hashes=input_hashes,
            environment=args.environment,
            staged_job_id=resume_stage_job_id(args.work_id, args.run_scope, args.attempt),
            already_staged=args.resume_already_staged,
        )
    else:
        if args.resume_already_staged:
            raise ValueError("already-staged resume requires a resume job directory")
        resume_job, checkpoint_id = "", ""
    input_root = f"cloud-animation/{args.run_scope}/{args.work_id}/attempt-{args.attempt}/inputs"
    manifest = build_manifest(inputs, input_root=input_root)
    stage_inputs(inputs, manifest, environment=args.environment)
    deployment_receipt = json.loads(args.deployment_receipt.read_text(encoding="utf-8"))
    states = []
    state: dict[str, Any] = {}
    order: dict[str, Any] = {}
    for continuation in range(args.max_continuations + 1):
        order = build_work_order(
            args.work_id, args.lane, args.instruction, attempt=args.attempt,
            run_scope=args.run_scope, continuation=continuation,
            resume_job=resume_job, checkpoint_id=checkpoint_id,
            motion_capture_frames=args.motion_capture_frames,
        )
        state = invoke(order, manifest, project_id=args.project_id, environment=args.environment,
                       source_sha=source_sha, deployment_receipt=deployment_receipt)
        states.append({
            "job_id": state.get("job_id"), "status": state.get("status"),
            "stop_reason": state.get("stop_reason"), "checkpoint_id": state.get("checkpoint_id"),
        })
        if state.get("status") == "ready_for_review" or not continuation_available(state):
            break
        resume_job, checkpoint_id = state["job_id"], state["checkpoint_id"]
    result = {"work_order": order, "input_manifest": manifest,
              "worker_attempts": states, "worker_state": state}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    fetch_job(state, artifact_root=args.artifact_root, environment=args.environment)
    if state.get("status") != "ready_for_review":
        raise RuntimeError("GUI worker did not produce a reviewable native: " + json.dumps(state)[:2000])
    native = order["work_id"] + ".blend"
    artifact = (state.get("files") or {}).get(native)
    if not isinstance(artifact, dict) or not re.fullmatch(r"[a-f0-9]{64}", artifact.get("sha256", "")):
        raise RuntimeError("GUI worker omitted its hash-bound native artifact")
    print(json.dumps({"work_id": order["work_id"], "job_id": state.get("job_id"),
                      "status": state.get("status"), "native": state["files"][order["work_id"] + ".blend"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
