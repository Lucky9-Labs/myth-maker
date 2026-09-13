#!/usr/bin/env python3
"""Verify cloud GUI-worker artifacts against their provider receipt."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def assignments(values: list[str]) -> dict[str, str]:
    result = {}
    for value in values:
        name, separator, path = value.partition("=")
        if not separator or not name or not path or name in result:
            raise ValueError("artifact assignments must be unique NAME=PATH values")
        result[name] = path
    return result


def verify(receipt_path: Path, artifact_dir: Path, outputs: dict[str, str], frames: dict[str, str]) -> dict:
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    order = receipt.get("work_order") or {}
    provider = (receipt.get("worker_state") or {}).get("provider_receipt") or {}
    provider_name = provider.get("provider")
    trusted_provider = provider_name == "modal" or (
        provider_name == "github-actions"
        and provider.get("repository") == "Lucky9-Labs/myth-maker"
        and re.fullmatch(r"[a-f0-9]{40}", provider.get("source_sha", ""))
    )
    if not trusted_provider or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", order.get("work_id", "")):
        raise ValueError("not a provider-observed cloud GUI animation receipt")
    verified = {}
    for kind, requested, metadata_by_name in (
        ("output", outputs, provider.get("output_artifacts") or {}),
        ("frame", frames, provider.get("blender_window_frames") or {}),
    ):
        for name, relative_path in requested.items():
            metadata = metadata_by_name.get(name)
            path = artifact_dir / relative_path
            if not isinstance(metadata, dict) or not path.is_file():
                raise ValueError(f"missing provider artifact: {kind}:{name}")
            observed = {"bytes": path.stat().st_size, "sha256": digest(path)}
            if observed != {"bytes": metadata.get("bytes"), "sha256": metadata.get("sha256")}:
                raise ValueError(f"provider artifact mismatch: {kind}:{name}")
            verified[f"{kind}:{name}"] = {"uri": metadata.get("uri"), **observed}
    result = {
        "format": "myth-maker.cloud-gui-animation-verification/v1",
        "work_id": order["work_id"],
        "provider": provider_name,
        "source_sha": provider.get("source_sha"),
        "function_call_id": provider.get("function_call_id"),
        "verified_artifacts": verified,
    }
    (artifact_dir / "verification.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    parser.add_argument("--output", action="append", default=[])
    parser.add_argument("--frame", action="append", default=[])
    args = parser.parse_args()
    print(json.dumps(verify(args.receipt, args.artifact_dir, assignments(args.output), assignments(args.frame)), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
