from pathlib import Path
import unittest


WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "reef-skitter-cloud-animation.yml"


class ReefSkitterCloudWorkflowTests(unittest.TestCase):
    def test_cloud_pipeline_uses_github_gui_workers_and_four_parallel_clip_slots(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertEqual(text.count("scripts/run_github_gui_animation_job.py"), 3)
        self.assertIn("max-parallel: 4", text)
        self.assertNotIn("MODAL_TOKEN", text)
        self.assertNotIn("modal volume", text)

    def test_all_five_actions_have_provider_hashed_motion_capture(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        for clip in ("idle", "walk", "run", "attack", "death"):
            self.assertIn(f"- clip: {clip}", text)
        self.assertIn("--motion-capture-frames 40", text)
        self.assertIn("scripts/verify_cloud_gui_animation_artifacts.py", text)
        self.assertIn("scripts/verify_animation_motion.py", text)
        self.assertEqual(text.count("scripts/inspect_blender_animation.py"), 3)
        self.assertIn("$job_root/$CLIP.gif", text)
        self.assertEqual(text.count("scripts/seal_github_animation_receipt.py"), 3)
        self.assertEqual(text.count("steps.upload-evidence.outputs.artifact-digest"), 3)

    def test_reruns_resolve_the_latest_successful_dependency_attempt(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("scripts/resolve_github_animation_artifact.py rig-artifacts", text)
        self.assertIn("scripts/resolve_github_animation_artifact.py clip-artifacts", text)
        self.assertIn("pattern: reef-skitter-clip-*-${{ github.run_id }}-*", text)
        self.assertNotIn('name: reef-skitter-rig-${{ github.run_id }}-${{ github.run_attempt }}\n          path: rig-artifact', text)

    def test_worker_failures_restore_runner_read_access_before_evidence_upload(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertEqual(text.count("worker_status=$?"), 3)
        self.assertEqual(text.count('sudo chown -R "$(id -u):$(id -g)" evidence receipts'), 3)
        self.assertEqual(text.count('exit "$worker_status"'), 3)

    def test_each_stage_resolves_the_actual_final_continuation_job(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertEqual(text.count("scripts/resolve_github_animation_job_root.py"), 5)
        self.assertNotIn('job_root="evidence/rig/jobs/draft-gui-$rig_id-a$GITHUB_RUN_ATTEMPT"', text)
        self.assertNotIn('job_root="evidence/$CLIP/jobs/draft-gui-$clip_id-a$GITHUB_RUN_ATTEMPT"', text)
        self.assertNotIn('job_root="evidence/final/jobs/draft-gui-$integration_id-a$GITHUB_RUN_ATTEMPT"', text)

    def test_rig_can_resume_a_prior_cloud_artifact_without_local_blender(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("rig_seed_run_id:", text)
        self.assertIn("run-id: ${{ inputs.rig_seed_run_id }}", text)
        self.assertIn("--resume-job-dir", text)
        self.assertIn("scripts/resolve_github_animation_resume.py", text)
        self.assertIn("rig-id: ${{ steps.author.outputs.rig-id }}", text)
        self.assertIn('rig_id="${{ needs.rig.outputs.rig-id }}"', text)


if __name__ == "__main__":
    unittest.main()
