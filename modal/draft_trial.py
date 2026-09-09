"""Bounded Astra-operated Blender GUI worker for encounter components."""
from __future__ import annotations

import base64
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import uuid

import modal

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, "/opt")
from draft_support import blender_launch_args, budget_phase, classify_model_stop, incremental_evidence_ready, incremental_gain_reached, incremental_score_threshold_reached, incremental_target, incremental_turn_plan, normalize_keys, normalize_pointer_keys, parse_incremental_rating, read_incremental_response, record_incremental_rating, validate_input_aliases, validate_input_names, validate_typed_text, native_name, render_prompt, validate_cloud_need
from draft_checkpoints import CheckpointStore, load_resume, load_terminal_artifact, read_stable, sha256, validate_native, write_json_atomic
from desktop_readiness import terminal_error_state
from infrastructure import runtime

RUNTIME = runtime()
app = modal.App(RUNTIME.app_name)


BLENDER_VERSION = "5.2.1"
BLENDER_ARCHIVE_URL = "https://download.blender.org/release/Blender5.2/blender-5.2.1-linux-x64.tar.xz"
BLENDER_ARCHIVE_SHA256 = "a31f524fa99a527d3d52b7f5aaa68c34e1a19d5a1c9473f79c5cc610fd5b10e9"
image = (modal.Image.debian_slim(python_version="3.12")
         .apt_install("ca-certificates", "curl", "git", "git-lfs", "libegl1", "libgl1", "libxkbcommon0", "openssh-client", "scrot", "tk", "x11-xserver-utils", "xvfb")
         .run_commands(
             f"curl --fail --location --retry 3 {BLENDER_ARCHIVE_URL} --output /tmp/blender.tar.xz",
             f"echo '{BLENDER_ARCHIVE_SHA256}  /tmp/blender.tar.xz' | sha256sum --check --status",
             "tar -C /opt -xf /tmp/blender.tar.xz",
             "ln -s /opt/blender-5.2.1-linux-x64/blender /usr/local/bin/blender",
             "rm /tmp/blender.tar.xz")
         .pip_install("openai>=2,<3", "Pillow>=10,<12", "pyautogui>=0.9.54,<1")
         .apt_install("xdotool", "openbox", "x11-utils", "tesseract-ocr")
         .add_local_file(HERE / "draft_prompt.md", "/opt/draft_prompt.md")
         .add_local_file(HERE / "draft_resume.md", "/opt/draft_resume.md")
         .add_local_file(HERE / "draft_support.py", "/opt/draft_support.py")
         .add_local_file(HERE / "infrastructure.py", "/opt/infrastructure.py")
         .add_local_file(HERE / "desktop_readiness.py", "/opt/desktop_readiness.py")
         .add_local_file(HERE / "draft_checkpoints.py", "/opt/draft_checkpoints.py"))


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
volume = modal.Volume.from_name(RUNTIME.volume_name)
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


def image_item(data: bytes) -> dict:
    from PIL import Image
    output = io.BytesIO()
    with Image.open(io.BytesIO(data)) as picture:
        picture.convert("RGB").save(output, format="PNG")
    return {"type": "input_image", "image_url": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode(), "detail": "original"}


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
        return _run_draft(job_id, inputs, provenance, part, resume_job, checkpoint_id, feedback,
                          resume_artifact, resume_sha256, incremental, baseline_score)
    finally:
        # Hard container termination may leave this protective lease. A coordinator
        # must verify terminal state before manually repairing it; no age stealing.
        if part_leases.get(lease_key) == job_id:
            part_leases.pop(lease_key)


def _run_draft(job_id: str, inputs: dict[str, bytes], provenance: dict, part: str,
               resume_job: str = "", checkpoint_id: str = "", feedback: str = "",
               resume_artifact: str = "", resume_sha256: str = "",
               incremental: bool = False, baseline_score: int = 0) -> dict:
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
    prompt = goal + "\n\n" + protocol
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
    os.environ["DISPLAY"] = ":99"
    os.environ["XAUTHORITY"] = "/tmp/draft.Xauthority"
    Path(os.environ["XAUTHORITY"]).touch(mode=0o600)
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
        # Match the historically working worker: Blender may initially render a
        # black desktop, so Astra receives the capture and uses passive
        # screenshot/wait turns while the GUI completes its own startup.
        time.sleep(2)
        processes.append(subprocess.Popen(["openbox"], stdout=process_logs[1], stderr=subprocess.STDOUT))
        blender_args = blender_launch_args(bool(resume), part)
        processes.append(subprocess.Popen(blender_args, stdout=process_logs[2], stderr=subprocess.STDOUT))
        time.sleep(5)
        if any(process.poll() is not None for process in processes):
            raise RuntimeError("An isolated desktop process exited during startup")
        initial = screenshot(shots / "000-initial.png")
        shutil.copy2(shots / "000-initial.png", root / "latest.png")
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
        state.update(terminal_error_state(error))
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
        if (root / "final-desktop.png").exists():
            shutil.copy2(root / "final-desktop.png", output / (Path(native).stem + "_preview.png"))
        state["input_snapshot_unchanged"] = (digest((reference_dir / "source_scene.blend").read_bytes()) == digest(inputs["source_scene.blend"])) if "source_scene.blend" in inputs else None
        state["reference_snapshots_unchanged"] = all(digest((reference_dir / name).read_bytes()) == digest(data) for name, data in {**inputs, **input_aliases}.items())
        state["files"] = {str(p.relative_to(output)): {"bytes": p.stat().st_size, "sha256": digest(p.read_bytes())} for p in output.iterdir() if p.is_file()}
        checkpoint(force=True)
        state["resumable"] = bool(state.get("checkpoint_id"))
        if state["status"] in {"checkpointed_partial", "ready_for_review"} and not state["resumable"]:
            state["status"] = "blocked"
            state["stop_reason"] = "checkpoint_failed"
        persist()
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
