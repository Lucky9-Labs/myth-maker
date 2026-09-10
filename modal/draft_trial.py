"""Bounded Astra-operated Blender GUI worker for encounter components."""
from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

import modal

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, "/opt")
from draft_support import blender_launch_args, budget_phase, classify_model_stop, finalize_terminal_state, incremental_evidence_ready, incremental_gain_reached, incremental_score_threshold_reached, incremental_target, incremental_turn_plan, normalize_keys, normalize_pointer_keys, parse_incremental_rating, read_incremental_response, record_incremental_rating, validate_input_aliases, validate_input_names, validate_typed_text, native_name, pinned_worker_contract, render_prompt, validate_cloud_need
from draft_checkpoints import CheckpointStore, load_resume, load_terminal_artifact, modal_volume_receipt, read_stable, sha256, validate_native, write_json_atomic
from desktop_readiness import configure_isolated_x11, prepare_isolated_x11_runtime, terminal_failure, wait_for_desktop
from deterministic_encounter import MATERIAL_NAMES, recipe_digest, validate_recipe
from glb_source_importer import validate_glb
from infrastructure import runtime
from modal_volume_inputs import load_volume_inputs, validate_volume_input_manifest
from asset_production import (create_run_ledger, run_asset_production_job as execute_asset_production_job,
                              prepare_correction_wave, validate_critique_request, validate_job_manifest, validate_visual_critique)
from asset_progress import build_dashboard, dashboard_bundle, evaluate_reference_progress
from component_diffusion import run_component_diffusion, validate_component_diffusion_job

RUNTIME = runtime()
app = modal.App(RUNTIME.app_name)


image = (modal.Image.from_registry("python:3.12-slim-bookworm")
         .apt_install("ca-certificates", "curl", "git", "git-lfs", "libegl1", "libgl1", "libxkbcommon0", "openssh-client", "scrot", "tk", "x11-xserver-utils", "xvfb", "xz-utils")
         .add_local_file(HERE / "install_blender.sh", "/opt/install_blender.sh", copy=True)
         .run_commands(
             "/bin/sh /opt/install_blender.sh")
         .pip_install("openai>=2,<3", "Pillow>=10,<12", "pyautogui>=0.9.54,<1")
         .apt_install("xdotool", "openbox", "x11-utils", "tesseract-ocr")
         # These are import-time runtime dependencies.  `copy=True` makes
         # them immutable image layers; non-copy local-file mounts are not
         # available when Modal imports the deployed function service.
         .add_local_file(HERE / "draft_prompt.md", "/opt/draft_prompt.md", copy=True)
         .add_local_file(HERE / "draft_resume.md", "/opt/draft_resume.md", copy=True)
         .add_local_file(HERE / "draft_support.py", "/opt/draft_support.py", copy=True)
         .add_local_file(HERE / "infrastructure.py", "/opt/infrastructure.py", copy=True)
         .add_local_file(HERE / "desktop_readiness.py", "/opt/desktop_readiness.py", copy=True)
         .add_local_file(HERE / "draft_checkpoints.py", "/opt/draft_checkpoints.py", copy=True)
         .add_local_file(HERE / "deterministic_encounter.py", "/opt/deterministic_encounter.py", copy=True)
         .add_local_file(HERE / "encounter_worker_adapter.py", "/opt/encounter_worker_adapter.py", copy=True)
         .add_local_file(HERE / "glb_source_importer.py", "/opt/glb_source_importer.py", copy=True)
         .add_local_file(HERE / "modal_volume_inputs.py", "/opt/modal_volume_inputs.py", copy=True))
image = (image
         .add_local_file(HERE / "asset_production.py", "/opt/asset_production.py", copy=True)
         .add_local_file(HERE / "asset_progress.py", "/opt/asset_progress.py", copy=True)
         .add_local_file(HERE / "asset_production_blender.py", "/opt/asset_production_blender.py", copy=True)
         .add_local_file(HERE / "component_diffusion.py", "/opt/component_diffusion.py", copy=True))

diffusion_image = (modal.Image.from_registry("nvidia/cuda:12.4.1-runtime-ubuntu22.04", add_python="3.12")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .run_commands("python -m pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124")
    .pip_install(
        "transformers==4.46.0", "diffusers==0.30.0", "accelerate==1.1.1",
        "huggingface-hub==0.30.2", "safetensors==0.4.4", "numpy==1.26.4",
        "scipy==1.14.1", "einops==0.8.0", "omegaconf==2.3.0", "pyyaml==6.0.2",
        "opencv-python-headless==4.10.0.84", "imageio==2.36.0", "scikit-image==0.24.0",
        "rembg==2.0.65", "onnxruntime==1.17.3", "trimesh==4.4.7",
        "pymeshlab==2022.2.post3", "pygltflib==1.16.3", "xatlas==0.0.9",
        "tqdm==4.66.5", "psutil==6.0.0", "pydantic==2.10.6", "timm", "torchdiffeq")
    .run_commands(
        "git clone --filter=blob:none https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1.git /opt/Hunyuan3D-2.1",
        "cd /opt/Hunyuan3D-2.1 && git checkout 82920d643c0dc2f7bfd7255f45f62d386edfe60c")
    .add_local_file(HERE / "component_diffusion.py", "/opt/component_diffusion.py", copy=True)
    .env({"HF_HOME": "/submissions/model-cache/huggingface", "PYTHONPATH": "/opt"}))

volume = modal.Volume.from_name(RUNTIME.volume_name)
SUBMISSIONS_ROOT = Path("/submissions")


@app.function(image=image, timeout=60, cpu=0.125, retries=0, max_containers=1)
def run_dispatch_probe(work_order: dict) -> dict:
    """Return a bounded, provider-observable terminal receipt without using OpenAI or Blender."""
    required = {"schema_version", "work_id", "attempt", "kind"}
    if set(work_order) != required or work_order.get("schema_version") != "1" or work_order.get("kind") != "bounded-health-probe":
        raise ValueError("invalid bounded Modal probe work order")
    if not isinstance(work_order["work_id"], str) or not work_order["work_id"] or work_order.get("attempt") != 1:
        raise ValueError("bounded Modal probe requires one stable first attempt")
    function_call_id = modal.current_function_call_id()
    input_id = modal.current_input_id()
    if not function_call_id or not input_id:
        raise RuntimeError("Modal did not provide a call and input identity to the remote probe")
    return {
        "status": "completed",
        "work_id": work_order["work_id"],
        "function_call_id": function_call_id,
        "input_id": input_id,
        "worker_id": input_id,
    }
secret = modal.Secret.from_name(
    RUNTIME.openai_secret_name,
    required_keys=list(RUNTIME.openai_secret_keys),
)
MAX_ACTIONS = 350
MAX_TURNS = 40
MAX_SECONDS = 12 * 60
part_leases = modal.Dict.from_name(
    RUNTIME.lease_dict_name,
)

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _deterministic_artifact(path: Path) -> dict:
    data = read_stable(path)
    return {"bytes": len(data), "sha256": digest(data)}


def _validate_deterministic_png(path: Path) -> dict:
    """Reject a staged frame that is not a decodable, non-empty PNG."""
    from PIL import Image

    with Image.open(io.BytesIO(read_stable(path))) as picture:
        if picture.format != "PNG" or picture.width <= 0 or picture.height <= 0:
            raise RuntimeError("deterministic Blender recipe emitted an invalid staged PNG")
        width, height = picture.size
        picture.verify()
    return {"width": width, "height": height}


