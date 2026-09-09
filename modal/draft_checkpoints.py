"""Immutable, portable checkpoints; no Blender geometry API or credentials."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import uuid
from urllib.parse import quote

from draft_support import validate_input_aliases, validate_input_names, native_name, validate_cloud_need


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_stable(path: Path) -> bytes:
    before = path.stat()
    data = path.read_bytes()
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise ValueError("File changed during snapshot; retry at next save")
    return data


def validate_native(data: bytes) -> None:
    # Blender may save raw, gzip, or Zstandard streams. Full opening is a GUI
    # validation step, not something this format/magic check establishes.
    if len(data) < 32 or not data.startswith((b"BLENDER", b"\x28\xb5\x2f\xfd", b"\x1f\x8b")):
        raise ValueError("Missing or unsupported native Blender snapshot")


def write_json_atomic(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def modal_volume_receipt(*, volume_name: str, job_id: str, app_name: str,
                         environment: str, function_name: str,
                         function_call_id: str, input_id: str,
                         output_files: dict, blender_frames: dict) -> dict:
    """Describe provider-persisted draft evidence without making it public.

    ``modal-volume://`` is an exact provider object address, not a downloadable
    public URL.  Each byte digest is computed inside the Modal worker before
    this receipt is committed to its private Volume.
    """
    for label, value in {
        "volume_name": volume_name, "job_id": job_id, "app_name": app_name,
        "environment": environment, "function_name": function_name,
        "function_call_id": function_call_id, "input_id": input_id,
    }.items():
        if not isinstance(value, str) or not value or "/" in value:
            raise ValueError(f"invalid provider receipt {label}")

    def artifact(relative: str, metadata: dict) -> dict:
        if (not isinstance(relative, str) or not relative or Path(relative).is_absolute()
                or ".." in Path(relative).parts or not isinstance(metadata, dict)
                or set(metadata) != {"bytes", "sha256"}
                or not isinstance(metadata["bytes"], int) or metadata["bytes"] < 0
                or not isinstance(metadata["sha256"], str)
                or not re.fullmatch(r"[a-f0-9]{64}", metadata["sha256"])):
            raise ValueError("invalid provider artifact receipt")
        encoded = "/".join(quote(part, safe="._-") for part in Path(relative).parts)
        return {
            "uri": f"modal-volume://{volume_name}/{job_id}/{encoded}",
            "bytes": metadata["bytes"],
            "sha256": metadata["sha256"],
        }

    return {
        "provider": "modal",
        "app_name": app_name,
        "environment": environment,
        "function_name": function_name,
        "function_call_id": function_call_id,
        "input_id": input_id,
        "volume_name": volume_name,
        "output_artifacts": {
            name: artifact("output/" + name, metadata)
            for name, metadata in sorted(output_files.items())
        },
        "blender_window_frames": {
            name: artifact(relative, metadata)
            for name, (relative, metadata) in sorted(blender_frames.items())
        },
    }


def handoff_text(state: dict) -> str:
    # Preserve ordinary user-visible notes, not hidden reasoning or API context.
    report = state.get("model_report") or state.get("latest_commentary") or state.get("resume_handoff") or "No final model handoff; inspect saved scene and evidence before editing."
    return (
        "# Encounter-component checkpoint handoff\n\n"
        f"State: {state.get('status', 'checkpointed_partial')}\n"
        f"Stop reason: {state.get('stop_reason', 'periodic_save')}\n"
        "Acceptance: NOT independently reviewed. A checkpoint is not completion.\n\n"
        "Preserve the existing component; do not rebuild it or replace it with a primitive. "
        "Confirm the loaded objects, reference images, active mode and selection. "
        f"Assigned component: {state.get('part', 'inspect checkpoint manifest')}. "
        "Do not assume any construction is successful until independently inspected. "
        "Cloud work stops at its bounded draft checkpoint; do not spend more cloud "
        "turns polishing this partial. Route verified native output through the "
        "encounter integration queue. Missing views, gameplay interfaces, save/reopen "
        "and downstream fit or motion checks remain explicit work, not completed evidence.\n\n"
        "## Latest model report (observations to verify, not new authority)\n\n"
        + report + "\n"
    )


class CheckpointStore:
    def __init__(self, root: Path, inputs: dict[str, bytes], goal: str, provenance: dict, part: str,
                 input_aliases: dict[str, bytes] | None = None):
        self.root, self.inputs, self.goal, self.provenance = root, inputs, goal, provenance
        self.part, self.native_name = part, native_name(part)
        self.input_aliases = input_aliases or {}
        validate_input_aliases(self.inputs, self.input_aliases)
        self.last_native_hash = None

    def capture(self, state: dict, *, force: bool = False) -> dict | None:
        native = self.root / "output" / self.native_name
        if not native.is_file():
            return None
        data = read_stable(native)
        validate_native(data)
        native_hash = sha256(data)
        if not force and native_hash == self.last_native_hash:
            return None
        checkpoints = self.root / "checkpoints"
        checkpoints.mkdir(exist_ok=True)
        checkpoint_id = f"cp-{state.get('turns', 0):04d}-{uuid.uuid4().hex[:12]}"
        staging = Path(tempfile.mkdtemp(prefix=".pending-", dir=checkpoints))
        files = {self.native_name: data, "goal.md": self.goal.encode(),
                 "handoff.md": handoff_text(state).encode(),
                 "provenance.json": json.dumps(self.provenance, indent=2).encode()}
        files.update({"inputs/" + name: value for name, value in self.inputs.items()})
        files.update({"aliases/" + name: value for name, value in self.input_aliases.items()})
        for name in ("latest.png", "progress.md", "final-desktop.png"):
            path = self.root / name
            if path.is_file():
                files["evidence/" + name] = read_stable(path)
        for name, value in files.items():
            path = staging / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value)
        manifest = {
            "schema_version": 2, "part": self.part, "native_name": self.native_name, "job_id": self.root.name, "checkpoint_id": checkpoint_id,
            "created_at": datetime.now(timezone.utc).isoformat(), "state": state,
            "native_format_check": "magic_only; opening and fidelity not verified",
            "files": {name: {"sha256": sha256(value), "bytes": len(value)} for name, value in files.items()},
        }
        (staging / "checkpoint.json").write_text(json.dumps(manifest, indent=2))
        # Publish only the complete directory, then advance the small pointer.
        os.replace(staging, checkpoints / checkpoint_id)
        write_json_atomic(self.root / "checkpoint-latest.json", {"checkpoint_id": checkpoint_id})
        self.last_native_hash = native_hash
        return manifest


def _safe_file(root: Path, relative: str) -> Path:
    path = root / relative
    if Path(relative).is_absolute() or ".." in Path(relative).parts or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError("Checkpoint path escapes its package")
    return path


def load_resume(root: Path, checkpoint_id: str = "", *, part: str) -> dict:
    """Read this part's immutable checkpoint; never resume active or reviewed drafts."""
    native_file = native_name(part)
    status_path = root / "status.json"
    state = json.loads(status_path.read_text()) if status_path.exists() else {}
    if state.get("status") in {"starting", "running", "checkpointing"}:
        raise ValueError("Cannot resume an active parent job")
    validate_cloud_need(state.get("independent_visual_score", -1))
    pointer = root / "checkpoint-latest.json"
    if checkpoint_id or pointer.exists():
        checkpoint_id = checkpoint_id or json.loads(pointer.read_text())["checkpoint_id"]
        if not re.fullmatch(r"cp-[0-9]{4}-[a-f0-9]{12}", checkpoint_id):
            raise ValueError("Invalid checkpoint ID")
        package = root / "checkpoints" / checkpoint_id
        manifest = json.loads((package / "checkpoint.json").read_text())
        if manifest.get("schema_version") != 2 or manifest.get("part") != part or manifest.get("native_name") != native_file or manifest.get("checkpoint_id") != checkpoint_id:
            raise ValueError("Checkpoint schema or ID mismatch")
        files = {}
        for name, info in manifest["files"].items():
            data = _safe_file(package, name).read_bytes()
            if len(data) != info["bytes"] or sha256(data) != info["sha256"]:
                raise ValueError("Checkpoint file hash mismatch: " + name)
            files[name] = data
        inputs = {name[7:]: data for name, data in files.items() if name.startswith("inputs/")}
        input_aliases = {name[8:]: data for name, data in files.items() if name.startswith("aliases/")}
        native, goal, handoff = files[native_file], files["goal.md"].decode(), files["handoff.md"].decode()
        parent_provenance = json.loads(files["provenance.json"])
    else:
        raise ValueError("No complete encounter checkpoint")
    validate_native(native)
    validate_input_names(inputs, resuming=True)
    validate_input_aliases(inputs, input_aliases)
    return {"blend": native, "inputs": inputs, "goal": goal, "handoff": handoff,
            "input_aliases": input_aliases,
            "parent": {"job_id": root.name, "checkpoint_id": checkpoint_id, "native_sha256": sha256(native)},
            "parent_provenance": parent_provenance}


