"""Closed, immutable references to draft inputs already stored on a Modal Volume."""
from __future__ import annotations

import hashlib
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
import re
from typing import Any

SHA256 = re.compile(r"^[a-f0-9]{64}$")
REQUIRED_INPUTS = {
    "source_scene.blend", "structure_reference.png", "component_reference.png",
    "primary_artwork.png", "concept_reference.png",
}


def validate_volume_input_manifest(value: Any, *, expected_volume: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or set(value) != {"schema_version", "volume_name", "input_root", "files"}:
        raise ValueError("volume input manifest does not match the closed v1 shape")
    if value.get("schema_version") != "1" or value.get("volume_name") != expected_volume:
        raise ValueError("volume input manifest identity mismatch")
    root = value.get("input_root")
    path = PurePosixPath(root) if isinstance(root, str) else None
    if not path or path.is_absolute() or ".." in path.parts or "." in path.parts:
        raise ValueError("input_root must be a safe relative Modal Volume path")
    files = value.get("files")
    if not isinstance(files, Mapping) or set(files) != REQUIRED_INPUTS:
        raise ValueError("volume input manifest must name exactly the required draft inputs")
    for name, record in files.items():
        if (not isinstance(record, Mapping) or set(record) != {"sha256", "bytes"}
                or not isinstance(record.get("sha256"), str) or not SHA256.fullmatch(record["sha256"])
                or not isinstance(record.get("bytes"), int) or isinstance(record["bytes"], bool) or record["bytes"] <= 0):
            raise ValueError(f"invalid immutable input record for {name}")
    return {"schema_version": "1", "volume_name": value["volume_name"], "input_root": str(path),
            "files": {name: dict(record) for name, record in files.items()}}


def load_volume_inputs(value: Any, submissions_root: Path, *, expected_volume: str) -> dict[str, bytes]:
    manifest = validate_volume_input_manifest(value, expected_volume=expected_volume)
    root = submissions_root.joinpath(*PurePosixPath(manifest["input_root"]).parts)
    result: dict[str, bytes] = {}
    for name, record in manifest["files"].items():
        data = (root / name).read_bytes()
        if len(data) != record["bytes"]:
            raise ValueError(f"Modal Volume input length mismatch for {name}")
        if hashlib.sha256(data).hexdigest() != record["sha256"]:
            raise ValueError(f"Modal Volume input hash mismatch for {name}")
        result[name] = data
    return result
