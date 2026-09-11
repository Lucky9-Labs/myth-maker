#!/usr/bin/env python3
"""Submit one closed agentic stitch job to the trusted Modal deployment."""
import argparse
import json
import os
from pathlib import Path

import modal

from sys import path as import_path

ROOT = Path(__file__).parents[1]
import_path.insert(0, str(ROOT / "modal"))
from infrastructure import runtime


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment", default=os.environ.get("MODAL_ENVIRONMENT", "dev"))
    parser.add_argument("--job-json", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    job = json.loads(args.job_json)
    config = runtime(args.environment)
    function = modal.Function.from_name(
        config.app_name,
        config.agentic_stitch_function_name,
        environment_name=config.environment,
    )
    receipt = function.remote(job)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
