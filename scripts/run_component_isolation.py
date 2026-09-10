#!/usr/bin/env python3
"""Run one measured cloud component-isolation attempt."""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
import modal
ROOT = Path(__file__).parents[1]; sys.path.insert(0, str(ROOT / "modal"))
from component_isolation import validate_component_isolation_job
from infrastructure import runtime

def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("--environment", default="dev")
    parser.add_argument("--job-json", required=True); parser.add_argument("--output", required=True)
    args = parser.parse_args(); job = validate_component_isolation_job(json.loads(args.job_json))
    config = runtime(args.environment)
    function = modal.Function.from_name(config.app_name, "run_component_isolation_job",
                                        environment_name=config.environment)
    receipt = function.remote(job)
    output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    if receipt.get("status") != "completed": raise RuntimeError("component isolation failed")
    return 0
if __name__ == "__main__": raise SystemExit(main())