@app.function(image=image, cpu=4, memory=8192, timeout=8 * 60, retries=0, max_containers=1,
              volumes={"/submissions": volume})
def run_deterministic_recipe(job_id: str, recipe: dict, provenance: dict) -> dict:
    """Build one generic recipe in Blender without a model API or secret.

    This is separate from ``run_draft``: it mounts the private evidence Volume
    but has no OpenAI secret and never calls the Responses API.  Hashes and
    the provider receipt are produced in the Modal container after Blender
    writes the native scene, self-contained GLB, and three staged PNG frames.
    """
    if not isinstance(job_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,95}", job_id):
        raise ValueError("deterministic recipe job_id must be a stable identifier")
    checked_recipe = validate_recipe(recipe)
    if not isinstance(provenance, dict) or set(provenance) - {"source_sha", "request_kind", "deployed_function_id"}:
        raise ValueError("deterministic recipe provenance has an invalid shape")
    source_sha = provenance.get("source_sha")
    if not isinstance(source_sha, str) or not re.fullmatch(r"[a-f0-9]{40}", source_sha):
        raise ValueError("deterministic recipe provenance needs an immutable source_sha")
    if provenance.get("request_kind", "deterministic-encounter-recipe") != "deterministic-encounter-recipe":
        raise ValueError("deterministic recipe provenance has an unsupported request_kind")
    deployed_function_id = provenance.get("deployed_function_id")
    if not isinstance(deployed_function_id, str) or not re.fullmatch(r"fu-[A-Za-z0-9]+", deployed_function_id):
        raise ValueError("deterministic recipe provenance needs the deployed Modal function ID")
    function_call_id, input_id = modal.current_function_call_id(), modal.current_input_id()
    if not function_call_id or not input_id:
        raise RuntimeError("Modal did not provide a call and input identity to the deterministic recipe")

    volume.reload()
    root = SUBMISSIONS_ROOT / job_id
    root.mkdir(exist_ok=False)
    output, frames = root / "output", root / "frames"
    output.mkdir()
    recipe_path = root / "recipe.json"
    recipe_bytes = json.dumps(checked_recipe, sort_keys=True, separators=(",", ":")).encode("utf-8")
    recipe_path.write_bytes(recipe_bytes)
    native = output / (checked_recipe["recipe_id"] + ".blend")
    glb = output / (checked_recipe["recipe_id"] + ".glb")
    command = ["/usr/local/bin/blender", "--background", "--factory-startup", "--disable-autoexec",
               "--python", "/opt/deterministic_encounter.py", "--", "--recipe", str(recipe_path),
               "--output", str(native), "--frames", str(frames), "--glb", str(glb)]
    started = time.monotonic()
    completed = subprocess.run(command, capture_output=True, text=True, timeout=7 * 60, check=False)
    execution = {
        "engine": "blender-cli", "returncode": completed.returncode,
        "duration_ms": round((time.monotonic() - started) * 1000),
        "stdout_sha256": digest(completed.stdout.encode()), "stderr_sha256": digest(completed.stderr.encode()),
    }
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip().replace("\n", " ")[:500]
        raise RuntimeError("deterministic Blender recipe failed" + (": " + detail if detail else ""))
    required_frames = {
        "initial": frames / "000-initial.png",
        "intermediate": frames / "010-appendages.png",
        "final": frames / "020-final.png",
    }
    if not native.is_file() or not glb.is_file() or not all(path.is_file() for path in required_frames.values()):
        raise RuntimeError("deterministic Blender recipe omitted a required native, GLB, or staged frame")
    validate_native(read_stable(native))
    glb_document = validate_glb(read_stable(glb), material_allowlist=list(MATERIAL_NAMES), extension_allowlist=[])
    expected_nodes = {"encounter-body"} | {
        f"encounter-appendage-{index:02d}" for index in range(checked_recipe["appendages"]["count"])
    }
    node_names = {
        node.get("name") for node in glb_document.get("nodes", [])
        if isinstance(node, dict) and isinstance(node.get("name"), str)
    }
    missing_nodes = sorted(expected_nodes - node_names)
    if missing_nodes:
        raise RuntimeError("deterministic GLB omitted required encounter nodes: " + ", ".join(missing_nodes))
    frame_validation = {label: _validate_deterministic_png(path) for label, path in required_frames.items()}
    output_files = {path.name: _deterministic_artifact(path) for path in (native, glb)}
    frame_files = {
        label: (str(path.relative_to(root)), _deterministic_artifact(path))
        for label, path in required_frames.items()
    }
    state = {
        "format": "myth-maker.deterministic-modal-blender-receipt/v1",
        "status": "completed", "job_id": job_id, "recipe_id": checked_recipe["recipe_id"],
        "execution": execution,
        "provenance": {
            "source_sha": source_sha, "recipe_format": checked_recipe["format"],
            "recipe_sha256": recipe_digest(checked_recipe), "deployed_function_id": deployed_function_id,
            "openai_api_used": False,
        },
        "glb_validation": {
            "format": "glb-2.0-self-contained", "node_count": len(glb_document.get("nodes", [])),
            "appendage_count": checked_recipe["appendages"]["count"],
            "required_node_names": sorted(expected_nodes),
            "material_names": [item.get("name") for item in glb_document.get("materials", [])],
        },
        "frame_validation": frame_validation,
        "files": output_files,
        "provider_receipt": modal_volume_receipt(
            volume_name=RUNTIME.volume_name, job_id=job_id, app_name=RUNTIME.app_name,
            environment=RUNTIME.environment, function_name="run_deterministic_recipe",
            function_call_id=function_call_id, input_id=input_id, output_files=output_files,
            blender_frames=frame_files),
    }
    write_json_atomic(root / "status.json", state)
    volume.commit()
    return state


def image_item(data: bytes) -> dict:
    from PIL import Image
    output = io.BytesIO()
    with Image.open(io.BytesIO(data)) as picture:
        picture.convert("RGB").save(output, format="PNG")
    return {"type": "input_image", "image_url": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode(), "detail": "original"}


@app.function(image=image, gpu="T4", cpu=4, memory=8192, timeout=16 * 60,
              retries=0, max_containers=4, volumes={"/submissions": volume})
def run_asset_production_job(job: dict) -> dict:
    """Run one closed, immutable asset-production attempt entirely in Modal."""
    checked = validate_job_manifest(job)
    lease_key = "asset-production:" + checked["run_id"] + ":" + checked["worker_slot"]
    lease_value = checked["work_id"] + ":a" + str(checked["attempt"])
    if not part_leases.put(lease_key, lease_value, skip_if_exists=True):
        raise RuntimeError("asset-production slot already claimed; reconcile it before dispatch")
    try:
        function_call_id, input_id = modal.current_function_call_id(), modal.current_input_id()
        if not function_call_id or not input_id:
            raise RuntimeError("Modal did not provide asset-production call and input identities")
        volume.reload()
        receipt = execute_asset_production_job(
            checked, SUBMISSIONS_ROOT, SUBMISSIONS_ROOT / "asset-production",
            "/usr/local/bin/blender", function_call_id=function_call_id, input_id=input_id,
        )
        volume.commit()
        return receipt
    finally:
        if part_leases.get(lease_key) == lease_value:
            part_leases.pop(lease_key)


