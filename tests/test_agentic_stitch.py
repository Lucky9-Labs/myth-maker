from pathlib import Path
import hashlib
import json
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / "modal"))

from agentic_stitch import (  # noqa: E402
    FORMAT,
    PLAN_FORMAT,
    close_agentic_stitch_job,
    run_agentic_stitch,
    validate_agentic_stitch_job,
)


def artifact(name: str, digest: str) -> dict:
    return {
        "path": f"asset-production/pilot/components/{name}.glb",
        "bytes": 42,
        "sha256": digest * 64,
        "media_type": "model/gltf-binary",
    }


def job() -> dict:
    transform = {"location_m": [0, 0, 0], "rotation_degrees": [0, 0, 0], "scale": [1, 1, 1]}
    components = [
        {"component_id": "torso", "artifact": artifact("torso", "a")},
        {"component_id": "cockpit-glass", "artifact": artifact("glass", "b")},
        {"component_id": "pelvis", "artifact": artifact("pelvis", "c")},
    ]
    connections = [
        {
            "connection_id": "torso-glass",
            "from_component": "torso",
            "from_interface": "cockpit-recess",
            "from_anchor_local_m": [0, -0.4, 0.3],
            "from_path_local_m": [[-0.2, -0.4, 0.1], [0, -0.4, 0.3], [0.2, -0.4, 0.1]],
            "to_component": "cockpit-glass",
            "to_interface": "glass-rim",
            "to_anchor_local_m": [0, 0.1, 0],
            "to_path_local_m": [[-0.2, 0.1, -0.2], [0, 0.1, 0], [0.2, 0.1, -0.2]],
            "path_closed": False,
            "method": "reshape-and-bridge",
            "connector": {"radius_m": 0.12, "collar_length_m": 0.04, "clearance_m": 0.002},
            "max_gap_m": 0.002,
        },
        {
            "connection_id": "torso-pelvis",
            "from_component": "torso",
            "from_interface": "waist-land",
            "from_anchor_local_m": [0, 0, -0.8],
            "from_path_local_m": [[-0.2, 0, -0.8], [0, 0, -0.8], [0.2, 0, -0.8]],
            "to_component": "pelvis",
            "to_interface": "spine-seat",
            "to_anchor_local_m": [0, 0, 0.4],
            "to_path_local_m": [[-0.2, 0, 0.4], [0, 0, 0.4], [0.2, 0, 0.4]],
            "path_closed": False,
            "method": "socket-fit",
            "connector": {"radius_m": 0.2, "collar_length_m": 0.1, "clearance_m": 0.003},
            "max_gap_m": 0.003,
        },
    ]
    plan = {
        "format": PLAN_FORMAT,
        "plan_id": "mech-global-stitch-v1",
        "author": {"model": "gpt-6-astra", "request_id": "resp-123"},
        "objective": "Jointly fit and close the torso section while preserving articulation.",
        "component_ids": ["torso", "cockpit-glass", "pelvis"],
        "placements": [
            {"component_id": component["component_id"], "initial_transform": transform, "max_translation_m": 1.0}
            for component in components
        ],
        "sections": [
            {
                "section_id": "central-body",
                "component_ids": ["torso", "cockpit-glass", "pelvis"],
                "target_role": "connected torso, cockpit enclosure, and waist interface",
            }
        ],
        "connections": connections,
        "operations": [
            {
                "operation_id": "fit-central-body",
                "order": 1,
                "operation": "reshape",
                "section_id": "central-body",
                "connection_ids": ["torso-glass", "torso-pelvis"],
                "instructions": "Reshape all three neighboring shells together to establish shared lands.",
            },
            {
                "operation_id": "close-central-body",
                "order": 2,
                "operation": "bridge-seam",
                "section_id": "central-body",
                "connection_ids": ["torso-glass", "torso-pelvis"],
                "instructions": "Bridge both required interfaces and restore hard-surface edge flow.",
            },
        ],
        "acceptance": {
            "required_connection_ids": ["torso-glass", "torso-pelvis"],
            "max_unresolved_connections": 0,
            "max_surface_gap_m": 0.003,
            "require_single_connected_body": True,
            "require_manifold_required_seams": True,
            "require_articulation_clearance": True,
        },
    }
    return {
        "format": FORMAT,
        "run_id": "pilot-001",
        "work_id": "central-body-stitch-v1",
        "attempt": 1,
        "asset_id": "mech",
        "components": components,
        "retired_sha256": ["d" * 64],
        "objective": "Create a connected central body with repaired interfaces.",
        "model": "gpt-6-astra",
        "evidence": [{"path": "reference.png", "bytes": 10, "sha256": "e" * 64, "media_type": "image/png"}],
        "_test_plan": plan,
    }


