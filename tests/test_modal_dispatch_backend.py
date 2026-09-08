import hashlib
from pathlib import Path
import sys
import unittest


MODAL_DIR = Path(__file__).parents[1] / "modal"
sys.path.insert(0, str(MODAL_DIR))
from modal_dispatch_backend import ModalDraftBackend


def work_order(attempt=2):
    return {
        "schema_version": "1", "work_id": "tideglass-body-source", "encounter_id": "tideglass-reef",
        "lane": "body-source", "deadline_at": "2026-09-09T12:00:00Z",
        "requested_provides": ["encounter.body.source"], "input_module_ids": [], "depends_on_work_ids": [],
        "attempt": attempt, "instruction": "Create a source candidate through the GUI only.",
        "host_capabilities": {"schema_version": "1", "host_id": "demo-host", "host_build": "2026.09.08",
            "platform": "linux", "scripting_backend": "il2cpp", "execution_kinds": ["recipe"],
            "loaders": ["recipe-loader"], "contracts": ["encounter-module.v1"],
            "limits": {"memory_mb": 2048, "preload_seconds": 30}},
    }


def inputs():
    return {
        "source_scene.blend": b"source", "structure_reference.png": b"structure",
        "component_reference.png": b"component", "primary_artwork.png": b"primary",
        "concept_reference.png": b"concept",
    }


class ModalDraftBackendTests(unittest.TestCase):
    def test_preflight_is_dry_run_and_derives_the_existing_entrypoint_arguments(self):
        backend = ModalDraftBackend(project_id="myth-maker", inputs=inputs(), provenance={"source": "test"})

        plan = backend.preflight(work_order())

        self.assertEqual(plan, {
            "backend": "modal-draft", "mode": "dry-run", "entrypoint": "draft_trial.run_draft.remote",
            "work_id": "tideglass-body-source", "part": "tideglass-body-source",
            "job_id": "draft-gui-tideglass-body-source-a2", "cloud_launch": False,
        })

    def test_cloud_execution_requires_explicit_opt_in_and_keeps_work_id_stable(self):
        captured = {}
        native = b"native"
        digest = hashlib.sha256(native).hexdigest()

        def invoke(*args, **kwargs):
            captured["args"], captured["kwargs"] = args, kwargs
            return {"status": "checkpointed_partial", "files": {
                "tideglass-body-source.blend": {"sha256": digest, "bytes": len(native)}}}

        backend = ModalDraftBackend(project_id="myth-maker", inputs=inputs(), provenance={"source": "test"}, invoke=invoke)
        with self.assertRaisesRegex(PermissionError, "explicit cloud opt-in"):
            backend.run(work_order())

        result = backend.run(work_order(), allow_cloud_launch=True)
        self.assertEqual(captured["args"][0], "draft-gui-tideglass-body-source-a2")
        self.assertEqual(captured["args"][3:5], ("myth-maker", "tideglass-body-source"))
        self.assertEqual(result.events[-1]["kind"], "completed")


if __name__ == "__main__":
    unittest.main()
