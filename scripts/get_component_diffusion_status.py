#!/usr/bin/env python3
"""Read a component-diffusion attempt's provider-persisted phase."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import modal
import sys

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "modal"))
from infrastructure import runtime


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment", default="dev")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--work-id", required=True)
    parser.add_argument("--attempt", required=True, type=int)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    config = runtime(args.environment)
    function = modal.Function.from_name(
        config.app_name, "get_component_diffusion_status", environment_name=config.environment)
    function.hydrate()
    status = function.remote(args.run_id, args.work_id, args.attempt)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(status, indent=2, sort_keys=True) + "\n")
    print(json.dumps(status, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
