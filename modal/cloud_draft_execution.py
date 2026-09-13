"""Runner-neutral persistence and provenance for GUI-authored Blender drafts."""
from __future__ import annotations

from dataclasses import dataclass
from copy import deepcopy
from pathlib import Path
import re
import shutil
from typing import Callable
from urllib.parse import quote


_REPOSITORY = "Lucky9-Labs/myth-maker"
_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_JOB_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,127}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")


@dataclass(frozen=True)
class DraftExecution:
    """One adapter at the GUI worker's persistence/provenance seam."""

    submissions_root: Path
    inputs_dir: Path
    output_link: Path
    prompt_template: Path
    resume_template: Path
    reload: Callable[[], None]
    commit: Callable[[], None]
    receipt: Callable[..., dict]
    motion_capture_frames: int = 0
    motion_capture_fps: int = 8

    def __post_init__(self) -> None:
        if (not isinstance(self.motion_capture_frames, int) or self.motion_capture_frames < 0
                or not isinstance(self.motion_capture_fps, int) or not 1 <= self.motion_capture_fps <= 30):
            raise ValueError("invalid motion capture configuration")


def reset_process_local_aliases(execution: DraftExecution) -> None:
    """Clear only this worker's disposable /inputs and /output aliases.

    Modal may reuse a container for sequential calls. Durable job data lives
    under ``submissions_root``; these aliases are process-local conveniences
    and must never be mistaken for ownership left by another live job.
    """
    inputs = execution.inputs_dir
    if inputs.is_symlink() or (inputs.exists() and not inputs.is_dir()):
        raise RuntimeError("Blender input alias is not a disposable directory")
    if inputs.is_dir():
        shutil.rmtree(inputs)
    output = execution.output_link
    if output.is_symlink():
        output.unlink()
    elif output.exists():
        raise RuntimeError("Blender output alias is not a disposable symlink")


def github_actions_artifact_receipt(*, repository: str, source_sha: str,
                                    run_id: str, run_attempt: str, job_name: str,
                                    artifact_name: str, artifact_path_prefix: str, job_id: str,
                                    output_files: dict, blender_frames: dict) -> dict:
    """Bind worker-computed hashes to one trusted GitHub Actions artifact."""
    if repository != _REPOSITORY or not re.fullmatch(r"[a-f0-9]{40}", source_sha):
        raise ValueError("invalid trusted GitHub source identity")
    if not run_id.isdigit() or not run_attempt.isdigit() or int(run_id) < 1 or int(run_attempt) < 1:
        raise ValueError("invalid GitHub workflow execution identity")
    if not _SAFE_NAME.fullmatch(job_name) or not _SAFE_NAME.fullmatch(artifact_name) or not _SAFE_JOB_ID.fullmatch(job_id):
        raise ValueError("invalid GitHub artifact identity")

    artifact_prefix = Path(artifact_path_prefix)
    if (not artifact_path_prefix or artifact_prefix.is_absolute() or ".." in artifact_prefix.parts
            or any(not _SAFE_NAME.fullmatch(part) for part in artifact_prefix.parts)):
        raise ValueError("invalid GitHub artifact path prefix")
    encoded_prefix = "/".join(quote(part, safe="._-") for part in artifact_prefix.parts)
    prefix = f"github-actions-runner://{repository}/{run_id}/{run_attempt}/{artifact_name}/{encoded_prefix}/jobs/{job_id}"

    def artifact(relative: str, metadata: dict) -> dict:
        path = Path(relative)
        if (not relative or path.is_absolute() or ".." in path.parts
                or not isinstance(metadata, dict) or set(metadata) != {"bytes", "sha256"}
                or not isinstance(metadata["bytes"], int) or metadata["bytes"] < 0
                or not isinstance(metadata["sha256"], str) or not _SHA256.fullmatch(metadata["sha256"])):
            raise ValueError("invalid GitHub artifact receipt")
        encoded = "/".join(quote(part, safe="._-") for part in path.parts)
        artifact_path = f"{encoded_prefix}/jobs/{job_id}/{encoded}"
        return {"uri": f"{prefix}/{encoded}", "artifact_path": artifact_path, **metadata}

    return {
        "provider": "github-actions-runner",
        "repository": repository,
        "source_sha": source_sha,
        "run_id": int(run_id),
        "run_attempt": int(run_attempt),
        "job_name": job_name,
        "artifact_name": artifact_name,
        "execution_url": f"https://github.com/{repository}/actions/runs/{run_id}",
        "function_call_id": f"github-actions:{run_id}:{run_attempt}:{job_name}:{job_id}",
        "input_id": job_id,
        "output_artifacts": {
            name: artifact("output/" + name, metadata)
            for name, metadata in sorted(output_files.items())
        },
        "blender_window_frames": {
            name: artifact(relative, metadata)
            for name, (relative, metadata) in sorted(blender_frames.items())
        },
    }


def seal_github_actions_artifact_receipt(receipt: dict, *, artifact_id: str,
                                         artifact_url: str, artifact_digest: str) -> dict:
    """Bind runner-computed per-file hashes to GitHub's stored artifact."""
    if receipt.get("provider") != "github-actions-runner":
        raise ValueError("only a GitHub runner receipt can be sealed")
    repository = receipt.get("repository")
    run_id = str(receipt.get("run_id", ""))
    normalized_digest = artifact_digest if artifact_digest.startswith("sha256:") else "sha256:" + artifact_digest
    if (repository != _REPOSITORY or not artifact_id.isdigit() or int(artifact_id) < 1
            or artifact_url != f"https://github.com/{repository}/actions/runs/{run_id}/artifacts/{artifact_id}"
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", normalized_digest)):
        raise ValueError("invalid GitHub provider artifact identity")
    sealed = deepcopy(receipt)
    sealed["provider"] = "github-actions"
    sealed["storage"] = {
        "artifact_id": int(artifact_id),
        "artifact_url": artifact_url,
        "artifact_digest": normalized_digest,
        "artifact_name": receipt["artifact_name"],
    }
    for collection_name in ("output_artifacts", "blender_window_frames"):
        for metadata in sealed[collection_name].values():
            artifact_path = metadata.get("artifact_path")
            if not isinstance(artifact_path, str) or not artifact_path:
                raise ValueError("runner receipt omitted an artifact path")
            metadata["uri"] = f"github-actions-artifact://{repository}/{artifact_id}/{artifact_path}"
    return sealed
