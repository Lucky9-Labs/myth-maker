from pathlib import Path
import unittest


WORKFLOW = (
    Path(__file__).parents[1]
    / ".github"
    / "workflows"
    / "reef-skitter-cloud-clip.yml"
)


class ReefSkitterCloudClipWorkflowTests(unittest.TestCase):
    def test_dispatch_selects_exactly_one_supported_clip(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("modal_deployment_run_id:", text)
        self.assertIn("source_animation_run_id:", text)
        self.assertIn("clip:", text)
        self.assertIn("type: choice", text)
        for clip in ("idle", "walk", "run", "attack", "death"):
            self.assertIn(f"- {clip}", text)
        self.assertIn("\n  author-clip:\n", text)
        self.assertNotIn("matrix:", text)
        self.assertNotIn("\n  rig:\n", text)
        self.assertNotIn("integrate-and-verify:", text)

    def test_authors_from_the_accepted_cross_run_rig_with_exact_modal_deployment(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertEqual(text.count("github-token: ${{ github.token }}"), 3)
        self.assertIn("run-id: ${{ inputs.modal_deployment_run_id }}", text)
        self.assertIn("pattern: deployment-receipt-modal-dev-${{ github.sha }}", text)
        self.assertIn("run-id: ${{ inputs.source_animation_run_id }}", text)
        self.assertIn(
            "pattern: reef-skitter-rig-${{ inputs.source_animation_run_id }}-*",
            text,
        )
        self.assertIn("scripts/resolve_github_animation_work_id.py", text)
        self.assertIn("scripts/resolve_github_animation_job_root.py", text)
        self.assertIn('--input "source_scene.blend=$source_scene"', text)

    def test_preserves_gui_continuation_motion_inspection_and_artifact_proof(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertEqual(text.count("scripts/run_cloud_gui_animation_job.py"), 1)
        self.assertIn("--lane animation-clip", text)
        self.assertIn("--max-continuations 2", text)
        self.assertIn("--motion-capture-frames 40", text)
        self.assertIn("Do not use Python or scripts", text)
        self.assertIn("scripts/inspect_blender_animation.py", text)
        self.assertIn("scripts/verify_cloud_gui_animation_artifacts.py", text)
        self.assertIn("scripts/verify_animation_motion.py", text)
        self.assertIn("$job_root/$CLIP.gif", text)
        self.assertIn(
            "name: reef-skitter-clip-${{ inputs.clip }}-${{ github.run_id }}-${{ github.run_attempt }}",
            text,
        )
        self.assertNotIn("OPENAI_API_KEY", text)

    def test_rejects_an_unverified_rig_before_spending_modal_authoring_time(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertEqual(
            text.count("scripts/verify_cloud_gui_animation_artifacts.py"),
            2,
        )
        self.assertIn('--receipt "$rig_receipt" --artifact-dir "$rig_root"', text)
        self.assertIn('--output "$rig_id.blend=output/$rig_id.blend"', text)

    def test_run_acceptance_does_not_require_an_unavailable_walk_comparison(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("Direct access to the walk Action is unavailable by design", text)
        self.assertIn("a direct visual comparison is not required", text)
        self.assertIn("12-frame loop", text)
        self.assertIn("24-frame walk specification", text)
        self.assertIn("preserve the root transform", text)

    def test_gui_authoring_removes_the_inherited_source_action(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("Remove every inherited empty or source Action through the visible Blender GUI", text)
        self.assertIn("leave exactly the selected target Action", text)

    def test_optionally_resumes_the_same_clip_provider_checkpoint_and_work_id(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("clip_seed_run_id:", text)
        self.assertIn("if: inputs.clip_seed_run_id != ''", text)
        self.assertIn("run-id: ${{ inputs.clip_seed_run_id }}", text)
        self.assertIn(
            "pattern: reef-skitter-clip-${{ inputs.clip }}-${{ inputs.clip_seed_run_id }}-*",
            text,
        )
        self.assertIn("scripts/resolve_github_animation_resume.py", text)
        self.assertIn('--field work-id', text)
        self.assertIn('--field provider', text)
        self.assertIn('--resume-modal-job-id "$seed_job_id"', text)
        self.assertIn('--resume-modal-checkpoint-id "$seed_checkpoint_id"', text)
        self.assertIn('--resume-job-dir "$seed_job_dir"', text)
        self.assertIn('"${resume_args[@]}"', text)
        self.assertIn('clip_id="reef-${CLIP}-${GITHUB_RUN_ID}"', text)


if __name__ == "__main__":
    unittest.main()
