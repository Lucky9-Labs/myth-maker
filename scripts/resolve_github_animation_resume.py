#!/usr/bin/env python3
"""Resolve a resumable rig checkpoint from one authenticated Actions artifact."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("artifact", type=Path)
    parser.add_argument("run_id")
    parser.add_argument("--field", choices=("work-id", "job-id", "checkpoint-id", "job-dir"))
    args = parser.parse_args()
    artifact = args.artifact.resolve()
    if not args.run_id.isdigit() or int(args.run_id) < 1:
        raise ValueError("invalid seed run ID")
    receipt_path = artifact / "receipts" / "reef-skitter-rig.json"
    payload = json.loads(receipt_path.read_text(encoding="utf-8"))
    order = payload.get("work_order") or {}
    state = payload.get("worker_state") or {}
    provider = state.get("provider_receipt") or {}
    work_id = order.get("work_id", "")
    job_id = provider.get("input_id", "")
    checkpoint_id = state.get("checkpoint_id", "")
    if (not re.fullmatch(r"reef-rig-[0-9]+", work_id)
            or state.get("part") != work_id
            or state.get("status") not in {"failed", "checkpointed_partial", "blocked"}
            or provider.get("provider") != "github-actions-runner"
            or provider.get("run_id") != int(args.run_id)
            or provider.get("artifact_name") != artifact.name
            or not re.fullmatch(r"draft-gui-[a-z0-9-]{1,118}", job_id)
            or not re.fullmatch(r"cp-[0-9]{4}-[a-f0-9]{12}", checkpoint_id)):
        raise RuntimeError("artifact does not contain a trusted resumable rig checkpoint")
    job_dir = (artifact / "evidence" / "rig" / "jobs" / job_id).resolve()
    if not job_dir.is_relative_to(artifact) or not (job_dir / "checkpoints" / checkpoint_id).is_dir():
        raise RuntimeError("receipted rig checkpoint directory is missing")
    result = {
        "work_id": work_id,
        "job_id": job_id,
        "checkpoint_id": checkpoint_id,
        "job_dir": str(job_dir),
    }
    if args.field:
        print(result[args.field.replace("-", "_")])
    else:
        print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