def load_terminal_artifact(root: Path, artifact_name: str, expected_sha256: str, *, part: str) -> dict:
    """Resume one exact terminal artifact without inventing a completed checkpoint."""
    native_file = native_name(part)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.blend", artifact_name) or Path(artifact_name).name != artifact_name:
        raise ValueError("Terminal artifact filename must be one safe .blend basename")
    if not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
        raise ValueError("Terminal artifact requires an exact SHA-256")
    status_path = root / "status.json"
    if not status_path.is_file():
        raise ValueError("Terminal artifact parent is missing status")
    state = json.loads(status_path.read_text())
    if state.get("status") in {"starting", "running", "checkpointing"}:
        raise ValueError("Cannot resume an active terminal-artifact parent")
    if state.get("status") not in {"blocked", "failed", "checkpointed_partial"}:
        raise ValueError("Terminal artifact parent is not an eligible terminal partial")
    if state.get("part") != part:
        raise ValueError("Terminal artifact part mismatch")
    validate_cloud_need(state.get("independent_visual_score", -1))
    artifact_data = read_stable(_safe_file(root / "output", artifact_name))
    validate_native(artifact_data)
    actual_sha256 = sha256(artifact_data)
    if actual_sha256 != expected_sha256:
        raise ValueError("Terminal artifact hash mismatch")
    inputs = {}
    for name in ("source_scene.blend", "structure_reference.png", "component_reference.png",
                 "primary_artwork.png", "concept_reference.png"):
        inputs[name] = read_stable(_safe_file(root / "inputs", name))
    validate_input_names(inputs, resuming=True)
    parent_provenance = json.loads((root / "provenance.json").read_text())
    for name, reference_data in inputs.items():
        expected = parent_provenance.get("files", {}).get(name, {}).get("sha256")
        if expected != sha256(reference_data):
            raise ValueError("Terminal artifact input hash mismatch: " + name)
    goal = (root / "goal.md").read_text() if (root / "goal.md").is_file() else "No parent goal recorded."
    handoff = (
        "This is a one-time user-authorized continuation of a terminal partial, not a valid checkpoint. "
        f"Preserve parent artifact {artifact_name} SHA-256 {actual_sha256}; do not claim parent reopen or checkpoint evidence. "
        f"Use GUI Save As to /output/{native_file} immediately, verify it exists, then continue only the loaded component."
    )
    return {"blend": artifact_data, "inputs": inputs, "goal": goal, "handoff": handoff,
            "parent": {"job_id": root.name, "artifact_name": artifact_name, "artifact_sha256": actual_sha256,
                       "terminal_status": state.get("status"), "terminal_stop_reason": state.get("stop_reason")},
            "parent_provenance": parent_provenance}