@app.function(image=diffusion_image, gpu="L40S", cpu=4, memory=32768, timeout=30 * 60,
              retries=0, max_containers=1, volumes={"/submissions": volume})
def run_component_diffusion_job(job: dict) -> dict:
    """Generate immutable component shell candidates from the frozen cloud reference."""
    checked = validate_component_diffusion_job(job)
    lease_key = "component-diffusion:" + checked["run_id"] + ":" + checked["component_id"]
    lease_value = checked["work_id"] + ":a" + str(checked["attempt"])
    if not part_leases.put(lease_key, lease_value, skip_if_exists=True):
        raise RuntimeError("component diffusion lane already claimed; reconcile it before dispatch")
    try:
        volume.reload()
        receipt = run_component_diffusion(checked, SUBMISSIONS_ROOT)
        volume.commit()
        return receipt
    finally:
        if part_leases.get(lease_key) == lease_value:
            part_leases.pop(lease_key)


@app.function(image=image, gpu="T4", cpu=4, memory=8192, timeout=6 * 60,
              retries=0, max_containers=4, secrets=[secret], volumes={"/submissions": volume})
def run_asset_visual_critique(request: dict) -> dict:
    """Perform one bounded, evidence-only Astra review of cloud renders."""
    checked = validate_critique_request(request)
    volume.reload()
    content = [{
        "type": "input_text",
        "text": (
            "Review this assembled game asset only against observable production criteria: silhouette, "
            "reference coherence, fit, articulation, weapon handling, animation readability, material "
            "identity, export correctness, and performance-visible complexity. Return JSON only with "
            "format myth-maker.asset-visual-critique/v1 and a defects array. Each defect requires "
            "defect_id and component_id in lowercase kebab-case, evidence_view, observable_problem, "
            "severity (blocking, nonblocking, or cosmetic), criterion, recommended_correction, and "
            "confidence from 0 to 1. Do not invent hidden geometry defects. Cosmetic defects are backlog. "
            "Prior dispositions: " + json.dumps(checked["prior_defects"], sort_keys=True)
        ),
    }]
    for artifact in checked["artifacts"]:
        path = (SUBMISSIONS_ROOT / artifact["path"]).resolve()
        if not path.is_relative_to(SUBMISSIONS_ROOT.resolve()) or not path.is_file():
            raise ValueError("critique artifact is unavailable: " + artifact["path"])
        data = read_stable(path)
        if len(data) != artifact["bytes"] or digest(data) != artifact["sha256"]:
            raise ValueError("critique artifact hash mismatch: " + artifact["path"])
        content.append({"type": "input_text", "text": "Evidence view: " + Path(artifact["path"]).stem})
        content.append({"type": "input_image", "image_url": "data:image/png;base64," + base64.b64encode(data).decode()})
    from openai import OpenAI
    started = time.monotonic()
    response = OpenAI().responses.create(
        model=checked["model"], input=[{"role": "user", "content": content}],
        reasoning={"effort": "high"}, max_output_tokens=5000, timeout=300,
    )
    if response.status != "completed" or not response.output_text:
        raise RuntimeError("asset visual critique did not return a completed JSON result")
    try:
        critique = validate_visual_critique(json.loads(response.output_text))
    except (json.JSONDecodeError, ValueError) as error:
        raise RuntimeError("asset visual critique returned an invalid closed result") from error
    usage = response.usage.model_dump() if response.usage else None
    cached = ((usage or {}).get("input_tokens_details") or {}).get("cached_tokens")
    if usage is not None and cached is None:
        cached = 0
    receipt = {
        "format": "myth-maker.asset-critique-receipt/v1", "status": "completed",
        "run_id": checked["run_id"], "work_id": checked["work_id"], "attempt": checked["attempt"],
        "provider": {"name": "openai", "model": checked["model"], "request_id": response.id},
        "duration_ms": round((time.monotonic() - started) * 1000),
        "model_usage": {
            "provenance": "measured" if usage else "unavailable",
            "input_tokens": (usage or {}).get("input_tokens"), "cached_input_tokens": cached,
            "output_tokens": (usage or {}).get("output_tokens"),
        },
        "critique": critique,
    }
    root = (SUBMISSIONS_ROOT / "asset-production" / checked["run_id"] / checked["work_id"]
            / f"critique-attempt-{checked['attempt']:04d}")
    root.mkdir(parents=True, exist_ok=False)
    write_json_atomic(root / "receipt.json", receipt)
    volume.commit()
    return receipt


@app.function(image=image, cpu=0.25, memory=512, timeout=60, retries=0, max_containers=1,
              volumes={"/submissions": volume})
def record_asset_production_run(wave: list[dict], receipts: list[dict]) -> dict:
    """Persist the closed run projection after observed cloud attempts."""
    run_id = validate_job_manifest(wave[0])["run_id"]
    root = SUBMISSIONS_ROOT / "asset-production" / run_id
    root.mkdir(parents=True, exist_ok=True)
    ledger_path = root / "run-ledger.json"
    prior = json.loads(read_stable(ledger_path)) if ledger_path.is_file() else None
    ledger = create_run_ledger(wave, receipts, prior)
    write_json_atomic(ledger_path, ledger)
    volume.commit()
    return ledger


@app.function(image=image, schedule=modal.Period(seconds=300), cpu=0.25, memory=512,
              timeout=360, retries=0, max_containers=1, secrets=[secret], volumes={"/submissions": volume})
def refresh_asset_progress_dashboards() -> dict:
    """Regenerate private progress GIFs for every observed production run."""
    volume.reload()
    root = SUBMISSIONS_ROOT / "asset-production"
    refreshed = []
    if root.is_dir():
        for run_root in sorted(root.iterdir()):
            if run_root.is_dir():
                # The five-minute schedule is observability-only. Paid Astra
                # evaluation is an explicit production gate after deterministic
                # and visual inspection; running it here silently spends money
                # on every new candidate, including cheap-gate rejects.
                refreshed.append(build_dashboard(run_root))
        volume.commit()
    return {"status": "completed", "runs": len(refreshed), "dashboards": refreshed}


@app.function(image=image, cpu=0.25, memory=512, timeout=360, retries=0,
              max_containers=1, secrets=[secret], volumes={"/submissions": volume})
def evaluate_asset_reference_progress(run_id: str) -> dict:
    """Run or reuse the reference evaluation for the current revision set."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,95}", run_id or ""):
        raise ValueError("invalid asset production run id")
    volume.reload()
    run_root = SUBMISSIONS_ROOT / "asset-production" / run_id
    if not run_root.is_dir(): raise ValueError("asset production run is unavailable")
    from openai import OpenAI
    receipt = evaluate_reference_progress(run_root, OpenAI())
    build_dashboard(run_root); volume.commit()
    return receipt


@app.function(image=image, cpu=0.25, memory=512, timeout=120, retries=0,
              max_containers=1, volumes={"/submissions": volume})
def get_asset_progress_dashboard(run_id: str) -> dict:
    """Fetch one private dashboard through authenticated Modal function access."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,95}", run_id or ""):
        raise ValueError("invalid asset production run id")
    volume.reload()
    run_root = SUBMISSIONS_ROOT / "asset-production" / run_id
    if not run_root.is_dir():
        raise ValueError("asset production run is unavailable")
    bundle = dashboard_bundle(run_root)
    volume.commit()
    return bundle


