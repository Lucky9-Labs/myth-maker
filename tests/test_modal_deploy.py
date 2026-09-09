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
    def test_resource_bootstrap_accepts_current_lowercase_cli_json_keys(self):
        resources = [
            [{"name": modal_deploy.VOLUME_NAME}],
            [{"name": modal_deploy.SECRET_NAME}],
        ]
        with patch.object(modal_deploy, "json_command", side_effect=resources), patch.object(modal_deploy, "run") as run:
            modal_deploy.ensure_named_resources("dev")
        run.assert_called_once_with("modal", "dict", "create", modal_deploy.DICT_NAME, "--env", "dev")

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
