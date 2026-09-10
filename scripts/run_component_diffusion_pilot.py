#!/usr/bin/env python3
"""Submit one immutable component diffusion attempt to the deployed Modal runtime."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys
import modal

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "modal"))
from component_diffusion import validate_component_diffusion_job
from infrastructure import runtime


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment", default="dev")
    parser.add_argument("--job-json", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    job = validate_component_diffusion_job(json.loads(args.job_json))
    config = runtime(args.environment)
    function = modal.Function.from_name(
        config.app_name, config.component_diffusion_function_name,
        environment_name=config.environment)
    function.hydrate()
    receipt = function.remote(job)
    output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    if receipt.get("status") != "completed":
        raise RuntimeError("component diffusion attempt did not complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
