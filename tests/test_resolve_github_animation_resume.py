import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "scripts" / "resolve_github_animation_resume.py"


class ResolveGitHubAnimationResumeTests(unittest.TestCase):
    def test_resolves_the_exact_receipted_checkpoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "reef-skitter-rig-42-1"
            job_id = "draft-gui-reef-rig-42-a1-c1"
            checkpoint_id = "cp-0002-abcdef123456"
            job = artifact / "evidence" / "rig" / "jobs" / job_id
            (job / "checkpoints" / checkpoint_id).mkdir(parents=True)
            (job / "checkpoint-latest.json").write_text(json.dumps({"checkpoint_id": checkpoint_id}))
            receipt = artifact / "receipts" / "reef-skitter-rig.json"
            receipt.parent.mkdir(parents=True)
            receipt.write_text(json.dumps({
                "work_order": {"work_id": "reef-rig-42"},
                "worker_state": {
                    "status": "failed", "part": "reef-rig-42", "checkpoint_id": checkpoint_id,
                    "provider_receipt": {
                        "provider": "github-actions-runner", "run_id": 42,
                        "artifact_name": "reef-skitter-rig-42-1", "input_id": job_id,
                    },
                },
            }))

            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(artifact), "42"],
                check=True, capture_output=True, text=True,
            )
            resolved = json.loads(result.stdout)

            self.assertEqual(resolved["work_id"], "reef-rig-42")
            self.assertEqual(resolved["job_id"], job_id)
            self.assertEqual(resolved["checkpoint_id"], checkpoint_id)
            self.assertEqual(Path(resolved["job_dir"]), job.resolve())
            self.assertEqual(resolved["provider"], "github-actions-runner")

    def test_resolves_a_modal_checkpoint_without_reuploading_its_volume_job(self):
        with tempfile.TemporaryDirectory() as temporary:
            artifact = Path(temporary) / "reef-skitter-rig-42-2"
            job_id = "draft-gui-reef-rig-42-run-90-a2"
            checkpoint_id = "cp-0003-abcdef123456"
            job = artifact / "evidence" / "rig" / "jobs" / job_id
            (job / "checkpoints" / checkpoint_id).mkdir(parents=True)
            (job / "checkpoint-latest.json").write_text(json.dumps({"checkpoint_id": checkpoint_id}))
            receipt = artifact / "receipts" / "reef-skitter-rig.json"
            receipt.parent.mkdir(parents=True)
            receipt.write_text(json.dumps({
                "work_order": {"work_id": "reef-rig-42"},
                "worker_state": {
                    "status": "checkpointed_partial", "part": "reef-rig-42", "job_id": job_id,
                    "checkpoint_id": checkpoint_id,
                    "provider_receipt": {
                        "provider": "modal", "volume_name": "myth-maker-encounter-submissions",
                        "app_name": "myth-maker-encounter-draft",
                        "function_name": "run_draft_from_volume_manifest",
                    },
                },
            }))

            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(artifact), "42"],
                check=True, capture_output=True, text=True,
            )

            self.assertEqual(json.loads(result.stdout)["provider"], "modal")


if __name__ == "__main__":
    unittest.main()
