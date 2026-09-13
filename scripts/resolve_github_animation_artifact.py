#!/usr/bin/env python3
"""Resolve the latest downloaded workflow artifact across rerun attempts."""
from __future__ import annotations

import argparse
from pathlib import Path
import re


_SAFE_PREFIX = re.compile(r"^[a-z0-9][a-z0-9-]{0,110}$")


def latest_attempt(root: Path, prefix: str) -> dict:
    if not _SAFE_PREFIX.fullmatch(prefix) or not root.is_dir():
        raise FileNotFoundError("no matching GitHub artifact attempt")
    pattern = re.compile(re.escape(prefix) + r"-([1-9][0-9]*)$")
    matches = []
    for path in root.iterdir():
        match = pattern.fullmatch(path.name)
        if path.is_dir() and match:
            matches.append((int(match.group(1)), path.resolve()))
    if not matches:
        raise FileNotFoundError("no matching GitHub artifact attempt")
    attempt, path = max(matches, key=lambda item: item[0])
    return {"attempt": attempt, "path": path}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("prefix")
    parser.add_argument("--field", choices=("path", "attempt"), default="path")
    args = parser.parse_args()
    result = latest_attempt(args.root, args.prefix)
    print(result[args.field])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
