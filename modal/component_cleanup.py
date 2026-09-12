"""Deterministic cloud cleanup for an Astra-approved diffusion component."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time


FORMAT = "myth-maker.component-cleanup-job/v1"
IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9-]{0,95}$")


def _artifact(value: object, media_type: str) -> bool:
    return (isinstance(value, dict) and set(value) == {"path", "bytes", "sha256", "media_type"}
            and value.get("media_type") == media_type and isinstance(value.get("path"), str)
            and not Path(value["path"]).is_absolute() and ".." not in Path(value["path"]).parts
            and isinstance(value.get("bytes"), int) and value["bytes"] > 0
            and isinstance(value.get("sha256"), str) and re.fullmatch(r"[a-f0-9]{64}", value["sha256"]))


def validate_component_cleanup_job(value: dict) -> dict:
    required = {"format", "run_id", "work_id", "attempt", "asset_id", "component_id",
                "candidate", "source_review", "merge_distance_ratio", "decimate_ratio",
                "smooth_factor", "smooth_iterations", "max_smooth_displacement_ratio",
                "lower_trim_ratio", "seat_band_ratio"}
    optional = {"salvage_bounds", "mechanical_patch", "aperture_cutout"}
    if not isinstance(value, dict) or not required <= set(value) or set(value) - required - optional:
        raise ValueError("component cleanup job has an invalid closed shape")
    if value["format"] != FORMAT or value["asset_id"] not in {"mech", "railgun"}:
        raise ValueError("component cleanup job has unsupported format or asset")
    if not all(isinstance(value[k], str) and IDENTIFIER.fullmatch(value[k])
               for k in ("run_id", "work_id", "component_id")):
        raise ValueError("component cleanup identifiers are invalid")
    if not isinstance(value["attempt"], int) or isinstance(value["attempt"], bool) or value["attempt"] < 1:
        raise ValueError("component cleanup attempt must be positive")
    if not _artifact(value["candidate"], "model/gltf-binary"):
        raise ValueError("component cleanup candidate is invalid")
    review = value["source_review"]
    if (not isinstance(review, dict) or set(review) != {"work_id", "candidate_sha256", "decision"}
            or not isinstance(review["work_id"], str) or not IDENTIFIER.fullmatch(review["work_id"])
            or review["candidate_sha256"] != value["candidate"]["sha256"]
            or review["decision"] not in {"clean", "ready-to-stitch", "regenerate"}):
        raise ValueError("component cleanup requires a matching Astra review")
    bounds = value.get("salvage_bounds")
    patch = value.get("mechanical_patch")
    aperture = value.get("aperture_cutout")
    if review["decision"] == "regenerate" and bounds is None and patch is None and aperture is None:
        raise ValueError("regenerate review cleanup requires bounded salvage or mechanical patch")
    if bounds is not None:
        if not isinstance(bounds, dict) or set(bounds) != {"x", "y", "z"}:
            raise ValueError("component salvage bounds are invalid")
        for interval in bounds.values():
            if (not isinstance(interval, list) or len(interval) != 2
                    or any(not isinstance(v, (int, float)) or isinstance(v, bool) for v in interval)
                    or not 0 <= interval[0] < interval[1] <= 1
                    or interval[1] - interval[0] < 0.1):
                raise ValueError("component salvage bounds are invalid")
    if patch is not None:
        patch_keys = {"type", "hub_axis", "hub_side", "hub_radius_ratio", "hub_depth_ratio",
                      "seat_width_ratio", "seat_depth_ratio", "seat_thickness_ratio", "bevel_ratio"}
        if not isinstance(patch, dict) or set(patch) != patch_keys or patch.get("type") != "capped-hub-seats":
            raise ValueError("component mechanical patch is invalid")
        if patch.get("hub_axis") not in {"x", "y"} or patch.get("hub_side") not in {"negative", "positive"}:
            raise ValueError("component mechanical patch orientation is invalid")
        ranges = {"hub_radius_ratio": (0.1, 0.45), "hub_depth_ratio": (0.02, 0.25),
                  "seat_width_ratio": (0.2, 0.9), "seat_depth_ratio": (0.2, 0.9),
                  "seat_thickness_ratio": (0.02, 0.2), "bevel_ratio": (0, 0.05)}
        for key, (low, high) in ranges.items():
            number = patch.get(key)
            if not isinstance(number, (int, float)) or isinstance(number, bool) or not low <= number <= high:
                raise ValueError("component mechanical patch parameters are invalid")
    if aperture is not None:
        keys = {"type", "axis", "center", "size", "seat_name", "seat_band_ratio"}
        if (not isinstance(aperture, dict) or set(aperture) != keys
                or aperture.get("type") != "ellipsoid-through-cut"
                or aperture.get("axis") not in {"x", "y"}
                or not isinstance(aperture.get("seat_name"), str)
                or not IDENTIFIER.fullmatch(aperture["seat_name"])):
            raise ValueError("component aperture cutout is invalid")
        for key in ("center", "size"):
            vector = aperture.get(key)
            if (not isinstance(vector, list) or len(vector) != 3
                    or any(not isinstance(v, (int, float)) or isinstance(v, bool) for v in vector)):
                raise ValueError("component aperture cutout is invalid")
        if (any(not 0 <= v <= 1 for v in aperture["center"])
                or any(not 0.05 <= v <= 1 for v in aperture["size"])
                or not isinstance(aperture["seat_band_ratio"], (int, float))
                or isinstance(aperture["seat_band_ratio"], bool)
                or not 0 < aperture["seat_band_ratio"] <= 0.03):
            raise ValueError("component aperture cutout parameters are invalid")
    merge = value["merge_distance_ratio"]
    decimate = value["decimate_ratio"]
    smooth = value["smooth_factor"]
    iterations = value["smooth_iterations"]
    displacement = value["max_smooth_displacement_ratio"]
    lower_trim = value["lower_trim_ratio"]
    seat_band = value["seat_band_ratio"]
    if (not isinstance(merge, (int, float)) or isinstance(merge, bool) or not 0 <= merge <= 0.001
            or not isinstance(decimate, (int, float)) or isinstance(decimate, bool) or not 0.05 <= decimate <= 1):
        raise ValueError("component cleanup parameters are outside bounded limits")
    if (not isinstance(smooth, (int, float)) or isinstance(smooth, bool) or not 0 <= smooth <= 0.2
            or not isinstance(iterations, int) or isinstance(iterations, bool) or not 0 <= iterations <= 5
            or not isinstance(displacement, (int, float)) or isinstance(displacement, bool)
            or not 0 <= displacement <= 0.005
            or not isinstance(lower_trim, (int, float)) or isinstance(lower_trim, bool)
            or not 0 <= lower_trim <= 0.1
            or not isinstance(seat_band, (int, float)) or isinstance(seat_band, bool)
            or not 0 <= seat_band <= 0.03):
        raise ValueError("component cleanup surface parameters are outside bounded limits")
    return json.loads(json.dumps(value))


def run_component_cleanup(job: dict, submissions_root: Path, blender: str) -> dict:
    checked = validate_component_cleanup_job(job)
    source = submissions_root / checked["candidate"]["path"]
    data = source.read_bytes()
    if len(data) != checked["candidate"]["bytes"] or hashlib.sha256(data).hexdigest() != checked["candidate"]["sha256"]:
        raise ValueError("component cleanup candidate hash mismatch")
    root = (submissions_root / "asset-production" / checked["run_id"] / "component-cleanup" /
            checked["work_id"] / f'attempt-{checked["attempt"]:04d}')
    if root.exists():
        raise ValueError("component cleanup attempt already exists")
    root.mkdir(parents=True)
    (root / "job.json").write_text(json.dumps(checked, indent=2, sort_keys=True) + "\n")
    started = datetime.now(timezone.utc); clock = time.monotonic()
    command = [blender, "--background", "--factory-startup", "--disable-autoexec",
               "--python", "/opt/component_cleanup_blender.py", "--", "--input", str(source),
               "--output", str(root), "--component-id", checked["component_id"],
               "--merge-distance-ratio", str(checked["merge_distance_ratio"]),
               "--decimate-ratio", str(checked["decimate_ratio"]),
               "--smooth-factor", str(checked["smooth_factor"]),
               "--smooth-iterations", str(checked["smooth_iterations"]),
               "--max-smooth-displacement-ratio", str(checked["max_smooth_displacement_ratio"]),
               "--lower-trim-ratio", str(checked["lower_trim_ratio"]),
               "--seat-band-ratio", str(checked["seat_band_ratio"])]
    if "salvage_bounds" in checked:
        command += ["--salvage-bounds", json.dumps(checked["salvage_bounds"], separators=(",", ":"))]
    if "mechanical_patch" in checked:
        command += ["--mechanical-patch", json.dumps(checked["mechanical_patch"], separators=(",", ":"))]
    if "aperture_cutout" in checked:
        command += ["--aperture-cutout", json.dumps(checked["aperture_cutout"], separators=(",", ":"))]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=12 * 60)
    expected = [root / "cleaned.glb", root / "cleaned.blend", root / "cleanup-stats.json"]
    if completed.returncode or not all(path.is_file() for path in expected):
        log = ((completed.stderr or "") + "\n" + (completed.stdout or "")).strip()[-3000:]
        raise RuntimeError("component cleanup failed or omitted artifacts: " + log)
    artifacts = {}
    media = {".glb": "model/gltf-binary", ".blend": "application/x-blender", ".json": "application/json"}
    for path in expected:
        payload = path.read_bytes()
        artifacts[path.name] = {"path": str(path.relative_to(submissions_root)), "bytes": len(payload),
                                "sha256": hashlib.sha256(payload).hexdigest(), "media_type": media[path.suffix]}
    receipt = {"format": "myth-maker.component-cleanup-receipt/v1", "status": "completed",
               "run_id": checked["run_id"], "work_id": checked["work_id"], "attempt": checked["attempt"],
               "asset_id": checked["asset_id"], "component_id": checked["component_id"],
               "source_candidate_sha256": checked["candidate"]["sha256"], "source_review": checked["source_review"],
               "parameters": {"merge_distance_ratio": checked["merge_distance_ratio"],
                              "decimate_ratio": checked["decimate_ratio"],
                              "smooth_factor": checked["smooth_factor"],
                              "smooth_iterations": checked["smooth_iterations"],
                              "max_smooth_displacement_ratio": checked["max_smooth_displacement_ratio"],
                              "lower_trim_ratio": checked["lower_trim_ratio"],
                              "seat_band_ratio": checked["seat_band_ratio"],
                              "salvage_bounds": checked.get("salvage_bounds"),
                              "mechanical_patch": checked.get("mechanical_patch"),
                              "aperture_cutout": checked.get("aperture_cutout")},
               "stats": json.loads((root / "cleanup-stats.json").read_text()), "artifacts": artifacts,
               "started_at": started.isoformat(), "completed_at": datetime.now(timezone.utc).isoformat(),
               "duration_ms": round((time.monotonic() - clock) * 1000)}
    (root / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    return receipt
