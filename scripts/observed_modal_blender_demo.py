#!/usr/bin/env python3
"""Dispatch the generic deterministic recipe demo through the deployed Modal app.

The Kraken label is intentionally isolated to this demo recipe. The Modal
function receives only a closed, generic body/appendage/material/camera recipe
and does not receive an OpenAI credential or make an API request.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sys


ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "modal"))
from deterministic_encounter import RECIPE_FORMAT, recipe_digest, validate_recipe


APP_NAME = "myth-maker-encounter-draft"
FUNCTION_NAME = "run_deterministic_recipe"
ENVIRONMENT = "dev"
REQUEST_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,42}$")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def request_scoped_ids(request_id: str) -> dict[str, str]:
    """Derive the immutable generic identifiers for one observed request."""
    if not isinstance(request_id, str) or not REQUEST_ID.fullmatch(request_id):
        raise ValueError("OBSERVED_MODAL_REQUEST_ID must be a stable request identifier")
    return {
        "request_id": request_id,
        "encounter_id": "encounter-" + request_id,
        "work_id": "encounter-body-" + request_id,
    }


def kraken_demo_recipe(work_id: str) -> dict:
    """Return demo data for a broadly reusable tentacled encounter recipe."""
    return validate_recipe({
        "format": RECIPE_FORMAT, "recipe_id": work_id,
        "body": {"scale": [2.7, 2.2, 1.85], "height": 2.15},
        "appendages": {"count": 8, "length": 4.8, "radius": 0.28, "curl": 1.65, "elevation": 0.34},
        "materials": {
            "body": [0.08, 0.21, 0.42, 1.0], "appendage": [0.15, 0.06, 0.31, 1.0],
            "accent": [0.96, 0.38, 0.08, 1.0], "ground": [0.018, 0.026, 0.06, 1.0],
        },
        "camera": {"location": [0, -17, 8.5], "target": [0, 0, 1.8], "resolution": [768, 576]},
    })


def public_terminal_receipt(state: dict, *, source_sha: str, job_id: str, ids: dict[str, str], recipe: dict) -> dict:
    provider = state.get("provider_receipt")
    if state.get("format") != "myth-maker.deterministic-modal-blender-receipt/v1" or state.get("status") != "completed":
        raise RuntimeError("deterministic Modal Blender run did not complete")
    if not isinstance(provider, dict) or provider.get("provider") != "modal":
        raise RuntimeError("deterministic Modal Blender run omitted its provider receipt")
    if provider.get("function_name") != FUNCTION_NAME:
        raise RuntimeError("receipt did not identify the deterministic Modal function")
    if state.get("provenance", {}).get("openai_api_used") is not False:
        raise RuntimeError("deterministic fallback did not prove OpenAI API non-use")
    if state.get("job_id") != job_id or state.get("recipe_id") != ids["work_id"]:
        raise RuntimeError("deterministic Modal Blender receipt is not bound to the request-scoped work")
    expected_files = {ids["work_id"] + ".blend", ids["work_id"] + ".glb"}
    if set(provider.get("output_artifacts", {})) != expected_files:
        raise RuntimeError("deterministic Modal Blender run omitted its native or GLB artifact")
    frames = provider.get("blender_window_frames", {})
    if set(frames) != {"initial", "intermediate", "final"}:
        raise RuntimeError("deterministic Modal Blender run omitted staged Blender frames")
    if state.get("provenance", {}).get("recipe_sha256") != recipe_digest(recipe):
        raise RuntimeError("deterministic Modal Blender receipt is not bound to the submitted recipe")
    if state.get("provenance", {}).get("source_sha") != source_sha:
        raise RuntimeError("deterministic Modal Blender receipt is not bound to the source revision")
    if not re.fullmatch(r"fu-[A-Za-z0-9]+", state.get("provenance", {}).get("deployed_function_id", "")):
        raise RuntimeError("deterministic Modal Blender receipt omitted its deployed function ID")
    if state.get("glb_validation", {}).get("format") != "glb-2.0-self-contained":
        raise RuntimeError("deterministic Modal Blender run did not validate its GLB")
    required_nodes = {"encounter-body"} | {
        f"encounter-appendage-{index:02d}" for index in range(recipe["appendages"]["count"])
    }
    glb_validation = state.get("glb_validation", {})
    if glb_validation.get("appendage_count") != recipe["appendages"]["count"] or not required_nodes.issubset(
            set(glb_validation.get("required_node_names", []))):
        raise RuntimeError("deterministic Modal Blender GLB did not prove its required encounter geometry")
    frame_validation = state.get("frame_validation", {})
    expected_resolution = recipe["camera"]["resolution"]
    if {name: item.get("width") for name, item in frame_validation.items()} != {name: expected_resolution[0] for name in frames} or \
       {name: item.get("height") for name, item in frame_validation.items()} != {name: expected_resolution[1] for name in frames}:
        raise RuntimeError("deterministic Modal Blender staged frames were not decoded at the recipe resolution")
    return {
        "format": "myth-maker.observed-modal-deterministic-demo/v1",
        "source_sha": source_sha, "request_id": ids["request_id"], "encounter_id": ids["encounter_id"],
        "work_id": ids["work_id"], "job_id": job_id,
        "recipe": recipe, "recipe_sha256": recipe_digest(recipe),
        "provider_receipt": provider, "worker_receipt": {
            "execution": state["execution"], "glb_validation": state["glb_validation"],
            "frame_validation": state["frame_validation"], "provenance": state["provenance"],
        },
    }


def main() -> int:
    source_sha = os.environ.get("GITHUB_SHA", "")
    job_id = os.environ.get("OBSERVED_MODAL_JOB_ID", "")
    request_id = os.environ.get("OBSERVED_MODAL_REQUEST_ID", "")
    if not re.fullmatch(r"[a-f0-9]{40}", source_sha):
        raise RuntimeError("GITHUB_SHA must be the trusted immutable source revision")
    if not re.fullmatch(r"deterministic-encounter-demo-[a-z0-9-]+", job_id):
        raise RuntimeError("OBSERVED_MODAL_JOB_ID must be the workflow-derived deterministic identity")
    try:
        ids = request_scoped_ids(request_id)
    except ValueError as error:
        raise RuntimeError(str(error)) from error
    recipe = kraken_demo_recipe(ids["work_id"])
    import modal
    function = modal.Function.from_name(APP_NAME, FUNCTION_NAME, environment_name=ENVIRONMENT)
    function.hydrate()
    if not isinstance(function.object_id, str) or not re.fullmatch(r"fu-[A-Za-z0-9]+", function.object_id):
        raise RuntimeError("deployed deterministic Modal function did not expose a function ID")
    state = function.remote(job_id, recipe, {"source_sha": source_sha, "request_kind": "deterministic-encounter-recipe",
                                             "deployed_function_id": function.object_id})
    receipt = public_terminal_receipt(state, source_sha=source_sha, job_id=job_id, ids=ids, recipe=recipe)
    output = ROOT / "provider-evidence" / "modal-blender-demo-receipt.json"
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    github_output = os.environ.get("GITHUB_OUTPUT")
    if github_output:
        with open(github_output, "a", encoding="utf-8") as handle:
            handle.write("".join(f"{name}={value}\n" for name, value in {
                "request_id": ids["request_id"], "encounter_id": ids["encounter_id"],
                "work_id": ids["work_id"], "job_id": job_id, "receipt_path": output,
            }.items()))
    print(json.dumps({"request_id": ids["request_id"], "encounter_id": ids["encounter_id"],
                      "work_id": ids["work_id"], "job_id": job_id,
                      "function_call_id": receipt["provider_receipt"]["function_call_id"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
