from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import types
import unittest


MODAL_DIR = Path(__file__).parents[1] / "modal"
sys.path.insert(0, str(MODAL_DIR))

from asset_production import (
    manifest_digest,
    job_ledger_entry,
    fan_in_assembly_job,
    create_run_ledger,
    plan_production_wave,
    prepare_correction_wave,
    run_asset_production_job,
    stage_volume_inputs,
    summarize_efficiency,
    validate_job_manifest,
    validate_visual_critique,
)


def artifact(path: str, data: bytes, media_type: str = "application/x-blender") -> dict:
    import hashlib
    return {
        "path": path,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "media_type": media_type,
    }


def job(slot: str = "worker-a", kind: str = "mech-structure") -> dict:
    source = b"BLENDER" + b"x" * 64
    return {
        "format": "myth-maker.asset-production-job/v1",
        "run_id": "raptor-production-001",
        "work_id": f"{slot}-a1",
        "attempt": 1,
        "worker_slot": slot,
        "job_type": kind,
        "source_revision": "a" * 64,
        "runtime_deployment": {"source_sha": "b" * 40, "function_id": "fu-proof"},
        "inputs": [artifact("ingest/source.blend", source),
                   artifact("ingest/reference.png", b"PNG-reference", "image/png")],
        "dependencies": [],
        "operations": [{"kind": name} for name in
                       ("normalize", "apply-core-kit", "render-review", "export-glb", "validate")],
        "review_views": ["full-body", "gameplay-distance"],
        "measurement": {"human_minutes": 0, "provenance": "measured"},
    }


