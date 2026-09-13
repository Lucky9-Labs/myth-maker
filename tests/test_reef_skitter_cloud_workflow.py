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


if __name__ == "__main__":
    unittest.main()
