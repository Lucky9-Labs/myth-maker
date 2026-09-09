"""Focused checks for the generic deterministic Blender fallback."""
from __future__ import annotations

import json
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest


MODAL_DIR = Path(__file__).parents[1] / "modal"
WORKFLOW = Path(__file__).parents[1] / ".github" / "workflows" / "deploy.yml"
sys.path.insert(0, str(MODAL_DIR))

from deterministic_encounter import MATERIAL_NAMES, RECIPE_FORMAT, recipe_digest, validate_recipe
from glb_source_importer import BlenderCliGlbConverter, validate_glb


def recipe() -> dict:
    return {
        "format": RECIPE_FORMAT, "recipe_id": "tentacled-test",
        "body": {"scale": [1.5, 1.25, 1.2], "height": 1.2},
        "appendages": {"count": 4, "length": 2.2, "radius": 0.16, "curl": 0.7, "elevation": 0.15},
        "materials": {
            "body": [0.1, 0.2, 0.4, 1], "appendage": [0.2, 0.1, 0.3, 1],
            "accent": [1, 0.3, 0.05, 1], "ground": [0.02, 0.02, 0.04, 1],
        },
        "camera": {"location": [0, -9, 4.5], "target": [0, 0, 1], "resolution": [256, 192]},
    }