class AssetProductionTests(unittest.TestCase):
    def test_blender_52_driver_uses_current_eevee_engine_name(self):
        driver = (MODAL_DIR / "asset_production_blender.py").read_text(encoding="utf-8")
        self.assertIn('scene.render.engine = "BLENDER_EEVEE"', driver)
        self.assertNotIn('scene.render.engine = "BLENDER_EEVEE_NEXT"', driver)
        self.assertIn('scene.world = bpy.data.worlds.new("asset-review-world")', driver)
        self.assertIn("def isolate_worker_ownership", driver)
        self.assertIn("def apply_reference_corrections", driver)
        self.assertIn("reference correction batch matched no owned geometry", driver)
        self.assertIn("def mount_railgun_to_mech", driver)
        self.assertIn('obj["asset_source_lane"]', driver)
        self.assertIn('obj.get("asset_source_lane") != "c"', driver)
        self.assertIn('job["job_type"] == "railgun" and view == "side"', driver)
        self.assertIn('camera_data.ortho_scale = max(height, width / aspect, 0.1) * 1.12', driver)
        self.assertIn('bpy.context.view_layer.update()', driver)
        self.assertIn('bpy.data.objects.remove(old_camera, do_unlink=True)', driver)
        self.assertIn('camera_data.shift_y = 0', driver)
        self.assertIn('visible = [obj for obj in meshes if not obj.hide_render]', driver)
        self.assertIn('assembly mech coverage collapsed', driver)
        self.assertIn('"review_protocol": REVIEW_PROTOCOL', driver)

    def test_manifest_accepts_bounded_reference_correction_operation(self):
        manifest = job()
        manifest["operations"].append({"kind": "apply-reference-corrections"})
        self.assertIn({"kind": "apply-reference-corrections"}, validate_job_manifest(manifest)["operations"])

    def test_job_manifest_is_closed_and_has_a_stable_digest(self):
        checked = validate_job_manifest(job())
        self.assertEqual(checked["worker_slot"], "worker-a")
        self.assertEqual(manifest_digest(checked), manifest_digest(job()))
        with self.assertRaisesRegex(ValueError, "invalid shape"):
            validate_job_manifest({**job(), "quality_score": 7})
        without_reference = job()
        without_reference["inputs"] = without_reference["inputs"][:1]
        with self.assertRaisesRegex(ValueError, "reference image"):
            validate_job_manifest(without_reference)

    def test_volume_ingestion_verifies_every_immutable_byte(self):
        manifest = job()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "ingest" / "source.blend"
            path.parent.mkdir()
            path.write_bytes(b"BLENDER" + b"x" * 64)
            (root / "ingest" / "reference.png").write_bytes(b"PNG-reference")
            staged = stage_volume_inputs(manifest, root)
            self.assertEqual(staged[0]["sha256"], manifest["inputs"][0]["sha256"])
            path.write_bytes(b"BLENDER" + b"tampered" * 12)
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                stage_volume_inputs(manifest, root)

    def test_first_wave_uses_all_slots_and_only_worker_d_can_assemble(self):
        jobs = [
            job("worker-a", "mech-structure"),
            job("worker-b", "mech-armor"),
            job("worker-c", "railgun"),
            job("worker-d", "core-kit"),
        ]
        wave = plan_production_wave(jobs)
        self.assertEqual([item["worker_slot"] for item in wave],
                         ["worker-a", "worker-b", "worker-c", "worker-d"])
        invalid = job("worker-a", "kit-assembly")
        with self.assertRaisesRegex(ValueError, "sole assembly authority"):
            plan_production_wave([invalid, *jobs[1:]])

    def test_measurement_marks_model_usage_unavailable_until_observed(self):
        checked = validate_job_manifest(job())
        self.assertEqual(checked["measurement"]["model_usage"], {
            "provenance": "unavailable",
            "input_tokens": None,
            "cached_input_tokens": None,
            "output_tokens": None,
        })

    def test_cloud_job_persists_outputs_and_terminal_receipt(self):
        manifest = job()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            volume, submissions = root / "volume", root / "submissions"
            source = volume / "ingest" / "source.blend"
            source.parent.mkdir(parents=True)
            source.write_bytes(b"BLENDER" + b"x" * 64)
            (volume / "ingest" / "reference.png").write_bytes(b"PNG-reference")

            calls = []
            def fake_run(command, **_kwargs):
                calls.append(command)
                output = Path(command[command.index("--output-root") + 1])
                (output / "renders").mkdir(parents=True)
                (output / "asset.blend").write_bytes(b"BLENDER" + b"y" * 64)
                (output / "asset.glb").write_bytes(b"glTF" + b"z" * 64)
                (output / "scene-manifest.json").write_text(json.dumps({"objects": []}))
                (output / "fit-report.json").write_text(json.dumps({"blocking": []}))
                (output / "core-kit-manifest.json").write_text(json.dumps({"version": "v1"}))
                for view in manifest["review_views"]:
                    (output / "renders" / f"{view}.png").write_bytes(b"png")
                return types.SimpleNamespace(returncode=0, stdout="cloud blender", stderr="")

            receipt = run_asset_production_job(
                manifest, volume, submissions, "/usr/local/bin/blender",
                function_call_id="fc-proof", input_id="in-proof", run_command=fake_run,
            )
            self.assertEqual(receipt["status"], "completed")
            self.assertEqual(receipt["execution"]["runtime"], "modal")
            self.assertIn("--python-exit-code", calls[0])
            self.assertEqual(set(receipt["artifacts"]), {
                "asset.blend", "asset.glb", "fit-report.json", "scene-manifest.json", "core-kit-manifest.json",
                "renders/full-body.png", "renders/gameplay-distance.png",
            })
            self.assertTrue((submissions / manifest["run_id"] / manifest["work_id"] / "attempt-0001" / "receipt.json").is_file())
            self.assertEqual(set(job_ledger_entry(receipt)), {
                "work_id", "attempt", "worker_slot", "job_type", "status", "input_hashes",
                "output_hashes", "queue_ms", "execution_ms", "model_usage", "human_minutes",
            })

    def test_failed_cloud_job_is_retained_without_automatic_retry(self):
        manifest = job()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            volume, submissions = root / "volume", root / "submissions"
            source = volume / "ingest" / "source.blend"
            source.parent.mkdir(parents=True)
            source.write_bytes(b"BLENDER" + b"x" * 64)
            (volume / "ingest" / "reference.png").write_bytes(b"PNG-reference")
            failed = lambda *_args, **_kwargs: types.SimpleNamespace(returncode=3, stdout="", stderr="bad scene")
            receipt = run_asset_production_job(
                manifest, volume, submissions, "/usr/local/bin/blender",
                function_call_id="fc-proof", input_id="in-proof", run_command=failed,
            )
            self.assertEqual(receipt["status"], "failed")
            self.assertEqual(receipt["retry"], "new-explicit-attempt-required")
            self.assertIn("bad scene", receipt["failure"]["detail"])

    def test_visual_critique_keeps_actionable_defects_and_backlogs_cosmetics(self):
        critique = validate_visual_critique({
            "format": "myth-maker.asset-visual-critique/v1",
            "defects": [
                {"defect_id": "grip-gap", "component_id": "railgun", "evidence_view": "grip",
                 "observable_problem": "Support hand misses the grip.", "severity": "blocking",
                 "criterion": "weapon-handling", "recommended_correction": "Move support-grip 4 cm aft.",
                 "confidence": 0.96},
                {"defect_id": "tiny-panel", "component_id": "railgun", "evidence_view": "side",
                 "observable_problem": "A small panel could use another bevel.", "severity": "cosmetic",
                 "criterion": "silhouette", "recommended_correction": "Add a bevel.", "confidence": 0.7},
            ],
        })
        self.assertEqual(critique["defects"][0]["disposition"], "accepted")
        self.assertEqual(critique["defects"][1]["disposition"], "backlog")

    def test_efficiency_summary_includes_failed_work_and_preserves_unknown_tokens(self):
        receipts = [
            {"status": "failed", "job_type": "railgun", "execution": {"duration_ms": 1200},
             "measurement": {"human_minutes": 2, "provenance": "measured",
                             "model_usage": {"provenance": "unavailable", "input_tokens": None,
                                             "cached_input_tokens": None, "output_tokens": None}}},
            {"status": "completed", "job_type": "kit-assembly", "execution": {"duration_ms": 800},
             "measurement": {"human_minutes": 0, "provenance": "measured",
                             "model_usage": {"provenance": "measured", "input_tokens": 100,
                                             "cached_input_tokens": 20, "output_tokens": 10}}},
        ]
        summary = summarize_efficiency(receipts)
        self.assertEqual(summary["compute_ms"], {"provenance": "measured", "value": 2000})
        self.assertEqual(summary["core_kit_ms"]["value"], 800)
        self.assertEqual(summary["asset_specific_ms"]["value"], 1200)
        self.assertEqual(summary["input_tokens"], {"provenance": "unavailable", "value": None})

    def test_fan_in_assembly_binds_exact_component_output_hashes(self):
        wave = [job("worker-a", "mech-structure"), job("worker-b", "mech-armor"),
                job("worker-c", "railgun"), job("worker-d", "core-kit")]
        receipts = []
        for index, item in enumerate(wave[:3]):
            digest = str(index + 1) * 64
            receipts.append({"status": "completed", "worker_slot": item["worker_slot"],
                             "artifacts": {"asset.blend": {"volume_path": f"asset-production/run/{index}.blend",
                                                             "bytes": 100 + index, "sha256": digest}}})
        assembly = fan_in_assembly_job(wave, receipts)
        self.assertEqual(assembly["attempt"], 2)
        self.assertEqual(assembly["job_type"], "kit-assembly")
        self.assertEqual(assembly["dependencies"], ["1" * 64, "2" * 64, "3" * 64])
        self.assertIn({"kind": "assemble"}, assembly["operations"])
        self.assertEqual([item["media_type"] for item in assembly["inputs"]].count("image/png"), 1)

    def test_correction_wave_advances_native_baselines_and_adds_real_patch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wave = [job("worker-a", "mech-structure"), job("worker-b", "mech-armor"),
                    job("worker-c", "railgun"), job("worker-d", "core-kit")]
            for index, item in enumerate(wave):
                attempt = root / item["work_id"] / "attempt-0003"; attempt.mkdir(parents=True)
                (attempt / "job.json").write_text(json.dumps(item))
                native = {"volume_path": f"asset-production/run/{item['work_id']}/asset.blend",
                          "bytes": 100 + index, "sha256": str(index + 1) * 64}
                receipt = {"worker_slot": item["worker_slot"], "work_id": item["work_id"], "attempt": 3,
                           "status": "completed", "artifacts": {"asset.blend": native}}
                (attempt / "receipt.json").write_text(json.dumps(receipt))
            corrected = prepare_correction_wave(root, {"source_sha": "c" * 40, "function_id": "fu-next"})
            self.assertEqual([item["attempt"] for item in corrected], [4, 4, 4, 4])
            self.assertTrue(all({"kind": "apply-reference-corrections"} in item["operations"] for item in corrected[:3]))
            self.assertEqual(corrected[0]["inputs"][0]["sha256"], "1" * 64)

            # The next immutable baseline already contains that patch, so the
            # operation is not compounded on a review-only follow-up wave.
            for item in corrected[:3]:
                attempt = root / item["work_id"] / "attempt-0004"; attempt.mkdir(parents=True)
                (attempt / "job.json").write_text(json.dumps(item))
                receipt = {"worker_slot": item["worker_slot"], "work_id": item["work_id"], "attempt": 4,
                           "status": "completed", "artifacts": {"asset.blend": {
                               "volume_path": f"asset-production/run/{item['work_id']}/attempt-4.blend",
                               "bytes": 200, "sha256": str({"worker-a": 5, "worker-b": 6, "worker-c": 7}[item["worker_slot"]]) * 64}}}
                (attempt / "receipt.json").write_text(json.dumps(receipt))
            reviewed = prepare_correction_wave(root, {"source_sha": "d" * 40, "function_id": "fu-review"})
            self.assertTrue(all({"kind": "apply-reference-corrections"} not in item["operations"] for item in reviewed[:3]))

    def test_run_ledger_includes_every_attempt_and_keeps_acceptance_pending(self):
        wave = [job("worker-a", "mech-structure"), job("worker-b", "mech-armor"),
                job("worker-c", "railgun"), job("worker-d", "core-kit")]
        receipts = []
        for item in wave:
            receipts.append({
                "work_id": item["work_id"], "attempt": 1, "worker_slot": item["worker_slot"],
                "job_type": item["job_type"], "status": "completed", "input_hashes": [],
                "output_hashes": [], "queue_ms": {"provenance": "unavailable", "value": None},
                "execution_ms": {"provenance": "measured", "value": 10},
                "execution": {"duration_ms": 10},
                "model_usage": {"provenance": "unavailable", "input_tokens": None,
                                "cached_input_tokens": None, "output_tokens": None},
                "human_minutes": {"provenance": "measured", "value": 0},
                "measurement": {"provenance": "measured", "human_minutes": 0,
                                "model_usage": {"provenance": "unavailable", "input_tokens": None,
                                                "cached_input_tokens": None, "output_tokens": None}},
            })
        ledger = create_run_ledger(wave, receipts)
        self.assertEqual(len(ledger["jobs"]), 4)
        self.assertEqual(ledger["status"], "running")
        self.assertTrue(all(value == "pending" for value in ledger["acceptance"].values()))

        later = create_run_ledger(wave, [receipts[0]], ledger)
        self.assertEqual(len(later["jobs"]), 4)
        self.assertEqual(later["measurement"]["compute_ms"]["value"], 40)
        self.assertEqual(later["started_at"], ledger["started_at"])


if __name__ == "__main__":
    unittest.main()
