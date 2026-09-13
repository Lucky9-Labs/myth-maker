#!/usr/bin/env python3
"""Resolve a resumable rig or clip checkpoint from one authenticated Actions artifact."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("run_id")
    parser.add_argument("--clip", choices=("idle", "walk", "run", "attack", "death"))
    parser.add_argument("--field", choices=("work-id", "job-id", "checkpoint-id", "job-dir", "provider"))
    args = parser.parse_args()
    artifact = args.artifact.resolve()
    if not args.run_id.isdigit() or int(args.run_id) < 1:
        raise ValueError("invalid seed run ID")
    if args.clip:
        receipt_path = artifact / "receipts" / f"reef-skitter-clip-{args.clip}.json"
        work_id_pattern = rf"reef-{re.escape(args.clip)}-[0-9]+"
        evidence_dir = args.clip
        kind = "clip"
    else:
        receipt_path = artifact / "receipts" / "reef-skitter-rig.json"
        work_id_pattern = r"reef-rig-[0-9]+"
        evidence_dir = "rig"
        kind = "rig"
    payload = json.loads(receipt_path.read_text(encoding="utf-8"))
    order = payload.get("work_order") or {}
    state = payload.get("worker_state") or {}
    provider = state.get("provider_receipt") or {}
    work_id = order.get("work_id", "")
    provider_name = provider.get("provider", "")
    job_id = state.get("job_id", "") if provider_name == "modal" else provider.get("input_id", "")
    checkpoint_id = state.get("checkpoint_id", "")
    if (not re.fullmatch(work_id_pattern, work_id)
            or state.get("part") != work_id
            or state.get("status") not in {"failed", "checkpointed_partial", "blocked", "ready_for_review"}
            or provider_name not in {"github-actions-runner", "modal"}
            or (provider_name == "github-actions-runner" and provider.get("run_id") != int(args.run_id))
            or (provider_name == "github-actions-runner" and provider.get("artifact_name") != artifact.name)
            or (provider_name == "modal" and (
                provider.get("volume_name") != "myth-maker-encounter-submissions"
                or provider.get("app_name") != "myth-maker-encounter-draft"
                or provider.get("function_name") != "run_draft_from_volume_manifest"))
            or not re.fullmatch(r"draft-gui-[a-z0-9-]{1,118}", job_id)
            or not re.fullmatch(r"cp-[0-9]{4}-[a-f0-9]{12}", checkpoint_id)):
        raise RuntimeError(f"artifact does not contain a trusted resumable {kind} checkpoint")
    job_dir = (artifact / "evidence" / evidence_dir / "jobs" / job_id).resolve()
    downloaded_checkpoint = (job_dir / "checkpoints" / checkpoint_id).is_dir()
    if (not job_dir.is_relative_to(artifact)
            or (provider_name == "github-actions-runner" and not downloaded_checkpoint)):
        raise RuntimeError("receipted rig checkpoint directory is missing")
    result = {
        "work_id": work_id,
        "job_id": job_id,
        "checkpoint_id": checkpoint_id,
        "job_dir": str(job_dir) if downloaded_checkpoint else "",
        "provider": provider_name,
    }
    if args.field:
        print(result[args.field.replace("-", "_")])
    else:
        print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
