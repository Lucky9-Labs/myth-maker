"""Immutable reference-to-component isolation for downstream 3D diffusion."""
from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import time

from component_diffusion import masked_component_crop


FORMAT = "myth-maker.component-isolation-job/v1"
MODEL = "gpt-image-2.5-flare-2026-09-08"
IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9-]{0,95}$")


def validate_component_isolation_job(value: dict) -> dict:
    required = {"format", "run_id", "work_id", "attempt", "asset_id", "component_id",
                "model", "reference_polygon", "component_description", "material",
                "symmetry", "attachment_surfaces", "quality"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("component isolation job has an invalid closed shape")
    if value["format"] != FORMAT or value["model"] != MODEL or value["asset_id"] not in {"mech", "railgun"}:
        raise ValueError("component isolation job has an unsupported format, model, or asset")
    if not all(isinstance(value[k], str) and IDENTIFIER.fullmatch(value[k])
               for k in ("run_id", "work_id", "component_id")):
        raise ValueError("component isolation identifiers must be lowercase kebab-case")
    if not isinstance(value["attempt"], int) or isinstance(value["attempt"], bool) or value["attempt"] < 1:
        raise ValueError("component isolation attempt must be positive")
    polygon = value["reference_polygon"]
    if (not isinstance(polygon, list) or not 3 <= len(polygon) <= 32
            or any(not isinstance(p, list) or len(p) != 2 or
                   any(not isinstance(v, (int, float)) or isinstance(v, bool) or not 0 <= v <= 1 for v in p)
                   for p in polygon)):
        raise ValueError("component isolation polygon is invalid")
    for key in ("component_description", "material"):
        if not isinstance(value[key], str) or not 8 <= len(value[key]) <= 600:
            raise ValueError("component isolation description is invalid")
    if value["symmetry"] not in {"none", "bilateral", "mirrored-pair"}:
        raise ValueError("component isolation symmetry is invalid")
    if (not isinstance(value["attachment_surfaces"], list) or len(value["attachment_surfaces"]) > 8
            or any(not isinstance(item, str) or not IDENTIFIER.fullmatch(item) for item in value["attachment_surfaces"])):
        raise ValueError("component isolation attachment surfaces are invalid")
    if value["quality"] not in {"low", "medium"}:
        raise ValueError("component isolation quality must be low or medium")
    return json.loads(json.dumps(value))


def _usage(response) -> dict:
    raw = getattr(response, "usage", None)
    value = raw.model_dump() if hasattr(raw, "model_dump") else raw if isinstance(raw, dict) else {}
    return {"provenance": "measured" if value else "unavailable",
            "input_tokens": value.get("input_tokens"), "output_tokens": value.get("output_tokens"),
            "input_tokens_details": value.get("input_tokens_details")}


def run_component_isolation(job: dict, submissions_root: Path, client) -> dict:
    checked = validate_component_isolation_job(job)
    run_root = submissions_root / "asset-production" / checked["run_id"]
    reference = run_root / "observability" / f'{checked["asset_id"]}-frozen-reference-preview.jpg'
    if not reference.is_file():
        raise ValueError("frozen asset reference is unavailable in the cloud run")
    root = run_root / "component-isolation" / checked["work_id"] / f'attempt-{checked["attempt"]:04d}'
    if root.exists():
        raise ValueError("component isolation attempt already exists")
    root.mkdir(parents=True)
    (root / "job.json").write_text(json.dumps(checked, indent=2, sort_keys=True) + "\n")
    crop = masked_component_crop(reference, checked["reference_polygon"], root / "source-crop.png")
    prompt = (
        "Create one clean 3D reconstruction reference image for only this game-asset component: "
        + checked["component_description"] + ". Preserve the component's distinctive outline and proportions from the input. "
        "Remove every neighboring part, character, frame, highlight fragment, reflection, text, and background object. "
        "Show exactly one complete component, centered, fully visible, in a neutral three-quarter orthographic product view. "
        "Use a flat transparent background, even studio lighting, crisp continuous surfaces, no cast shadow, and no labels. "
        "Render transparent or emissive production materials temporarily as opaque matte clay so image-to-3D can recover a closed shell. "
        f'Intended material after reconstruction: {checked["material"]}. Symmetry: {checked["symmetry"]}. '
        f'Preserve clear attachment surfaces for: {", ".join(checked["attachment_surfaces"]) or "none"}.'
    )
    started = datetime.now(timezone.utc); clock = time.monotonic()
    with open(root / "source-crop.png", "rb") as image:
        response = client.images.edit(model=checked["model"], image=image, prompt=prompt,
                                      size="1024x1024", quality=checked["quality"],
                                      background="transparent", output_format="png")
    data = base64.b64decode(response.data[0].b64_json)
    output = root / "isolated-component.png"; output.write_bytes(data)
    usage = _usage(response)
    receipt = {"format": "myth-maker.component-isolation-receipt/v1", "status": "completed",
        "run_id": checked["run_id"], "work_id": checked["work_id"], "attempt": checked["attempt"],
        "asset_id": checked["asset_id"], "component_id": checked["component_id"],
        "provider": {"name": "openai", "model": checked["model"], "request_id": getattr(response, "id", None)},
        "source_reference": {"path": str(reference.relative_to(submissions_root)),
            "sha256": hashlib.sha256(reference.read_bytes()).hexdigest()},
        "source_crop": {**crop, "path": str((root / "source-crop.png").relative_to(submissions_root))},
        "artifact": {"path": str(output.relative_to(submissions_root)), "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(), "media_type": "image/png"},
        "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(), "model_usage": usage,
        "started_at": started.isoformat(), "completed_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": round((time.monotonic() - clock) * 1000)}
    (root / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    return receipt
