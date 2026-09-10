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
    validate_correction_spec,
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
    def test_validates_bounded_parameterized_geometry(self):
        spec = {"version": "myth-maker.geometry-correction/v1", "commands": [{"op": "add-side-wedge",
            "name": "shin-panel-left", "owner": "receiver", "profile": [[0, 0], [1, 0], [0, 1]],
            "thickness": .1, "material": "armor-white"}]}
        self.assertEqual(validate_correction_spec(spec), spec)
        invalid = json.loads(json.dumps(spec)); invalid["commands"][0]["thickness"] = 99
        with self.assertRaisesRegex(ValueError, "add-side-wedge"): validate_correction_spec(invalid)

    def test_validates_mount_relative_component_construction(self):
        spec = {"version": "myth-maker.geometry-correction/v1", "commands": [
            {"op": "add-mounted-box", "name": "thigh-shell-l", "owner": "mount-upperleg-l",
             "location": [0, 0, 0], "dimensions": [.6, .5, 1.4], "material": "structural"},
            {"op": "add-mounted-side-wedge", "name": "shin-facet-l", "owner": "mount-lowerleg-l",
             "profile": [[-.3, .6], [.3, .5], [.22, -.6], [-.22, -.7]],
             "thickness": .45, "material": "armor-white"}]}
        self.assertEqual(validate_correction_spec(spec), spec)

    def test_validates_bounded_mounted_arc_shell(self):
        spec = {"version": "myth-maker.geometry-correction/v1", "commands": [
            {"op": "add-mounted-arc-shell", "name": "cockpit-rim", "owner": "mount-cockpit",
             "location": [0, 0, 0], "inner_radius": .8, "outer_radius": 1.05,
             "start_degrees": 20, "end_degrees": 160, "segments": 12,
             "thickness": .35, "material": "armor-blue"}]}
        self.assertEqual(validate_correction_spec(spec), spec)
        for key, value in (("segments", 33), ("inner_radius", 2)):
            invalid = json.loads(json.dumps(spec)); invalid["commands"][0][key] = value
            with self.assertRaisesRegex(ValueError, "add-mounted-arc-shell"):
                validate_correction_spec(invalid)

    def test_validates_bounded_mounted_frame(self):
        spec = {"version": "myth-maker.geometry-correction/v1", "commands": [
            {"op": "add-mounted-frame", "name": "stock-frame", "owner": "receiver",
             "location": [0, 0, 0], "profile": [[-2.4, .35], [-.8, .28], [-1.0, -.3], [-2.3, -.35]],
             "bar_width": .12, "thickness": .45, "closed": True, "material": "structural"}]}
        self.assertEqual(validate_correction_spec(spec), spec)
        invalid = json.loads(json.dumps(spec)); invalid["commands"][0]["bar_width"] = 0
        with self.assertRaisesRegex(ValueError, "add-mounted-frame"):
            validate_correction_spec(invalid)

    def test_validates_material_reassignment(self):
        spec = {"version": "myth-maker.geometry-correction/v1", "commands": [
            {"op": "set-material", "name": "armor-torso", "material": "structural"}]}
        self.assertEqual(validate_correction_spec(spec), spec)
        invalid = json.loads(json.dumps(spec)); invalid["commands"][0]["material"] = "unknown"
        with self.assertRaisesRegex(ValueError, "set-material"): validate_correction_spec(invalid)

    def test_validates_atomic_prefix_hide_and_large_rebuild(self):
        commands = [{"op": "hide-prefix", "name": "rail-housing-"}]
        commands.extend({"op": "hide", "name": f"legacy-part-{index}"} for index in range(24))
        spec = {"version": "myth-maker.geometry-correction/v1", "commands": commands}
        self.assertEqual(validate_correction_spec(spec), spec)
        invalid = {"version": spec["version"], "commands": [{"op": "hide-prefix", "name": "x"}]}
        with self.assertRaisesRegex(ValueError, "hide-prefix"):
            validate_correction_spec(invalid)

    def test_validates_bounded_parent_transform(self):
        spec = {"version": "myth-maker.geometry-correction/v1", "commands": [
            {"op": "translate", "name": "mount-hip-l", "delta": [.15, 0, 0]},
            {"op": "rotate-degrees", "name": "mount-upperleg-l", "delta": [0, -15, 0]}]}
        self.assertEqual(validate_correction_spec(spec), spec)
        invalid = json.loads(json.dumps(spec)); invalid["commands"][1]["delta"] = [0, -181, 0]
        with self.assertRaisesRegex(ValueError, "transform"): validate_correction_spec(invalid)

    def test_blender_52_driver_uses_current_eevee_engine_name(self):
        driver = (MODAL_DIR / "asset_production_blender.py").read_text(encoding="utf-8")
        self.assertIn('scene.render.engine = "BLENDER_EEVEE"', driver)
        self.assertNotIn('scene.render.engine = "BLENDER_EEVEE_NEXT"', driver)
        self.assertIn('scene.world = bpy.data.worlds.new("asset-review-world")', driver)
        self.assertIn("def isolate_worker_ownership", driver)
        self.assertIn("def apply_reference_corrections", driver)
        self.assertIn("def _mount_created", driver)
        self.assertIn('command["op"] == "add-mounted-box"', driver)
        self.assertIn('command["op"] == "add-mounted-arc-shell"', driver)
        self.assertIn('command["op"] == "add-mounted-frame"', driver)
        self.assertIn('command["op"] == "hide-prefix"', driver)
        self.assertIn('shader.inputs.get("Transmission Weight")', driver)
        self.assertIn('material.surface_render_method = "DITHERED"', driver)
        self.assertIn("def _add_polyline_frame", driver)
        self.assertIn('REFERENCE_CORRECTION_BATCH = "raptor-reference-batch/v5"', driver)
        self.assertIn('"frame-foot-toe"', driver)
        self.assertIn('"bow-blade-upper"', driver)
        self.assertIn("reference correction batch matched no owned geometry", driver)
        self.assertIn("def mount_railgun_to_mech", driver)
        self.assertIn('obj["asset_source_lane"]', driver)
        self.assertIn('obj.get("asset_source_lane") != "c"', driver)
        self.assertIn('job["job_type"] == "railgun" and view == "side"', driver)
        self.assertIn('camera_data.ortho_scale = max(height, width / aspect, 0.1) * 1.12', driver)
        self.assertIn('bpy.context.view_layer.update()', driver)
        self.assertIn('bpy.data.objects.remove(old_camera, do_unlink=True)', driver)
        self.assertIn('camera_data.shift_y = 0', driver)
        self.assertIn('camera.matrix_world.to_quaternion() @ Vector((mid_x, mid_y, 0))', driver)
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
            corrected = prepare_correction_wave(root, {"source_sha": "c" * 40, "function_id": "fu-next"},
                                                apply_reference_batch=True, reference_batch_slot="worker-c")
            self.assertEqual([item["attempt"] for item in corrected], [4, 4, 4, 4])
            self.assertTrue(all({"kind": "apply-reference-corrections"} not in item["operations"] for item in corrected[:2]))
            self.assertIn({"kind": "apply-reference-corrections"}, corrected[2]["operations"])
            self.assertEqual(corrected[0]["inputs"][0]["sha256"], "1" * 64)

            spec = {"version": "myth-maker.geometry-correction/v1", "commands": [
                {"op": "rotate-degrees", "name": "mount-upperleg-l", "delta": [0, -15, 0]}]}
            coordinated = prepare_correction_wave(root, {"source_sha": "e" * 40, "function_id": "fu-pose"},
                                                   reference_batch_slot="worker-a+worker-b", correction_spec=spec)
            self.assertTrue(all({"kind": "apply-parameterized-correction"} in item["operations"]
                                and item["correction_spec"] == spec for item in coordinated[:2]))
            self.assertNotIn("correction_spec", coordinated[2])

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

    def test_correction_wave_does_not_replay_parameterized_patch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); wave = [job("worker-a", "mech-structure"), job("worker-b", "mech-armor"),
                                             job("worker-c", "railgun"), job("worker-d", "core-kit")]
            for index, item in enumerate(wave):
                if item["worker_slot"] == "worker-a":
                    item["operations"].append({"kind": "apply-parameterized-correction"})
                    item["correction_spec"] = {"version": "myth-maker.geometry-correction/v1",
                        "commands": [{"op": "lengthen", "name": "frame-leg", "factor": 1.1}]}
                attempt = root / item["work_id"] / "attempt-0001"; attempt.mkdir(parents=True)
                (attempt / "job.json").write_text(json.dumps(item))
                receipt = {"worker_slot": item["worker_slot"], "work_id": item["work_id"], "attempt": 1,
                    "status": "completed", "artifacts": {"asset.blend": {"volume_path": f"x/{index}.blend",
                    "bytes": 10, "sha256": str(index + 1) * 64}}}
                (attempt / "receipt.json").write_text(json.dumps(receipt))
            next_wave = prepare_correction_wave(root, {"source_sha": "e" * 40, "function_id": "fu-clean"})
            self.assertNotIn({"kind": "apply-parameterized-correction"}, next_wave[0]["operations"])
            self.assertNotIn("correction_spec", next_wave[0])

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

    def test_correction_wave_promotes_best_scored_components_instead_of_latest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wave = [job("worker-a", "mech-structure"), job("worker-b", "mech-armor"),
                    job("worker-c", "railgun"), job("worker-d", "core-kit")]
            hashes = {"worker-a": "1" * 64, "worker-b": "2" * 64, "worker-c": "3" * 64}
            for item in wave:
                attempt = root / item["work_id"] / "attempt-0001"; attempt.mkdir(parents=True)
                stored = dict(item)
                if item["worker_slot"] == "worker-d":
                    stored["dependencies"] = list(hashes.values())
                    stored["inputs"] = [{"path": f"ingest/{slot}.blend", "bytes": 100, "sha256": digest,
                                         "media_type": "application/x-blender", "staged_name": f"{slot}.blend"}
                                        for slot, digest in hashes.items()]
                    stored["inputs"].append(artifact("ingest/reference.png", b"PNG-reference", "image/png"))
                (attempt / "job.json").write_text(json.dumps(stored))
                native = hashes.get(item["worker_slot"], "4" * 64)
                artifacts = {"asset.blend": {"volume_path": f"asset-production/run/{item['work_id']}/asset.blend",
                    "bytes": 100, "sha256": native}}
                if item["worker_slot"] == "worker-c": artifacts["renders/side.png"] = {"sha256": "c" * 64}
                if item["worker_slot"] == "worker-d": artifacts["renders/full-body.png"] = {"sha256": "d" * 64}
                (attempt / "receipt.json").write_text(json.dumps({"worker_slot": item["worker_slot"],
                    "work_id": item["work_id"], "attempt": 1, "status": "completed", "artifacts": artifacts}))
            # Newer C exists but scored evaluation promotes attempt 1.
            cjob = wave[2]; newer = root / cjob["work_id"] / "attempt-0002"; newer.mkdir()
            (newer / "job.json").write_text(json.dumps(cjob))
            (newer / "receipt.json").write_text(json.dumps({"worker_slot": "worker-c", "work_id": cjob["work_id"],
                "attempt": 2, "status": "completed", "artifacts": {"asset.blend": {
                    "volume_path": "asset-production/run/c/new.blend", "bytes": 100, "sha256": "5" * 64},
                    "renders/side.png": {"sha256": "e" * 64}}}))
            evaluations = root / "observability" / "evaluations"; evaluations.mkdir(parents=True)
            (evaluations / "latest.json").write_text(json.dumps({"status": "completed", "created_at": "2026-09-10T00:00:00Z",
                "evaluation": {"evaluations": [
                    {"asset_id": "mech", "render_sha256": "d" * 64, "weighted_score": 40},
                    {"asset_id": "railgun", "render_sha256": "c" * 64, "weighted_score": 50},
                    {"asset_id": "railgun", "render_sha256": "e" * 64, "weighted_score": 45}]}}))
            promoted = prepare_correction_wave(root, {"source_sha": "a" * 40, "function_id": "fu-promote"})
            self.assertEqual(promoted[2]["inputs"][0]["sha256"], "3" * 64)
            self.assertEqual(promoted[0]["inputs"][0]["sha256"], "1" * 64)
            self.assertNotIn({"kind": "apply-reference-corrections"}, promoted[2]["operations"])

    def test_correction_wave_does_not_promote_candidate_below_three_point_gain(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            railgun = job("worker-c", "railgun")
            for attempt_number, native, render in ((1, "3" * 64, "c" * 64), (2, "5" * 64, "e" * 64)):
                attempt = root / railgun["work_id"] / f"attempt-{attempt_number:04d}"; attempt.mkdir(parents=True)
                (attempt / "job.json").write_text(json.dumps(railgun))
                (attempt / "receipt.json").write_text(json.dumps({"worker_slot": "worker-c",
                    "work_id": railgun["work_id"], "attempt": attempt_number, "status": "completed",
                    "artifacts": {"asset.blend": {"volume_path": f"asset-production/run/c/{attempt_number}.blend",
                    "bytes": 100, "sha256": native}, "renders/side.png": {"sha256": render}}}))
            evaluations = root / "observability" / "evaluations"; evaluations.mkdir(parents=True)
            (evaluations / "latest.json").write_text(json.dumps({"status": "completed", "created_at": "2026-09-10T01:00:00Z",
                "evaluation": {"evaluations": [
                    {"asset_id": "railgun", "render_sha256": "c" * 64, "weighted_score": 56.0},
                    {"asset_id": "railgun", "render_sha256": "e" * 64, "weighted_score": 58.7}]}}))
            from asset_production import _best_scored_baselines
            receipts = [(path, json.loads(path.read_text())) for path in root.glob("*/attempt-*/receipt.json")]
            promoted = _best_scored_baselines(root, receipts)
            self.assertEqual(promoted["worker-c"][1]["artifacts"]["asset.blend"]["sha256"], "3" * 64)

    def test_baseline_resolution_retains_accepted_lineage_when_latest_baseline_was_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            railgun = job("worker-c", "railgun")
            receipts = []
            for attempt_number, native, render in ((1, "1" * 64, "a" * 64), (2, "2" * 64, "b" * 64),
                                                    (3, "3" * 64, "c" * 64), (4, "4" * 64, "d" * 64)):
                attempt = root / railgun["work_id"] / f"attempt-{attempt_number:04d}"; attempt.mkdir(parents=True)
                stored = dict(railgun)
                if attempt_number > 1: stored["correction_spec"] = {"version": "myth-maker.geometry-correction/v1", "commands": [{"op": "scale", "name": "receiver", "scale": [1, 1, 1]}]}
                (attempt / "job.json").write_text(json.dumps(stored))
                receipt = {"worker_slot": "worker-c", "work_id": railgun["work_id"], "attempt": attempt_number,
                    "status": "completed", "artifacts": {"asset.blend": {"volume_path": f"run/{attempt_number}.blend",
                    "bytes": 100, "sha256": native}, "renders/side.png": {"sha256": render}}}
                (attempt / "receipt.json").write_text(json.dumps(receipt)); receipts.append((attempt / "receipt.json", receipt))
            evaluations = root / "observability" / "evaluations"; evaluations.mkdir(parents=True)
            for name, created, rows in (
                ("accepted", "2026-09-10T00:01:00Z", [("a", 40), ("b", 44)]),
                ("rejected", "2026-09-10T00:02:00Z", [("b", 50), ("c", 51)]),
                ("wrong", "2026-09-10T00:03:00Z", [("c", 60), ("d", 61)])):
                (evaluations / f"{name}.json").write_text(json.dumps({"status": "completed", "created_at": created,
                    "evaluation": {"evaluations": [{"asset_id": "railgun", "render_sha256": digest * 64,
                    "weighted_score": score} for digest, score in rows]}}))
            from asset_production import _best_scored_baselines
            promoted = _best_scored_baselines(root, receipts)
            self.assertEqual(promoted["worker-c"][1]["artifacts"]["asset.blend"]["sha256"], "2" * 64)


if __name__ == "__main__":
    unittest.main()
