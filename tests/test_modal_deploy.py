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
    def test_named_secret_is_force_refreshed_from_this_ci_run(self):
        with patch.dict(modal_deploy.os.environ, {"OPENAI_API_KEY": "test-key"}, clear=False), patch.object(modal_deploy, "json_command", return_value=[{"Name": modal_deploy.VOLUME_NAME}]), patch.object(modal_deploy, "run") as run:
            modal_deploy.ensure_named_resources("dev")
        self.assertIn(
            ("modal", "secret", "create", modal_deploy.SECRET_NAME, "--env", "dev"),
            [call.args[:6] for call in run.call_args_list],
        )
        secret_call = next(call for call in run.call_args_list if call.args[:3] == ("modal", "secret", "create"))
        self.assertIn("--force", secret_call.args)

    def test_failed_modal_deploy_preserves_original_output_without_unsupported_image_command(self):
        error = subprocess.CalledProcessError(
            1,
            ("modal", "deploy"),
            output="Image build for im-abc123 failed.",
            stderr="provider error top-secret",
        )
        with patch.dict(modal_deploy.os.environ, {"OPENAI_API_KEY": "top-secret"}, clear=False), patch.object(modal_deploy.sys, "stderr") as stderr:
            modal_deploy.emit_deploy_failure(error)
        rendered = "".join(str(call.args[0]) for call in stderr.write.call_args_list)
        self.assertIn("im-abc123", rendered)
        self.assertNotIn("MODAL_TOKEN", rendered)
        self.assertNotIn("top-secret", rendered)
