from pathlib import Path
import unittest


WORKFLOW = (
    Path(__file__).parents[1]
    / ".github"
    / "workflows"
    / "reef-skitter-cloud-integration.yml"
)


class ReefSkitterCloudIntegrationWorkflowTests(unittest.TestCase):
    def test_dispatch_is_integration_only_and_requires_exact_source_runs(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("modal_deployment_run_id:", text)
        self.assertIn("source_animation_run_id:", text)
        self.assertEqual(text.count("required: true"), 2)
        self.assertIn("integrate-and-verify:", text)
        self.assertNotIn("\n  rig:\n", text)
        self.assertNotIn("\n  clips:\n", text)

    def test_downloads_the_exact_deployment_and_cross_run_animation_artifacts(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertEqual(text.count("github-token: ${{ github.token }}"), 3)
        self.assertIn("run-id: ${{ inputs.modal_deployment_run_id }}", text)
        self.assertIn("pattern: deployment-receipt-modal-dev-${{ github.sha }}", text)
        self.assertEqual(text.count("run-id: ${{ inputs.source_animation_run_id }}"), 2)
        self.assertIn(
            "pattern: reef-skitter-rig-${{ inputs.source_animation_run_id }}-*",
            text,
        )
        self.assertIn(
            "pattern: reef-skitter-clip-*-${{ inputs.source_animation_run_id }}-*",
            text,
        )

    def test_resolves_prior_run_work_ids_from_immutable_artifacts(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("SOURCE_ANIMATION_RUN_ID: ${{ inputs.source_animation_run_id }}", text)
        self.assertIn(
            'rig_id="$(python3 scripts/resolve_github_animation_work_id.py '
            '"$rig_receipt" --prefix reef-rig-)"',
            text,
        )
        self.assertIn('clip_id="reef-${clip}-${SOURCE_ANIMATION_RUN_ID}"', text)
        self.assertNotIn("needs.", text)

    def test_runs_only_cloud_integration_and_preserves_all_proof_gates(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertEqual(text.count("scripts/run_cloud_gui_animation_job.py"), 1)
        self.assertEqual(text.count("MODAL_TOKEN_ID: ${{ secrets.MODAL_TOKEN_ID }}"), 1)
        self.assertIn("--deployment-receipt deployment-receipt/modal-dev.json", text)
        self.assertIn("Append only the Action from each of the five immutable dependency blend files", text)
        self.assertIn("Reopen the saved integrated blend through the GUI", text)
        self.assertIn("export an animated GLB through File > Export > glTF 2.0", text)
        self.assertIn("reimport that GLB through File > Import > glTF 2.0", text)
        self.assertIn("scripts/verify_cloud_gui_animation_artifacts.py", text)
        self.assertIn("scripts/inspect_blender_animation.py", text)
        self.assertIn("scripts/inspect-animated-parted-glb.mjs", text)
        self.assertIn("name: reef-skitter-animation-candidate-${{ github.run_id }}-${{ github.run_attempt }}", text)


if __name__ == "__main__":
    unittest.main()
