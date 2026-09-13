#!/usr/bin/env python3
"""Resolve a reviewable animation work ID from its immutable receipt."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("receipt", type=Path)
    parser.add_argument("--prefix", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}-", args.prefix):
        raise ValueError("invalid work ID prefix")
    payload = json.loads(args.receipt.read_text(encoding="utf-8"))
    order = payload.get("work_order") or {}
    state = payload.get("worker_state") or {}
    work_id = order.get("work_id", "")
    if (state.get("status") != "ready_for_review"
            or state.get("part") != work_id
            or not re.fullmatch(re.escape(args.prefix) + r"[0-9]+", work_id)):
        raise RuntimeError("receipt does not contain a reviewable animation work ID")
    print(work_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
