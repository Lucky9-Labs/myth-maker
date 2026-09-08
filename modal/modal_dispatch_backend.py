"""Opt-in dispatcher backend for the existing Modal Blender draft entrypoint.

This module deliberately has no import-time Modal dependency and never starts a
remote function by default. Its preflight is an offline configuration check;
credential, account, image, and cloud-runtime verification remain separate
operator actions.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from encounter_worker_adapter import BlenderDraftWorkerAdapter, BlenderDraftRunResult
from modal_draft_runner import ModalDraftRunner


REQUIRED_INPUTS = {
    "source_scene.blend", "structure_reference.png", "component_reference.png",
    "primary_artwork.png", "concept_reference.png",
}


class ModalDraftBackend:
    """Bind one v1 work order to ``draft_trial.run_draft.remote`` only on opt-in.

    ``invoke`` is injectable for offline tests. Leaving it unset keeps import
    of the Modal app lazy, so `preflight` cannot create cloud resources, spend
    funds, or start a container.
    """

    def __init__(self, *, project_id: str, inputs: Mapping[str, bytes], provenance: Mapping[str, Any],
                 invoke: Callable[..., Mapping[str, Any]] | None = None, cloud_execution_enabled: bool = False):
        if not isinstance(project_id, str) or not project_id:
            raise ValueError("project_id is required for the existing draft entrypoint")
        if set(inputs) != REQUIRED_INPUTS or not all(isinstance(data, bytes) and data for data in inputs.values()):
            raise ValueError("Modal draft backend needs the existing five-file input package")
        if not isinstance(provenance, Mapping):
            raise ValueError("provenance must be a mapping")
        self.project_id = project_id
        self.inputs = dict(inputs)
        self.provenance = dict(provenance)
        self._invoke = invoke
        self.cloud_execution_enabled = cloud_execution_enabled

    def preflight(self, work_order: Mapping[str, Any]) -> dict[str, Any]:
        """Return the exact no-cloud invocation plan for operator inspection."""
        work_id, attempt = self._identity(work_order)
        return {
            "backend": "modal-draft",
            "mode": "dry-run",
            "entrypoint": "draft_trial.run_draft.remote",
            "work_id": work_id,
            "part": work_id,
            "job_id": self._job_id(work_id, attempt),
            "cloud_launch": False,
        }

    def run(self, work_order: Mapping[str, Any]) -> BlenderDraftRunResult:
        """Run when the deployed policy enables this backend; tests stay off by default."""
        if not self.cloud_execution_enabled:
            raise PermissionError("Modal execution is disabled by backend policy; use preflight for dry-run")
        invoke = self._invoke or self._load_existing_remote_entrypoint()
        runner = ModalDraftRunner(invoke, project_id=self.project_id, inputs=self.inputs, provenance=self.provenance)
        return BlenderDraftWorkerAdapter("modal-draft", runner).run(work_order)

    @staticmethod
    def _identity(work_order: Mapping[str, Any]) -> tuple[str, int]:
        if not isinstance(work_order, Mapping):
            raise ValueError("work_order must be a mapping")
        work_id, attempt = work_order.get("work_id"), work_order.get("attempt")
        if (not isinstance(work_id, str) or not work_id
                or not isinstance(attempt, int) or isinstance(attempt, bool) or attempt < 1):
            raise ValueError("work_order needs stable work_id and positive attempt")
        return work_id, attempt

    @staticmethod
    def _job_id(work_id: str, attempt: int) -> str:
        return f"draft-gui-{work_id}-a{attempt}"

    @staticmethod
    def _load_existing_remote_entrypoint() -> Callable[..., Mapping[str, Any]]:
        # This import is intentionally inside the paid-launch path: importing
        # draft_trial creates the Modal resource handles, whereas preflight must
        # remain completely local and side-effect free.
        from draft_trial import run_draft
        return run_draft.remote
