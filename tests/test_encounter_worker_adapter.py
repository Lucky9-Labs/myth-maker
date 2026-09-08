import hashlib
from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest


MODAL_DIR = Path(__file__).parents[1] / "modal"
sys.path.insert(0, str(MODAL_DIR))
from encounter_worker_adapter import BlenderDraftWorkerAdapter
from modal_draft_runner import ModalDraftRunner


def work_order(*, attempt=1):
    return {
        "schema_version": "1",
        "work_id": "arena-body-draft",
        "encounter_id": "frozen-citadel",
        "lane": "body",
        "deadline_at": "2026-09-09T12:00:00Z",
        "requested_provides": ["encounter.body"],
        "host_capabilities": {
            "schema_version": "1",
            "host_id": "mech-demo",
            "host_build": "2026.09.08",
            "platform": "linux",
            "scripting_backend": "il2cpp",
            "execution_kinds": ["recipe"],
            "loaders": ["asset-bundle"],
            "contracts": ["encounter-module.v1"],
            "limits": {"memory_mb": 2048, "preload_seconds": 30, "artifact_bytes": 50000000},
        },
        "input_module_ids": ["arena-envelope"],
        "depends_on_work_ids": [],
        "resource_leases": ["drafting.arena-body"],
        "attempt": attempt,
        "instruction": "Draft the scene through Blender's visible GUI only.",
    }


class BlenderDraftWorkerAdapterTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 8, 18, 0, tzinfo=timezone.utc)
        self.blend = b"BLENDER-v520" + b"x" * 64
        self.digest = hashlib.sha256(self.blend).hexdigest()

    def adapter(self, runner):
        return BlenderDraftWorkerAdapter("modal-blender-1", runner, clock=lambda: self.now)

    def test_emits_ordered_candidate_lifecycle_with_content_addressed_metadata(self):
        received = []

        def runner(order):
            received.append(order)
            return {
                "status": "checkpointed_partial",
                "files": {"arena-body-draft.blend": {"sha256": self.digest, "bytes": len(self.blend)}},
            }

        result = self.adapter(runner).run(work_order())
        events = result.events

        self.assertEqual(received, [work_order()])
        self.assertEqual([event["kind"] for event in events],
                         ["accepted", "started", "progress", "completed"])
        self.assertEqual([event["sequence"] for event in events], list(range(4)))
        self.assertTrue(all(event["work_id"] == "arena-body-draft" for event in events))
        self.assertTrue(all(event["occurred_at"] == "2026-09-08T18:00:00Z" for event in events))

        self.assertTrue(all("module" not in event for event in events))
        self.assertEqual(events[2]["progress"], 1)
        self.assertIsNotNone(result.source_artifact)
        self.assertEqual(result.source_artifact.to_record(), {
            "work_id": "arena-body-draft",
            "worker_id": "modal-blender-1",
            "created_at": "2026-09-08T18:00:00Z",
            "native_name": "arena-body-draft.blend",
            "parent_module_ids": ["arena-envelope"],
            "artifact": {
            "uri": "sha256:" + self.digest,
            "sha256": self.digest,
            "media_type": "application/x-blender",
            "byte_length": len(self.blend),
            },
        })
        self.assertIn("no EncounterModule candidate", events[-1]["message"])

    def test_failure_receipt_makes_retry_a_coordinator_decision(self):
        events = self.adapter(lambda _: {"status": "failed", "error": "desktop stopped", "files": {}}).run(work_order(attempt=2)).events

        self.assertEqual([event["kind"] for event in events], ["accepted", "started", "failed"])
        failed = events[-1]
        self.assertEqual(failed["error_code"], "draft-runtime-error")
        self.assertTrue(failed["retryable"])
        self.assertIn("attempt=3", failed["message"])

    def test_missing_native_receipt_fails_without_claiming_a_candidate(self):
        events = self.adapter(lambda _: {"status": "checkpointed_partial", "files": {}}).run(work_order()).events

        self.assertEqual([event["kind"] for event in events], ["accepted", "started", "failed"])
        self.assertEqual(events[-1]["error_code"], "native-artifact-missing")
        self.assertTrue(events[-1]["retryable"])

    def test_blocked_worker_is_terminal_and_not_retried_automatically(self):
        events = self.adapter(lambda _: {"status": "blocked", "stop_reason": "checkpoint_failed", "files": {}}).run(work_order()).events

        self.assertEqual(events[-1]["kind"], "failed")
        self.assertEqual(events[-1]["error_code"], "draft-blocked")
        self.assertFalse(events[-1]["retryable"])
        self.assertIn("does not retry", events[-1]["message"])

    def test_runner_exception_becomes_an_explicit_retryable_failure(self):
        def runner(_):
            raise RuntimeError("lease conflict")

        events = self.adapter(runner).run(work_order()).events

        self.assertEqual([event["kind"] for event in events], ["accepted", "started", "failed"])
        self.assertEqual(events[-1]["error_code"], "draft-runner-error")
        self.assertTrue(events[-1]["retryable"])

    def test_accepts_a_v1_work_order_without_assuming_its_runtime_loader(self):
        order = work_order()
        order["host_capabilities"]["execution_kinds"] = ["runtime_asset"]

        result = self.adapter(lambda _: {"status": "failed", "files": {}}).run(order)

        self.assertEqual(result.events[-1]["error_code"], "draft-runtime-error")

    def test_rejects_invalid_closed_v1_shapes_before_invoking_draft_runner(self):
        invoked = []
        invalid_orders = []
        duplicate_inputs = work_order()
        duplicate_inputs["input_module_ids"] = ["arena-envelope", "arena-envelope"]
        invalid_orders.append(duplicate_inputs)
        missing_host_field = work_order()
        del missing_host_field["host_capabilities"]["host_id"]
        invalid_orders.append(missing_host_field)
        extra_limit = work_order()
        extra_limit["host_capabilities"]["limits"]["unknown"] = 1
        invalid_orders.append(extra_limit)
        malformed_deadline = work_order()
        malformed_deadline["deadline_at"] = "2026-09-09"
        invalid_orders.append(malformed_deadline)

        adapter = self.adapter(lambda _: invoked.append(True))
        for order in invalid_orders:
            with self.assertRaises(ValueError):
                adapter.run(order)
        self.assertEqual(invoked, [])

    def test_modal_binding_maps_work_id_to_legacy_part_and_output_name(self):
        captured = {}

        def invoke(*args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            return {"status": "checkpointed_partial", "files": {
                "arena-body-draft.blend": {"sha256": self.digest, "bytes": len(self.blend)}}}

        runner = ModalDraftRunner(invoke, project_id="myth-project",
                                  inputs={"source_scene.blend": self.blend},
                                  provenance={"request_source": "test"})
        result = self.adapter(runner).run(work_order())

        self.assertEqual(captured["args"][0], "draft-gui-arena-body-draft-a1")
        self.assertEqual(captured["args"][3:5], ("myth-project", "arena-body-draft"))
        self.assertEqual(captured["kwargs"]["feedback"], work_order()["instruction"])
        self.assertEqual(captured["args"][2]["encounter_work_order"]["work_id"], "arena-body-draft")
        self.assertEqual(result.source_artifact.native_name, "arena-body-draft.blend")


if __name__ == "__main__":
    unittest.main()
