import hashlib, json, sys, tempfile, unittest
from pathlib import Path
from PIL import Image
ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "modal"))
from asset_progress import (build_dashboard, completed_developments, dashboard_bundle, production_observability,
                            reference_evaluation_inputs, reference_progress_history, validate_reference_evaluation)

class AssetProgressTests(unittest.TestCase):
    def _attempt(self, root, work, attempt, job_type, status="completed"):
        path = root / work / f"attempt-{attempt:04d}"
        render = path / "output" / "renders" / ("side.png" if job_type == "railgun" else "full-body.png")
        render.parent.mkdir(parents=True); Image.new("RGB", (32, 24), (attempt * 20, 30, 40)).save(render)
        data = render.read_bytes(); relative = f"renders/{render.name}"
        receipt = {"status": status, "work_id": work, "attempt": attempt, "job_type": job_type,
            "execution": {"completed_at": f"2026-09-09T00:0{attempt}:00+00:00", "duration_ms": attempt * 10},
            "input_hashes": ["a" * 64], "output_hashes": [hashlib.sha256(data).hexdigest()],
            "artifacts": {relative: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}}}
        (path / "receipt.json").write_text(json.dumps(receipt))
        reference = path / "inputs" / "reference.png"; reference.parent.mkdir()
        Image.new("RGB", (32, 24), (5, 6, 7)).save(reference); ref_data = reference.read_bytes()
        (path / "job.json").write_text(json.dumps({"inputs": [{"path": "frozen/reference.png",
            "staged_name": "reference.png", "media_type": "image/png", "bytes": len(ref_data),
            "sha256": hashlib.sha256(ref_data).hexdigest()}]}))

    def test_selects_only_latest_four_completed_verified_revisions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"
            for attempt in range(1, 6): self._attempt(root, "mech", attempt, "kit-assembly")
            self._attempt(root, "railgun", 1, "railgun", "failed")
            values = completed_developments(root)
            self.assertEqual([item["attempt"] for item in values["mech"]], [2, 3, 4, 5])
            self.assertEqual(values["railgun"], [])
            self.assertEqual(len(completed_developments(root, limit=None)["mech"]), 5)

    def test_builds_animated_gif_manifest_and_five_minute_dashboard(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"
            for attempt in range(1, 5): self._attempt(root, "gun", attempt, "railgun")
            manifest = build_dashboard(root); gif = root / "observability" / "railgun-last-four.gif"
            self.assertEqual(manifest["assets"]["railgun"]["gif"]["frames"], 4)
            self.assertTrue((root / "observability" / "railgun-frozen-reference.png").is_file())
            self.assertEqual(manifest["assets"]["railgun"]["reference"]["sha256"],
                             hashlib.sha256((root / "observability" / "railgun-frozen-reference.png").read_bytes()).hexdigest())
            with Image.open(gif) as image: self.assertEqual(image.n_frames, 4)
            self.assertIn('content="300"', (root / "observability" / "index.html").read_text())

    def test_private_bundle_includes_latest_structural_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"
            self._attempt(root, "mech", 1, "kit-assembly")
            self._attempt(root, "mech", 2, "kit-assembly")
            attempt = root / "mech" / "attempt-0002" / "output"
            (attempt / "scene-manifest.json").write_text(json.dumps({"objects": ["latest"]}))
            (attempt / "fit-report.json").write_text(json.dumps({"blocking": []}))
            files = dashboard_bundle(root)["files_base64"]
            self.assertIn("latest-kit-assembly-attempt-0002-scene-manifest.json", files)
            self.assertIn("latest-kit-assembly-attempt-0002-fit-report.json", files)

    def test_reports_five_minute_patches_and_measured_model_usage(self):
        from datetime import datetime, timezone
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"
            self._attempt(root, "mech", 5, "mech-structure")
            critique = root / "review" / "critique-attempt-0001"; critique.mkdir(parents=True)
            (critique / "receipt.json").write_text(json.dumps({"provider": {"model": "gpt-6-astra"},
                "duration_ms": 99, "model_usage": {"provenance": "measured", "input_tokens": 100,
                "cached_input_tokens": 25, "output_tokens": 20}, "critique": {"defects": []}}))
            observed = production_observability(root, datetime(2026, 9, 9, 0, 6, tzinfo=timezone.utc))
            self.assertEqual(len(observed["patches_last_5m"]), 1)
            astra = next(row for row in observed["models"] if row["model"] == "gpt-6-astra")
            self.assertEqual(astra["total_tokens"], 120)
            luna = next(row for row in observed["models"] if row["model"] == "gpt-5.6-luna")
            self.assertEqual(luna["provenance"], "unavailable")

    def test_reference_score_is_calculated_from_closed_rubric(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"; self._attempt(root, "mech", 1, "kit-assembly")
            inputs = reference_evaluation_inputs(root); revision = inputs["mech"]["developments"][0]["render_sha256"]
            criteria = {"silhouette": 80, "proportions": 60, "component_geometry": 50,
                        "material_identity": 90, "detail_readability": 40, "fit": 100}
            checked = validate_reference_evaluation({"format": "myth-maker.asset-reference-evaluation/v1",
                "evaluations": [{"asset_id": "mech", "render_sha256": revision, "criteria": criteria,
                    "confidence": .8, "observable_delta": "Baseline.", "blocking_visual_defects": []}]}, inputs)
            self.assertEqual(checked["evaluations"][0]["weighted_score"], 67)

    def test_reference_input_uses_best_historical_baseline_and_latest_only(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"
            for attempt in range(1, 5): self._attempt(root, "mech", attempt, "kit-assembly")
            values = completed_developments(root)["mech"]
            evaluations = root / "observability" / "evaluations"; evaluations.mkdir(parents=True)
            (evaluations / "prior.json").write_text(json.dumps({"status": "completed", "evaluation": {"evaluations": [
                {"asset_id": "mech", "render_sha256": values[0]["render_sha256"], "weighted_score": 20},
                {"asset_id": "mech", "render_sha256": values[1]["render_sha256"], "weighted_score": 40},
                {"asset_id": "mech", "render_sha256": values[2]["render_sha256"], "weighted_score": 30}]}}))
            selected = reference_evaluation_inputs(root)["mech"]["developments"]
            self.assertEqual([item["render_sha256"] for item in selected],
                             [values[1]["render_sha256"], values[3]["render_sha256"]])

    def test_reference_input_skips_asset_when_latest_render_was_already_evaluated(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"
            self._attempt(root, "gun", 1, "railgun")
            latest = completed_developments(root)["railgun"][-1]
            evaluations = root / "observability" / "evaluations"; evaluations.mkdir(parents=True)
            (evaluations / "prior.json").write_text(json.dumps({"status": "completed", "evaluation": {"evaluations": [
                {"asset_id": "railgun", "render_sha256": latest["render_sha256"], "weighted_score": 55}]}}))
            self.assertNotIn("railgun", reference_evaluation_inputs(root))

    def test_reference_input_skips_new_assembly_when_mech_dependencies_are_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"
            component_hashes = []
            for slot, digest in (("worker-a", "a" * 64), ("worker-b", "b" * 64)):
                attempt = root / slot / "attempt-0001"; attempt.mkdir(parents=True)
                (attempt / "receipt.json").write_text(json.dumps({"status": "completed", "worker_slot": slot,
                    "artifacts": {"asset.blend": {"sha256": digest}}}))
                component_hashes.append(digest)
            for attempt_number in (1, 2):
                self._attempt(root, "assembly", attempt_number, "kit-assembly")
                attempt = root / "assembly" / f"attempt-{attempt_number:04d}"
                job = json.loads((attempt / "job.json").read_text()); job["dependencies"] = component_hashes
                (attempt / "job.json").write_text(json.dumps(job))
            values = completed_developments(root)["mech"]
            evaluations = root / "observability" / "evaluations"; evaluations.mkdir(parents=True)
            (evaluations / "prior.json").write_text(json.dumps({"status": "completed", "evaluation": {"evaluations": [
                {"asset_id": "mech", "render_sha256": values[0]["render_sha256"], "weighted_score": 44}]}}))
            self.assertNotIn("mech", reference_evaluation_inputs(root))

    def test_reference_input_uses_last_accepted_revision_despite_noisy_absolute_scores(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"
            for attempt in range(1, 5): self._attempt(root, "mech", attempt, "kit-assembly")
            values = completed_developments(root)["mech"]
            evaluations = root / "observability" / "evaluations"; evaluations.mkdir(parents=True)
            (evaluations / "accepted.json").write_text(json.dumps({"status": "completed", "created_at": "2026-09-09T00:01:00Z",
                "evaluation": {"evaluations": [
                    {"asset_id": "mech", "render_sha256": values[0]["render_sha256"], "weighted_score": 40},
                    {"asset_id": "mech", "render_sha256": values[1]["render_sha256"], "weighted_score": 44}]}}))
            (evaluations / "rejected.json").write_text(json.dumps({"status": "completed", "created_at": "2026-09-09T00:02:00Z",
                "evaluation": {"evaluations": [
                    {"asset_id": "mech", "render_sha256": values[1]["render_sha256"], "weighted_score": 47},
                    {"asset_id": "mech", "render_sha256": values[2]["render_sha256"], "weighted_score": 48}]}}))
            selected = reference_evaluation_inputs(root)["mech"]["developments"]
            self.assertEqual([item["render_sha256"] for item in selected],
                             [values[1]["render_sha256"], values[3]["render_sha256"]])

    def test_reference_input_can_reach_accepted_revision_older_than_dashboard_window(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"
            for attempt in range(1, 7): self._attempt(root, "mech", attempt, "kit-assembly")
            values = completed_developments(root, limit=None)["mech"]
            evaluations = root / "observability" / "evaluations"; evaluations.mkdir(parents=True)
            (evaluations / "accepted.json").write_text(json.dumps({"status": "completed", "created_at": "2026-09-09T00:01:00Z",
                "evaluation": {"evaluations": [
                    {"asset_id": "mech", "render_sha256": values[0]["render_sha256"], "weighted_score": 40},
                    {"asset_id": "mech", "render_sha256": values[1]["render_sha256"], "weighted_score": 44}]}}))
            selected = reference_evaluation_inputs(root)["mech"]["developments"]
            self.assertEqual([item["render_sha256"] for item in selected],
                             [values[1]["render_sha256"], values[-1]["render_sha256"]])

    def test_reference_input_reevaluates_candidate_previously_compared_to_rejected_baseline(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"
            for attempt in range(1, 4): self._attempt(root, "mech", attempt, "kit-assembly")
            values = completed_developments(root)["mech"]
            evaluations = root / "observability" / "evaluations"; evaluations.mkdir(parents=True)
            (evaluations / "accepted.json").write_text(json.dumps({"status": "completed", "created_at": "2026-09-09T00:01:00Z",
                "evaluation": {"evaluations": [
                    {"asset_id": "mech", "render_sha256": values[0]["render_sha256"], "weighted_score": 40},
                    {"asset_id": "mech", "render_sha256": values[1]["render_sha256"], "weighted_score": 44}]}}))
            (evaluations / "wrong-baseline.json").write_text(json.dumps({"status": "completed", "created_at": "2026-09-09T00:02:00Z",
                "evaluation": {"evaluations": [
                    {"asset_id": "mech", "render_sha256": values[0]["render_sha256"], "weighted_score": 50},
                    {"asset_id": "mech", "render_sha256": values[2]["render_sha256"], "weighted_score": 51}]}}))
            selected = reference_evaluation_inputs(root)["mech"]["developments"]
            self.assertEqual([item["render_sha256"] for item in selected],
                             [values[1]["render_sha256"], values[2]["render_sha256"]])

    def test_progress_history_retains_unique_candidate_deltas(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"; evaluations = root / "observability" / "evaluations"
            evaluations.mkdir(parents=True)
            for index, (candidate, scores) in enumerate((("b", (30, 34)), ("b", (31, 35)),
                                                          ("c", (34, 33)), ("d", (40, 40.3))), 1):
                rows = [{"asset_id": "mech", "render_sha256": "a", "weighted_score": scores[0]},
                        {"asset_id": "mech", "render_sha256": candidate, "weighted_score": scores[1]}]
                (evaluations / f"{index}.json").write_text(json.dumps({"status": "completed",
                    "created_at": f"2026-09-09T00:0{index}:00+00:00", "evaluation": {"evaluations": rows}}))
            history = reference_progress_history(root)
            self.assertEqual([(row["render_sha256"], row["delta"], row["accepted"], row["cumulative_accepted_gain"]) for row in history],
                             [("b", 4, True, 4), ("c", -1, False, 4), ("d", 0.3, False, 4)])
            self.assertEqual(history[-1]["disposition"], "below-threshold")

    def test_progress_history_skips_unrelated_assembly_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "run-one"
            dependencies = []
            for slot in ("worker-a", "worker-b"):
                attempt = root / slot / "attempt-0001"; attempt.mkdir(parents=True)
                digest = ("a" if slot == "worker-a" else "b") * 64; dependencies.append(digest)
                (attempt / "job.json").write_text(json.dumps({"operations": [{"kind": "normalize"}]}))
                (attempt / "receipt.json").write_text(json.dumps({"worker_slot": slot,
                    "artifacts": {"asset.blend": {"sha256": digest}}}))
            assembly = root / "worker-d" / "attempt-0001"; assembly.mkdir(parents=True)
            (assembly / "job.json").write_text(json.dumps({"dependencies": dependencies}))
            (assembly / "receipt.json").write_text(json.dumps({"worker_slot": "worker-d",
                "artifacts": {"renders/full-body.png": {"sha256": "d" * 64}}}))
            evaluations = root / "observability" / "evaluations"; evaluations.mkdir(parents=True)
            (evaluations / "one.json").write_text(json.dumps({"status": "completed", "created_at": "2026-09-10T00:00:00Z",
                "evaluation": {"evaluations": [{"asset_id": "mech", "render_sha256": "c" * 64, "weighted_score": 40},
                                                {"asset_id": "mech", "render_sha256": "d" * 64, "weighted_score": 45}]}}))
            self.assertEqual(reference_progress_history(root), [])
if __name__ == "__main__": unittest.main()