@app.function(image=image, cpu=0.25, memory=512, timeout=120, retries=0,
              max_containers=1, volumes={"/submissions": volume})
def prepare_asset_correction_wave(run_id: str, runtime_deployment: dict,
                                  apply_reference_batch: bool = False,
                                  reference_batch_slot: str | None = None,
                                  correction_spec: dict | None = None,
                                  correction_specs: dict[str, dict] | None = None) -> list[dict]:
    """Build the next immutable defect-correction wave from cloud baselines."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,95}", run_id or ""):
        raise ValueError("invalid asset production run id")
    volume.reload()
    return prepare_correction_wave(SUBMISSIONS_ROOT / "asset-production" / run_id, runtime_deployment,
                                   apply_reference_batch=apply_reference_batch,
                                   reference_batch_slot=reference_batch_slot,
                                   correction_spec=correction_spec,
                                   correction_specs=correction_specs)

def screenshot(path: Path) -> bytes:
    subprocess.run(["scrot", "-o", str(path)], check=True, capture_output=True, timeout=5)
    return path.read_bytes()


def execute_actions(actions: list, remaining: int, deadline: float) -> int:
    import pyautogui as gui
    if len(actions) > remaining:
        raise RuntimeError("UI action budget exhausted")
    gui.FAILSAFE = True
    for raw in actions:
        if time.monotonic() >= deadline:
            raise RuntimeError("Interaction deadline exhausted before completing action batch")
        action = raw.model_dump() if hasattr(raw, "model_dump") else raw
        kind = action["type"]
        pointer_button = None
        if kind == "keypress":
            keys = normalize_keys(action["keys"]) if action.get("keys") else []
        elif kind in {"click", "double_click", "drag", "move", "scroll"}:
            keys, pointer_button = normalize_pointer_keys(action.get("keys"))
        else:
            keys = []
        if kind == "keypress":
            if not keys:
                raise ValueError("Empty keypress")
            subprocess.run(["xdotool", "key", "--clearmodifiers", "+".join(keys)], check=True)
        elif kind == "type":
            validate_typed_text(action["text"])
            gui.write(action["text"], interval=0.004)
        elif kind in {"click", "double_click", "drag", "move", "scroll"}:
            if keys:
                subprocess.run(["xdotool", "keydown", *keys], check=True)
            try:
                if pointer_button and kind in {"move", "scroll"}:
                    raise ValueError("Mouse button tokens are only permitted for click or drag actions")
                explicit_button = action.get("button")
                if explicit_button and pointer_button and explicit_button != pointer_button:
                    raise ValueError("Conflicting pointer button declarations")
                button = explicit_button or pointer_button or "left"
                if button not in {"left", "right", "middle"}:
                    raise ValueError("Unsupported mouse button")
                if kind in {"click", "double_click"}:
                    gui.click(action["x"], action["y"], clicks=2 if kind == "double_click" else 1, interval=0.12, button=button)
                elif kind == "move":
                    gui.moveTo(action["x"], action["y"])
                elif kind == "scroll":
                    gui.moveTo(action["x"], action["y"])
                    amount = action.get("scroll_y", 0)
                    gui.scroll(-round(amount / 100) if abs(amount) >= 100 else -amount)
                else:
                    path = action["path"]
                    gui.moveTo(path[0]["x"], path[0]["y"])
                    gui.mouseDown(button=button)
                    try:
                        for point in path[1:]:
                            gui.moveTo(point["x"], point["y"], duration=0.08)
                    finally:
                        gui.mouseUp(button=button)
            finally:
                if keys:
                    subprocess.run(["xdotool", "keyup", *keys], check=True)
        elif kind == "wait":
            time.sleep(min(action.get("ms", 1000) / 1000, 5, max(0, deadline - time.monotonic())))
        elif kind != "screenshot":
            raise ValueError(f"Unsupported action: {kind}")
    return len(actions)


@app.function(image=image, gpu="T4", cpu=4, memory=8192, timeout=16 * 60,
              retries=0, max_containers=4, secrets=[secret], volumes={"/submissions": volume})
def run_draft(job_id: str, inputs: dict[str, bytes], provenance: dict, project_id: str, part: str,
              resume_job: str = "", checkpoint_id: str = "", feedback: str = "",
              reviewed_score: float = -1, resume_artifact: str = "",
              resume_sha256: str = "", incremental: bool = False,
              baseline_score: int = 0, baseline_source: str = "explicit_incremental_self_score",
              prior_model_self_score: int = -1) -> dict:
    """Atomic per-component cloud ownership; never steal a lease or retry automatically."""
    return _run_draft_entry(job_id, inputs, provenance, project_id, part, resume_job, checkpoint_id,
                            feedback, reviewed_score, resume_artifact, resume_sha256, incremental,
                            baseline_score, baseline_source, prior_model_self_score)


@app.function(image=image, gpu="T4", cpu=4, memory=8192, timeout=16 * 60,
              retries=0, max_containers=4, secrets=[secret], volumes={"/submissions": volume})
def run_draft_from_volume_manifest(work_order: dict, manifest: dict, provenance: dict,
                                   project_id: str) -> dict:
    """Resolve immutable inputs inside Modal, then enter the existing GUI-only worker."""
    checked = validate_volume_input_manifest(manifest, expected_volume=RUNTIME.volume_name)
    volume.reload()
    inputs = load_volume_inputs(checked, SUBMISSIONS_ROOT, expected_volume=RUNTIME.volume_name)
    work_id, attempt = work_order.get("work_id"), work_order.get("attempt")
    if not isinstance(work_id, str) or not isinstance(attempt, int) or isinstance(attempt, bool):
        raise ValueError("volume draft work order needs stable work_id and attempt")
    job_id = f"draft-gui-{work_id}-a{attempt}"
    invocation_provenance = dict(provenance)
    invocation_provenance["encounter_work_order"] = {
        "work_id": work_id, "encounter_id": work_order.get("encounter_id"),
        "lane": work_order.get("lane"), "attempt": attempt,
    }
    invocation_provenance["input_manifest"] = checked
    return _run_draft_entry(job_id, inputs, invocation_provenance, project_id, work_id,
                            feedback=work_order.get("instruction", ""))


def _run_draft_entry(job_id: str, inputs: dict[str, bytes], provenance: dict, project_id: str,
                     part: str, resume_job: str = "", checkpoint_id: str = "", feedback: str = "",
                     reviewed_score: float = -1, resume_artifact: str = "", resume_sha256: str = "",
                     incremental: bool = False, baseline_score: int = 0,
                     baseline_source: str = "explicit_incremental_self_score",
                     prior_model_self_score: int = -1) -> dict:
    native_name(project_id)
    native_name(part)
    lease_key = project_id + ":" + part
    if not incremental:
        validate_cloud_need(reviewed_score)
    else:
        incremental_target(baseline_score)
        provenance["incremental_request"] = {
            "baseline_score": baseline_score,
            "baseline_score_kind": baseline_source,
            "incremental_cloud_target": 8,
            "independent_visual_score": reviewed_score if reviewed_score != -1 else None,
            "prior_model_self_score": prior_model_self_score if prior_model_self_score != -1 else None,
        }
    if not part_leases.put(lease_key, job_id, skip_if_exists=True):
        raise RuntimeError("Cloud component already claimed; reconcile its existing job, do not duplicate")
    try:
        provenance["project_id"] = project_id
        function_call_id = modal.current_function_call_id()
        input_id = modal.current_input_id()
        if not function_call_id or not input_id:
            raise RuntimeError("Modal did not provide call and input identities to the Blender draft")
        return _run_draft(job_id, inputs, provenance, part, resume_job, checkpoint_id, feedback,
                          resume_artifact, resume_sha256, incremental, baseline_score,
                          function_call_id, input_id)
    finally:
        # Hard container termination may leave this protective lease. A coordinator
        # must verify terminal state before manually repairing it; no age stealing.
        if part_leases.get(lease_key) == job_id:
            part_leases.pop(lease_key)


def _run_draft(job_id: str, inputs: dict[str, bytes], provenance: dict, part: str,
               resume_job: str = "", checkpoint_id: str = "", feedback: str = "",
               resume_artifact: str = "", resume_sha256: str = "",
               incremental: bool = False, baseline_score: int = 0,
               function_call_id: str = "", input_id: str = "") -> dict:
    native = native_name(part)
    provenance["part"] = part
    provenance["cloud_target"] = 8 if incremental else 4
    provenance["local_target"] = 8
    from openai import OpenAI
    if not job_id.startswith("draft-gui-") or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in job_id):
        raise ValueError("Invalid isolated job ID")
    if resume_job and (not resume_job.startswith("draft-gui-")
                       or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in resume_job)):
        raise ValueError("Invalid isolated resume job ID")
    if not job_id:
        raise ValueError("Missing job ID")
    if bool(resume_artifact) != bool(resume_sha256):
        raise ValueError("Terminal artifact resume requires both filename and SHA-256")
    if resume_artifact and checkpoint_id:
        raise ValueError("Terminal artifact resume cannot claim a checkpoint")
    if incremental:
        incremental_target(baseline_score)
        if not resume_job:
            raise ValueError("Incremental mode requires a loaded parent native")
    resume = None
    input_aliases = {}
    if resume_job:
        volume.reload()
        parent_root = Path("/submissions") / resume_job
        resume = (load_terminal_artifact(parent_root, resume_artifact, resume_sha256, part=part)
                  if resume_artifact else load_resume(parent_root, checkpoint_id, part=part))
        inputs = resume["inputs"]
        input_aliases = resume.get("input_aliases", {})
        provenance["parent_terminal_artifact" if resume_artifact else "parent_checkpoint"] = resume["parent"]
        provenance["parent_provenance"] = resume["parent_provenance"]
        if input_aliases:
            provenance["derived_input_aliases"] = {
                name: {"canonical_name": "component_reference.png", "sha256": digest(data), "bytes": len(data)}
                for name, data in input_aliases.items()
            }
    validate_input_names(inputs, resuming=bool(resume))
    validate_input_aliases(inputs, input_aliases if resume else {})
    root = Path("/submissions") / job_id
    root.mkdir(exist_ok=False)
    reference_dir = Path("/inputs")
    reference_dir.mkdir()
    output = root / "output"
    output.mkdir()
    Path("/output").symlink_to(output, target_is_directory=True)
    job_inputs = root / "inputs"
    job_inputs.mkdir()
    for name, data in {**inputs, **input_aliases}.items():
        destination = reference_dir / name
        destination.write_bytes(data)
        destination.chmod(0o444)
        # Keep job-local compatibility paths durable for portable resumes.
        job_destination = job_inputs / name
        job_destination.write_bytes(data)
        job_destination.chmod(0o444)
    goal = render_prompt(Path("/opt/draft_prompt.md").read_text(), part)
    if feedback and not (resume_artifact or incremental):
        goal += "\n\n# User continuation direction\n" + feedback
    protocol = render_prompt(Path("/opt/draft_resume.md").read_text(), part)
    prompt = goal + "\n\n" + protocol + pinned_worker_contract(provenance)
    if resume:
        (output / native).write_bytes(resume["blend"])
        prompt += ("\n\n# THIS IS A RESUME, NOT A FRESH SCENE\n"
                   f"Blender is opening the existing /output/{native} checkpoint. "
                   "Ignore earlier fresh-factory-scene setup instructions. Do NOT delete "
                   "existing objects or rebuild the component. The saved references are restored "
                   "at their original /inputs paths. The parent source-scene snapshot "
                   "may be absent; the component checkpoint is your starting model. "
                   + ("This specific continuation is user-authorized once for a terminal artifact: "
                      "use Blender GUI Save As immediately to verify /output/" + native +
                      " exists, without modifying the immutable parent artifact.\n\n" if resume_artifact else "\n\n")
                   + resume["handoff"])
        if feedback and (resume_artifact or incremental):
            prompt += "\n\n# User continuation direction\n" + feedback
    if incremental:
        target_score = incremental_target(baseline_score)
        prompt += ("\n\n# CURRENT USER-AUTHORIZED INCREMENTAL OVERRIDE\n"
                   "This current authorization supersedes inherited 4/10 cloud limits and any no-continuation "
                   "wording above. Work only from this loaded native, retain the fixed baseline score, and make "
                   f"at most one scored step: {baseline_score}/10 to {target_score}/10 (incremental cloud cap 8/10). "
                   "After one actual scored improvement with a changed saved native hash, stop for handoff; do not "
                   "start a second increment. Emit the required public INCREMENTAL_RATING JSON marker after each "
                   "comparison. If the baseline is already 8/10 or higher, do no modeling: obtain fresh visible evidence, "
                   "save the loaded native through the Blender GUI, verify its saved timestamp/hash, and hand off "
                   "as PARTIAL or READY_FOR_REVIEW without claiming a gain or independent acceptance.")
        request_meta = provenance["incremental_request"]
        if request_meta["prior_model_self_score"] is not None and request_meta["prior_model_self_score"] != baseline_score:
            prompt += (" The supplied baseline is a current " + request_meta["baseline_score_kind"] +
                       f" ({baseline_score}/10); preserve and disclose the earlier model self-score "
                       f"({request_meta['prior_model_self_score']}/10) in the first comparison. This recalibration "
                       "is not a scored gain: confirm it against the reference before editing, or report a disputed seed.")
    (root / "goal.md").write_text(goal)
    (root / "prompt.md").write_text(prompt)
    (root / "provenance.json").write_text(json.dumps(provenance, indent=2))
    references = root / "references"
    references.mkdir()
    for name, data in inputs.items():
        if not name.endswith(".blend"):
            (references / name).write_bytes(data)
    shots = root / "screenshots"
    shots.mkdir()
    configure_isolated_x11(os.environ, runtime_dir=f"/tmp/{job_id}-runtime")
    runtime_dir = prepare_isolated_x11_runtime(os.environ)
    Path(os.environ["XAUTHORITY"]).touch(mode=0o600)
    runtime_stat = runtime_dir.stat()
    (root / "launch-environment.json").write_text(json.dumps({
        "display": os.environ["DISPLAY"],
        "wayland_display_repr": repr(os.environ["WAYLAND_DISPLAY"]),
        "wayland_display_length": len(os.environ["WAYLAND_DISPLAY"]),
        "xdg_session_type": os.environ["XDG_SESSION_TYPE"],
        "xdg_runtime_dir": str(runtime_dir),
        "xdg_runtime_mode": oct(runtime_stat.st_mode & 0o777),
        "xdg_runtime_owner_uid": runtime_stat.st_uid,
        "xdg_runtime_owner_gid": runtime_stat.st_gid,
    }, indent=2))
    processes = []
    process_logs = []
    incremental_state = None
    if incremental:
        incremental_state = {"baseline_score": baseline_score, "target_score": incremental_target(baseline_score),
                             "baseline_score_kind": provenance["incremental_request"]["baseline_score_kind"],
                             "independent_visual_score": provenance["incremental_request"]["independent_visual_score"],
                             "prior_model_self_score": provenance["incremental_request"]["prior_model_self_score"],
                             "current_score": None, "baseline_native_sha256": digest(resume["blend"]),
                             "current_native_sha256": digest(resume["blend"]),
                             "baseline_native_mtime_ns": (output / native).stat().st_mtime_ns,
                             "current_native_mtime_ns": (output / native).stat().st_mtime_ns,
                             "evidence_only": baseline_score >= 8, "save_only": False,
                             "save_only_instruction_issued": False}
    state = {"job_id": job_id, "part": part, "cloud_target": 8 if incremental else 4, "local_target": 8, "status": "starting", "model": "gpt-6-astra", "actions": 0, "turns": 0,
             "input_tokens": 0, "output_tokens": 0, "acceptance": "not reviewed", "model_report": "",
             "resumed_from": resume["parent"] if resume else None,
             "resume_kind": "terminal_artifact" if resume_artifact else "checkpoint" if resume else None,
             "stop_reason": None}
    if incremental_state:
        state["incremental"] = incremental_state
    if resume:
        state["resume_handoff"] = resume["handoff"]
    checkpoints = CheckpointStore(root, inputs, goal, provenance, part, input_aliases=input_aliases)

    def checkpoint(*, force: bool = False) -> None:
        try:
            manifest = checkpoints.capture(state.copy(), force=force)
            if manifest:
                state["checkpoint_id"] = manifest["checkpoint_id"]
                state["checkpoint_native_sha256"] = manifest["files"][native]["sha256"]
                state["checkpoint_error"] = None
        except (ValueError, OSError) as error:
            # Never publish a partially written save or destroy an earlier checkpoint.
            state["checkpoint_error"] = str(error)[:600]

    def persist() -> None:
        state["updated_at"] = datetime.now(timezone.utc).isoformat()
        state["artifacts"] = {p.name: p.stat().st_size for p in output.iterdir() if p.is_file()}
        write_json_atomic(root / "status.json", state)
        volume.commit()
        print(json.dumps(state), flush=True)

    try:
        for name in ("xvfb", "openbox", "blender"):
            process_logs.append((root / (name + ".log")).open("w"))
        processes.append(subprocess.Popen(["Xvfb", ":99", "-ac", "-screen", "0", "1600x1000x24", "-nolisten", "tcp"],
                                          stdout=process_logs[0], stderr=subprocess.STDOUT))
        time.sleep(2)
        processes.append(subprocess.Popen(["openbox"], stdout=process_logs[1], stderr=subprocess.STDOUT))
        blender_args = blender_launch_args(bool(resume), part)
        processes.append(subprocess.Popen(blender_args, stdout=process_logs[2], stderr=subprocess.STDOUT))
        if any(process.poll() is not None for process in processes):
            raise RuntimeError("An isolated desktop process exited during startup")
        # Do not spend model turns guessing at a black or unrecognized X11
        # desktop. The bounded probe records concrete startup evidence first.
        initial, readiness = wait_for_desktop(root, processes, time.monotonic() + 45)
        startup_capture = root / readiness["capture"]
        shutil.copy2(startup_capture, shots / "000-initial.png")
        shutil.copy2(startup_capture, root / "latest.png")
        state["desktop_readiness"] = {"capture": readiness["capture"],
                                      "window_id": readiness["window_id"],
                                      "ui_text": readiness["ui_text"]}
        state["status"] = "running"
        checkpoint()
        persist()
        client = OpenAI(api_key=os.environ["OPENAI_API_KEY"], timeout=MAX_SECONDS, max_retries=0)
        request_input = [{"role": "user", "content": [
            {"type": "input_text", "text": prompt + "\nThe attached image is the CURRENT BLENDER DESKTOP. Confirm its actual state before actions. Inspect the existing module first if resuming. Reference images are bundled at the paths above, not attached separately. Keep a reference pane available while modeling and reopen the skeleton and ink concept for comparisons."},
            image_item(initial)]}]
        previous = None
        deadline = time.monotonic() + MAX_SECONDS
        while state["turns"] < MAX_TURNS and time.monotonic() < deadline:
            milestone_saved = incremental_state and (
                incremental_gain_reached(baseline_score=incremental_state["baseline_score"],
                                         current_score=incremental_state["current_score"],
                                         baseline_native_sha256=incremental_state["baseline_native_sha256"],
                                         current_native_sha256=incremental_state["current_native_sha256"])
                or incremental_evidence_ready(baseline_score=incremental_state["baseline_score"],
                                              current_score=incremental_state["current_score"],
                                              baseline_native_mtime_ns=incremental_state["baseline_native_mtime_ns"],
                                              current_native_mtime_ns=incremental_state["current_native_mtime_ns"]))
            if incremental_state and incremental_state["save_only_instruction_issued"] and milestone_saved:
                # A changed hash alone is not a published milestone. Capture the
                # current Blender desktop plus stable native bytes before stopping.
                checkpoint(force=True)
                expected_hash = incremental_state["current_native_sha256"]
                if (state.get("checkpoint_native_sha256") == expected_hash and (root / "latest.png").is_file()):
                    state["status"] = "checkpointed_partial"
                    state["stop_reason"] = ("incremental_evidence_saved" if incremental_state["evidence_only"]
                                            else "incremental_milestone_saved")
                else:
                    state["status"] = "blocked"
                    state["stop_reason"] = "incremental_checkpoint_validation_failed"
                break
            if budget_phase(state, deadline - time.monotonic()) == "exhausted":
                state["status"] = "checkpointed_partial" if (output / native).exists() else "blocked"
                state["stop_reason"] = "budget_limit"
                break
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                state["status"] = "checkpointed_partial" if (output / native).exists() else "blocked"
                state["stop_reason"] = "budget_limit"
                break
            kwargs = {"model": "gpt-6-astra", "tools": [{"type": "computer"}], "input": request_input,
                      "reasoning": {"effort": "high"}, "max_output_tokens": min(3000, 20_000 - state["output_tokens"]),
                      "timeout": min(180, max(1, remaining_seconds))}
            if previous:
                kwargs["previous_response_id"] = previous
            response = client.responses.create(**kwargs)
            state["turns"] += 1
            state["input_tokens"] += response.usage.input_tokens if response.usage else 0
            state["output_tokens"] += response.usage.output_tokens if response.usage else 0
            previous = response.id
            state["last_response_id"] = previous
            rating_was_pending = bool(incremental_state and state.get("rating_correction_pending"))
            if rating_was_pending and not response.output_text:
                read_incremental_response("", state)
            if response.output_text:
                state["latest_commentary"] = response.output_text
                if incremental_state:
                    rating = read_incremental_response(response.output_text, state)
                    if rating:
                        incremental_state = record_incremental_rating(incremental_state, rating)
                        state["incremental"] = incremental_state
                        native_path = output / native
                        incremental_state["current_native_sha256"] = digest(native_path.read_bytes()) if native_path.is_file() else None
                        incremental_state["current_native_mtime_ns"] = native_path.stat().st_mtime_ns if native_path.is_file() else None
                        if incremental_score_threshold_reached(
                                baseline_score=incremental_state["baseline_score"], current_score=rating["score"]):
                            incremental_state["save_only"] = True
                with (root / "progress.md").open("a") as progress:
                    progress.write(f"\n## Turn {state['turns']}\n\n{response.output_text}\n")
            calls = [item for item in response.output if item.type == "computer_call"]
            (root / f"turn-{state['turns']:03d}.json").write_text(json.dumps({
                "response_id": response.id, "status": response.status, "text": response.output_text,
                "calls": [c.model_dump() for c in calls], "usage": response.usage.model_dump() if response.usage else None}, indent=2))
            if response.status != "completed":
                raise RuntimeError(f"Model response {response.status}: {response.incomplete_details}")
            if incremental_state and state.get("rating_correction_pending"):
                # Preserve the raw report, native and last integer assessment.
                # One protocol-only correction turn is allowed within existing
                # budgets. Never execute a malformed response's proposed edits.
                if len(state["rating_protocol_errors"]) >= 2:
                    state["status"] = "checkpointed_partial" if (output / native).exists() else "blocked"
                    state["stop_reason"] = "rating_protocol_exhausted"
                    break
                request_input = []
                for index, call in enumerate(calls):
                    shot = shots / f"{state['turns']:03d}-rating-skipped-{index}.png"
                    data = screenshot(shot)
                    shutil.copy2(shot, root / "latest.png")
                    request_input.append({"type": "computer_call_output", "call_id": call.call_id,
                                          "output": {"type": "computer_screenshot", "image_url": "data:image/png;base64," + base64.b64encode(data).decode(), "detail": "original"}})
                state["skipped_modeling_calls"] = state.get("skipped_modeling_calls", 0) + len(calls)
                request_input.append({"role": "user", "content":
                                      "RATING PROTOCOL CORRECTION ONLY: your proposed actions were not executed. "
                                      "Return a valid INCREMENTAL_RATING JSON marker with integer score1..10, non-empty reasons list "
                                      "and evidence string. Do not round partial progress up or claim a full-point gain. "
                                      "Explain fractional visual progress in reasons while retaining the last supported integer. "
                                      "Do not model or issue computer calls in this correction response. Existing saved native and "
                                      "last valid score are preserved. Only one correction response is allowed within the original budgets."})
                checkpoint(force=True)
                persist()
                continue
            if rating_was_pending:
                # The one recovery response is assessment-only. Even a valid
                # correction does not authorize its attached computer actions.
                state["skipped_modeling_calls"] = state.get("skipped_modeling_calls", 0) + len(calls)
                state["status"] = "checkpointed_partial" if (output / native).exists() else "blocked"
                state["stop_reason"] = "rating_protocol_corrected"
                break
            if not calls:
                state["model_report"] = response.output_text
                if incremental_state and incremental_turn_plan(
                        baseline_score=incremental_state["baseline_score"], current_score=incremental_state["current_score"],
                        save_only_instruction_issued=incremental_state["save_only_instruction_issued"],
                        has_computer_calls=False) == "request_save_only":
                    incremental_state["save_only_instruction_issued"] = True
                    request_input = [{"role": "user", "content":
                                      "INCREMENTAL MILESTONE: no report-only handoff yet. Stop modeling and use Blender GUI Save As, "
                                      "keep fresh visible evidence, then report PARTIAL or READY_FOR_REVIEW. Do not claim independent acceptance."}]
                    checkpoint()
                    persist()
                    continue
                outcome = classify_model_stop(response.output_text, (output / native).exists())
                if (output / native).exists() or "DRAFT_STATUS: BLOCKED" in response.output_text:
                    state["status"] = outcome
                    state["stop_reason"] = ("model_requested_review" if outcome == "ready_for_review" else
                                            "model_blocked" if outcome == "blocked" else
                                            "budget_checkpoint" if state.get("checkpoint_requested") else "model_partial_handoff")
                    break
                request_input = [{"role": "user", "content": f"The required /output/{native} does not exist yet. Continue using the Blender GUI and save your current module there. Do not claim delivery without a saved file. If actually blocked, report the precise blocker."}]
                if state.get("missing_save_reminder"):
                    state["status"] = "blocked"
                    state["stop_reason"] = "missing_native_artifact"
                    break
                state["missing_save_reminder"] = True
                persist()
                continue
            if incremental_state and incremental_turn_plan(
                    baseline_score=incremental_state["baseline_score"], current_score=incremental_state["current_score"],
                    save_only_instruction_issued=incremental_state["save_only_instruction_issued"],
                    has_computer_calls=True) == "skip_calls_for_save_only":
                # The score threshold arrived alongside a planned modeling batch.  Do not
                # execute that batch. Return an explicit current screenshot for every
                # skipped call so the Responses chain remains protocol-complete.
                incremental_state["save_only_instruction_issued"] = True
                request_input = []
                for index, call in enumerate(calls):
                    shot = shots / f"{state['turns']:03d}-skipped-{index}.png"
                    data = screenshot(shot)
                    shutil.copy2(shot, root / "latest.png")
                    request_input.append({"type": "computer_call_output", "call_id": call.call_id,
                                          "output": {"type": "computer_screenshot", "image_url": "data:image/png;base64," + base64.b64encode(data).decode(), "detail": "original"}})
                state["skipped_modeling_calls"] = state.get("skipped_modeling_calls", 0) + len(calls)
                request_input.append({"role": "user", "content":
                                      "INCREMENTAL MILESTONE: the proposed modeling actions were intentionally skipped. Use Blender GUI Save As only, "
                                      "preserve fresh evidence, then report PARTIAL or READY_FOR_REVIEW without independent acceptance."})
                checkpoint()
                persist()
                continue
            request_input = []
            for index, call in enumerate(calls):
                if getattr(call, "pending_safety_checks", None):
                    raise RuntimeError("Computer tool requested safety review; actions not executed")
                state["actions"] += execute_actions(call.actions, MAX_ACTIONS - state["actions"], deadline)
                time.sleep(0.4)
                if time.monotonic() >= deadline:
                    raise RuntimeError("Interaction deadline exhausted after action batch")
                shot = shots / f"{state['turns']:03d}-{index}.png"
                data = screenshot(shot)
                shutil.copy2(shot, root / "latest.png")
                request_input.append({"type": "computer_call_output", "call_id": call.call_id,
                                      "output": {"type": "computer_screenshot", "image_url": "data:image/png;base64," + base64.b64encode(data).decode(), "detail": "original"}})
            if incremental_state:
                native_path = output / native
                incremental_state["current_native_sha256"] = digest(native_path.read_bytes()) if native_path.is_file() else None
                incremental_state["current_native_mtime_ns"] = native_path.stat().st_mtime_ns if native_path.is_file() else None
                if incremental_score_threshold_reached(
                        baseline_score=incremental_state["baseline_score"], current_score=incremental_state["current_score"]):
                    incremental_state["save_only"] = True
            phase = budget_phase(state, deadline - time.monotonic())
            instruction = "Continue the current correction. Save through the GUI after meaningful changes. Reopen references at comparison checkpoints."
            if incremental_state and incremental_state["save_only"]:
                incremental_state["save_only_instruction_issued"] = True
                instruction = ("INCREMENTAL EVIDENCE-ONLY HANDOFF: do not model. Save the loaded native through Blender GUI now, "
                               "verify its saved timestamp/hash and fresh evidence, then finish with PARTIAL or READY_FOR_REVIEW. "
                               "Do not claim a gain or independent acceptance." if incremental_state["evidence_only"] else
                               "INCREMENTAL MILESTONE: stop modeling. Save the changed native through Blender GUI now, "
                               "verify its actual hash/evidence, then finish with PARTIAL or READY_FOR_REVIEW. "
                               "Do not claim independent acceptance.")
            if phase != "work":
                state["checkpoint_requested"] = True
                instruction = (f"CHECKPOINT NOW: do not start another feature. Save /output/{native} through the GUI, "
                               "leave a clear comparison view, and end with DRAFT_STATUS: PARTIAL plus the handoff. "
                               "This pauses a resumable job; it does not mean the draft is accepted.")
            request_input.append({"role": "user", "content": f"Progress budget: {state['actions']}/{MAX_ACTIONS} actions, {state['turns']}/{MAX_TURNS} responses, {state['input_tokens']}/650000 cumulative input tokens; {int(max(0, deadline-time.monotonic()))} seconds remain. {instruction}"})
            checkpoint()
            persist()
        else:
            state["status"] = "checkpointed_partial" if (output / native).exists() else "blocked"
            state["stop_reason"] = "budget_limit"
    except Exception as error:
        state.update(terminal_failure(error))
    finally:
        try:
            screenshot(root / "final-desktop.png")
        except Exception:
            pass
        for p in processes:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
        for log in process_logs:
            log.close()
        shutil.rmtree(runtime_dir, ignore_errors=True)
        if (root / "final-desktop.png").exists():
            shutil.copy2(root / "final-desktop.png", output / (Path(native).stem + "_preview.png"))
        def finalize_state():
            state["input_snapshot_unchanged"] = (digest((reference_dir / "source_scene.blend").read_bytes()) == digest(inputs["source_scene.blend"])) if "source_scene.blend" in inputs else None
            state["reference_snapshots_unchanged"] = all(digest((reference_dir / name).read_bytes()) == digest(data) for name, data in {**inputs, **input_aliases}.items())
            state["files"] = {str(p.relative_to(output)): {"bytes": p.stat().st_size, "sha256": digest(p.read_bytes())} for p in output.iterdir() if p.is_file()}
            frame_paths = {
                "initial": root / "screenshots" / "000-initial.png",
                "latest": root / "latest.png",
                "final": root / "final-desktop.png",
            }
            frames = {
                name: (str(path.relative_to(root)), {"bytes": path.stat().st_size, "sha256": digest(path.read_bytes())})
                for name, path in frame_paths.items() if path.is_file()
            }
            state["provider_receipt"] = modal_volume_receipt(
                volume_name=RUNTIME.volume_name, job_id=job_id, app_name=RUNTIME.app_name,
                environment=RUNTIME.environment, function_name="run_draft",
                function_call_id=function_call_id, input_id=input_id,
                output_files=state["files"], blender_frames=frames,
            )
            checkpoint(force=True)
            state["resumable"] = bool(state.get("checkpoint_id"))
            if state["status"] in {"checkpointed_partial", "ready_for_review"} and not state["resumable"]:
                state["status"] = "blocked"
                state["stop_reason"] = "checkpoint_failed"
            persist()

        if state.get("error"):
            finalize_terminal_state(state, finalize_state)
        else:
            finalize_state()
    return state


@app.local_entrypoint()
def main(project_id: str, part: str, source: str = "", skeleton: str = "", detail: str = "", primary: str = "", concept: str = "",
         resume_job: str = "", checkpoint_id: str = "", feedback: str = "",
         reviewed_score: float = -1, parent_thread: str = "", resume_artifact: str = "",
         resume_sha256: str = "", incremental: bool = False,
         baseline_score: int = 0, baseline_source: str = "explicit_incremental_self_score",
         prior_model_self_score: int = -1) -> None:
    native_name(project_id)
    native_name(part)
    if not incremental:
        validate_cloud_need(reviewed_score)
    if incremental:
        incremental_target(baseline_score)
        if baseline_source not in {"explicit_incremental_self_score", "root_calibrated_current_review", "current_recalibration",
                                   "legacy_model_self_score", "unknown_requires_entry_assessment"}:
            raise ValueError("Unsupported incremental baseline source")
        if prior_model_self_score != -1 and (not isinstance(prior_model_self_score, int) or not 1 <= prior_model_self_score <= 10):
            raise ValueError("prior-model-self-score must be -1 or an integer from 1 through 10")
    runner_files = ["draft_trial.py", "draft_support.py", "draft_checkpoints.py", "draft_prompt.md", "draft_resume.md", "desktop_readiness.py"]
    provenance = {"parent_thread": parent_thread, "project_id": project_id, "files": {},
                  "runner": {"file_hashes": {name: digest((HERE / name).read_bytes()) for name in runner_files}}}
    terminal_resume = bool(resume_artifact or resume_sha256)
    if resume_job:
        if any((source, skeleton, detail, primary, concept)):
            raise ValueError("Resume uses the parent's exact references; do not mix fresh file arguments")
        if terminal_resume and (not resume_artifact or not resume_sha256 or checkpoint_id):
            raise ValueError("Terminal artifact resume needs job, filename and SHA-256 but no checkpoint ID")
        paths = {}
    else:
        if incremental or terminal_resume or not all((source, skeleton, detail, primary, concept)) or checkpoint_id:
            raise ValueError("Fresh runs need all five file arguments; checkpoint-id requires resume-job")
        paths = {"source_scene.blend": Path(source), "structure_reference.png": Path(skeleton),
                 "component_reference.png": Path(detail), "primary_artwork.png": Path(primary),
                 "concept_reference.png": Path(concept)}
    inputs = {}
    for name, path in paths.items():
        before = path.stat()
        data = path.read_bytes()
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise RuntimeError("A source file changed while snapshotting; no cloud job launched")
        inputs[name] = data
        provenance["files"][name] = {"sha256": digest(data), "bytes": len(data), "mtime_ns": after.st_mtime_ns}
    if not resume_job:
        validate_input_names(inputs)
    job_id = "draft-gui-" + part + "-" + datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    print("Launching isolated job " + job_id, flush=True)
    print(json.dumps(run_draft.remote(job_id, inputs, provenance, project_id, part, resume_job, checkpoint_id, feedback,
                                      reviewed_score, resume_artifact, resume_sha256, incremental, baseline_score,
                                      baseline_source, prior_model_self_score), indent=2))
