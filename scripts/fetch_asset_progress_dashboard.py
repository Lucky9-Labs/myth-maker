#!/usr/bin/env python3
"""Fetch a private cloud-rendered progress dashboard from Modal."""
from __future__ import annotations
import argparse, base64, sys
from pathlib import Path
import modal
ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "modal"))
from infrastructure import runtime

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment", default="dev")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    config = runtime(args.environment)
    function = modal.Function.from_name(config.app_name, "get_asset_progress_dashboard", environment_name=config.environment)
    bundle = function.remote(args.run_id)
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    for name, encoded in bundle["files_base64"].items():
        if Path(name).name != name: raise RuntimeError("dashboard returned an unsafe filename")
        (output / name).write_bytes(base64.b64decode(encoded, validate=True))
    print(output / "index.html")
    return 0
if __name__ == "__main__": raise SystemExit(main())
