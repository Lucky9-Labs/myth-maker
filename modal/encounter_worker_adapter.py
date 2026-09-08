"""Translate one GUI-only Blender draft receipt into the stable v1 worker seam.

The adapter deliberately does not import Modal, OpenAI, or Blender.  A caller
supplies a ``draft_runner`` that executes the existing GUI-only worker and
returns its persisted terminal state.  This keeps worker lifecycle reporting
testable offline and prevents the adapter from widening the worker's authority.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import re
from typing import Any


ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
SEMANTIC_TAG = re.compile(r"^[a-z][a-z0-9_.-]{0,95}$")
CONTRACT_NAME = re.compile(r"^[a-z][a-z0-9_.-]{0,95}\.v[1-9][0-9]*$")
WORK_ORDER_FIELDS = {
    "schema_version", "work_id", "encounter_id", "lane", "deadline_at",
    "requested_provides", "host_capabilities", "input_module_ids",
    "depends_on_work_ids", "resource_leases", "attempt", "instruction",
}
WORK_ORDER_REQUIRED = {
    "schema_version", "work_id", "encounter_id", "lane", "deadline_at",
    "requested_provides", "host_capabilities", "input_module_ids", "attempt",
}
HOST_FIELDS = {"schema_version", "host_id", "host_build", "platform", "scripting_backend",
               "execution_kinds", "loaders", "contracts", "limits"}
HOST_REQUIRED = HOST_FIELDS
HOST_LIMIT_FIELDS = {"memory_mb", "preload_seconds", "artifact_bytes", "actors"}
HOST_LIMIT_REQUIRED = {"memory_mb", "preload_seconds"}


class BlenderDraftWorkerAdapter:
    """A small interface around one draft runner: ``run(work_order) -> events``.

    ``draft_runner`` owns the old worker invocation and must return its final
    state, including the ``files`` receipt written by ``draft_trial.py``. The
    adapter returns a local source-artifact receipt when that state names the
    expected native file with a valid immutable SHA-256 digest. It never
    schedules a retry; ``retryable`` is advisory for the coordinator's next
    work order.
    """

    def __init__(self, worker_id: str, draft_runner: Callable[[dict[str, Any]], Mapping[str, Any]],
                 *, clock: Callable[[], datetime] | None = None):
        if not isinstance(worker_id, str) or not ID.fullmatch(worker_id):
            raise ValueError("worker_id must be a stable v1 identifier")
        self.worker_id = worker_id
        self.draft_runner = draft_runner
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def run(self, work_order: Mapping[str, Any]) -> "BlenderDraftRunResult":
        """Run exactly one accepted work order and return events plus a local receipt."""
        order = self._validated_work_order(work_order)
        events: list[dict[str, Any]] = []
        self._append(events, order, "accepted", message="GUI-only Blender draft accepted.")
        self._append(events, order, "started", message="GUI-only Blender draft started.")
        try:
            state = self.draft_runner(order)
        except Exception as error:
            self._failed(events, order, "draft-runner-error", True,
                         f"Draft runner raised {type(error).__name__}: {error}")
            return BlenderDraftRunResult(events, None)

        if not isinstance(state, Mapping):
            self._failed(events, order, "draft-status-invalid", False,
                         "Draft runner returned no terminal state.")
            return BlenderDraftRunResult(events, None)
        status = state.get("status")
        if status in {"checkpointed_partial", "ready_for_review"}:
            try:
                source_artifact = self._source_artifact(order, state)
            except ValueError as error:
                self._failed(events, order, self._candidate_error_code(error),
                             self._candidate_retryable(error), str(error))
                return BlenderDraftRunResult(events, None)
            self._append(events, order, "progress", progress=1,
                         message="Immutable Blender source artifact recorded for downstream review/import.")
            self._append(events, order, "completed",
                         message="Draft worker completed; no EncounterModule candidate was emitted from the source artifact.")
            return BlenderDraftRunResult(events, source_artifact)
        if status == "blocked":
            self._failed(events, order, "draft-blocked", False,
                         self._state_message(state, "GUI-only draft blocked."))
        elif status == "failed":
            self._failed(events, order, "draft-runtime-error", True,
                         self._state_message(state, "GUI-only draft failed."))
        else:
            self._failed(events, order, "draft-status-invalid", False,
                         f"Unexpected draft terminal status: {status!r}.")
        return BlenderDraftRunResult(events, None)

    def _validated_work_order(self, value: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(value, Mapping):
            raise ValueError("work order must be an object")
        if set(value) - WORK_ORDER_FIELDS or WORK_ORDER_REQUIRED - set(value):
            raise ValueError("work order does not match the closed v1 shape")
        order = dict(value)
        if order["schema_version"] != "1":
            raise ValueError("work order must use schema_version 1")
        for field in ("work_id", "encounter_id"):
            if not isinstance(order[field], str) or not ID.fullmatch(order[field]):
                raise ValueError(f"{field} must be a stable v1 identifier")
        if not isinstance(order["lane"], str) or not SEMANTIC_TAG.fullmatch(order["lane"]):
            raise ValueError("lane must be a v1 semantic tag")
        if not isinstance(order["attempt"], int) or isinstance(order["attempt"], bool) or order["attempt"] < 1:
            raise ValueError("attempt must be a positive integer")
        if not isinstance(order["requested_provides"], list) or not order["requested_provides"]:
            raise ValueError("requested_provides must be a non-empty list")
        if (not all(isinstance(tag, str) and SEMANTIC_TAG.fullmatch(tag)
                    for tag in order["requested_provides"])
                or len(set(order["requested_provides"])) != len(order["requested_provides"])):
            raise ValueError("requested_provides must contain unique v1 semantic tags")
        self._validate_id_list(order["input_module_ids"], "input_module_ids")
        if "depends_on_work_ids" in order:
            self._validate_id_list(order["depends_on_work_ids"], "depends_on_work_ids")
        if "resource_leases" in order:
            self._validate_tag_list(order["resource_leases"], "resource_leases")
        if "instruction" in order and (not isinstance(order["instruction"], str)
                                        or len(order["instruction"]) > 16_000):
            raise ValueError("instruction must be a string of at most 16000 characters")
        self._validate_deadline(order["deadline_at"])
        self._validate_host(order["host_capabilities"])
        return order

    @staticmethod
    def _validate_deadline(value: Any) -> None:
        if not isinstance(value, str) or not re.fullmatch(
                r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})", value):
            raise ValueError("deadline_at must be an RFC3339 timestamp")
        try:
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError("deadline_at must be an RFC3339 timestamp") from error

    @staticmethod
    def _validate_host(host: Any) -> None:
        if not isinstance(host, Mapping) or set(host) - HOST_FIELDS or HOST_REQUIRED - set(host):
            raise ValueError("host_capabilities does not match the closed v1 shape")
        if host["schema_version"] != "1":
            raise ValueError("host_capabilities must use schema_version 1")
        if not isinstance(host["host_id"], str) or not ID.fullmatch(host["host_id"]):
            raise ValueError("host_capabilities host_id must be a v1 identifier")
        if not isinstance(host["host_build"], str) or not 1 <= len(host["host_build"]) <= 128:
            raise ValueError("host_capabilities host_build must be a non-empty string of at most 128 characters")
        if host.get("scripting_backend") not in {"mono", "il2cpp"}:
            raise ValueError("host_capabilities needs a supported scripting backend")
        if not isinstance(host.get("platform"), str) or not 1 <= len(host["platform"]) <= 64:
            raise ValueError("host_capabilities needs a platform")
        BlenderDraftWorkerAdapter._validate_enum_list(
            host["execution_kinds"], "execution_kinds",
            {"recipe", "runtime_asset", "managed_plugin", "remote_logic"})
        BlenderDraftWorkerAdapter._validate_tag_list(host["loaders"], "loaders")
        contracts = host["contracts"]
        if (not isinstance(contracts, list)
                or not all(isinstance(contract, str) and CONTRACT_NAME.fullmatch(contract) for contract in contracts)
                or len(contracts) != len(set(contracts))):
            raise ValueError("host_capabilities contracts must contain unique v1 contract names")
        limits = host["limits"]
        if not isinstance(limits, Mapping) or set(limits) - HOST_LIMIT_FIELDS or HOST_LIMIT_REQUIRED - set(limits):
            raise ValueError("host_capabilities limits does not match the closed v1 shape")
        BlenderDraftWorkerAdapter._validate_int(limits["memory_mb"], "memory_mb", minimum=1)
        BlenderDraftWorkerAdapter._validate_int(limits["preload_seconds"], "preload_seconds", minimum=0)
        if "artifact_bytes" in limits:
            BlenderDraftWorkerAdapter._validate_int(limits["artifact_bytes"], "artifact_bytes", minimum=0)
        if "actors" in limits:
            BlenderDraftWorkerAdapter._validate_int(limits["actors"], "actors", minimum=1)

    @staticmethod
    def _validate_id_list(values: Any, name: str) -> None:
        if (not isinstance(values, list)
                or not all(isinstance(value, str) and ID.fullmatch(value) for value in values)
                or len(values) != len(set(values))):
            raise ValueError(f"{name} must contain unique v1 identifiers")

    @staticmethod
    def _validate_tag_list(values: Any, name: str) -> None:
        if (not isinstance(values, list)
                or not all(isinstance(value, str) and SEMANTIC_TAG.fullmatch(value) for value in values)
                or len(values) != len(set(values))):
            raise ValueError(f"{name} must contain unique v1 semantic tags")

    @staticmethod
    def _validate_enum_list(values: Any, name: str, allowed: set[str]) -> None:
        if (not isinstance(values, list) or not values
                or not all(isinstance(value, str) and value in allowed for value in values)
                or len(values) != len(set(values))):
            raise ValueError(f"{name} must contain unique supported values")

    @staticmethod
    def _validate_int(value: Any, name: str, *, minimum: int) -> None:
        if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
            raise ValueError(f"{name} must be an integer of at least {minimum}")
    def _source_artifact(self, order: dict[str, Any], state: Mapping[str, Any]) -> "SourceArtifactReceipt":
        native_name = order["work_id"] + ".blend"
        files = state.get("files")
        receipt = files.get(native_name) if isinstance(files, Mapping) else None
        if not isinstance(receipt, Mapping):
            raise ValueError("native-artifact-missing: terminal receipt has no expected native artifact")
        digest, byte_length = receipt.get("sha256"), receipt.get("bytes")
        if not isinstance(digest, str) or not SHA256.fullmatch(digest):
            raise ValueError("native-artifact-invalid: native artifact has no valid sha256")
        if not isinstance(byte_length, int) or isinstance(byte_length, bool) or byte_length < 0:
            raise ValueError("native-artifact-invalid: native artifact has no valid byte count")
        return SourceArtifactReceipt(
            work_id=order["work_id"], worker_id=self.worker_id,
            created_at=self._timestamp(), native_name=native_name,
            artifact=HashAddressedArtifact("sha256:" + digest, digest,
                                           "application/x-blender", byte_length),
            parent_module_ids=tuple(order["input_module_ids"]),
        )

    def _failed(self, events: list[dict[str, Any]], order: dict[str, Any], error_code: str,
                retryable: bool, detail: str) -> None:
        next_attempt = order["attempt"] + 1
        retry_note = (f" Coordinator may issue a new work order with attempt={next_attempt}; this adapter does not retry."
                      if retryable else " This adapter does not retry automatically.")
        self._append(events, order, "failed", error_code=error_code, retryable=retryable,
                     message=(detail + retry_note)[:2000])

    @staticmethod
    def _state_message(state: Mapping[str, Any], fallback: str) -> str:
        detail = state.get("error") or state.get("stop_reason") or fallback
        return str(detail)[:1500]

    @staticmethod
    def _candidate_error_code(error: ValueError) -> str:
        return str(error).split(":", 1)[0]

    @staticmethod
    def _candidate_retryable(error: ValueError) -> bool:
        return str(error).startswith(("native-artifact-missing", "native-artifact-invalid"))

    def _append(self, events: list[dict[str, Any]], order: dict[str, Any], kind: str,
                **details: Any) -> None:
        sequence = len(events)
        identity = f"{order['work_id']}:{order['attempt']}:{self.worker_id}:{sequence}".encode()
        events.append({
            "schema_version": "1",
            "event_id": "evt-" + hashlib.sha256(identity).hexdigest()[:32],
            "work_id": order["work_id"],
            "encounter_id": order["encounter_id"],
            "worker_id": self.worker_id,
            "sequence": sequence,
            "occurred_at": self._timestamp(),
            "kind": kind,
            **details,
        })

    def _timestamp(self) -> str:
        current = self.clock()
        if current.tzinfo is None:
            raise ValueError("clock must return a timezone-aware datetime")
        return current.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class HashAddressedArtifact:
    """Immutable metadata for a source object, with no runtime-loadability claim."""

    uri: str
    sha256: str
    media_type: str
    byte_length: int

    def to_record(self) -> dict[str, Any]:
        return {"uri": self.uri, "sha256": self.sha256,
                "media_type": self.media_type, "byte_length": self.byte_length}


@dataclass(frozen=True)
class SourceArtifactReceipt:
    """Adapter-local evidence for a GUI-authored source file awaiting import."""

    work_id: str
    worker_id: str
    created_at: str
    native_name: str
    artifact: HashAddressedArtifact
    parent_module_ids: tuple[str, ...]

    def to_record(self) -> dict[str, Any]:
        return {
            "work_id": self.work_id, "worker_id": self.worker_id,
            "created_at": self.created_at, "native_name": self.native_name,
            "artifact": self.artifact.to_record(),
            "parent_module_ids": list(self.parent_module_ids),
        }


@dataclass(frozen=True)
class BlenderDraftRunResult:
    """Ordered v1 events and optional local source evidence from one work order."""

    events: list[dict[str, Any]]
    source_artifact: SourceArtifactReceipt | None
