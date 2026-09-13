from pathlib import Path
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from run_github_gui_animation_job import (
    continuation_available,
    continuation_job_id,
    initial_job_id,
    prepare_continuation,
    reset_gui_client_modules,
    stage_resume_job,
    trusted_context,
    worker_paths,
)


class GitHubGuiAnimationJobTests(unittest.TestCase):
    def test_accepts_only_the_trusted_main_workflow_context(self):
        environment = {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": "Lucky9-Labs/myth-maker",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_SHA": "a" * 40,
            "GITHUB_RUN_ID": "42",
            "GITHUB_RUN_ATTEMPT": "2",
            "GITHUB_JOB": "rig",
        }

        self.assertEqual(trusted_context(environment)["run_id"], "42")
        with self.assertRaisesRegex(RuntimeError, "trusted GitHub Actions main context"):
            trusted_context({**environment, "GITHUB_REF": "refs/heads/feature"})

    def test_keeps_all_persisted_worker_evidence_inside_the_uploaded_artifact_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            artifact_root = workspace / "evidence" / "rig"

            paths = worker_paths(workspace=workspace, artifact_root=artifact_root)

            self.assertEqual(paths["submissions_root"], artifact_root.resolve() / "jobs")
            self.assertEqual(paths["prompt_template"], workspace.resolve() / "modal" / "draft_prompt.md")
            with self.assertRaisesRegex(ValueError, "artifact root"):
                worker_paths(workspace=workspace, artifact_root=workspace.parent / "outside")

    def test_continuation_uses_the_latest_immutable_checkpoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            inputs = root / "inputs"
            output = root / "output"
            inputs.mkdir()
            output.symlink_to(root / "old-output", target_is_directory=True)

            parent, checkpoint = prepare_continuation(
                state={"status": "checkpointed_partial", "checkpoint_id": "cp-0024-abcdef123456"},
                previous_job_id="draft-gui-reef-rig-42-a1",
                inputs_dir=inputs,
                output_link=output,
            )

            self.assertEqual(parent, "draft-gui-reef-rig-42-a1")
            self.assertEqual(checkpoint, "cp-0024-abcdef123456")
            self.assertFalse(inputs.exists())
            self.assertFalse(output.exists())

    def test_continuation_job_ids_remain_stable_and_bounded(self):
        self.assertEqual(
            initial_job_id("reef-rig-42", attempt=1, run_id="99"),
            "draft-gui-reef-rig-42-r99-a1",
        )
        self.assertEqual(
            continuation_job_id("draft-gui-reef-rig-42-r99-a1", 2),
            "draft-gui-reef-rig-42-r99-a1-c2",
        )
        with self.assertRaisesRegex(ValueError, "continuation"):
            continuation_job_id("draft-gui-reef-rig-42-a1", 0)

    def test_does_not_attempt_to_resume_a_failed_non_checkpointed_state(self):
        self.assertFalse(continuation_available({
            "status": "failed",
            "stop_reason": "runtime_error",
            "checkpoint_id": None,
        }))
        self.assertTrue(continuation_available({
            "status": "checkpointed_partial",
            "checkpoint_id": "cp-0024-abcdef123456",
        }))
        self.assertTrue(continuation_available({
            "status": "failed",
            "stop_reason": "runtime_error",
            "checkpoint_id": "cp-0002-abcdef123456",
        }))

    def test_continuation_drops_the_stale_x11_gui_client(self):
        sentinel = object()
        sys.modules["pyautogui"] = sentinel
        sys.modules["pyautogui._pyautogui_x11"] = sentinel
        sys.modules["mouseinfo"] = sentinel

        reset_gui_client_modules()

        self.assertNotIn("pyautogui", sys.modules)
        self.assertNotIn("pyautogui._pyautogui_x11", sys.modules)
        self.assertNotIn("mouseinfo", sys.modules)

    def test_stages_a_cross_run_checkpoint_only_when_inputs_match(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "downloaded" / "draft-gui-reef-rig-42-a1-c1"
            checkpoint = source / "checkpoints" / "cp-0002-abcdef123456"
            checkpoint.mkdir(parents=True)
            (source / "status.json").write_text('{"status":"failed","part":"reef-rig-42"}')
            (source / "checkpoint-latest.json").write_text('{"checkpoint_id":"cp-0002-abcdef123456"}')
            (checkpoint / "checkpoint.json").write_text('{"schema_version":2,"part":"reef-rig-42","native_name":"reef-rig-42.blend","checkpoint_id":"cp-0002-abcdef123456","files":{"inputs/source_asset.glb":{"sha256":"' + ('a' * 64) + '","bytes":3}}}')
            destination = root / "evidence" / "rig" / "jobs"

            job_id, checkpoint_id = stage_resume_job(
                source=source, submissions_root=destination,
                part="reef-rig-42",
                expected_input_hashes={"source_asset.glb": {"sha256": "a" * 64, "bytes": 3}},
            )

            self.assertEqual(job_id, source.name)
            self.assertEqual(checkpoint_id, "cp-0002-abcdef123456")
            self.assertTrue((destination / source.name / "status.json").is_file())


if __name__ == "__main__":
    unittest.main()
