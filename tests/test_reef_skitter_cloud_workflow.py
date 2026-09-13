from pathlib import Path
import unittest


WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "reef-skitter-cloud-animation.yml"


class ReefSkitterCloudWorkflowTests(unittest.TestCase):
    def test_cloud_pipeline_uses_modal_gui_workers_and_four_parallel_clip_slots(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertEqual(text.count("scripts/run_cloud_gui_animation_job.py"), 3)
        self.assertNotIn("scripts/run_github_gui_animation_job.py", text)
        self.assertIn("max-parallel: 4", text)
        self.assertEqual(text.count("MODAL_TOKEN_ID: ${{ secrets.MODAL_TOKEN_ID }}"), 3)
        self.assertEqual(text.count("deployment-receipt-modal-dev-${{ github.sha }}"), 3)
        self.assertEqual(text.count("--deployment-receipt deployment-receipt/modal-dev.json"), 3)
        self.assertNotIn("deployment-receipt/receipts/modal-dev.json", text)
        self.assertNotIn("OPENAI_API_KEY", text)

    def test_all_five_actions_have_provider_hashed_motion_capture(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        for clip in ("idle", "walk", "run", "attack", "death"):
            self.assertIn(f"- clip: {clip}", text)
        self.assertIn("--motion-capture-frames 40", text)
        self.assertIn("scripts/verify_cloud_gui_animation_artifacts.py", text)
        self.assertIn("scripts/verify_animation_motion.py", text)
        self.assertEqual(text.count("scripts/inspect_blender_animation.py"), 3)
        self.assertIn("$job_root/$CLIP.gif", text)
        self.assertNotIn("scripts/seal_github_animation_receipt.py", text)
        self.assertNotIn("--allow-runner-receipt", text)

    def test_reruns_resolve_the_latest_successful_dependency_attempt(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("scripts/resolve_github_animation_artifact.py rig-artifacts", text)
        self.assertIn("scripts/resolve_github_animation_artifact.py clip-artifacts", text)
        self.assertIn("pattern: reef-skitter-clip-*-${{ github.run_id }}-*", text)
        self.assertNotIn('name: reef-skitter-rig-${{ github.run_id }}-${{ github.run_attempt }}\n          path: rig-artifact', text)

    def test_authoring_does_not_use_the_runner_desktop_or_root_owned_outputs(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertNotIn("sudo --preserve-env", text)
        self.assertNotIn("sudo chown", text)
        self.assertNotIn("GitHub-hosted Blender desktop", text)

    def test_each_stage_resolves_the_actual_final_continuation_job(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertEqual(text.count("scripts/resolve_github_animation_job_root.py"), 6)
        self.assertNotIn('job_root="evidence/rig/jobs/draft-gui-$rig_id-a$GITHUB_RUN_ATTEMPT"', text)
        self.assertNotIn('job_root="evidence/$CLIP/jobs/draft-gui-$clip_id-a$GITHUB_RUN_ATTEMPT"', text)
        self.assertNotIn('job_root="evidence/final/jobs/draft-gui-$integration_id-a$GITHUB_RUN_ATTEMPT"', text)

    def test_rig_can_resume_a_prior_cloud_artifact_without_local_blender(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("rig_seed_run_id:", text)
        self.assertIn("run-id: ${{ inputs.rig_seed_run_id }}", text)
        self.assertIn("--resume-job-dir", text)
        self.assertIn("--resume-modal-job-id", text)
        self.assertIn("--resume-modal-checkpoint-id", text)
        self.assertIn("scripts/resolve_github_animation_resume.py", text)
        self.assertIn("rig-id: ${{ steps.author.outputs.rig-id }}", text)
        self.assertIn('rig_id="${{ needs.rig.outputs.rig-id }}"', text)

    def test_integration_declares_every_job_whose_outputs_it_reads(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("integrate-and-verify:\n    needs: [rig, clips]", text)

    def test_rig_instruction_prioritizes_known_binding_failures(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("A bone moving without its intended mesh is a blocking binding defect", text)
        self.assertIn("repair the binding before continuing the audit", text)
        self.assertIn("An unreadable reference pane is not a blocker", text)
        self.assertIn("do not save again after that verification", text)
        self.assertIn("otherwise that newer save would require another reopen", text)

    def test_rig_and_gaits_follow_source_derived_limb_topology(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertNotIn("six-legged", text)
        self.assertNotIn("six-leg scuttle", text)
        self.assertIn("Do not invent missing limbs", text)
        self.assertIn("tripo_part_6 has two welded disconnected regions", text)
        self.assertIn("vertex groups without splitting the provider object", text)
        self.assertIn("source-derived locomotor limb count", text)

    def test_run_lane_uses_objective_acceptance_without_direct_walk_access(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("Direct access to the walk Action is unavailable by design", text)
        self.assertIn("a direct visual comparison is not required", text)
        self.assertIn("12-frame loop", text)
        self.assertIn("24-frame walk specification", text)
        self.assertIn("preserve the root transform", text)

    def test_each_clip_lane_removes_the_inherited_source_action_in_the_gui(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("Remove every inherited empty or source Action through the visible Blender GUI", text)
        self.assertIn("leave exactly the selected target Action", text)


if __name__ == "__main__":
    unittest.main()
