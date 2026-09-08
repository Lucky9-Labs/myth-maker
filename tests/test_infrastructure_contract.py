import json
from pathlib import Path
import re
import subprocess
import sys
import unittest


ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / "modal" / "infrastructure.py"
TERRAFORM_MAIN = ROOT / "infra" / "terraform" / "main.tf"
WORKER_SOURCE = ROOT / "src" / "worker.js"


def configured_module_sources():
    text = TERRAFORM_MAIN.read_text()
    return {
        match.group(1): ROOT / "src" / match.group(2)
        for match in re.finditer(
            r'name\s+=\s+"([^\"]+)"\s+content_type\s+=\s+"application/javascript\+module"\s+content_file\s+=\s+"\$\{path\.module\}/\.\./\.\./src/([^\"]+)"',
            text,
        )
    }


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
        self.assertEqual(contract["railway"]["required_plain_configuration"]["COORDINATOR_WORK_ID_HEADER"], "x-work-id")
        self.assertEqual(contract["modal"]["openai_secret_name"], "myth-maker-encounter-openai")
        self.assertEqual(contract["modal"]["openai_secret_keys"], ["OPENAI_API_KEY"])
        self.assertNotIn("openai_secret_value", json.dumps(contract))
        self.assertEqual(len(contract["connections"]), 2)
        self.assertIn("x-work-id", contract["connections"][0]["rule"])
        self.assertIn("BlenderDraftWorkerAdapter", contract["connections"][1]["to"])
        self.assertEqual(contract["railway"]["receiver"]["token_secret_name"], "WORK_DISPATCH_TOKEN")
        self.assertEqual(contract["ci_deployment_controller"]["deployment_owner"], "ci-only")

    def test_cloudflare_bundle_resolves_imports_and_matches_runtime_bindings(self):
        modules = configured_module_sources()
        self.assertEqual(set(modules), {"worker.js", "encounter-package-assembler.js", "responses-steering.js"})
        for name, source in modules.items():
            self.assertTrue(source.is_file(), f"configured module {name} must exist")
            for relative_import in re.findall(r'from\s+["\'](\.[^"\']+)["\']', source.read_text()):
                imported = (source.parent / relative_import).resolve()
                self.assertIn(imported, modules.values(), f"{name} imports unbundled {relative_import}")

        runtime_bindings = set(re.findall(r"env\.(WORK_DISPATCH_(?:URL|TOKEN))", WORKER_SOURCE.read_text()))
        terraform_bindings = set(re.findall(r'name\s+=\s+"(WORK_DISPATCH_(?:URL|TOKEN))"', TERRAFORM_MAIN.read_text()))
        contract = self.render()
        contract_bindings = set(contract["cloudflare"]["required_plain_configuration"])
        contract_bindings.update(contract["cloudflare"]["required_secret_names"])
        self.assertEqual(runtime_bindings, {"WORK_DISPATCH_URL", "WORK_DISPATCH_TOKEN"})
        self.assertEqual(runtime_bindings, terraform_bindings)
        self.assertEqual(runtime_bindings, runtime_bindings & contract_bindings)

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
