import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "resolve_github_animation_job_root.py"


class ResolveGitHubAnimationJobRootTests(unittest.TestCase):
    def test_resolves_only_the_receipted_job_beneath_the_artifact_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            job = root / "jobs" / "draft-gui-reef-rig-42-a1-c1"
            job.mkdir(parents=True)
            receipt = root / "receipt.json"
            receipt.write_text(json.dumps({
                "worker_state": {
                    "status": "ready_for_review",
                    "provider_receipt": {
                        "provider": "github-actions-runner",
                        "input_id": job.name,
                    },
                },
            }))

            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(receipt), str(root)],
                check=True, capture_output=True, text=True,
            )

            self.assertEqual(Path(result.stdout.strip()), job.resolve())

    def test_rejects_a_non_reviewable_worker_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            receipt = root / "receipt.json"
            receipt.write_text(json.dumps({
                "worker_state": {
                    "status": "checkpointed_partial",
                    "provider_receipt": {
                        "provider": "github-actions-runner",
                        "input_id": "draft-gui-reef-rig-42-a1",
                    },
                },
            }))

            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(receipt), str(root)],
                capture_output=True, text=True,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("ready for review", result.stderr)

    def test_resolves_a_provider_observed_modal_job(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            job = root / "jobs" / "draft-gui-reef-rig-42-run-77-a1"
            job.mkdir(parents=True)
            prefix = "modal-volume://myth-maker-encounter-submissions/" + job.name + "/"
            receipt = root / "receipt.json"
            receipt.write_text(json.dumps({"worker_state": {
                "status": "ready_for_review", "job_id": job.name,
                "provider_receipt": {
                    "provider": "modal", "volume_name": "myth-maker-encounter-submissions",
                    "app_name": "myth-maker-encounter-draft",
                    "function_name": "run_draft_from_volume_manifest",
                    "output_artifacts": {"reef-rig-42.blend": {"uri": prefix + "output/reef-rig-42.blend"}},
                    "blender_window_frames": {"final": {"uri": prefix + "final-desktop.png"}},
                },
            }}))

            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(receipt), str(root)],
                check=True, capture_output=True, text=True,
            )

            self.assertEqual(Path(result.stdout.strip()), job.resolve())


if __name__ == "__main__":
    unittest.main()
