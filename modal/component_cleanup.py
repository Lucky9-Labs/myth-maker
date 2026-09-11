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
                "candidate", "source_review", "merge_distance_ratio", "decimate_ratio"}
    if not isinstance(value, dict) or set(value) != required:
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
            or review["decision"] not in {"clean", "ready-to-stitch"}):
        raise ValueError("component cleanup requires a matching accepted Astra review")
    merge = value["merge_distance_ratio"]
    decimate = value["decimate_ratio"]
    if (not isinstance(merge, (int, float)) or isinstance(merge, bool) or not 0 <= merge <= 0.001
            or not isinstance(decimate, (int, float)) or isinstance(decimate, bool) or not 0.05 <= decimate <= 1):
        raise ValueError("component cleanup parameters are outside bounded limits")
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
               "--decimate-ratio", str(checked["decimate_ratio"])]
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
                              "decimate_ratio": checked["decimate_ratio"]},
               "stats": json.loads((root / "cleanup-stats.json").read_text()), "artifacts": artifacts,
               "started_at": started.isoformat(), "completed_at": datetime.now(timezone.utc).isoformat(),
               "duration_ms": round((time.monotonic() - clock) * 1000)}
    (root / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    return receipt
