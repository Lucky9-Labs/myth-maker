"""Acceptance tests for the automated-policy Blender-source to GLB importer seam."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest


MODAL_DIR = Path(__file__).parents[1] / "modal"
sys.path.insert(0, str(MODAL_DIR))

from encounter_worker_adapter import HashAddressedArtifact, SourceArtifactReceipt
from glb_source_importer import (BlenderCliGlbConverter, GlbSourceImporter,
                                 validate_glb_v1_profile)


class FixtureConverter:
    """Test-only GLB producer; it is not a Blender-source conversion claim."""

    def convert(self, source_bytes):
        if not source_bytes:
            raise ValueError("source is empty")
        return fixture_glb({
            "asset": {"version": "2.0", "generator": "myth-maker-test-fixture"},
            "scene": 0, "scenes": [{"nodes": [0]}],
            "nodes": [{"name": "encounter-origin"}], "materials": [{"name": "standard"}],
        })


def fixture_glb(document, binary=b""):
    encoded = json.dumps(document, sort_keys=True, separators=(",", ":")).encode("utf-8")
    encoded += b" " * ((4 - len(encoded) % 4) % 4)
    chunks = struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
    if binary:
        binary += b"\0" * ((4 - len(binary) % 4) % 4)
        chunks += struct.pack("<II", len(binary), 0x004E4942) + binary
    return struct.pack("<4sII", b"glTF", 2, 12 + len(chunks)) + chunks


class GlbSourceImporterTests(unittest.TestCase):
    def setUp(self):
        self.source = b"BLENDER-v520" + b"source" * 16
        self.source_sha256 = hashlib.sha256(self.source).hexdigest()
        self.receipt = SourceArtifactReceipt(
            work_id="arena-body-draft", worker_id="modal-blender-1",
            created_at="2026-09-08T18:00:00Z", native_name="arena-body-draft.blend",
            artifact=HashAddressedArtifact(
                uri="sha256:" + self.source_sha256, sha256=self.source_sha256,
                media_type="application/x-blender", byte_length=len(self.source)),
            parent_module_ids=("arena-envelope",),
        )
        self.host = {
            "schema_version": "1", "host_id": "mech-demo", "host_build": "2026.09.08",
            "platform": "linux", "scripting_backend": "il2cpp",
            "execution_kinds": ["runtime_asset"], "loaders": ["gltf", "urp"],
            "contracts": ["encounter-module.v1"],
            "limits": {"memory_mb": 2048, "preload_seconds": 30, "artifact_bytes": 100000},
        }
        self.target = {
            "platform": "linux",
            "loader": {"id": "gltf", "version": "2.0"},
            "render_pipeline": {"id": "urp", "version": "17"},
            "material_allowlist": ["standard"],
            "extension_allowlist": [],
        }
        self.module = {
            "module_id": "arena-body-glb", "revision": 1,
            "provides": ["encounter.body"], "requires": ["encounter-module.v1"],
            "conflicts": [], "quality": {"tier": 1, "score": 2.5},
            "fallback_module_ids": ["baseline-arena-body"],
        }

    def importer(self, converter=None):
        return GlbSourceImporter(converter or FixtureConverter(),
                                 clock=lambda: datetime(2026, 9, 8, 20, tzinfo=timezone.utc))

    def test_accepted_automated_validation_converts_to_a_self_contained_runtime_asset(self):
        result = self.importer().import_validated(
            source_receipt=self.receipt, source_bytes=self.source,
            host_capabilities=self.host, target=self.target, module=self.module,
            named_anchors=[{"name": "encounter-origin", "node": "encounter-origin"}],
            bounds={"minimum": [-1, 0, -1], "maximum": [1, 2, 1]},
        )

        self.assertEqual(result.runtime_asset["execution_kind"], "runtime_asset")
        self.assertEqual(hashlib.sha256(result.glb_bytes).hexdigest(),
                         result.runtime_asset["artifact"]["sha256"])
        self.assertEqual(result.runtime_asset["artifact"]["media_type"], "model/gltf-binary")
        self.assertEqual(result.runtime_asset["provides"], ["encounter.body"])
        self.assertEqual(result.runtime_asset["compatibility"]["bindings"], {"gltf": "2.0", "urp": "17"})
        self.assertEqual(result.runtime_asset["fallback_module_ids"], ["baseline-arena-body"])
        self.assertEqual(result.loader_profile["profile"], "glb.v1")
        self.assertEqual(result.loader_profile["artifact"], result.runtime_asset["artifact"])
        self.assertEqual(result.loader_profile["byte_cap"], 100000)
        self.assertEqual(result.loader_profile["named_anchors"],
                         [{"name": "encounter-origin", "node": "encounter-origin"}])
        self.assertEqual(result.loader_profile["provenance"]["source_receipt"], self.receipt.to_record())
        acceptance = result.loader_profile["provenance"]["acceptance"]
        self.assertEqual(acceptance["actor_kind"], "automated_validator")
        self.assertEqual(acceptance["policy_id"], "blender-export-v1")
        self.assertEqual(acceptance["source_sha256"], self.source_sha256)
        self.assertTrue(all(item["result"] == "passed" for item in acceptance["evidence"]))
        self.assertNotIn("collision", result.loader_profile)
        self.assertNotIn("navigation", result.loader_profile)

    def test_loader_profile_is_closed_and_rejects_gameplay_fields(self):
        result = self.importer().import_validated(
            source_receipt=self.receipt, source_bytes=self.source,
            host_capabilities=self.host, target=self.target, module=self.module,
            named_anchors=[], bounds={"minimum": [0, 0, 0], "maximum": [1, 1, 1]})
        validate_glb_v1_profile(result.loader_profile)
        with self.assertRaisesRegex(ValueError, "invalid shape"):
            validate_glb_v1_profile({**result.loader_profile, "collision": "invented"})
        bad = {**result.loader_profile, "provenance": {**result.loader_profile["provenance"],
               "acceptance": {**result.loader_profile["provenance"]["acceptance"], "source_sha256": "0" * 64}}}
        with self.assertRaisesRegex(ValueError, "not bound"):
            validate_glb_v1_profile(bad)

    def test_rejects_corrupt_source_or_glb_and_oversized_output(self):
        with self.assertRaisesRegex(ValueError, "source hash"):
            self.importer().import_validated(
                source_receipt=self.receipt, source_bytes=self.source + b"changed",
                host_capabilities=self.host, target=self.target, module=self.module,
                named_anchors=[], bounds={"minimum": [0, 0, 0], "maximum": [1, 1, 1]})

        with self.assertRaisesRegex(ValueError, "GLB"):
            self.importer(lambda _: b"not-a-glb").import_validated(
                source_receipt=self.receipt, source_bytes=self.source,
                host_capabilities=self.host, target=self.target, module=self.module,
                named_anchors=[], bounds={"minimum": [0, 0, 0], "maximum": [1, 1, 1]})

        tiny_host = {**self.host, "limits": {**self.host["limits"], "artifact_bytes": 16}}
        with self.assertRaisesRegex(ValueError, "byte limit"):
            self.importer().import_validated(
                source_receipt=self.receipt, source_bytes=self.source,
                host_capabilities=tiny_host, target=self.target, module=self.module,
                named_anchors=[], bounds={"minimum": [0, 0, 0], "maximum": [1, 1, 1]})

    def test_rejects_incompatible_target_before_emitting_candidate(self):
        incompatible_host = {**self.host, "loaders": ["gltf"]}
        with self.assertRaisesRegex(ValueError, "render pipeline"):
            self.importer().import_validated(
                source_receipt=self.receipt, source_bytes=self.source,
                host_capabilities=incompatible_host, target=self.target, module=self.module,
                named_anchors=[], bounds={"minimum": [0, 0, 0], "maximum": [1, 1, 1]})

    def test_rejects_malformed_glb_ranges_and_invalid_receipt_provenance(self):
        malformed = fixture_glb({"asset": {"version": "2.0"}, "buffers": [{"byteLength": 4}],
                                 "bufferViews": [{"buffer": 0, "byteOffset": 999, "byteLength": 4}]}, b"1234")
        with self.assertRaisesRegex(ValueError, "buffer view"):
            self.importer(lambda _: malformed).import_validated(
                source_receipt=self.receipt, source_bytes=self.source,
                host_capabilities=self.host, target=self.target, module=self.module,
                named_anchors=[], bounds={"minimum": [0, 0, 0], "maximum": [1, 1, 1]})
        invalid_receipt = SourceArtifactReceipt(
            work_id="arena-body-draft", worker_id="modal-blender-1", created_at="not-a-time",
            native_name="arena-body-draft.blend", artifact=self.receipt.artifact,
            parent_module_ids=("arena-envelope",))
        with self.assertRaisesRegex(ValueError, "source receipt"):
            self.importer().import_validated(
                source_receipt=invalid_receipt, source_bytes=self.source,
                host_capabilities=self.host, target=self.target, module=self.module,
                named_anchors=[], bounds={"minimum": [0, 0, 0], "maximum": [1, 1, 1]})

    @unittest.skipUnless(BlenderCliGlbConverter.discover(), "Blender CLI is unavailable")
    def test_real_blender_cli_exports_a_deterministic_fixture(self):
        executable = BlenderCliGlbConverter.discover()
        with tempfile.TemporaryDirectory(prefix="myth-maker-blender-fixture-") as directory:
            source_path = Path(directory) / "fixture.blend"
            expression = (
                "import bpy; "
                "bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False); "
                "bpy.ops.mesh.primitive_cube_add(size=1); "
                "obj=bpy.context.object; obj.name='encounter-origin'; "
                "mat=bpy.data.materials.new('standard'); obj.data.materials.append(mat); "
                f"bpy.ops.wm.save_as_mainfile(filepath={str(source_path)!r})"
            )
            completed = subprocess.run(
                [str(executable), "--background", "--factory-startup", "--python-expr", expression],
                capture_output=True, text=True, timeout=60, check=False)
            self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
            source = source_path.read_bytes()
        source_sha256 = hashlib.sha256(source).hexdigest()
        receipt = SourceArtifactReceipt(
            work_id="real-arena", worker_id="blender-cli", created_at="2026-09-08T18:00:00Z",
            native_name="real-arena.blend",
            artifact=HashAddressedArtifact("sha256:" + source_sha256, source_sha256,
                                           "application/x-blender", len(source)),
            parent_module_ids=())
        converter = BlenderCliGlbConverter(executable)
        result = self.importer(converter).import_validated(
            source_receipt=receipt, source_bytes=source,
            host_capabilities=self.host, target=self.target, module=self.module,
            named_anchors=[{"name": "encounter-origin", "node": "encounter-origin"}],
            bounds={"minimum": [-1, -1, -1], "maximum": [1, 1, 1]})
        self.assertGreater(len(result.glb_bytes), 20)
        self.assertEqual(result.loader_profile["provenance"]["converter"], "BlenderCliGlbConverter")
        self.assertEqual(result.glb_bytes, converter.convert(source))


if __name__ == "__main__":
    unittest.main()
