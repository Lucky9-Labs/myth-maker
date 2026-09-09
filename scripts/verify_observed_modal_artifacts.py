#!/usr/bin/env python3
"""Verify bytes downloaded from Modal's private Volume against its receipt."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(receipt_path: Path, artifact_dir: Path) -> dict:
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    provider = receipt.get("provider_receipt", {})
    format_ = receipt.get("format")
    if format_ not in {"myth-maker.observed-modal-blender-demo/v1", "myth-maker.observed-modal-deterministic-demo/v1"} or provider.get("provider") != "modal":
        raise ValueError("not an observed Modal Blender receipt")
    if format_ == "myth-maker.observed-modal-deterministic-demo/v1":
        expected = {
            "source": provider.get("output_artifacts", {}).get(receipt.get("work_id", "") + ".blend"),
            "glb": provider.get("output_artifacts", {}).get(receipt.get("work_id", "") + ".glb"),
            "initial": provider.get("blender_window_frames", {}).get("initial"),
            "intermediate": provider.get("blender_window_frames", {}).get("intermediate"),
            "final": provider.get("blender_window_frames", {}).get("final"),
        }
        local = {
            "source": artifact_dir / "source.blend", "glb": artifact_dir / "encounter.glb",
            "initial": artifact_dir / "initial.png", "intermediate": artifact_dir / "intermediate.png",
            "final": artifact_dir / "final.png",
        }
    else:
        expected = {
            "source": provider.get("output_artifacts", {}).get(receipt.get("work_id", "") + ".blend"),
            "preview": provider.get("output_artifacts", {}).get(receipt.get("work_id", "") + "_preview.png"),
            "initial": provider.get("blender_window_frames", {}).get("initial"),
            "latest": provider.get("blender_window_frames", {}).get("latest"),
            "final": provider.get("blender_window_frames", {}).get("final"),
        }
        local = {
            "source": artifact_dir / "source.blend", "preview": artifact_dir / "preview.png",
            "initial": artifact_dir / "initial.png", "latest": artifact_dir / "latest.png",
            "final": artifact_dir / "final.png",
        }
    verified = {}
    for label, metadata in expected.items():
        path = local[label]
        if not isinstance(metadata, dict) or not path.is_file():
            raise ValueError(f"missing provider artifact: {label}")
        actual = {"bytes": path.stat().st_size, "sha256": digest(path)}
        if actual["bytes"] != metadata.get("bytes") or actual["sha256"] != metadata.get("sha256"):
            raise ValueError(f"provider artifact hash mismatch: {label}")
        verified[label] = {"uri": metadata.get("uri"), **actual}
    result = {
        "format": "myth-maker.observed-modal-blender-artifact-verification/v1",
        "work_id": receipt["work_id"], "function_call_id": provider["function_call_id"],
        "verified_artifacts": verified,
    }
    (artifact_dir / "verification.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--artifact-dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.receipt, args.artifact_dir), sort_keys=True))
