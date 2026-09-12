#!/usr/bin/env python3
"""Poll a previously spawned Modal function call without rerunning it."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import modal


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--call-id", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--timeout", type=float, default=0)
    args = parser.parse_args()
    if not args.call_id.startswith("fc-") or len(args.call_id) > 128:
        raise ValueError("invalid Modal function call id")

    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    call = modal.FunctionCall.from_id(args.call_id)
    try:
        result = call.get(timeout=args.timeout)
    except TimeoutError:
        result = {"status": "pending", "provider_call_id": args.call_id}
    record = {
        "format": "myth-maker.modal-function-call-observation/v1",
        "provider_call_id": args.call_id,
        "status": "pending" if result.get("status") == "pending" else "completed",
        "result": result,
    }
    output.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
