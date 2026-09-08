import json
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "modal" / "infrastructure.py"


class InfrastructureContractTests(unittest.TestCase):
    def render(self, environment="dev"):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--environment", environment, "--check-files"],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)

    def test_contract_has_no_secret_values_and_connects_all_three_platforms(self):
        contract = self.render()
        self.assertEqual(contract["format"], "myth-maker.infrastructure.application-config/v1")
        self.assertEqual(contract["cloudflare"]["durable_object"]["migration_tag"], "v1")
        self.assertEqual(contract["railway"]["required_plain_configuration"]["MODAL_FUNCTION_NAME"], "run_draft")
        self.assertEqual(contract["railway"]["required_plain_configuration"]["MODAL_ADAPTER_CLASS"], "BlenderDraftWorkerAdapter")
        self.assertEqual(contract["modal"]["openai_secret_name"], "myth-maker-encounter-openai")
        self.assertEqual(contract["modal"]["openai_secret_keys"], ["OPENAI_API_KEY"])
        self.assertNotIn("openai_secret_value", json.dumps(contract))
        self.assertEqual(len(contract["connections"]), 2)
        self.assertIn("BlenderDraftWorkerAdapter", contract["connections"][1]["to"])

    def test_environment_changes_only_environment_scoped_names(self):
        contract = self.render("staging")
        self.assertEqual(contract["environment"], "staging")
        self.assertEqual(contract["cloudflare"]["worker_name"], "myth-maker-staging-encounter-runtime")
        self.assertEqual(contract["modal"]["environment"], "staging")

    def test_dev_contract_preserves_the_existing_worker_name(self):
        contract = self.render("dev")
        self.assertEqual(contract["cloudflare"]["worker_name"], "myth-maker-encounter-runtime")

    def test_invalid_environment_fails_without_side_effects(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--environment", "not valid"],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("lowercase kebab-case", result.stderr)


if __name__ == "__main__":
    unittest.main()
