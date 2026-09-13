from pathlib import Path
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from run_github_gui_animation_job import (
    continuation_available,
    continuation_job_id,
    prepare_continuation,
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
            continuation_job_id("draft-gui-reef-rig-42-a1", 2),
            "draft-gui-reef-rig-42-a1-c2",
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


if __name__ == "__main__":
    unittest.main()
