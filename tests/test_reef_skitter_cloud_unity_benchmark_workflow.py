from pathlib import Path
import unittest


ROOT = Path(__file__).parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "reef-skitter-cloud-unity-benchmark.yml"


class ReefSkitterCloudUnityBenchmarkWorkflowTests(unittest.TestCase):
    def test_is_manual_cloud_gpu_macos_only(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("workflow_dispatch:", text)
        self.assertIn("runs-on: macos-15-xlarge", text)
        self.assertIn("if: github.ref == 'refs/heads/main'", text)
        self.assertNotIn("self-hosted", text)
        self.assertNotIn("ubuntu-", text)
        self.assertIn("timeout-minutes: 90", text)

    def test_binds_exact_successful_integration_artifact_and_glb(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        for field in (
            "integration_run_id:",
            "integration_run_attempt:",
            "integration_head_sha:",
            "integration_artifact_digest:",
            "integrated_glb_sha256:",
        ):
            self.assertIn(field, text)
        self.assertEqual(text.count("required: true"), 5)
        self.assertIn('.conclusion == "success"', text)
        self.assertIn('.path == ".github/workflows/reef-skitter-cloud-integration.yml"', text)
        self.assertIn(".digest == $digest", text)
        self.assertIn("ref: ${{ github.sha }}", text)
        self.assertNotIn("ref: ${{ inputs.integration_head_sha }}", text)
        self.assertIn("name: reef-skitter-animation-candidate-${{ inputs.integration_run_id }}-${{ inputs.integration_run_attempt }}", text)
        self.assertIn("scripts/verify_cloud_gui_animation_artifacts.py", text)
        self.assertIn("scripts/inspect-animated-parted-glb.mjs", text)
        self.assertIn('.parts == 15 and .skinned_parts == 15', text)
        self.assertIn('["attack", "death", "idle", "run", "walk"]', text)

    def test_activates_exact_unity_only_from_protected_secrets(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("environment: dev", text)
        self.assertIn("UNITY_VERSION: 6000.6.0f1", text)
        self.assertIn("UNITY_CHANGESET: f7f8ed4d1e24", text)
        for secret in ("UNITY_EMAIL", "UNITY_PASSWORD", "UNITY_SERIAL"):
            self.assertIn(f"{secret}: ${{{{ secrets.{secret} }}}}", text)
            self.assertIn(f'test -n "${secret}"', text)
        self.assertIn('--version "$UNITY_VERSION" --changeset "$UNITY_CHANGESET"', text)
        self.assertIn('-serial "$UNITY_SERIAL" -username "$UNITY_EMAIL" -password "$UNITY_PASSWORD"', text)
        self.assertIn("-returnlicense", text)

    def test_runs_player_and_metal_harness_then_fail_closed_verifier(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("run-reef-skitter-swarm-benchmark.sh", text)
        self.assertIn("run-reef-skitter-metal-trace.sh", text)
        self.assertIn("verify-reef-skitter-cloud-benchmark.mjs", text)
        for argument in (
            "--benchmark",
            "--screenshot",
            "--metal-receipt",
            "--metal-intervals",
            "--metal-benchmark",
            "--metal-screenshot",
            "--integration-run",
            "--integration-artifact",
            "--animation-inspection",
            "--expected-source-sha256",
        ):
            self.assertIn(argument, text)

    def test_uploads_source_player_metal_and_acceptance_separately(self):
        text = WORKFLOW.read_text(encoding="utf-8")

        for name in (
            "reef-skitter-unity-source-",
            "reef-skitter-unity-player-",
            "reef-skitter-unity-metal-",
            "reef-skitter-unity-acceptance-",
        ):
            self.assertEqual(text.count(f"name: {name}"), 1)
        self.assertEqual(text.count("actions/upload-artifact@"), 4)
        self.assertIn("if: success()", text)


if __name__ == "__main__":
    unittest.main()
