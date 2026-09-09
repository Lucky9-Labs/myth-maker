"""Emit a test-only GLB importer result for the JavaScript assembler contract test."""
from __future__ import annotations

from datetime import datetime, timezone
import argparse
import base64
import hashlib
import json
from pathlib import Path
import struct
import sys


MODAL_DIR = Path(__file__).parents[1] / "modal"
sys.path.insert(0, str(MODAL_DIR))

from encounter_worker_adapter import HashAddressedArtifact, SourceArtifactReceipt
from glb_source_importer import GlbSourceImporter, validate_glb_v1_profile


class FixtureConverter:
    def convert(self, source_bytes):
        document = {"asset": {"version": "2.0"}, "nodes": [{"name": "encounter-origin"}],
                    "materials": [{"name": "standard"}]}
        encoded = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
        encoded += b" " * ((4 - len(encoded) % 4) % 4)
        return struct.pack("<4sII", b"glTF", 2, 20 + len(encoded)) + struct.pack(
            "<II", len(encoded), 0x4E4F534A) + encoded


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--malformed-profile", action="store_true")
    parser.add_argument("--malformed-module", action="store_true")
    args = parser.parse_args()
    source = b"BLENDER-v520-test-fixture"
    digest = hashlib.sha256(source).hexdigest()
    receipt = SourceArtifactReceipt(
        work_id="glb-fixture", worker_id="blender-validator", created_at="2026-09-08T18:00:00Z",
        native_name="glb-fixture.blend",
        artifact=HashAddressedArtifact("sha256:" + digest, digest, "application/x-blender", len(source)),
        parent_module_ids=())
    host = {"schema_version": "1", "host_id": "glb-host", "host_build": "1.0.0",
            "platform": "linux", "scripting_backend": "il2cpp", "execution_kinds": ["recipe", "runtime_asset"],
            "loaders": ["gltf", "urp"], "contracts": ["encounter-module.v1"],
            "limits": {"memory_mb": 1024, "preload_seconds": 10, "artifact_bytes": 100000}}
    result = GlbSourceImporter(FixtureConverter(), clock=lambda: datetime(2026, 9, 8, 20, tzinfo=timezone.utc)).import_validated(
        source_receipt=receipt, source_bytes=source, host_capabilities=host,
        target={"platform": "linux", "loader": {"id": "gltf", "version": "2.0"},
                "render_pipeline": {"id": "urp", "version": "17"}, "material_allowlist": ["standard"],
                "extension_allowlist": []},
        module={"module_id": "glb-candidate", "revision": 1, "provides": ["encounter.body"],
                "requires": ["encounter-module.v1"], "conflicts": [],
                "quality": {"tier": 1, "score": 2}, "fallback_module_ids": ["baseline-body"]},
        named_anchors=[{"name": "encounter-origin", "node": "encounter-origin"}],
        bounds={"minimum": [-1, -1, -1], "maximum": [1, 1, 1]})
    profile = dict(result.loader_profile)
    module = dict(result.runtime_asset)
    if args.malformed_profile:
        profile["collision"] = "forbidden"
        validate_glb_v1_profile(profile)
    if args.malformed_module:
        module["undeclared"] = "forbidden"
    print(json.dumps({"host": host, "profile": profile, "module": module,
                      "glb_bytes_base64": base64.b64encode(result.glb_bytes).decode("ascii")}, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
