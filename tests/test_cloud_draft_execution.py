import hashlib
from pathlib import Path
import sys
import unittest


sys.path.insert(0, str(Path(__file__).parents[1] / "modal"))
from cloud_draft_execution import github_actions_artifact_receipt, seal_github_actions_artifact_receipt


class GitHubActionsArtifactReceiptTests(unittest.TestCase):
    def test_binds_worker_evidence_to_one_immutable_workflow_artifact(self):
        output = {"reef-rig.blend": {"bytes": 7, "sha256": hashlib.sha256(b"BLENDER").hexdigest()}}
        frames = {"final": ("final-desktop.png", {"bytes": 3, "sha256": hashlib.sha256(b"png").hexdigest()})}

        receipt = github_actions_artifact_receipt(
            repository="Lucky9-Labs/myth-maker",
            source_sha="a" * 40,
            run_id="34743294949",
            run_attempt="2",
            job_name="rig",
            artifact_name="reef-skitter-rig-34743294949-2",
            artifact_path_prefix="evidence/rig",
            job_id="draft-gui-reef-rig-34743294949-a2",
            output_files=output,
            blender_frames=frames,
        )

        self.assertEqual(receipt["provider"], "github-actions-runner")
        self.assertEqual(receipt["source_sha"], "a" * 40)
        self.assertEqual(receipt["execution_url"], "https://github.com/Lucky9-Labs/myth-maker/actions/runs/34743294949")
        self.assertEqual(
            receipt["output_artifacts"]["reef-rig.blend"]["uri"],
            "github-actions-runner://Lucky9-Labs/myth-maker/34743294949/2/reef-skitter-rig-34743294949-2/evidence/rig/jobs/draft-gui-reef-rig-34743294949-a2/output/reef-rig.blend",
        )

    def test_seals_runner_hashes_with_githubs_actual_artifact_identity_and_digest(self):
        runner = github_actions_artifact_receipt(
            repository="Lucky9-Labs/myth-maker", source_sha="a" * 40,
            run_id="42", run_attempt="1", job_name="rig", artifact_name="reef-rig-42-1",
            artifact_path_prefix="evidence/rig", job_id="draft-gui-reef-rig-42-a1",
            output_files={"reef.blend": {"bytes": 7, "sha256": hashlib.sha256(b"BLENDER").hexdigest()}},
            blender_frames={},
        )

        sealed = seal_github_actions_artifact_receipt(
            runner, artifact_id="1234",
            artifact_url="https://github.com/Lucky9-Labs/myth-maker/actions/runs/42/artifacts/1234",
            artifact_digest="b" * 64,
        )

        self.assertEqual(sealed["provider"], "github-actions")
        self.assertEqual(sealed["storage"]["artifact_id"], 1234)
        self.assertEqual(sealed["storage"]["artifact_digest"], "sha256:" + "b" * 64)
        self.assertIn("/1234/evidence/rig/jobs/", sealed["output_artifacts"]["reef.blend"]["uri"])

    def test_rejects_untrusted_or_traversing_identity(self):
        with self.assertRaises(ValueError):
            github_actions_artifact_receipt(
                repository="other/repo", source_sha="a" * 40, run_id="1", run_attempt="1",
                job_name="rig", artifact_name="artifact", artifact_path_prefix="evidence/rig", job_id="../job",
                output_files={}, blender_frames={},
            )


if __name__ == "__main__":
    unittest.main()
