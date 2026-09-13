#!/usr/bin/env python3
"""Resolve the final reviewable GUI job directory from its worker receipt."""
from __future__ import annotations

import json
from pathlib import Path
import re
import sys


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: resolve_github_animation_job_root.py RECEIPT ARTIFACT_ROOT")
    receipt_path = Path(sys.argv[1]).resolve()
    artifact_root = Path(sys.argv[2]).resolve()
    payload = json.loads(receipt_path.read_text(encoding="utf-8"))
    state = payload.get("worker_state") or {}
    provider = state.get("provider_receipt") or {}
    if state.get("status") != "ready_for_review":
        raise RuntimeError("worker is not ready for review")
    provider_name = provider.get("provider")
    if provider_name == "modal":
        job_id = state.get("job_id", "")
        prefix = f"modal-volume://myth-maker-encounter-submissions/{job_id}/"
        artifacts = [*(provider.get("output_artifacts") or {}).values(),
                     *(provider.get("blender_window_frames") or {}).values()]
        trusted = (provider.get("volume_name") == "myth-maker-encounter-submissions"
                   and provider.get("app_name") == "myth-maker-encounter-draft"
                   and provider.get("function_name") == "run_draft_from_volume_manifest"
                   and artifacts and all(str(item.get("uri", "")).startswith(prefix) for item in artifacts))
    else:
        job_id = provider.get("input_id", "")
        trusted = provider_name == "github-actions-runner"
    if not trusted or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", job_id):
        raise RuntimeError("worker receipt has no trusted provider job ID")
    job_root = (artifact_root / "jobs" / job_id).resolve()
    if not job_root.is_relative_to(artifact_root) or not job_root.is_dir():
        raise RuntimeError("receipted worker job directory is missing")
    print(job_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
