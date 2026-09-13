import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from run_cloud_gui_animation_job import (build_manifest, build_work_order, collect_inputs,
                                         continuation_available, fetch_job, resume_stage_job_id,
                                         stage_resume_job, validate_deployment_receipt,
                                         validate_modal_resume_identity, validate_resume_job)


GLB = b"glTF\x02\x00\x00\x00\x0c\x00\x00\x00"


class CloudGuiAnimationJobTests(unittest.TestCase):
    def test_collects_a_closed_hash_bound_input_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            files = {
                "source_asset.glb": GLB,
                "structure_reference.png": b"one",
                "component_reference.png": b"two",
                "primary_artwork.png": b"three",
                "concept_reference.png": b"four",
            }
            specs = []
            for name, data in files.items():
                path = root / name
                path.write_bytes(data)
                specs.append(f"{name}={path}")

            collected = collect_inputs(specs)
            manifest = build_manifest(collected, input_root="cloud-animation/run-7/reef-skitter-rig/inputs")

            self.assertEqual(set(manifest["files"]), set(files))
            self.assertEqual(manifest["files"]["source_asset.glb"]["sha256"], hashlib.sha256(GLB).hexdigest())
            self.assertEqual(manifest["volume_name"], "myth-maker-encounter-submissions")

    def test_work_order_keeps_the_instruction_and_stable_identity(self):
        order = build_work_order(
            "reef-skitter-clip-idle", "animation-clip", "Author idle", attempt=1,
            run_scope="run-42", motion_capture_frames=40,
        )

        self.assertEqual(order, {
            "schema_version": "1", "work_id": "reef-skitter-clip-idle", "encounter_id": "reef-skitter",
            "lane": "animation-clip", "attempt": 1, "run_scope": "run-42", "continuation": 0,
            "instruction": "Author idle", "resume_job": "", "checkpoint_id": "",
            "motion_capture_frames": 40,
        })

    def test_work_order_binds_a_continuation_to_one_immutable_checkpoint(self):
        order = build_work_order(
            "reef-rig-42", "animation-rig", "Continue rig", attempt=2, run_scope="run-99",
            continuation=1, resume_job="draft-gui-reef-rig-42-run-99-a2",
            checkpoint_id="cp-0004-abcdef123456",
        )

        self.assertEqual(order["continuation"], 1)
        self.assertEqual(order["resume_job"], "draft-gui-reef-rig-42-run-99-a2")
        self.assertEqual(order["checkpoint_id"], "cp-0004-abcdef123456")

    def test_direct_modal_resume_requires_both_valid_provider_identities(self):
        self.assertEqual(
            validate_modal_resume_identity(
                "draft-gui-reef-rig-42-run-99-a2-c2", "cp-0022-abcdef123456"
            ),
            ("draft-gui-reef-rig-42-run-99-a2-c2", "cp-0022-abcdef123456"),
        )
        for job_id, checkpoint_id in (("", "cp-0022-abcdef123456"),
                                      ("draft-gui-reef-rig-42", ""),
                                      ("../job", "cp-0022-abcdef123456")):
            with self.subTest(job_id=job_id), self.assertRaises(ValueError):
                validate_modal_resume_identity(job_id, checkpoint_id)

    def test_quota_failure_never_schedules_a_continuation(self):
        state = {"status": "failed", "checkpoint_id": "cp-0004-abcdef123456",
                 "error": "429 insufficient_quota credit_balance_exhausted"}

        self.assertFalse(continuation_available(state))

    def test_validates_a_portable_resume_checkpoint_against_current_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "draft-gui-reef-rig-42-a1"
            checkpoint_id = "cp-0004-abcdef123456"
            package = source / "checkpoints" / checkpoint_id
            package.mkdir(parents=True)
            inputs = {"source_asset.glb": {"bytes": len(GLB), "sha256": hashlib.sha256(GLB).hexdigest()}}
            (source / "status.json").write_text('{"part":"reef-rig-42","status":"failed"}')
            (source / "checkpoint-latest.json").write_text('{"checkpoint_id":"cp-0004-abcdef123456"}')
            (package / "checkpoint.json").write_text(__import__("json").dumps({
                "schema_version": 2, "part": "reef-rig-42", "checkpoint_id": checkpoint_id,
                "files": {"inputs/source_asset.glb": inputs["source_asset.glb"]},
            }))

            self.assertEqual(
                validate_resume_job(source, part="reef-rig-42", expected_input_hashes=inputs),
                (source.name, checkpoint_id),
            )

    def test_fetches_the_exact_modal_job_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "evidence"
            job_id = "draft-gui-reef-idle-42-run-42-a1"
            state = {"job_id": job_id, "part": "reef-idle-42", "provider_receipt": {
                "provider": "modal", "volume_name": "myth-maker-encounter-submissions",
                "app_name": "myth-maker-encounter-draft", "environment": "dev",
                "function_name": "run_draft_from_volume_manifest",
            }}

            def download(command, check):
                destination = Path(command[-1]) / job_id
                destination.mkdir(parents=True)
                (destination / "status.json").write_text(
                    '{"job_id":"' + job_id + '","part":"reef-idle-42"}'
                )

            with patch("run_cloud_gui_animation_job.subprocess.run", side_effect=download) as run:
                destination = fetch_job(state, artifact_root=root, environment="dev")

            self.assertEqual(destination, (root / "jobs" / job_id).resolve())
            self.assertEqual(run.call_args.args[0][0:5], ["modal", "volume", "get", "--env", "dev"])
            self.assertEqual(Path(run.call_args.args[0][-1]), (root / "jobs").resolve())

    def test_stages_a_legacy_checkpoint_under_a_run_scoped_immutable_alias(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "draft-gui-reef-rig-42-a1"
            checkpoint_id = "cp-0004-abcdef123456"
            package = source / "checkpoints" / checkpoint_id
            package.mkdir(parents=True)
            inputs = {"source_asset.glb": {"bytes": len(GLB), "sha256": hashlib.sha256(GLB).hexdigest()}}
            (source / "status.json").write_text('{"part":"reef-rig-42","status":"failed"}')
            (source / "checkpoint-latest.json").write_text('{"checkpoint_id":"cp-0004-abcdef123456"}')
            (package / "checkpoint.json").write_text(__import__("json").dumps({
                "schema_version": 2, "part": "reef-rig-42", "checkpoint_id": checkpoint_id,
                "files": {"inputs/source_asset.glb": inputs["source_asset.glb"]},
            }))
            staged = resume_stage_job_id("reef-rig-42", "run-99", 2)

            with patch("run_cloud_gui_animation_job.subprocess.run") as run:
                result = stage_resume_job(
                    source, part="reef-rig-42", expected_input_hashes=inputs,
                    environment="dev", staged_job_id=staged,
                )

            self.assertEqual(result, (staged, checkpoint_id))
            self.assertEqual(run.call_args.args[0][-1], "/" + staged)

    def test_deployment_receipt_binds_source_environment_and_volume_function(self):
        receipt = {
            "format": "myth-maker.deployment-receipt/v1", "provider": "modal", "status": "success",
            "environment": "dev", "source_sha": "a" * 40,
            "details": {"provider_evidence": {"health": {"volume_draft_function_id": "fu-current"}}},
        }

        validate_deployment_receipt(receipt, source_sha="a" * 40, environment="dev", function_id="fu-current")
        with self.assertRaisesRegex(RuntimeError, "deployment receipt"):
            validate_deployment_receipt(receipt, source_sha="b" * 40, environment="dev", function_id="fu-current")


if __name__ == "__main__":
    unittest.main()
