"""Validated, immutable component-wise image-to-3D generation."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time
from typing import Callable


FORMAT = "myth-maker.component-diffusion-job/v1"
RECEIPT_FORMAT = "myth-maker.component-diffusion-receipt/v1"
MODEL = "tencent/Hunyuan3D-2.1"
L40S_USD_PER_SECOND = 0.000542
CPU_USD_PER_CORE_SECOND = 0.0000131
MEMORY_USD_PER_GIB_SECOND = 0.00000222


def validate_component_diffusion_job(value: dict) -> dict:
    required = {"format", "run_id", "work_id", "attempt", "asset_id", "component_id",
                "model", "reference_polygon", "seeds", "num_inference_steps", "octree_resolution"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("component diffusion job has an invalid closed shape")
    if value["format"] != FORMAT or value["asset_id"] != "mech" or value["model"] != MODEL:
        raise ValueError("component diffusion job has an unsupported format, asset, or model")
    import re
    name = re.compile(r"^[a-z0-9][a-z0-9-]{0,95}$")
    if not all(isinstance(value[key], str) and name.fullmatch(value[key])
               for key in ("run_id", "work_id", "component_id")):
        raise ValueError("component diffusion identifiers must be lowercase kebab-case")
    if not isinstance(value["attempt"], int) or value["attempt"] < 1:
        raise ValueError("component diffusion attempt must be positive")
    polygon = value["reference_polygon"]
    if not isinstance(polygon, list) or not 3 <= len(polygon) <= 32:
        raise ValueError("component diffusion polygon requires 3 to 32 points")
    for point in polygon:
        if (not isinstance(point, list) or len(point) != 2 or
                any(not isinstance(axis, (int, float)) or not 0 <= axis <= 1 for axis in point)):
            raise ValueError("component diffusion polygon points must be normalized pairs")
    seeds = value["seeds"]
    if (not isinstance(seeds, list) or len(seeds) != 1
            or any(not isinstance(seed, int) or not 0 <= seed <= 2**32 - 1 for seed in seeds)):
        raise ValueError("component diffusion requires exactly one uint32 seed per immutable attempt")
    if not isinstance(value["num_inference_steps"], int) or not 5 <= value["num_inference_steps"] <= 50:
        raise ValueError("component diffusion inference steps must be between 5 and 50")
    if value["octree_resolution"] not in {128, 192, 256, 320, 384}:
        raise ValueError("component diffusion octree resolution is unsupported")
    return value


def masked_component_crop(reference: Path, polygon: list[list[float]], output: Path) -> dict:
    from PIL import Image, ImageDraw
    with Image.open(reference) as source:
        source = source.convert("RGBA")
        points = [(round(x * source.width), round(y * source.height)) for x, y in polygon]
        mask = Image.new("L", source.size, 0)
        ImageDraw.Draw(mask).polygon(points, fill=255)
        bounds = mask.getbbox()
        if bounds is None:
            raise ValueError("component diffusion polygon produced an empty crop")
        isolated = Image.new("RGBA", source.size, (255, 255, 255, 0))
        isolated.paste(source, mask=mask)
        isolated = isolated.crop(bounds)
        side = max(isolated.size)
        padded = Image.new("RGBA", (side, side), (255, 255, 255, 0))
        offset = ((side - isolated.width) // 2, (side - isolated.height) // 2)
        padded.paste(isolated, offset, isolated)
        output.parent.mkdir(parents=True, exist_ok=True)
        padded.save(output, format="PNG")
    data = output.read_bytes()
    return {"path": str(output), "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
            "width": side, "height": side}


def _write_phase(attempt_root: Path, phase: str, status: str, started: datetime,
                 checkpoint: Callable[[], None] | None, **details: object) -> None:
    payload = {
        "format": "myth-maker.component-diffusion-phase/v1",
        "phase": phase,
        "status": status,
        "started_at": started.isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        **details,
    }
    destination = attempt_root / "phase.json"
    temporary = destination.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    temporary.replace(destination)
    if checkpoint:
        checkpoint()


def run_component_diffusion(job: dict, submissions_root: Path,
                            checkpoint: Callable[[], None] | None = None) -> dict:
    checked = validate_component_diffusion_job(job)
    run_root = submissions_root / "asset-production" / checked["run_id"]
    reference = run_root / "observability" / "mech-frozen-reference-preview.jpg"
    if not reference.is_file():
        raise ValueError("frozen mech reference is unavailable in the cloud run")
    attempt_root = run_root / "component-diffusion" / checked["work_id"] / f"attempt-{checked['attempt']:04d}"
    receipt_path = attempt_root / "receipt.json"
    if receipt_path.exists():
        raise ValueError("component diffusion attempt already has a terminal receipt")
    attempt_root.mkdir(parents=True, exist_ok=False)
    (attempt_root / "job.json").write_text(json.dumps(checked, indent=2, sort_keys=True) + "\n")
    crop = masked_component_crop(reference, checked["reference_polygon"], attempt_root / "reference-crop.png")
    reference_data = reference.read_bytes()
    started = datetime.now(timezone.utc)
    clock = time.monotonic()
    _write_phase(attempt_root, "reference-crop", "completed", started, checkpoint,
                 reference_crop=crop)
    from PIL import Image
    import sys
    import torch
    from huggingface_hub import snapshot_download
    sys.path.insert(0, "/opt/Hunyuan3D-2.1/hy3dshape")
    from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline
    _write_phase(attempt_root, "model-cache", "running", started, checkpoint)
    model_root = snapshot_download(repo_id=MODEL, allow_patterns=["hunyuan3d-dit-v2-1/*"])
    _write_phase(attempt_root, "model-cache", "completed", started, checkpoint,
                 model_root=model_root)
    _write_phase(attempt_root, "model-load", "running", started, checkpoint)
    pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
        model_root, subfolder="hunyuan3d-dit-v2-1")
    pipeline.to("cuda")
    _write_phase(attempt_root, "model-load", "completed", started, checkpoint)
    artifacts = []
    with Image.open(attempt_root / "reference-crop.png") as image:
        condition = image.convert("RGBA")
        for seed in checked["seeds"]:
            candidate_started = time.monotonic()
            _write_phase(attempt_root, "shape-generation", "running", started, checkpoint, seed=seed)
            mesh = pipeline(
                image=condition,
                num_inference_steps=checked["num_inference_steps"],
                octree_resolution=checked["octree_resolution"],
                num_chunks=8000,
                generator=torch.Generator(device="cuda").manual_seed(seed),
                output_type="trimesh",
            )[0]
            destination = attempt_root / f"candidate-{seed}.glb"
            mesh.export(destination)
            data = destination.read_bytes()
            artifacts.append({"seed": seed, "path": str(destination.relative_to(submissions_root)),
                              "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                              "vertices": int(len(mesh.vertices)), "faces": int(len(mesh.faces)),
                              "generation_seconds": round(time.monotonic() - candidate_started, 3)})
            _write_phase(attempt_root, "shape-generation", "completed", started, checkpoint,
                         seed=seed, artifact=artifacts[-1])
    duration = time.monotonic() - clock
    estimated_cost = duration * (L40S_USD_PER_SECOND + 4 * CPU_USD_PER_CORE_SECOND + 32 * MEMORY_USD_PER_GIB_SECOND)
    receipt = {
        "format": RECEIPT_FORMAT, "status": "completed", "run_id": checked["run_id"],
        "work_id": checked["work_id"], "attempt": checked["attempt"], "asset_id": "mech",
        "component_id": checked["component_id"], "model": MODEL, "model_tokens": 0,
        "reference": {"path": str(reference.relative_to(submissions_root)), "bytes": len(reference_data),
                      "sha256": hashlib.sha256(reference_data).hexdigest()},
        "reference_crop": {**crop, "path": str((attempt_root / "reference-crop.png").relative_to(submissions_root))},
        "artifacts": artifacts, "started_at": started.isoformat(),
        "completed_at": datetime.now(timezone.utc).isoformat(), "execution_seconds": round(duration, 3),
        "compute": {"gpu": "L40S", "cpu_cores": 4, "memory_gib": 32,
                    "estimated_cost_usd": round(estimated_cost, 6),
                    "cost_provenance": "estimated-from-published-modal-unit-rates-2026-09-10"},
    }
    receipt_path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    return receipt
