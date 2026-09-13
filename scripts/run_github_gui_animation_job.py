#!/usr/bin/env python3
"""Run the production Blender GUI worker on a trusted GitHub-hosted runner."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "modal"))
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from cloud_draft_execution import DraftExecution, github_actions_artifact_receipt
from run_cloud_gui_animation_job import SAFE_ID, build_work_order, collect_inputs


def trusted_context(environment: dict[str, str]) -> dict[str, str]:
    required = {
        "GITHUB_ACTIONS": "true",
        "GITHUB_REPOSITORY": "Lucky9-Labs/myth-maker",
        "GITHUB_REF": "refs/heads/main",
    }
    valid = all(environment.get(name) == value for name, value in required.items())
    source_sha = environment.get("GITHUB_SHA", "")
    run_id = environment.get("GITHUB_RUN_ID", "")
    run_attempt = environment.get("GITHUB_RUN_ATTEMPT", "")
    job_name = environment.get("GITHUB_JOB", "")
    if (not valid or not re.fullmatch(r"[a-f0-9]{40}", source_sha)
            or not run_id.isdigit() or not run_attempt.isdigit()
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", job_name)):
        raise RuntimeError("GUI animation requires the trusted GitHub Actions main context")
    return {
        "repository": environment["GITHUB_REPOSITORY"],
        "source_sha": source_sha,
        "run_id": run_id,
        "run_attempt": run_attempt,
        "job_name": job_name,
    }


def worker_paths(*, workspace: Path, artifact_root: Path) -> dict[str, Path]:
    workspace = workspace.resolve()
    artifact_root = artifact_root.resolve()
    if artifact_root == workspace or not artifact_root.is_relative_to(workspace):
        raise ValueError("artifact root must be a child of the trusted workspace")
    return {
        "submissions_root": artifact_root / "jobs",
        "inputs_dir": Path("/inputs"),
        "output_link": Path("/output"),
        "prompt_template": workspace / "modal" / "draft_prompt.md",
        "resume_template": workspace / "modal" / "draft_resume.md",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work-id", required=True)
    parser.add_argument("--lane", required=True)
    parser.add_argument("--attempt", type=int, default=1)
    parser.add_argument("--instruction", required=True)
    parser.add_argument("--artifact-name", required=True)
    parser.add_argument("--artifact-root", type=Path, required=True)
    parser.add_argument("--motion-capture-frames", type=int, default=0)
    parser.add_argument("--input", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    context = trusted_context(os.environ)
    if not SAFE_ID.fullmatch(args.work_id) or not SAFE_ID.fullmatch(args.lane):
        raise ValueError("work and lane IDs must be stable lowercase kebab-case")
    if args.attempt != int(context["run_attempt"]):
        raise ValueError("worker attempt must equal the GitHub workflow attempt")

    workspace = Path(os.environ["GITHUB_WORKSPACE"]).resolve()
    paths = worker_paths(workspace=workspace, artifact_root=args.artifact_root)
    paths["submissions_root"].mkdir(parents=True, exist_ok=False)
    if paths["inputs_dir"].exists() or paths["output_link"].exists() or paths["output_link"].is_symlink():
        raise RuntimeError("isolated Blender input/output aliases already exist")

    inputs = collect_inputs(args.input)
    input_bytes = {name: data for name, (_, data) in inputs.items()}
    order = build_work_order(args.work_id, args.lane, args.instruction, attempt=args.attempt)
    job_id = f"draft-gui-{args.work_id}-a{args.attempt}"
    approved_at = datetime.now(timezone.utc)
    provenance = {
        "source_sha": context["source_sha"],
        "execution_boundary": "github-hosted-runner",
        "worker_contract": {
            "asset": "reef-skitter",
            "lane": args.lane,
            "geometry_and_animation_authoring": "visible Blender GUI only",
            "output_owner": args.work_id,
            "input_files": {
                name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                for name, data in sorted(input_bytes.items())
            },
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

    receipt = lambda *, job_id, output_files, blender_frames: github_actions_artifact_receipt(
        **context, artifact_name=args.artifact_name, job_id=job_id,
        output_files=output_files, blender_frames=blender_frames,
    )
    execution = DraftExecution(
        **paths,
        reload=lambda: None,
        commit=lambda: None,
        receipt=receipt,
        motion_capture_frames=args.motion_capture_frames,
    )

    from draft_trial import _run_draft
    state = _run_draft(
        job_id, input_bytes, provenance, args.work_id, feedback=args.instruction,
        function_call_id=f"github-actions:{context['run_id']}:{context['run_attempt']}:{context['job_name']}",
        input_id=job_id, execution=execution,
    )
    result = {"work_order": order, "worker_state": state}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if state.get("status") != "ready_for_review":
        raise RuntimeError("GUI worker did not produce a reviewable native: " + json.dumps(state)[:2000])
    native = args.work_id + ".blend"
    if native not in (state.get("files") or {}):
        raise RuntimeError("GUI worker omitted its native Blender artifact")
    print(json.dumps({"work_id": args.work_id, "job_id": job_id, "status": state["status"], "native": state["files"][native]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
