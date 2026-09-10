import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "deployment" / "modal_deploy.py"
SPEC = importlib.util.spec_from_file_location("modal_deploy", MODULE_PATH)
modal_deploy = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = modal_deploy
SPEC.loader.exec_module(modal_deploy)


class ModalDeployTest(unittest.TestCase):
    def test_deployment_verifies_asset_production_and_critique_functions(self):
        source = MODULE_PATH.read_text(encoding="utf-8")
        self.assertIn('ASSET_PRODUCTION_FUNCTION = "run_asset_production_job"', source)
        self.assertIn('ASSET_CRITIQUE_FUNCTION = "run_asset_visual_critique"', source)
        self.assertIn('ASSET_LEDGER_FUNCTION = "record_asset_production_run"', source)
        self.assertIn('"max_asset_production_containers": 4', source)

    def test_scheduled_refresh_serializes_reference_evaluation(self):
        source = (MODULE_PATH.parents[2] / "modal" / "draft_trial.py").read_text(encoding="utf-8")
        scheduled = source.split("def refresh_asset_progress_dashboards()", 1)[1].split(
            "def evaluate_asset_reference_progress", 1
        )[0]
        self.assertIn("evaluate_asset_reference_progress.remote(run_root.name)", scheduled)
        self.assertNotIn("evaluate_reference_progress(run_root, OpenAI())", scheduled)

    def test_named_secret_is_force_refreshed_from_this_ci_run(self):
        with patch.dict(modal_deploy.os.environ, {"OPENAI_API_KEY": "test-key"}, clear=False), patch.object(modal_deploy, "json_command", return_value=[{"Name": modal_deploy.VOLUME_NAME}]), patch.object(modal_deploy, "run") as run:
            modal_deploy.ensure_named_resources("dev")
        self.assertIn(
            ("modal", "secret", "create", modal_deploy.SECRET_NAME, "--env", "dev"),
            [call.args[:6] for call in run.call_args_list],
        )
        secret_call = next(call for call in run.call_args_list if call.args[:3] == ("modal", "secret", "create"))
        self.assertIn("--force", secret_call.args)

    def test_app_observation_accepts_current_lowercase_cli_json_keys(self):
        app = modal_deploy.deployed_app([
            {"app_id": "ap-old", "description": modal_deploy.APP_NAME, "state": "stopped"},
            {"app_id": "ap-current", "description": modal_deploy.APP_NAME, "state": "deployed"},
        ])
        self.assertEqual(modal_deploy.item_value(app, "App ID", "app_id"), "ap-current")
        self.assertEqual(modal_deploy.item_value({"version": "v-current"}, "Version", "version"), "v-current")

    def test_resource_bootstrap_accepts_current_lowercase_cli_json_keys(self):
        with patch.dict(modal_deploy.os.environ, {"OPENAI_API_KEY": "test-key"}, clear=False), patch.object(modal_deploy, "json_command", return_value=[{"name": modal_deploy.VOLUME_NAME}]), patch.object(modal_deploy, "run") as run:
            modal_deploy.ensure_named_resources("dev")
        self.assertFalse(any(call.args[:3] == ("modal", "volume", "create") for call in run.call_args_list))
        self.assertIn("--force", next(call for call in run.call_args_list if call.args[:3] == ("modal", "secret", "create")).args)

    def test_failed_modal_deploy_fetches_only_the_reported_image_build_logs(self):
        error = subprocess.CalledProcessError(
            1,
            ("modal", "deploy"),
            output="Image build for im-abc123 failed.",
            stderr="provider error",
        )
        logs = subprocess.CompletedProcess(
            ("modal", "image", "logs", "im-abc123", "--all"),
            0,
            stdout="failing layer output\n",
            stderr="",
        )
        with patch.object(modal_deploy.subprocess, "run", return_value=logs) as run, patch.object(modal_deploy.sys, "stderr") as stderr:
            modal_deploy.emit_failed_image_logs(error)
        run.assert_called_once_with(
            ("modal", "image", "logs", "im-abc123", "--all"),
            text=True,
            capture_output=True,
            check=False,
        )
        rendered = "".join(str(call.args[0]) for call in stderr.write.call_args_list)
        self.assertIn("im-abc123", rendered)
        self.assertNotIn("MODAL_TOKEN", rendered)

    def test_failed_modal_deploy_reports_redacted_cli_error_without_an_image_id(self):
        error = subprocess.CalledProcessError(1, ("modal", "deploy"), stderr="failed for token-sensitive-value")
        with patch.dict(modal_deploy.os.environ, {"MODAL_TOKEN_SECRET": "sensitive-value"}, clear=False), patch.object(modal_deploy.subprocess, "run") as run, patch.object(modal_deploy.sys, "stderr") as stderr:
            modal_deploy.emit_failed_image_logs(error)
        run.assert_not_called()
        rendered = "".join(str(call.args[0]) for call in stderr.write.call_args_list)
        self.assertIn("Modal deploy failure context", rendered)
        self.assertIn("[REDACTED]", rendered)
        self.assertNotIn("sensitive-value", rendered)
