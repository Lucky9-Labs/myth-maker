import ast
import sys
import unittest
from pathlib import Path

MODAL_DIR = Path(__file__).parents[1] / "modal"
sys.path.insert(0, str(MODAL_DIR))
from draft_support import (KEY_ALIASES, blender_launch_args, budget_phase,
                           classify_model_stop, native_name, normalize_keys,
                           normalize_pointer_keys, render_prompt,
                           finalize_terminal_state, validate_input_names,
                           validate_typed_text)


INPUTS = {name: b"reference" for name in (
    "source_scene.blend", "structure_reference.png", "component_reference.png",
    "primary_artwork.png", "concept_reference.png")}


class DraftPolicyTests(unittest.TestCase):
    def test_terminal_state_keeps_the_original_error_when_receipt_cleanup_fails(self):
        state = {"status": "failed", "stop_reason": "runtime_error", "error": "provider authentication failed"}

        def unavailable_volume():
            raise RuntimeError("volume commit unavailable")

        self.assertIs(finalize_terminal_state(state, unavailable_volume), state)
        self.assertEqual(state["error"], "provider authentication failed")
        self.assertEqual(state["terminal_cleanup_error"], "volume commit unavailable")

    def test_draft_worker_uses_the_shared_terminal_failure_receipt_helper(self):
        tree = ast.parse((MODAL_DIR / "draft_trial.py").read_text())
        imported = {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module == "desktop_readiness"
            for alias in node.names
        }
        self.assertIn("terminal_failure", imported)

    def test_review_marker_never_self_accepts(self):
        for report in ("Looks done", "DRAFT_STATUS: PARTIAL", "DRAFT_STATUS: READY_FOR_REVIEW\nDRAFT_STATUS: PARTIAL"):
            self.assertEqual(classify_model_stop(report, True), "checkpointed_partial")
        self.assertEqual(classify_model_stop("DRAFT_STATUS: READY_FOR_REVIEW", True), "ready_for_review")
        self.assertEqual(classify_model_stop("DRAFT_STATUS: READY_FOR_REVIEW", False), "blocked")
        self.assertEqual(classify_model_stop("DRAFT_STATUS: BLOCKED", True), "blocked")

    def test_budget_caps_and_checkpoint_reserve(self):
        for field, cap in (("actions", 350), ("turns", 40), ("input_tokens", 650000), ("output_tokens", 20000)):
            self.assertEqual(budget_phase({field: cap}, 720), "exhausted")
        for field, reserve in (("actions", 270), ("turns", 32), ("input_tokens", 480000), ("output_tokens", 14000)):
            self.assertEqual(budget_phase({field: reserve}, 720), "checkpoint")

    def test_component_output_and_prompt_are_generic(self):
        template = (MODAL_DIR / "draft_prompt.md").read_text()
        prompt = render_prompt(template, "cryo-warden-arena")
        self.assertNotIn("{{", prompt)
        self.assertIn("cryo-warden-arena", prompt)
        self.assertIn("/output/cryo-warden-arena.blend", prompt)
        self.assertIn("is never acceptance", prompt)
        self.assertEqual(blender_launch_args(True, "cryo-warden-arena")[-1], "/output/cryo-warden-arena.blend")
        self.assertIn("--disable-autoexec", blender_launch_args(False, "cryo-warden-arena"))
        for invalid in ("../escape", "Boss", "", "x" * 65):
            with self.assertRaises(ValueError):
                native_name(invalid)

    def test_named_nonempty_input_contract_only(self):
        validate_input_names(INPUTS)
        altered = INPUTS | {"unexpected.png": b"bad"}
        with self.assertRaises(ValueError):
            validate_input_names(altered)

    def test_key_and_console_guards(self):
        for name, expected in KEY_ALIASES.items():
            self.assertEqual(normalize_keys([name]), [expected])
        self.assertEqual(normalize_pointer_keys(["shift", "RIGHT_MOUSE"]), (["shift"], "right"))
        for keys in (["SHIFT", "F4"], ["ALT", "F2"], ["CTRL", "ALT", "T"], ["UNKNOWN"], []):
            with self.assertRaises(ValueError):
                normalize_keys(keys)
        for text in ("import bpy", "exec('x')", "one\ntwo", "Python Console", "https://example.org", "x" * 513):
            with self.assertRaises(ValueError):
                validate_typed_text(text)

    def test_runner_preserves_hard_cap_and_no_retry_contract(self):
        text = (MODAL_DIR / "draft_trial.py").read_text()
        ast.parse(text)
        self.assertIn("MAX_SECONDS = 12 * 60", text)
        self.assertIn("retries=0", text)
        self.assertIn("max_retries=0", text)
        self.assertIn("skip_if_exists=True", text)
        self.assertIn("lease_key = project_id + \":\" + part", text)
        self.assertIn("part_leases.get(lease_key) == job_id", text)
        self.assertIn('modal.Image.from_registry("python:3.12-slim-bookworm")', text)
        self.assertIn('"xz-utils"', text)
        self.assertIn('.add_local_file(HERE / "install_blender.sh", "/opt/install_blender.sh", copy=True)', text)
        self.assertIn('.run_commands(\n             "/bin/sh /opt/install_blender.sh")', text)
        self.assertNotIn("modal.Image.debian_slim", text)
        self.assertIn('"infrastructure.py", "/opt/infrastructure.py"', text)
        self.assertNotIn("create_if_missing=True", text)
        self.assertNotIn("bpy.", text)

    def test_blender_archive_is_verified_before_it_can_cross_a_builder_step(self):
        text = (MODAL_DIR / "install_blender.sh").read_text()
        download = "curl --fail --location --retry 3 --retry-all-errors --silent --show-error"
        verification = "sha256sum --check --status"
        extraction = 'tar -C /opt -xf "$archive"'
        self.assertIn(download, text)
        self.assertIn(verification, text)
        self.assertIn(extraction, text)
        self.assertLess(text.index(download), text.index(verification))
        self.assertLess(text.index(verification), text.index(extraction))
        self.assertIn("Blender archive checksum mismatch: expected %s, actual %s, bytes %s", text)
        self.assertIn("a31f524fa99a527d3d52b7f5aaa68c34e1a19d5a1c9473f79c5cc610fd5b10e9", text)


if __name__ == "__main__":
    unittest.main()
