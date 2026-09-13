from pathlib import Path
import sys
import tempfile
import unittest


sys.path.insert(0, str(Path(__file__).parents[1] / "scripts"))
from run_github_gui_animation_job import trusted_context, worker_paths


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


if __name__ == "__main__":
    unittest.main()
