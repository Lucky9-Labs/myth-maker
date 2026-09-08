import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parents[1] / "modal"))
from draft_checkpoints import CheckpointStore, handoff_text, load_resume, load_terminal_artifact, sha256, validate_native


REFS = {name: b"reference" for name in (
    "structure_reference.png", "component_reference.png",
    "primary_artwork.png", "concept_reference.png")}
BLEND = b"BLENDER-v520" + b"x" * 64
COMPONENT = "cryo-warden-arena"


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "draft-gui-cryo-warden-arena-test"
        (self.root / "output").mkdir(parents=True)
        (self.root / "output" / (COMPONENT + ".blend")).write_bytes(BLEND)
        self.store = CheckpointStore(self.root, REFS, "original goal", {"runner": {"release": "test"}}, COMPONENT)

    def state(self):
        return {"status": "checkpointed_partial", "turns": 9, "stop_reason": "budget_limit",
                "model_report": "Keep the arena pillars. Fix the spawn interfaces.", "acceptance": "not reviewed"}

    def test_handoff_is_component_specific_and_not_acceptance(self):
        note = handoff_text({"part": COMPONENT, "status": "checkpointed_partial"})
        self.assertIn("Assigned component: " + COMPONENT, note)
        self.assertIn("encounter integration queue", note)
        self.assertIn("not completed evidence", note)

    def test_roundtrip_keeps_goal_references_and_handoff(self):
        manifest = self.store.capture(self.state())
        result = load_resume(self.root, part=COMPONENT)
        self.assertEqual(result["blend"], BLEND)
        self.assertEqual(result["inputs"], REFS)
        self.assertEqual(result["goal"], "original goal")
        self.assertIn("Fix the spawn interfaces", result["handoff"])
        self.assertEqual(result["parent"]["checkpoint_id"], manifest["checkpoint_id"])

    def test_aliases_are_rejected_for_a_fresh_contract(self):
        with self.assertRaisesRegex(ValueError, "aliases"):
            CheckpointStore(self.root, REFS, "goal", {}, COMPONENT,
                            input_aliases={"old_reference.png": b"reference"})

    def test_checkpoint_is_immutable_and_corruption_fails_closed(self):
        first = self.store.capture(self.state())
        (self.root / "output" / (COMPONENT + ".blend")).write_bytes(BLEND + b"next")
        second = self.store.capture(self.state())
        self.assertNotEqual(first["checkpoint_id"], second["checkpoint_id"])
        self.assertEqual(load_resume(self.root, first["checkpoint_id"], part=COMPONENT)["blend"], BLEND)
        ref = self.root / "checkpoints" / second["checkpoint_id"] / "inputs/primary_artwork.png"
        ref.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "hash"):
            load_resume(self.root, part=COMPONENT)

    def test_resume_refuses_active_cross_component_and_reviewed_parent(self):
        self.store.capture(self.state())
        with self.assertRaisesRegex(ValueError, "mismatch"):
            load_resume(self.root, part="different-component")
        (self.root / "status.json").write_text(json.dumps({"status": "running"}))
        with self.assertRaisesRegex(ValueError, "active"):
            load_resume(self.root, part=COMPONENT)
        (self.root / "status.json").write_text(json.dumps({"status": "ready_for_review", "independent_visual_score": 4}))
        with self.assertRaisesRegex(ValueError, "local queue"):
            load_resume(self.root, part=COMPONENT)

    def test_terminal_artifact_resume_verifies_exact_hash_and_inputs(self):
        root = Path(self.temp.name) / "draft-gui-terminal"
        (root / "output").mkdir(parents=True)
        (root / "inputs").mkdir()
        (root / "output/Untitled.blend").write_bytes(BLEND)
        inputs = {"source_scene.blend": BLEND, **REFS}
        for name, data in inputs.items():
            (root / "inputs" / name).write_bytes(data)
        (root / "status.json").write_text(json.dumps({"part": COMPONENT, "status": "blocked"}))
        (root / "provenance.json").write_text(json.dumps({"files": {name: {"sha256": sha256(data)} for name, data in inputs.items()}}))
        result = load_terminal_artifact(root, "Untitled.blend", sha256(BLEND), part=COMPONENT)
        self.assertEqual(result["blend"], BLEND)
        self.assertEqual(result["inputs"]["source_scene.blend"], BLEND)
        with self.assertRaisesRegex(ValueError, "hash"):
            load_terminal_artifact(root, "Untitled.blend", "0" * 64, part=COMPONENT)

    def test_native_magic_validation(self):
        validate_native(bytes.fromhex("28b52ffd") + b"x" * 64)
        with self.assertRaises(ValueError):
            validate_native(b"not a blend" * 20)


if __name__ == "__main__":
    unittest.main()