class DeterministicEncounterTests(unittest.TestCase):
    def test_recipe_is_closed_and_stably_hashed(self):
        checked = validate_recipe(recipe())
        self.assertEqual(checked["appendages"]["count"], 4)
        self.assertEqual(recipe_digest(checked), recipe_digest(recipe()))
        with self.assertRaisesRegex(ValueError, "invalid shape"):
            validate_recipe({**recipe(), "gameplay": "invented"})

    def test_observed_workflow_calls_the_secretless_function_and_retrieves_every_required_artifact(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        observer = workflow.split("  observed-deterministic-modal-blender:", 1)[1]
        worker = (MODAL_DIR / "draft_trial.py").read_text(encoding="utf-8")
        function = worker.split("def run_deterministic_recipe", 1)[1].split("def image_item", 1)[0]
        self.assertIn('FUNCTION_NAME = "run_deterministic_recipe"', (Path(__file__).parents[1] / "scripts" / "observed_modal_blender_demo.py").read_text())
        self.assertNotIn("OPENAI_API_KEY", observer)
        self.assertIn("needs: [assert-deployment-input, modal]", observer)
        self.assertIn("CI-owned deployment", workflow)
        self.assertIn("needs.assert-deployment-input.outputs.source_sha", observer)
        self.assertNotIn("workflow_run", observer)
        self.assertNotIn("secrets=[secret]", function)
        for filename in ("$WORK_ID.blend", "$WORK_ID.glb", "000-initial.png", "010-appendages.png", "020-final.png"):
            self.assertIn(filename, workflow)

    def test_modal_wrapper_runs_blender_and_commits_a_bound_receipt(self):
        class ChainImage:
            @classmethod
            def from_registry(cls, *_args, **_kwargs):
                return cls()

            def __getattr__(self, _name):
                return lambda *_args, **_kwargs: self

        class FakeApp:
            def __init__(self, *_args, **_kwargs):
                pass

            def function(self, **_kwargs):
                return lambda function: function

            def local_entrypoint(self, **_kwargs):
                return lambda function: function

        class FakeResource:
            @classmethod
            def from_name(cls, *_args, **_kwargs):
                return cls()

        fake_modal = types.SimpleNamespace(
            App=FakeApp, Image=ChainImage, Volume=FakeResource, Secret=FakeResource, Dict=FakeResource,
            current_function_call_id=lambda: "fc-proof", current_input_id=lambda: "in-proof")
        previous = sys.modules.get("modal")
        sys.modules["modal"] = fake_modal
        sys.path.insert(0, str(MODAL_DIR))
        try:
            spec = importlib.util.spec_from_file_location("draft_trial_wrapper_test", MODAL_DIR / "draft_trial.py")
            worker = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = worker
            spec.loader.exec_module(worker)
            self.addCleanup(sys.modules.pop, spec.name, None)
        finally:
            sys.path.remove(str(MODAL_DIR))
            if previous is None:
                del sys.modules["modal"]
            else:
                sys.modules["modal"] = previous

        class Volume:
            def __init__(self):
                self.reloaded = self.committed = False

            def reload(self):
                self.reloaded = True

            def commit(self):
                self.committed = True

        with tempfile.TemporaryDirectory(prefix="myth-maker-deterministic-wrapper-") as temporary:
            root, volume = Path(temporary), Volume()
            worker.SUBMISSIONS_ROOT, worker.volume = root, volume
            worker.modal = fake_modal
            worker.validate_glb = lambda data, **_kwargs: {"nodes": [{"name": "encounter-body"}] + [{"name": f"encounter-appendage-{index:02d}"} for index in range(4)], "materials": [{"name": "encounter-body"}]}
            worker._validate_deterministic_png = lambda _path: {"width": 256, "height": 192}
            worker.modal_volume_receipt = lambda **kwargs: {"provider": "modal", "function_name": kwargs["function_name"]}

            def fake_blender(command, **_kwargs):
                native = Path(command[command.index("--output") + 1])
                frames = Path(command[command.index("--frames") + 1])
                glb = Path(command[command.index("--glb") + 1])
                native.write_bytes(b"BLENDER" + b"x" * 64)
                glb.write_bytes(b"glTF" + b"x" * 32)
                frames.mkdir()
                for name in ("000-initial.png", "010-appendages.png", "020-final.png"):
                    (frames / name).write_bytes(b"png")
                return types.SimpleNamespace(returncode=0, stdout="built", stderr="")

            worker.subprocess = types.SimpleNamespace(run=fake_blender)
            state = worker.run_deterministic_recipe(
                "deterministic-wrapper-test", recipe(),
                {"source_sha": "a" * 40, "request_kind": "deterministic-encounter-recipe", "deployed_function_id": "fu-proof"})
            self.assertTrue(volume.reloaded and volume.committed)
            self.assertEqual(state["status"], "completed")
            self.assertFalse(state["provenance"]["openai_api_used"])
            self.assertEqual(state["provenance"]["deployed_function_id"], "fu-proof")
            self.assertEqual(state["glb_validation"]["appendage_count"], recipe()["appendages"]["count"])
            self.assertEqual(state["frame_validation"]["initial"], {"width": 256, "height": 192})
            self.assertEqual(set(state["provider_receipt"]["function_name"] for _ in [0]), {"run_deterministic_recipe"})

    @unittest.skipUnless(BlenderCliGlbConverter.discover(), "Blender CLI is unavailable")
    def test_real_blender_creates_native_glb_and_initial_intermediate_final_frames(self):
        blender = BlenderCliGlbConverter.discover()
        with tempfile.TemporaryDirectory(prefix="myth-maker-deterministic-recipe-") as temporary:
            root = Path(temporary)
            recipe_path, source, frames, glb = root / "recipe.json", root / "tentacled-test.blend", root / "frames", root / "tentacled-test.glb"
            recipe_path.write_text(json.dumps(recipe()), encoding="utf-8")
            completed = subprocess.run(
                [str(blender), "--background", "--factory-startup", "--disable-autoexec",
                 "--python", str(MODAL_DIR / "deterministic_encounter.py"), "--",
                 "--recipe", str(recipe_path), "--output", str(source), "--frames", str(frames), "--glb", str(glb)],
                capture_output=True, text=True, timeout=120, check=False)
            self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
            self.assertTrue(source.is_file(), completed.stdout + completed.stderr)
            self.assertTrue(glb.is_file(), completed.stdout + completed.stderr)
            self.assertTrue(all((frames / name).is_file()
                                for name in ("000-initial.png", "010-appendages.png", "020-final.png")))
            document = validate_glb(glb.read_bytes(), material_allowlist=list(MATERIAL_NAMES), extension_allowlist=[])
            self.assertGreaterEqual(len(document.get("nodes", [])), 7)
            self.assertTrue({"encounter-body", *[f"encounter-appendage-{index:02d}" for index in range(4)]}.issubset(
                {item.get("name") for item in document.get("nodes", [])}))
            self.assertIn("encounter-body", [item.get("name") for item in document.get("materials", [])])


if __name__ == "__main__":
    unittest.main()
