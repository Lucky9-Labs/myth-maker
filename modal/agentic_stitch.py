"""Closed contract for model-planned, topology-aware component stitching.

This module deliberately does not execute Blender.  It closes and validates the
job handed to the cloud stitch worker so a transform-only component layout can
never be admitted as a stitch attempt.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable


FORMAT = "myth-maker.agentic-stitch-job/v1"
CLOSED_FORMAT = "myth-maker.agentic-stitch-execution/v1"
PLAN_FORMAT = "myth-maker.agentic-stitch-plan/v1"
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,95}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
STITCH_METHODS = {"bridge", "remesh", "reshape-and-bridge", "socket-fit"}
OPERATION_TYPES = {
    "align",
    "reshape",
    "trim-overlap",
    "build-connector",
    "bridge-seam",
    "remesh-union",
    "restore-hard-surface",
}
TOPOLOGY_OPERATIONS = {"build-connector", "bridge-seam", "remesh-union"}

PLAN_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["format", "plan_id", "objective", "component_ids", "placements", "sections", "connections", "operations", "acceptance"],
    "properties": {
        "format": {"type": "string", "const": PLAN_FORMAT},
        "plan_id": {"type": "string"},
        "objective": {"type": "string"},
        "component_ids": {"type": "array", "items": {"type": "string"}},
        "placements": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["component_id", "initial_transform", "max_translation_m"], "properties": {
            "component_id": {"type": "string"},
            "initial_transform": {"type": "object", "additionalProperties": False, "required": ["location_m", "rotation_degrees", "scale"], "properties": {
                "location_m": {"type": "array", "items": {"type": "number", "minimum": -20, "maximum": 20}, "minItems": 3, "maxItems": 3},
                "rotation_degrees": {"type": "array", "items": {"type": "number", "minimum": -360, "maximum": 360}, "minItems": 3, "maxItems": 3},
                "scale": {"type": "array", "items": {"type": "number", "minimum": 0.05, "maximum": 20}, "minItems": 3, "maxItems": 3},
            }},
            "max_translation_m": {"type": "number", "minimum": 0, "maximum": 5},
        }}},
        "sections": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["section_id", "component_ids", "target_role"], "properties": {
            "section_id": {"type": "string"}, "component_ids": {"type": "array", "items": {"type": "string"}}, "target_role": {"type": "string"},
        }}},
        "connections": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["connection_id", "from_component", "from_interface", "from_anchor_local_m", "to_component", "to_interface", "to_anchor_local_m", "method", "connector", "max_gap_m"], "properties": {
            "connection_id": {"type": "string"}, "from_component": {"type": "string"}, "from_interface": {"type": "string"},
            "from_anchor_local_m": {"type": "array", "items": {"type": "number", "minimum": -20, "maximum": 20}, "minItems": 3, "maxItems": 3},
            "to_component": {"type": "string"}, "to_interface": {"type": "string"},
            "to_anchor_local_m": {"type": "array", "items": {"type": "number", "minimum": -20, "maximum": 20}, "minItems": 3, "maxItems": 3},
            "method": {"type": "string", "enum": sorted(STITCH_METHODS)},
            "connector": {"type": "object", "additionalProperties": False, "required": ["radius_m", "collar_length_m", "clearance_m"], "properties": {
                "radius_m": {"type": "number", "minimum": 0.001, "maximum": 2}, "collar_length_m": {"type": "number", "minimum": 0, "maximum": 2}, "clearance_m": {"type": "number", "minimum": 0, "maximum": 0.1},
            }}, "max_gap_m": {"type": "number", "minimum": 0, "maximum": 0.01},
        }}},
        "operations": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["operation_id", "order", "operation", "section_id", "connection_ids", "instructions"], "properties": {
            "operation_id": {"type": "string"}, "order": {"type": "integer"}, "operation": {"type": "string", "enum": sorted(OPERATION_TYPES)},
            "section_id": {"type": "string"}, "connection_ids": {"type": "array", "items": {"type": "string"}}, "instructions": {"type": "string"},
        }}},
        "acceptance": {"type": "object", "additionalProperties": False, "required": ["required_connection_ids", "max_unresolved_connections", "max_surface_gap_m", "require_single_connected_body", "require_manifold_required_seams", "require_articulation_clearance"], "properties": {
            "required_connection_ids": {"type": "array", "items": {"type": "string"}}, "max_unresolved_connections": {"type": "integer", "const": 0},
            "max_surface_gap_m": {"type": "number", "minimum": 0, "maximum": 0.01}, "require_single_connected_body": {"type": "boolean", "const": True},
            "require_manifold_required_seams": {"type": "boolean", "const": True}, "require_articulation_clearance": {"type": "boolean", "const": True},
        }},
    },
}


def _name(value: object) -> bool:
    return isinstance(value, str) and bool(NAME.fullmatch(value))


def _artifact(value: object) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == {"path", "bytes", "sha256", "media_type"}
        and value.get("media_type") == "model/gltf-binary"
        and isinstance(value.get("path"), str)
        and not Path(value["path"]).is_absolute()
        and ".." not in Path(value["path"]).parts
        and isinstance(value.get("bytes"), int)
        and not isinstance(value.get("bytes"), bool)
        and value["bytes"] > 0
        and isinstance(value.get("sha256"), str)
        and bool(SHA256.fullmatch(value["sha256"]))
    )


def _number(value: object, *, minimum: float, maximum: float) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and minimum <= value <= maximum
    )


def _vector(value: object, *, minimum: float, maximum: float) -> bool:
    return (
        isinstance(value, list)
        and len(value) == 3
        and all(_number(item, minimum=minimum, maximum=maximum) for item in value)
    )


def _validate_plan(plan: object, component_ids: set[str]) -> None:
    required = {
        "format", "plan_id", "author", "objective", "component_ids",
        "placements", "sections", "connections", "operations", "acceptance",
    }
    if not isinstance(plan, dict) or set(plan) != required or plan.get("format") != PLAN_FORMAT:
        raise ValueError("agentic stitch plan has an invalid closed shape")
    if not _name(plan.get("plan_id")):
        raise ValueError("agentic stitch plan id is invalid")
    author = plan.get("author")
    if (
        not isinstance(author, dict)
        or set(author) != {"model", "request_id"}
        or not isinstance(author.get("model"), str)
        or not author["model"]
        or not isinstance(author.get("request_id"), str)
        or not author["request_id"]
    ):
        raise ValueError("agentic stitch plan requires model authorship")
    if not isinstance(plan.get("objective"), str) or not plan["objective"].strip():
        raise ValueError("agentic stitch plan objective is invalid")
    if (
        not isinstance(plan.get("component_ids"), list)
        or len(plan["component_ids"]) != len(set(plan["component_ids"]))
        or set(plan["component_ids"]) != component_ids
    ):
        raise ValueError("agentic stitch plan must cover the exact component set")

    placements = plan.get("placements")
    placed: set[str] = set()
    if not isinstance(placements, list) or len(placements) != len(component_ids):
        raise ValueError("agentic stitch plan requires one bounded placement per component")
    for placement in placements:
        transform = placement.get("initial_transform") if isinstance(placement, dict) else None
        if (
            not isinstance(placement, dict)
            or set(placement) != {"component_id", "initial_transform", "max_translation_m"}
            or placement.get("component_id") not in component_ids
            or placement["component_id"] in placed
            or not isinstance(transform, dict)
            or set(transform) != {"location_m", "rotation_degrees", "scale"}
            or not _vector(transform.get("location_m"), minimum=-20.0, maximum=20.0)
            or not _vector(transform.get("rotation_degrees"), minimum=-360.0, maximum=360.0)
            or not _vector(transform.get("scale"), minimum=0.05, maximum=20.0)
            or not _number(placement.get("max_translation_m"), minimum=0.0, maximum=5.0)
        ):
            raise ValueError("agentic stitch component placement is invalid")
        placed.add(placement["component_id"])

    sections = plan.get("sections")
    if not isinstance(sections, list) or not sections:
        raise ValueError("agentic stitch plan requires sections")
    section_ids: set[str] = set()
    assigned: list[str] = []
    for section in sections:
        if (
            not isinstance(section, dict)
            or set(section) != {"section_id", "component_ids", "target_role"}
            or not _name(section.get("section_id"))
            or section["section_id"] in section_ids
            or not isinstance(section.get("component_ids"), list)
            or not section["component_ids"]
            or any(component_id not in component_ids for component_id in section["component_ids"])
            or not isinstance(section.get("target_role"), str)
            or not section["target_role"].strip()
        ):
            raise ValueError("agentic stitch section is invalid")
        section_ids.add(section["section_id"])
        assigned.extend(section["component_ids"])
    if len(assigned) != len(set(assigned)) or set(assigned) != component_ids:
        raise ValueError("every component must belong to exactly one stitch section")

    connections = plan.get("connections")
    if not isinstance(connections, list) or len(connections) < len(component_ids) - 1:
        raise ValueError("agentic stitch plan does not contain enough connections")
    connection_ids: set[str] = set()
    adjacency = {component_id: set() for component_id in component_ids}
    for connection in connections:
        if not isinstance(connection, dict) or set(connection) != {
            "connection_id", "from_component", "from_interface",
            "from_anchor_local_m", "to_component", "to_interface",
            "to_anchor_local_m", "method", "connector", "max_gap_m",
        }:
            raise ValueError("agentic stitch connection has an invalid closed shape")
        source, target = connection.get("from_component"), connection.get("to_component")
        if (
            not _name(connection.get("connection_id"))
            or connection["connection_id"] in connection_ids
            or source not in component_ids
            or target not in component_ids
            or source == target
            or not _name(connection.get("from_interface"))
            or not _name(connection.get("to_interface"))
            or not _vector(connection.get("from_anchor_local_m"), minimum=-20.0, maximum=20.0)
            or not _vector(connection.get("to_anchor_local_m"), minimum=-20.0, maximum=20.0)
            or connection.get("method") not in STITCH_METHODS
            or not _number(connection.get("max_gap_m"), minimum=0.0, maximum=0.01)
        ):
            raise ValueError("agentic stitch connection is invalid")
        connector = connection.get("connector")
        if (
            not isinstance(connector, dict)
            or set(connector) != {"radius_m", "collar_length_m", "clearance_m"}
            or not _number(connector.get("radius_m"), minimum=0.001, maximum=2.0)
            or not _number(connector.get("collar_length_m"), minimum=0.0, maximum=2.0)
            or not _number(connector.get("clearance_m"), minimum=0.0, maximum=0.1)
        ):
            raise ValueError("agentic stitch connector geometry is invalid")
        connection_ids.add(connection["connection_id"])
        adjacency[source].add(target)
        adjacency[target].add(source)

    # A pile of independently positioned islands is not a whole-body plan.
    visited: set[str] = set()
    pending = [next(iter(component_ids))]
    while pending:
        current = pending.pop()
        if current in visited:
            continue
        visited.add(current)
        pending.extend(adjacency[current] - visited)
    if visited != component_ids:
        raise ValueError("agentic stitch connection graph must be connected")

    operations = plan.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("agentic stitch plan requires operations")
    repaired_connections: set[str] = set()
    operation_ids: set[str] = set()
    previous_order = 0
    for operation in operations:
        if not isinstance(operation, dict) or set(operation) != {
            "operation_id", "order", "operation", "section_id",
            "connection_ids", "instructions",
        }:
            raise ValueError("agentic stitch operation has an invalid closed shape")
        refs = operation.get("connection_ids")
        if (
            not _name(operation.get("operation_id"))
            or operation["operation_id"] in operation_ids
            or not isinstance(operation.get("order"), int)
            or isinstance(operation.get("order"), bool)
            or operation["order"] <= previous_order
            or operation.get("operation") not in OPERATION_TYPES
            or operation.get("section_id") not in section_ids
            or not isinstance(refs, list)
            or not refs
            or len(refs) != len(set(refs))
            or any(ref not in connection_ids for ref in refs)
            or not isinstance(operation.get("instructions"), str)
            or not operation["instructions"].strip()
        ):
            raise ValueError("agentic stitch operation is invalid")
        operation_ids.add(operation["operation_id"])
        previous_order = operation["order"]
        if operation["operation"] in TOPOLOGY_OPERATIONS:
            repaired_connections.update(refs)
    if repaired_connections != connection_ids:
        raise ValueError("every connection requires a topology-changing stitch operation")

    acceptance = plan.get("acceptance")
    if (
        not isinstance(acceptance, dict)
        or set(acceptance) != {
            "required_connection_ids", "max_unresolved_connections",
            "max_surface_gap_m", "require_single_connected_body",
            "require_manifold_required_seams", "require_articulation_clearance",
        }
        or not isinstance(acceptance.get("required_connection_ids"), list)
        or len(acceptance["required_connection_ids"]) != len(set(acceptance["required_connection_ids"]))
        or set(acceptance["required_connection_ids"]) != connection_ids
        or acceptance.get("max_unresolved_connections") != 0
        or not _number(acceptance.get("max_surface_gap_m"), minimum=0.0, maximum=0.01)
        or acceptance.get("require_single_connected_body") is not True
        or acceptance.get("require_manifold_required_seams") is not True
        or acceptance.get("require_articulation_clearance") is not True
    ):
        raise ValueError("agentic stitch acceptance must close every required connection")


def _validate_components(components: object, retired: object) -> set[str]:
    if not isinstance(components, list) or not 2 <= len(components) <= 64:
        raise ValueError("agentic stitch requires at least two components")
    component_ids: set[str] = set()
    artifact_hashes: set[str] = set()
    for component in components:
        if (
            not isinstance(component, dict)
            or set(component) != {"component_id", "artifact"}
            or not _name(component.get("component_id"))
            or component["component_id"] in component_ids
            or not _artifact(component.get("artifact"))
            or component["artifact"]["sha256"] in artifact_hashes
        ):
            raise ValueError("agentic stitch component is invalid")
        if component["artifact"]["sha256"] in retired:
            raise ValueError("retired component hash cannot enter agentic stitch")
        component_ids.add(component["component_id"])
        artifact_hashes.add(component["artifact"]["sha256"])
    return component_ids


def _retired(value: object) -> bool:
    return (
        isinstance(value, list)
        and len(value) == len(set(value))
        and all(isinstance(item, str) and bool(SHA256.fullmatch(item)) for item in value)
    )


def _image_artifact(value: object) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == {"path", "bytes", "sha256", "media_type"}
        and value.get("media_type") == "image/png"
        and isinstance(value.get("path"), str)
        and not Path(value["path"]).is_absolute()
        and ".." not in Path(value["path"]).parts
        and isinstance(value.get("bytes"), int)
        and not isinstance(value.get("bytes"), bool)
        and value["bytes"] > 0
        and isinstance(value.get("sha256"), str)
        and bool(SHA256.fullmatch(value["sha256"]))
    )


def validate_agentic_stitch_job(value: object) -> dict:
    """Validate the immutable inputs from which Astra must author the plan."""
    required = {
        "format", "run_id", "work_id", "attempt", "asset_id", "components",
        "retired_sha256", "objective", "model", "evidence",
    }
    if (
        not isinstance(value, dict)
        or set(value) != required
        or value.get("format") != FORMAT
        or value.get("asset_id") != "mech"
    ):
        raise ValueError("agentic stitch job has an invalid closed shape")
    if not all(_name(value.get(key)) for key in ("run_id", "work_id")):
        raise ValueError("agentic stitch job identifiers are invalid")
    if (
        not isinstance(value.get("attempt"), int)
        or isinstance(value.get("attempt"), bool)
        or value["attempt"] < 1
    ):
        raise ValueError("agentic stitch job attempt is invalid")
    retired = value.get("retired_sha256")
    if not _retired(retired):
        raise ValueError("agentic stitch retired hashes are invalid")
    _validate_components(value.get("components"), retired)
    if not isinstance(value.get("objective"), str) or not value["objective"].strip():
        raise ValueError("agentic stitch objective is invalid")
    if value.get("model") != "gpt-6-astra":
        raise ValueError("agentic stitch planning requires Astra")
    if (
        not isinstance(value.get("evidence"), list)
        or not 1 <= len(value["evidence"]) <= 8
        or any(not _image_artifact(item) for item in value["evidence"])
    ):
        raise ValueError("agentic stitch evidence is invalid")
    return json.loads(json.dumps(value))


def close_agentic_stitch_job(
    *, run_id: str, work_id: str, attempt: int, components: list[dict],
    retired_sha256: list[str], global_plan: dict,
) -> dict:
    """Build the exact wire shape and validate it before dispatch."""
    value = {
        "format": CLOSED_FORMAT,
        "run_id": run_id,
        "work_id": work_id,
        "attempt": attempt,
        "asset_id": "mech",
        "components": components,
        "retired_sha256": retired_sha256,
        "global_plan": global_plan,
    }
    required = {
        "format", "run_id", "work_id", "attempt", "asset_id", "components",
        "retired_sha256", "global_plan",
    }
    if set(value) != required or not _name(run_id) or not _name(work_id) or not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1:
        raise ValueError("closed agentic stitch execution is invalid")
    if not _retired(retired_sha256):
        raise ValueError("agentic stitch retired hashes are invalid")
    component_ids = _validate_components(components, retired_sha256)
    _validate_plan(global_plan, component_ids)
    return json.loads(json.dumps(value))


def _checked_bytes(root: Path, artifact: dict, label: str) -> bytes:
    path = root / artifact["path"]
    data = path.read_bytes()
    if len(data) != artifact["bytes"] or hashlib.sha256(data).hexdigest() != artifact["sha256"]:
        raise ValueError(f"agentic stitch {label} artifact hash mismatch")
    return data


def run_agentic_stitch(
    job: dict,
    submissions_root: Path,
    blender_path: str,
    client,
    checkpoint: Callable[[], object] | None = None,
) -> dict:
    """Ask Astra for one global repair plan, validate it, then execute once."""
    checked = validate_agentic_stitch_job(job)
    root = (
        submissions_root / "asset-production" / checked["run_id"] /
        "agentic-stitch" / checked["work_id"] / f"attempt-{checked['attempt']:04d}"
    )
    if root.exists():
        raise ValueError("agentic stitch attempt already exists")
    root.mkdir(parents=True)
    (root / "job.json").write_text(json.dumps(checked, indent=2, sort_keys=True) + "\n")
    def publish_stage(stage: str, **details: object) -> None:
        payload = {
            "format": "myth-maker.agentic-stitch-stage/v1",
            "run_id": checked["run_id"],
            "work_id": checked["work_id"],
            "attempt": checked["attempt"],
            "stage": stage,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            **details,
        }
        (root / "stage.json").write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
        if checkpoint is not None:
            checkpoint()

    publish_stage("astra-global-plan", status="running")
    for component in checked["components"]:
        _checked_bytes(submissions_root, component["artifact"], "component")

    content = [{
        "type": "input_text",
        "text": (
            "Author one executable global Blender stitch plan for these immutable Hunyuan mech components. "
            "This is a joint cleanup pass: reshape neighbors, build missing collars or sockets, bridge required seams, "
            "and preserve articulation clearance. A transform-only or disconnected puzzle layout is forbidden. "
            "Every component must appear exactly once in placements and sections; the connection graph must span every "
            "component; every connection must receive build-connector, bridge-seam, or remesh-union. Use meters and local "
            "component anchor coordinates. max_gap_m and acceptance max_surface_gap_m must be <=0.01; connector radius "
            "0.001..2; collar length 0..2; clearance 0..0.1; max translation 0..5. Return JSON only.\n"
            f"OBJECTIVE: {checked['objective']}\n"
            f"COMPONENTS: {json.dumps([{'component_id': item['component_id'], 'sha256': item['artifact']['sha256']} for item in checked['components']])}"
        ),
    }]
    for evidence in checked["evidence"]:
        data = _checked_bytes(submissions_root, evidence, "evidence")
        content.append({
            "type": "input_image",
            "image_url": "data:image/png;base64," + base64.b64encode(data).decode(),
            "detail": "original",
        })

    started = datetime.now(timezone.utc)
    clock = time.monotonic()
    response = client.responses.create(
        model=checked["model"],
        input=[{"role": "user", "content": content}],
        # The strict plan is already heavily constrained by PLAN_SCHEMA. Medium
        # reasoning leaves more of the output budget for the executable graph.
        reasoning={"effort": "medium"},
        text={"format": {"type": "json_schema", "name": "agentic_stitch_plan", "strict": True, "schema": PLAN_SCHEMA}},
        max_output_tokens=16000,
        timeout=600,
    )
    if response.status != "completed" or not response.output_text:
        usage = response.usage.model_dump() if response.usage else None
        incomplete = getattr(response, "incomplete_details", None)
        if hasattr(incomplete, "model_dump"):
            incomplete = incomplete.model_dump()
        failure = {
            "format": "myth-maker.agentic-stitch-failure/v1",
            "status": "failed",
            "stage": "astra-global-plan",
            "run_id": checked["run_id"],
            "work_id": checked["work_id"],
            "attempt": checked["attempt"],
            "provider": {"name": "openai", "model": checked["model"], "request_id": getattr(response, "id", None)},
            "response_status": getattr(response, "status", None),
            "incomplete_details": incomplete,
            "model_usage": {"provenance": "measured" if usage else "unavailable", "input_tokens": (usage or {}).get("input_tokens"), "cached_input_tokens": ((usage or {}).get("input_tokens_details") or {}).get("cached_tokens"), "output_tokens": (usage or {}).get("output_tokens")},
            "started_at": started.isoformat(),
            "completed_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": round((time.monotonic() - clock) * 1000),
        }
        (root / "failure.json").write_text(json.dumps(failure, indent=2, sort_keys=True) + "\n")
        publish_stage("astra-global-plan", status="failed")
        return failure
    plan = json.loads(response.output_text)
    plan["author"] = {"model": checked["model"], "request_id": response.id}
    try:
        execution = close_agentic_stitch_job(
            run_id=checked["run_id"], work_id=checked["work_id"], attempt=checked["attempt"],
            components=checked["components"], retired_sha256=checked["retired_sha256"], global_plan=plan,
        )
    except ValueError as error:
        usage = response.usage.model_dump() if response.usage else None
        (root / "rejected-plan.json").write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n")
        failure = {
            "format": "myth-maker.agentic-stitch-failure/v1", "status": "failed",
            "stage": "plan-validation", "reason": str(error),
            "run_id": checked["run_id"], "work_id": checked["work_id"], "attempt": checked["attempt"],
            "provider": {"name": "openai", "model": checked["model"], "request_id": response.id},
            "model_usage": {"provenance": "measured" if usage else "unavailable", "input_tokens": (usage or {}).get("input_tokens"), "cached_input_tokens": ((usage or {}).get("input_tokens_details") or {}).get("cached_tokens"), "output_tokens": (usage or {}).get("output_tokens")},
            "started_at": started.isoformat(), "completed_at": datetime.now(timezone.utc).isoformat(),
            "duration_ms": round((time.monotonic() - clock) * 1000),
        }
        (root / "failure.json").write_text(json.dumps(failure, indent=2, sort_keys=True) + "\n")
        publish_stage("plan-validation", status="failed", reason=str(error))
        return failure
    (root / "plan.json").write_text(json.dumps(plan, indent=2, sort_keys=True) + "\n")
    (root / "execution.json").write_text(json.dumps(execution, indent=2, sort_keys=True) + "\n")
    publish_stage(
        "blender-execution",
        status="running",
        request_id=response.id,
        connection_count=len(plan["connections"]),
    )

    completed = subprocess.run(
        [blender_path, "--background", "--factory-startup", "--disable-autoexec", "--python", "/opt/agentic_stitch_blender.py", "--", "--job", str(root / "execution.json"), "--submissions", str(submissions_root), "--output", str(root)],
        capture_output=True, text=True, timeout=20 * 60,
    )
    expected = [root / name for name in ("assembly.blend", "assembly.glb", "three-quarter.png", "front.png", "side.png", "stitch-report.json")]
    if completed.returncode or not all(path.is_file() for path in expected):
        detail = ((completed.stderr or "") + "\n" + (completed.stdout or ""))[-4000:]
        raise RuntimeError("agentic stitch Blender execution failed: " + detail)
    report = json.loads((root / "stitch-report.json").read_text())
    if (
        report.get("status") != "completed"
        or report.get("unresolved_connection_ids") != []
        or report.get("single_connected_body") is not True
        or report.get("manifold_required_seams") is not True
        or report.get("articulation_clearance") is not True
    ):
        raise RuntimeError("agentic stitch output did not close its acceptance contract")

    media = {".blend": "application/x-blender", ".glb": "model/gltf-binary", ".png": "image/png", ".json": "application/json"}
    artifacts = {}
    for path in expected:
        data = path.read_bytes()
        artifacts[path.name] = {
            "path": str(path.relative_to(submissions_root)), "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(), "media_type": media[path.suffix],
        }
    usage = response.usage.model_dump() if response.usage else None
    receipt = {
        "format": "myth-maker.agentic-stitch-receipt/v1", "status": "completed",
        "run_id": checked["run_id"], "work_id": checked["work_id"], "attempt": checked["attempt"],
        "asset_id": "mech", "component_hashes": {item["component_id"]: item["artifact"]["sha256"] for item in checked["components"]},
        "plan_sha256": hashlib.sha256((root / "plan.json").read_bytes()).hexdigest(), "connectivity": report.get("connectivity"), "artifacts": artifacts,
        "provider": {"name": "openai", "model": checked["model"], "request_id": response.id},
        "model_usage": {"provenance": "measured" if usage else "unavailable", "input_tokens": (usage or {}).get("input_tokens"), "cached_input_tokens": ((usage or {}).get("input_tokens_details") or {}).get("cached_tokens"), "output_tokens": (usage or {}).get("output_tokens")},
        "started_at": started.isoformat(), "completed_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": round((time.monotonic() - clock) * 1000),
    }
    (root / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    publish_stage("completed", status="completed", request_id=response.id)
    return receipt
