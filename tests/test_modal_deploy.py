import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "deployment" / "modal_deploy.py"
SPEC = importlib.util.spec_from_file_location("modal_deploy", MODULE_PATH)
modal_deploy = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = modal_deploy
SPEC.loader.exec_module(modal_deploy)


class ModalDeployTest(unittest.TestCase):
    def test_deploy_streams_image_build_logs_through_the_supported_cli(self):
        with patch.object(modal_deploy, "run") as run:
            modal_deploy.deploy_app("dev")
        run.assert_called_once_with(
            "modal", "deploy", "--stream-logs", "--env", "dev", "modal/draft_trial.py",
        )