def request() -> dict:
    value = job()
    value.pop("_test_plan")
    return value


def close(value: dict) -> dict:
    return close_agentic_stitch_job(
        run_id=value["run_id"], work_id=value["work_id"], attempt=value["attempt"],
        components=value["components"], retired_sha256=value["retired_sha256"],
        global_plan=value["_test_plan"],
    )


class Tests(unittest.TestCase):
    def test_closes_valid_model_authored_job(self):
        value = job()
        closed = close(value)
        self.assertEqual(closed["global_plan"], value["_test_plan"])

    def test_allows_descriptive_mesh_interface_selectors(self):
        value = job()
        value["_test_plan"]["connections"][0]["from_interface"] = (
            "Complete cockpit-mouth perimeter, including crown, jambs, and sill."
        )
        self.assertEqual(close(value)["global_plan"]["connections"][0]["from_interface"],
                         value["_test_plan"]["connections"][0]["from_interface"])

    def test_accepts_hash_locked_planning_request(self):
        self.assertEqual(validate_agentic_stitch_job(request()), request())

    def test_accepts_hash_locked_plan_for_zero_call_reexecution(self):
        value = request()
        value["accepted_plan"] = {
            "path": "asset-production/pilot/agentic-stitch/central/attempt-0005/plan.json",
            "bytes": 11427,
            "sha256": "d" * 64,
            "media_type": "application/json",
        }
        self.assertEqual(validate_agentic_stitch_job(value), value)

    def test_rejects_transform_only_loose_layout(self):
        value = job()
        value["_test_plan"]["operations"] = [{
            "operation_id": "place-parts",
            "order": 1,
            "operation": "align",
            "section_id": "central-body",
            "connection_ids": ["torso-glass", "torso-pelvis"],
            "instructions": "Place pieces near their expected locations.",
        }]
        with self.assertRaisesRegex(ValueError, "topology-changing"):
            close(value)

    def test_rejects_incomplete_disconnected_plan(self):
        value = job()
        value["_test_plan"]["connections"] = value["_test_plan"]["connections"][:1]
        value["_test_plan"]["operations"][0]["connection_ids"] = ["torso-glass"]
        value["_test_plan"]["operations"][1]["connection_ids"] = ["torso-glass"]
        value["_test_plan"]["acceptance"]["required_connection_ids"] = ["torso-glass"]
        with self.assertRaisesRegex(ValueError, "enough connections|connected"):
            close(value)

    def test_rejects_component_omitted_from_section(self):
        value = job()
        value["_test_plan"]["sections"][0]["component_ids"].remove("pelvis")
        with self.assertRaisesRegex(ValueError, "exactly one"):
            close(value)

    def test_rejects_unresolved_connection_allowance(self):
        value = job()
        value["_test_plan"]["acceptance"]["max_unresolved_connections"] = 1
        with self.assertRaisesRegex(ValueError, "close every required connection"):
            close(value)

    def test_rejects_unpaired_stitch_paths(self):
        value = job()
        value["_test_plan"]["connections"][0]["to_path_local_m"].pop()
        with self.assertRaisesRegex(ValueError, "connection is invalid"):
            close(value)

    def test_rejects_duplicate_operation_id(self):
        value = job()
        value["_test_plan"]["operations"][1]["operation_id"] = "fit-central-body"
        with self.assertRaisesRegex(ValueError, "operation is invalid"):
            close(value)

    def test_rejects_retired_or_mutable_component_selection(self):
        value = job()
        value["retired_sha256"] = ["a" * 64]
        with self.assertRaisesRegex(ValueError, "retired"):
            close(value)

    def test_rejects_non_model_authored_plan(self):
        value = job()
        value["_test_plan"]["author"] = {"model": "", "request_id": ""}
        with self.assertRaisesRegex(ValueError, "model authorship"):
            close(value)

    def test_rejects_open_job_shape(self):
        value = request()
        value["preview_only"] = True
        with self.assertRaisesRegex(ValueError, "closed shape"):
            validate_agentic_stitch_job(value)

    def test_runner_authors_plan_and_records_measured_usage(self):
        value = job()
        request_value = request()
        plan = dict(value["_test_plan"])
        plan.pop("author")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for component in request_value["components"]:
                data = component["component_id"].encode()
                path = root / component["artifact"]["path"]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                component["artifact"].update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
            evidence_data = b"png-evidence"
            evidence_path = root / request_value["evidence"][0]["path"]
            evidence_path.write_bytes(evidence_data)
            request_value["evidence"][0].update(bytes=len(evidence_data), sha256=hashlib.sha256(evidence_data).hexdigest())

            response = SimpleNamespace(
                status="completed", output_text=json.dumps(plan), id="resp-measured",
                usage=SimpleNamespace(model_dump=lambda: {"input_tokens": 1200, "output_tokens": 400, "input_tokens_details": {"cached_tokens": 100}}),
            )
            visual_review = {
                "format": "myth-maker.agentic-stitch-visual-review/v1", "decision": "accept",
                "scores": {"reference_fidelity": 80, "integration_quality": 82,
                           "material_identity": 90, "component_preservation": 88},
                "blocking_defects": [], "summary": "The section is visually coherent.",
            }
            review_response = SimpleNamespace(
                status="completed", output_text=json.dumps(visual_review), id="resp-review",
                usage=SimpleNamespace(model_dump=lambda: {"input_tokens": 600, "output_tokens": 120,
                                                          "input_tokens_details": {"cached_tokens": 200}}),
            )
            responses = iter((response, review_response))
            client = SimpleNamespace(responses=SimpleNamespace(create=lambda **_kwargs: next(responses)))

            def blender(command, **_kwargs):
                output = Path(command[command.index("--output") + 1])
                for name in ("assembly.blend", "assembly.glb", "three-quarter.png", "front.png", "side.png"):
                    (output / name).write_bytes(name.encode())
                (output / "stitch-report.json").write_text(json.dumps({
                    "status": "completed", "unresolved_connection_ids": [],
                    "single_connected_body": True, "manifold_required_seams": True,
                    "articulation_clearance": True, "connectivity": {"topology_changed": True},
                }))
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            with patch("agentic_stitch.subprocess.run", side_effect=blender):
                receipt = run_agentic_stitch(request_value, root, "/bin/blender", client)
            self.assertEqual(receipt["provider"]["request_id"], "resp-measured")
            self.assertEqual(receipt["model_usage"]["input_tokens"], 1800)
            self.assertEqual(receipt["model_usage"]["cached_input_tokens"], 300)
            self.assertEqual(receipt["model_usage"]["output_tokens"], 520)
            self.assertEqual(receipt["review_usage"]["input_tokens"], 600)
            self.assertEqual(receipt["visual_review"]["decision"], "accept")

    def test_runner_persists_terminal_incomplete_model_response(self):
        request_value = request()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for component in request_value["components"]:
                data = component["component_id"].encode()
                path = root / component["artifact"]["path"]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                component["artifact"].update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
            evidence_data = b"png-evidence"
            evidence_path = root / request_value["evidence"][0]["path"]
            evidence_path.write_bytes(evidence_data)
            request_value["evidence"][0].update(bytes=len(evidence_data), sha256=hashlib.sha256(evidence_data).hexdigest())
            response = SimpleNamespace(
                status="incomplete", output_text="", id="resp-incomplete",
                incomplete_details=SimpleNamespace(model_dump=lambda: {"reason": "max_output_tokens"}),
                usage=SimpleNamespace(model_dump=lambda: {"input_tokens": 900, "output_tokens": 7000, "input_tokens_details": {"cached_tokens": 0}}),
            )
            client = SimpleNamespace(responses=SimpleNamespace(create=lambda **_kwargs: response))
            receipt = run_agentic_stitch(request_value, root, "/bin/blender", client)
            self.assertEqual(receipt["status"], "failed")
            self.assertEqual(receipt["stage"], "astra-global-plan")
            self.assertEqual(receipt["incomplete_details"]["reason"], "max_output_tokens")
            self.assertEqual(receipt["model_usage"]["output_tokens"], 7000)
            self.assertTrue((root / "asset-production" / "pilot-001" / "agentic-stitch" /
                             "central-body-stitch-v1" / "attempt-0001" / "failure.json").is_file())


if __name__ == "__main__":
    unittest.main()
