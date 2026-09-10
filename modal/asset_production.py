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
JOB_TYPES = ("mech-structure", "mech-armor", "railgun", "core-kit", "kit-assembly", "final-validation")
OPERATIONS = (
    "normalize", "apply-core-kit", "apply-reference-corrections", "assemble", "bind-rig", "animate",
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
        _closed(item, {"path", "bytes", "sha256", "media_type"}, {"staged_name"}, "input artifact")
        if (not _safe_relative(item["path"]) or item["path"] in seen_paths
                or not isinstance(item["bytes"], int) or isinstance(item["bytes"], bool) or item["bytes"] < 1
                or not isinstance(item["sha256"], str) or not SHA256.fullmatch(item["sha256"])
                or not isinstance(item["media_type"], str) or not item["media_type"]
                or ("staged_name" in item and (not isinstance(item["staged_name"], str)
                                                or Path(item["staged_name"]).name != item["staged_name"]
                                                or not item["staged_name"]))):
            raise ValueError("input artifact has invalid identity")
        seen_paths.add(item["path"])
        inputs.append(dict(item))
    basenames = [item.get("staged_name", Path(item["path"]).name) for item in inputs]
    if len(set(basenames)) != len(basenames):
        raise ValueError("input artifact basenames must be unique inside the cloud job")
    if value["job_type"] in {"mech-structure", "mech-armor", "railgun", "core-kit"}:
        references = [item for item in inputs if item["media_type"] in {"image/png", "image/jpeg"}]
        if not references:
            raise ValueError("cloud modeling job requires an immutable reference image")

    if (not isinstance(value["operations"], list) or not value["operations"]
            or any(not isinstance(item, dict) or set(item) != {"kind"} or item["kind"] not in OPERATIONS
                   for item in value["operations"])):
        raise ValueError("asset production operations must use the closed core-kit vocabulary")
    operation_kinds = {item["kind"] for item in value["operations"]}
    required_operations = {"normalize", "apply-core-kit", "render-review", "export-glb", "validate"}
    if not required_operations.issubset(operation_kinds):
        raise ValueError("asset production job omits a required cloud production operation")
    if (not isinstance(value["dependencies"], list)
            or any(not isinstance(item, str) or not SHA256.fullmatch(item) for item in value["dependencies"])
            or len(set(value["dependencies"])) != len(value["dependencies"])):
        raise ValueError("asset production dependencies must be unique content hashes")
    input_hashes = {item["sha256"] for item in inputs}
    if not set(value["dependencies"]).issubset(input_hashes):
        raise ValueError("asset production dependency hash is not present in immutable inputs")
    if value["job_type"] == "kit-assembly" and "assemble" in operation_kinds:
        blend_hashes = {item["sha256"] for item in inputs if item["media_type"] == "application/x-blender"}
        if set(value["dependencies"]) != blend_hashes:
            raise ValueError("assembly dependencies must exactly match every Blender input hash")
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
    if len({item["run_id"] for item in checked}) != 1:
        raise ValueError("production wave cannot mix run identities")
    deployments = {(item["runtime_deployment"]["source_sha"], item["runtime_deployment"]["function_id"])
                   for item in checked}
    if len(deployments) != 1:
        raise ValueError("production wave cannot mix runtime deployments")
    for item in checked:
        if item["job_type"] == "kit-assembly" and item["worker_slot"] != "worker-d":
            raise ValueError("worker-d is the sole assembly authority")
        if item["worker_slot"] == "worker-d" and item["job_type"] not in {"core-kit", "kit-assembly", "final-validation"}:
            raise ValueError("worker-d is reserved for kit assembly and validation")
    return sorted(checked, key=lambda item: SLOTS.index(item["worker_slot"]))


def _best_scored_baselines(run_root: Path, receipts: list[tuple[Path, dict]]) -> dict[str, tuple[Path, dict]]:
    """Resolve promoted component receipts from the strongest same-protocol renders."""
    evaluations = []
    for path in (run_root / "observability" / "evaluations").glob("*.json"):
        value = _read_json(path)
        if value and value.get("status") == "completed": evaluations.append(value)
    if not evaluations:
        return {}
    latest = max(evaluations, key=lambda item: item.get("created_at", ""))
    scores = (latest.get("evaluation") or {}).get("evaluations") or []

    def receipt_for_render(asset_id: str) -> tuple[Path, dict] | None:
        candidates = sorted((item for item in scores if item.get("asset_id") == asset_id),
                            key=lambda item: item.get("weighted_score", -1), reverse=True)
        for score in candidates:
            digest = score.get("render_sha256")
            for path, receipt in receipts:
                artifacts = receipt.get("artifacts") or {}
                if any(name.startswith("renders/") and item.get("sha256") == digest
                       for name, item in artifacts.items()):
                    return path, receipt
        return None

    promoted = {}
    mech = receipt_for_render("mech")
    if mech:
        assembly_job = _read_json(mech[0].parent / "job.json") or {}
        dependencies = set(assembly_job.get("dependencies") or [])
        for slot in SLOTS[:2]:
            matches = [(path, receipt) for path, receipt in receipts
                       if receipt.get("worker_slot") == slot
                       and (receipt.get("artifacts") or {}).get("asset.blend", {}).get("sha256") in dependencies]
            if matches: promoted[slot] = max(matches, key=lambda pair: pair[1].get("attempt", 0))
    railgun = receipt_for_render("railgun")
    if railgun: promoted["worker-c"] = railgun
    return promoted


def _read_json(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def prepare_correction_wave(run_root: Path, runtime_deployment: dict,
                            apply_reference_batch: bool = False) -> list[dict]:
    """Advance from promoted baselines; apply a new batch only when explicitly requested."""
    if set(runtime_deployment) != {"source_sha", "function_id"}:
        raise ValueError("correction wave requires the current runtime deployment")
    receipts = []
    for path in run_root.glob("*/attempt-*/receipt.json"):
        receipt = _read_json(path)
        if isinstance(receipt, dict): receipts.append((path, receipt))
    promoted = _best_scored_baselines(run_root, receipts)
    wave = []
    for slot in SLOTS:
        candidates = [(path, item) for path, item in receipts if item.get("worker_slot") == slot and item.get("status") == "completed" and (item.get("artifacts") or {}).get("asset.blend")]
        if not candidates: raise ValueError("correction wave has no completed native baseline for " + slot)
        receipt_path, receipt = promoted.get(slot) or max(candidates, key=lambda pair: pair[1].get("attempt", 0))
        prior = json.loads((receipt_path.parent / "job.json").read_text(encoding="utf-8"))
        native = receipt["artifacts"]["asset.blend"]
        references = [dict(item) for item in prior["inputs"] if item["media_type"] in {"image/png", "image/jpeg"}]
        inputs = ([{"path": native["volume_path"], "bytes": native["bytes"], "sha256": native["sha256"],
                    "media_type": "application/x-blender", "staged_name": "source.blend"}, *references]
                  if slot != "worker-d" else [dict(item) for item in prior["inputs"]])
        attempts = [item.get("attempt", 0) for _path, item in receipts if item.get("work_id") == receipt["work_id"]]
        operations = [dict(item) for item in prior["operations"]]
        # A correction is baked into the immutable native baseline. Replaying
        # the same operation on every wave compounds scale changes and spends
        # compute without representing a new defect decision.
        if slot != "worker-d":
            operations = [item for item in operations if item["kind"] != "apply-reference-corrections"]
        if slot != "worker-d" and apply_reference_batch:
            operations.append({"kind": "apply-reference-corrections"})
        wave.append(validate_job_manifest({**prior, "attempt": max(attempts) + 1,
            "runtime_deployment": dict(runtime_deployment), "source_revision": native["sha256"],
            "inputs": inputs, "dependencies": [] if slot != "worker-d" else list(prior["dependencies"]),
            "operations": operations}))
    return plan_production_wave(wave)


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

    def duration_for(core_kit: bool) -> float | None:
        selected = [item.get("execution", {}).get("duration_ms") for item in receipts
                    if (item.get("job_type") in {"core-kit", "kit-assembly"}) == core_kit]
        return sum(selected) if selected and all(isinstance(item, (int, float)) for item in selected) else None

    core = duration_for(True)
    asset = duration_for(False)
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


def job_ledger_entry(receipt: dict) -> dict:
    """Project a provider receipt into the closed public run-ledger shape."""
    names = ("work_id", "attempt", "worker_slot", "job_type", "status", "input_hashes",
             "output_hashes", "queue_ms", "execution_ms", "model_usage", "human_minutes")
    if not isinstance(receipt, dict) or any(name not in receipt for name in names):
        raise ValueError("asset production receipt cannot populate the run ledger")
    return {name: json.loads(json.dumps(receipt[name])) for name in names}


def fan_in_assembly_job(wave: list[dict], receipts: list[dict]) -> dict:
    """Create Worker D's next attempt from exact successful A-C native hashes."""
    checked_wave = plan_production_wave(wave)
    template = next(item for item in checked_wave if item["worker_slot"] == "worker-d")
    by_slot = {item.get("worker_slot"): item for item in receipts}
    component_receipts = []
    for slot in SLOTS[:3]:
        receipt = by_slot.get(slot)
        native = (receipt or {}).get("artifacts", {}).get("asset.blend")
        if not receipt or receipt.get("status") != "completed" or not native:
            raise ValueError("fan-in assembly requires completed A-C native receipts")
        component_receipts.append(native)
    inputs = [{
        "path": item["volume_path"], "bytes": item["bytes"], "sha256": item["sha256"],
        "media_type": "application/x-blender", "staged_name": f"{SLOTS[index]}-asset.blend",
    } for index, item in enumerate(component_receipts)]
    dependency_hashes = [item["sha256"] for item in inputs]
    inputs.extend(dict(item) for item in template["inputs"]
                  if item["media_type"] in {"image/png", "image/jpeg"})
    operations = [dict(item) for item in template["operations"]]
    if {item["kind"] for item in operations}.isdisjoint({"assemble"}):
        operations.append({"kind": "assemble"})
    assembly = {
        **template,
        "job_type": "kit-assembly",
        "attempt": template["attempt"] + 1,
        "source_revision": hashlib.sha256("".join(dependency_hashes).encode()).hexdigest(),
        "inputs": inputs,
        "dependencies": dependency_hashes,
        "operations": operations,
    }
    return validate_job_manifest(assembly)


def create_run_ledger(wave: list[dict], receipts: list[dict], prior: dict | None = None) -> dict:
    checked_wave = plan_production_wave(wave)
    if not receipts:
        raise ValueError("asset production run ledger requires observed attempts")
    first = checked_wave[0]
    source_revision = hashlib.sha256(
        "".join(sorted(item["source_revision"] for item in checked_wave)).encode()
    ).hexdigest()
    prior_jobs = (prior or {}).get("jobs", [])
    jobs = {(item["work_id"], item["attempt"], item["job_type"]): item for item in prior_jobs}
    for receipt in receipts:
        entry = job_ledger_entry(receipt)
        jobs[(entry["work_id"], entry["attempt"], entry["job_type"])] = entry
    all_jobs = list(jobs.values())
    aggregate_receipts = [{
        "status": item["status"], "job_type": item["job_type"],
        "execution": {"duration_ms": item["execution_ms"]["value"]
                      if item["execution_ms"]["provenance"] == "measured" else None},
        "measurement": {
            "human_minutes": item["human_minutes"]["value"]
                             if item["human_minutes"]["provenance"] == "measured" else None,
            "model_usage": item["model_usage"],
        },
    } for item in all_jobs]
    summary = summarize_efficiency(aggregate_receipts)
    prior_started = (prior or {}).get("started_at")
    observed_starts = [item.get("execution", {}).get("started_at") for item in receipts
                       if item.get("execution", {}).get("started_at")]
    start_candidates = ([prior_started] if prior_started else []) + observed_starts
    started_at = min(start_candidates) if start_candidates else None
    acceptance = {name: "pending" for name in
                  ("assembly", "rig", "animation", "export", "performance", "unity_runtime", "visual_review")}
    acceptance.update((prior or {}).get("acceptance", {}))
    return {
        "schema_version": "1", "run_id": first["run_id"], "project_id": "myth-maker",
        "asset_set_id": "raptor-mech-railgun", "source_revision": source_revision,
        "runtime_deployment": {
            "provider": "modal", "source_sha": first["runtime_deployment"]["source_sha"],
            "function_id": first["runtime_deployment"]["function_id"],
            "volume": "myth-maker-encounter-submissions",
            "lease_store": "myth-maker-encounter-component-leases", "max_containers": 4,
        },
        "status": "failed" if any(item["status"] == "failed" for item in all_jobs)
                  or (prior or {}).get("status") == "failed" else (prior or {}).get("status", "running"),
        "started_at": started_at or datetime.now(timezone.utc).isoformat(),
        "completed_at": (prior or {}).get("completed_at"),
        "jobs": all_jobs, "defects": list((prior or {}).get("defects", [])),
        "acceptance": acceptance,
        "measurement": {
            "elapsed_ms": {"provenance": "unavailable", "value": None},
            "compute_ms": summary["compute_ms"], "human_minutes": summary["human_minutes"],
            "input_tokens": summary["input_tokens"], "cached_input_tokens": summary["cached_input_tokens"],
            "output_tokens": summary["output_tokens"], "core_kit_ms": summary["core_kit_ms"],
            "asset_specific_ms": summary["asset_specific_ms"],
        },
    }


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
    root = submissions_root / checked["run_id"] / checked["work_id"] / f"attempt-{checked['attempt']:04d}"
    if root.exists():
        raise ValueError("asset production attempt already exists; use a new explicit attempt")
    inputs, output = root / "inputs", root / "output"
    inputs.mkdir(parents=True)
    output.mkdir()
    for item in checked["inputs"]:
        source = (volume_root / item["path"]).resolve()
        destination = inputs / item.get("staged_name", Path(item["path"]).name)
        shutil.copyfile(source, destination)
        destination.chmod(0o444)
    manifest_path = root / "job.json"
    manifest_path.write_text(json.dumps(checked, indent=2, sort_keys=True), encoding="utf-8")
    started_at = datetime.now(timezone.utc).isoformat()
    started = time.monotonic()
    command = [
        blender, "--background", "--factory-startup", "--disable-autoexec",
        "--python-exit-code", "1",
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
    (root / "stdout.log").write_text(completed.stdout, encoding="utf-8")
    (root / "stderr.log").write_text(completed.stderr, encoding="utf-8")
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
        required = ["asset.blend", "asset.glb", "scene-manifest.json", "fit-report.json", "core-kit-manifest.json"]
        required.extend("renders/" + view + ".png" for view in checked["review_views"])
        missing = [relative for relative in required if not (output / relative).is_file()]
        if missing:
            receipt.update({"status": "failed", "retry": "new-explicit-attempt-required",
                            "failure": {"classification": "required-output-missing",
                                        "detail": ", ".join(missing)}, "artifacts": {}})
        else:
            artifacts = {relative: _artifact_receipt(output / relative, relative) for relative in required}
            for relative, artifact in artifacts.items():
                artifact["volume_path"] = str(Path(submissions_root.name) / checked["run_id"]
                                              / checked["work_id"] / f"attempt-{checked['attempt']:04d}"
                                              / "output" / relative)
            if not (output / "asset.blend").read_bytes().startswith((b"BLENDER", b"\x28\xb5\x2f\xfd", b"\x1f\x8b")):
                raise ValueError("cloud Blender output failed native format validation")
            fit = json.loads((output / "fit-report.json").read_text(encoding="utf-8"))
            if fit.get("blocking"):
                receipt.update({"status": "failed", "retry": "new-explicit-attempt-required",
                                "failure": {"classification": "blocking-fit-validation",
                                            "detail": "; ".join(fit["blocking"])}, "artifacts": artifacts})
            else:
                receipt.update({"status": "completed", "retry": "not-requested", "artifacts": artifacts})
    receipt["input_hashes"] = sorted(item["sha256"] for item in checked["inputs"])
    receipt["output_hashes"] = sorted(item["sha256"] for item in receipt["artifacts"].values())
    receipt["queue_ms"] = {"provenance": "unavailable", "value": None}
    receipt["execution_ms"] = {"provenance": "measured", "value": execution["duration_ms"]}
    receipt["model_usage"] = checked["measurement"]["model_usage"]
    receipt["human_minutes"] = {"provenance": checked["measurement"]["provenance"],
                                "value": checked["measurement"]["human_minutes"]}
    (root / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True), encoding="utf-8")
    return receipt
