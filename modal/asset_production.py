"""Closed contracts and immutable staging for cloud asset-production jobs."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone


FORMAT = "myth-maker.asset-production-job/v1"
SLOTS = ("worker-a", "worker-b", "worker-c", "worker-d")
JOB_TYPES = ("mech-structure", "mech-armor", "railgun", "kit-assembly", "final-validation")
OPERATIONS = (
    "normalize", "apply-core-kit", "assemble", "bind-rig", "animate",
    "render-review", "export-glb", "validate",
)
VIEWS = (
    "full-body", "gameplay-distance", "first-person", "front", "side", "rear",
    "articulation", "grip", "charge-rest", "charge-mid", "charge-full",
)
CRITERIA = (
    "silhouette", "reference-coherence", "fit", "articulation", "weapon-handling",
    "animation-readability", "material-identity", "export", "performance",
)
IDENTIFIER = re.compile(r"^[a-z0-9][a-z0-9-]{0,95}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
SOURCE_SHA = re.compile(r"^[a-f0-9]{40}$")
FUNCTION_ID = re.compile(r"^fu-[A-Za-z0-9]+$")


def _closed(value: dict, required: set[str], optional: set[str], label: str) -> None:
    if not isinstance(value, dict) or not required.issubset(value) or set(value) - required - optional:
        raise ValueError(f"{label} has an invalid shape")


def _safe_relative(value: str) -> bool:
    path = Path(value) if isinstance(value, str) else Path("/")
    return bool(value) and not path.is_absolute() and ".." not in path.parts


def validate_job_manifest(value: dict) -> dict:
    required = {
        "format", "run_id", "work_id", "attempt", "worker_slot", "job_type",
        "source_revision", "runtime_deployment", "inputs", "dependencies",
        "operations", "review_views", "measurement",
    }
    _closed(value, required, set(), "asset production job")
    if value["format"] != FORMAT:
        raise ValueError("asset production job has an unsupported format")
    for name in ("run_id", "work_id"):
        if not isinstance(value[name], str) or not IDENTIFIER.fullmatch(value[name]):
            raise ValueError(f"asset production job has invalid {name}")
    if not isinstance(value["attempt"], int) or isinstance(value["attempt"], bool) or value["attempt"] < 1:
        raise ValueError("asset production job attempt must be positive")
    if value["worker_slot"] not in SLOTS or value["job_type"] not in JOB_TYPES:
        raise ValueError("asset production job has invalid worker routing")
    if not isinstance(value["source_revision"], str) or not SHA256.fullmatch(value["source_revision"]):
        raise ValueError("asset production job needs a content-addressed source revision")

    deployment = value["runtime_deployment"]
    _closed(deployment, {"source_sha", "function_id"}, set(), "runtime deployment")
    if not SOURCE_SHA.fullmatch(deployment["source_sha"]) or not FUNCTION_ID.fullmatch(deployment["function_id"]):
        raise ValueError("runtime deployment needs immutable provider identities")

    if not isinstance(value["inputs"], list) or not value["inputs"]:
        raise ValueError("asset production job needs immutable inputs")
    seen_paths = set()
    inputs = []
    for item in value["inputs"]:
        _closed(item, {"path", "bytes", "sha256", "media_type"}, set(), "input artifact")
        if (not _safe_relative(item["path"]) or item["path"] in seen_paths
                or not isinstance(item["bytes"], int) or isinstance(item["bytes"], bool) or item["bytes"] < 1
                or not isinstance(item["sha256"], str) or not SHA256.fullmatch(item["sha256"])
                or not isinstance(item["media_type"], str) or not item["media_type"]):
            raise ValueError("input artifact has invalid identity")
        seen_paths.add(item["path"])
        inputs.append(dict(item))
    basenames = [Path(item["path"]).name for item in inputs]
    if len(set(basenames)) != len(basenames):
        raise ValueError("input artifact basenames must be unique inside the cloud job")

    if (not isinstance(value["dependencies"], list)
            or any(not isinstance(item, str) or not SHA256.fullmatch(item) for item in value["dependencies"])
            or len(set(value["dependencies"])) != len(value["dependencies"])):
        raise ValueError("asset production dependencies must be unique content hashes")
    if (not isinstance(value["operations"], list) or not value["operations"]
            or any(not isinstance(item, dict) or set(item) != {"kind"} or item["kind"] not in OPERATIONS
                   for item in value["operations"])):
        raise ValueError("asset production operations must use the closed core-kit vocabulary")
    if (not isinstance(value["review_views"], list)
            or any(item not in VIEWS for item in value["review_views"])
            or len(set(value["review_views"])) != len(value["review_views"])):
        raise ValueError("asset production review views are invalid")

    measurement = value["measurement"]
    _closed(measurement, {"human_minutes", "provenance"}, {"model_usage"}, "measurement")
    if (not isinstance(measurement["human_minutes"], (int, float))
            or isinstance(measurement["human_minutes"], bool) or measurement["human_minutes"] < 0
            or measurement["provenance"] not in {"measured", "estimated", "unavailable"}):
        raise ValueError("asset production measurement is invalid")
    model_usage = measurement.get("model_usage", {
        "provenance": "unavailable", "input_tokens": None,
        "cached_input_tokens": None, "output_tokens": None,
    })
    _closed(model_usage, {"provenance", "input_tokens", "cached_input_tokens", "output_tokens"}, set(), "model usage")
    if model_usage["provenance"] not in {"measured", "unavailable"}:
        raise ValueError("model usage may only be measured or unavailable")
    for name in ("input_tokens", "cached_input_tokens", "output_tokens"):
        token_count = model_usage[name]
        if token_count is not None and (not isinstance(token_count, int) or isinstance(token_count, bool) or token_count < 0):
            raise ValueError("model token counts must be nonnegative integers")
    if model_usage["provenance"] == "measured" and any(model_usage[name] is None for name in ("input_tokens", "cached_input_tokens", "output_tokens")):
        raise ValueError("measured model usage requires every token count")
    if model_usage["provenance"] == "unavailable" and any(model_usage[name] is not None for name in ("input_tokens", "cached_input_tokens", "output_tokens")):
        raise ValueError("unavailable model usage cannot invent token counts")

    checked = json.loads(json.dumps(value))
    checked["inputs"] = inputs
    checked["measurement"]["model_usage"] = model_usage
    return checked


def manifest_digest(value: dict) -> str:
    checked = validate_job_manifest(value)
    encoded = json.dumps(checked, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def stage_volume_inputs(value: dict, volume_root: Path) -> list[dict]:
    checked = validate_job_manifest(value)
    root = volume_root.resolve()
    staged = []
    for artifact in checked["inputs"]:
        path = (root / artifact["path"]).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise ValueError("input artifact is unavailable: " + artifact["path"])
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if len(data) != artifact["bytes"] or digest != artifact["sha256"]:
            raise ValueError("input artifact hash mismatch: " + artifact["path"])
        staged.append(dict(artifact))
    return staged


def plan_production_wave(values: list[dict]) -> list[dict]:
    checked = [validate_job_manifest(value) for value in values]
    slots = [item["worker_slot"] for item in checked]
    if sorted(slots) != list(SLOTS):
        raise ValueError("production wave must occupy each of the four worker slots exactly once")
    for item in checked:
        if item["job_type"] == "kit-assembly" and item["worker_slot"] != "worker-d":
            raise ValueError("worker-d is the sole assembly authority")
        if item["worker_slot"] == "worker-d" and item["job_type"] not in {"kit-assembly", "final-validation"}:
            raise ValueError("worker-d is reserved for kit assembly and validation")
    return sorted(checked, key=lambda item: SLOTS.index(item["worker_slot"]))


def validate_visual_critique(value: dict) -> dict:
    _closed(value, {"format", "defects"}, set(), "asset visual critique")
    if value["format"] != "myth-maker.asset-visual-critique/v1" or not isinstance(value["defects"], list):
        raise ValueError("asset visual critique has an invalid shape")
    defects, seen = [], set()
    required = {"defect_id", "component_id", "evidence_view", "observable_problem", "severity",
                "criterion", "recommended_correction", "confidence"}
    for defect in value["defects"]:
        _closed(defect, required, set(), "visual defect")
        if (not IDENTIFIER.fullmatch(defect["defect_id"]) or defect["defect_id"] in seen
                or not IDENTIFIER.fullmatch(defect["component_id"])
                or not isinstance(defect["evidence_view"], str) or not defect["evidence_view"]
                or not isinstance(defect["observable_problem"], str) or not defect["observable_problem"]
                or not isinstance(defect["recommended_correction"], str) or not defect["recommended_correction"]
                or defect["severity"] not in {"blocking", "nonblocking", "cosmetic"}
                or defect["criterion"] not in CRITERIA
                or not isinstance(defect["confidence"], (int, float)) or isinstance(defect["confidence"], bool)
                or not 0 <= defect["confidence"] <= 1):
            raise ValueError("visual defect is invalid")
        seen.add(defect["defect_id"])
        checked = dict(defect)
        checked["disposition"] = "backlog" if defect["severity"] == "cosmetic" else "accepted"
        defects.append(checked)
    return {"format": value["format"], "defects": defects}


def validate_critique_request(value: dict) -> dict:
    required = {"format", "run_id", "work_id", "attempt", "model", "artifacts", "prior_defects"}
    _closed(value, required, set(), "asset critique request")
    if (value["format"] != "myth-maker.asset-critique-request/v1"
            or not IDENTIFIER.fullmatch(value["run_id"])
            or not IDENTIFIER.fullmatch(value["work_id"])
            or not isinstance(value["attempt"], int) or isinstance(value["attempt"], bool) or value["attempt"] < 1
            or value["model"] != "gpt-6-astra"
            or not isinstance(value["artifacts"], list) or not value["artifacts"]
            or not isinstance(value["prior_defects"], list)):
        raise ValueError("asset critique request is invalid")
    for item in value["artifacts"]:
        _closed(item, {"path", "bytes", "sha256", "media_type"}, set(), "critique artifact")
        if (not _safe_relative(item["path"]) or not isinstance(item["bytes"], int) or item["bytes"] < 1
                or not SHA256.fullmatch(item["sha256"]) or item["media_type"] != "image/png"):
            raise ValueError("asset critique artifact is invalid")
    return json.loads(json.dumps(value))


def summarize_efficiency(receipts: list[dict]) -> dict:
    """Aggregate all attempts without turning absent measurements into zero."""
    durations = [item.get("execution", {}).get("duration_ms") for item in receipts]
    measured_durations = bool(receipts) and all(isinstance(value, (int, float)) and value >= 0 for value in durations)
    human = [item.get("measurement", {}).get("human_minutes") for item in receipts]
    measured_human = bool(receipts) and all(isinstance(value, (int, float)) and value >= 0 for value in human)
    model_usage = [item.get("measurement", {}).get("model_usage", {}) for item in receipts]
    measured_model = bool(model_usage) and all(item.get("provenance") == "measured" for item in model_usage)

    def value(provenance: str, amount):
        return {"provenance": provenance, "value": amount}

    def duration_for(job_type: str | None) -> float | None:
        selected = [item.get("execution", {}).get("duration_ms") for item in receipts
                    if (item.get("job_type") == "kit-assembly") == (job_type == "kit-assembly")]
        return sum(selected) if selected and all(isinstance(item, (int, float)) for item in selected) else None

    core = duration_for("kit-assembly")
    asset = duration_for(None)
    summary = {
        "compute_ms": value("measured" if measured_durations else "unavailable",
                            sum(durations) if measured_durations else None),
        "human_minutes": value("measured" if measured_human else "unavailable",
                               sum(human) if measured_human else None),
        "core_kit_ms": value("measured" if core is not None else "unavailable", core),
        "asset_specific_ms": value("measured" if asset is not None else "unavailable", asset),
        "attempts": len(receipts),
        "failed_attempts": sum(item.get("status") == "failed" for item in receipts),
    }
    for name in ("input_tokens", "cached_input_tokens", "output_tokens"):
        summary[name] = value("measured" if measured_model else "unavailable",
                              sum(item[name] for item in model_usage) if measured_model else None)
    return summary


def _artifact_receipt(path: Path, relative: str) -> dict:
    data = path.read_bytes()
    return {"path": relative, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def run_asset_production_job(value: dict, volume_root: Path, submissions_root: Path,
                             blender: str, *, function_call_id: str, input_id: str,
                             run_command=subprocess.run) -> dict:
    """Execute one immutable Blender job in the caller's cloud filesystem.

    The Modal-decorated entrypoint supplies provider identity and commits the
    surrounding Volume. Keeping this core free of the Modal SDK makes the exact
    production behavior locally testable without claiming local asset evidence.
    """
    checked = validate_job_manifest(value)
    if not function_call_id or not input_id:
        raise ValueError("cloud job requires provider call and input identities")
    stage_volume_inputs(checked, volume_root)
    root = submissions_root / checked["run_id"] / checked["work_id"]
    if root.exists():
        raise ValueError("asset production attempt already exists; use a new explicit attempt")
    inputs, output = root / "inputs", root / "output"
    inputs.mkdir(parents=True)
    output.mkdir()
    for item in checked["inputs"]:
        source = (volume_root / item["path"]).resolve()
        destination = inputs / Path(item["path"]).name
        shutil.copyfile(source, destination)
        destination.chmod(0o444)
    manifest_path = root / "job.json"
    manifest_path.write_text(json.dumps(checked, indent=2, sort_keys=True), encoding="utf-8")
    started_at = datetime.now(timezone.utc).isoformat()
    started = time.monotonic()
    command = [
        blender, "--background", "--factory-startup", "--disable-autoexec",
        "--python", "/opt/asset_production_blender.py", "--",
        "--job", str(manifest_path), "--inputs", str(inputs), "--output-root", str(output),
    ]
    completed = run_command(command, capture_output=True, text=True, timeout=15 * 60, check=False)
    execution = {
        "runtime": "modal", "engine": "blender-cli", "gpu_class": "T4", "cpu_count": 4,
        "started_at": started_at, "completed_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": round((time.monotonic() - started) * 1000), "returncode": completed.returncode,
        "stdout_sha256": hashlib.sha256(completed.stdout.encode()).hexdigest(),
        "stderr_sha256": hashlib.sha256(completed.stderr.encode()).hexdigest(),
    }
    receipt = {
        "format": "myth-maker.asset-production-receipt/v1",
        "run_id": checked["run_id"], "work_id": checked["work_id"], "attempt": checked["attempt"],
        "worker_slot": checked["worker_slot"], "job_type": checked["job_type"],
        "job_manifest_sha256": manifest_digest(checked),
        "provider": {"name": "modal", "function_call_id": function_call_id, "input_id": input_id,
                     "function_id": checked["runtime_deployment"]["function_id"]},
        "execution": execution, "measurement": checked["measurement"],
    }
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "Blender exited without diagnostics").strip().replace("\n", " ")[:1000]
        receipt.update({"status": "failed", "retry": "new-explicit-attempt-required",
                        "failure": {"classification": "blender-execution-failed", "detail": detail},
                        "artifacts": {}})
    else:
        required = ["asset.blend", "asset.glb", "scene-manifest.json", "fit-report.json"]
        required.extend("renders/" + view + ".png" for view in checked["review_views"])
        missing = [relative for relative in required if not (output / relative).is_file()]
        if missing:
            receipt.update({"status": "failed", "retry": "new-explicit-attempt-required",
                            "failure": {"classification": "required-output-missing",
                                        "detail": ", ".join(missing)}, "artifacts": {}})
        else:
            artifacts = {relative: _artifact_receipt(output / relative, relative) for relative in required}
            if not (output / "asset.blend").read_bytes().startswith((b"BLENDER", b"\x28\xb5\x2f\xfd", b"\x1f\x8b")):
                raise ValueError("cloud Blender output failed native format validation")
            receipt.update({"status": "completed", "retry": "not-requested", "artifacts": artifacts})
    (root / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True), encoding="utf-8")
    return receipt
