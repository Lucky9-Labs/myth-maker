"""Bind a v1 work order to the existing GUI-only ``run_draft`` invocation."""
from __future__ import annotations

from collections.abc import Callable, Mapping
import copy
from typing import Any


class ModalDraftRunner:
    """Supply stable draft arguments without adding authority to the GUI worker.

    ``invoke`` is normally ``run_draft.remote`` from ``draft_trial.py``. Inputs
    and provenance are already-snapshotted caller-owned values; this binding
    only derives the legacy job/part identifiers from the idempotent v1 work
    order. It deliberately leaves retries to the coordinator.
    """

    def __init__(self, invoke: Callable[..., Mapping[str, Any]], *, project_id: str,
                 inputs: Mapping[str, bytes], provenance: Mapping[str, Any]):
        self.invoke = invoke
        self.project_id = project_id
        self.inputs = dict(inputs)
        self.provenance = copy.deepcopy(dict(provenance))

    def __call__(self, work_order: dict[str, Any]) -> Mapping[str, Any]:
        provenance = copy.deepcopy(self.provenance)
        provenance["encounter_work_order"] = {
            "work_id": work_order["work_id"],
            "encounter_id": work_order["encounter_id"],
            "lane": work_order["lane"],
            "attempt": work_order["attempt"],
        }
        job_id = f"draft-gui-{work_order['work_id']}-a{work_order['attempt']}"
        return self.invoke(job_id, dict(self.inputs), provenance, self.project_id,
                           work_order["work_id"], feedback=work_order.get("instruction", ""))
