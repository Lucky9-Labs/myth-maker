"""Automated-policy Blender-source to self-contained ``glb.v1`` candidate importer.

This is an offline seam. It validates an immutable source receipt and an
explicit policy-authorized acceptance before asking a supplied conversion adapter for bytes.
The importer does not inspect a visual scene to manufacture game semantics:
``provides``, quality, conflicts, and fallbacks are caller-declared metadata.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
from typing import Any, Protocol

from encounter_worker_adapter import HashAddressedArtifact, SourceArtifactReceipt


ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
SEMANTIC_TAG = re.compile(r"^[a-z][a-z0-9_.-]{0,95}$")
CONTRACT_NAME = re.compile(r"^[a-z][a-z0-9_.-]{0,95}\.v[1-9][0-9]*$")
GLB_MIME = "model/gltf-binary"
GLB_MAGIC = b"glTF"
GLB_JSON = 0x4E4F534A
GLB_BIN = 0x004E4942


class GlbConverter(Protocol):
    """The sole conversion-adapter seam: native source bytes in, GLB bytes out."""

    def convert(self, source_bytes: bytes) -> bytes: ...


@dataclass(frozen=True)
class AcceptanceEvidence:
    """One named automated-validation outcome, retained as evidence."""

    evidence_id: str
    result: str

    def to_record(self) -> dict[str, str]:
        return {"evidence_id": self.evidence_id, "result": self.result}


@dataclass(frozen=True)
class AcceptanceReceipt:
    """Importer-produced acceptance from deterministic validation evidence."""

    source_sha256: str
    output_sha256: str
    status: str
    actor_kind: str
    actor_id: str
    policy_id: str
    accepted_at: str
    evidence: tuple[AcceptanceEvidence, ...]

    def to_record(self) -> dict[str, Any]:
        return {"source_sha256": self.source_sha256, "output_sha256": self.output_sha256, "status": self.status,
                "actor_kind": self.actor_kind, "actor_id": self.actor_id,
                "policy_id": self.policy_id, "accepted_at": self.accepted_at,
                "evidence": [item.to_record() for item in self.evidence]}


@dataclass(frozen=True)
class ImportResult:
    """A v1 runtime candidate and its additive, closed GLB loader sidecar."""

    glb_bytes: bytes
    runtime_asset: dict[str, Any]
    loader_profile: dict[str, Any]


class BlenderCliGlbConverter:
    """Concrete adapter for Blender's CLI; source geometry stays inside Blender."""

    def __init__(self, executable: str | Path | None = None):
        resolved = Path(executable) if executable else self.discover()
        if resolved is None or not resolved.is_file():
            raise ValueError("Blender CLI is unavailable")
        self.executable = resolved
        self.last_receipt: dict[str, Any] | None = None

    @classmethod
    def discover(cls) -> Path | None:
        candidates = [shutil.which("blender"), "/Applications/Blender.app/Contents/MacOS/Blender"]
        for candidate in candidates:
            if candidate and Path(candidate).is_file():
                return Path(candidate)
        return None

    def convert(self, source_bytes: bytes) -> bytes:
        if not source_bytes:
            raise ValueError("source is empty")
        with tempfile.TemporaryDirectory(prefix="myth-maker-glb-") as directory:
            source = Path(directory) / "source.blend"
            output = Path(directory) / "output.glb"
            source.write_bytes(source_bytes)
            expression = (
                "import bpy; "
                f"bpy.ops.export_scene.gltf(filepath={str(output)!r}, export_format='GLB', "
                "export_apply=True, export_materials='EXPORT', check_existing=False)"
            )
            command = [str(self.executable), "--background", "--disable-autoexec", str(source),
                       "--python-expr", expression]
            started = time.monotonic()
            completed = subprocess.run(
                command, capture_output=True, text=True, timeout=60, check=False)
            self.last_receipt = {
                "argv": command, "cwd": str(directory), "returncode": completed.returncode,
                "duration_ms": round((time.monotonic() - started) * 1000),
                "stdout_sha256": hashlib.sha256(completed.stdout.encode()).hexdigest(),
                "stderr_sha256": hashlib.sha256(completed.stderr.encode()).hexdigest(),
                "stdout_tail": completed.stdout[-1000:], "stderr_tail": completed.stderr[-1000:],
            }
            if completed.returncode != 0 or not output.is_file():
                detail = (completed.stderr or completed.stdout).strip().replace("\n", " ")[:500]
                raise ValueError("Blender GLB export failed" + (": " + detail if detail else ""))
            return output.read_bytes()


class GlbSourceImporter:
    """Deep import module: one accepted source receipt becomes one checked candidate."""

    def __init__(self, converter: GlbConverter | Callable[[bytes], bytes], *,
                 clock: Callable[[], datetime] | None = None):
        self.converter = converter
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def import_validated(self, *, source_receipt: SourceArtifactReceipt,
                        source_bytes: bytes,
                        host_capabilities: Mapping[str, Any], target: Mapping[str, Any],
                        module: Mapping[str, Any], named_anchors: list[Mapping[str, str]],
                        bounds: Mapping[str, Any]) -> ImportResult:
        """Convert only explicitly accepted source bytes and emit a runtime candidate.

        No collision, navigation, hit-volume, attack, animation, AI, or objective
        information is accepted or inferred at this seam.  Such host gameplay
        contracts must be separately authored and validated by their owning host.
        """
        self._validate_source(source_receipt, source_bytes)
        checked_host = self._validate_host(host_capabilities)
        checked_target = self._validate_target(target, checked_host)
        checked_module = self._validate_module(module)
        checked_anchors = self._validate_anchors(named_anchors)
        checked_bounds = self._validate_bounds(bounds)

        output = self._convert(source_bytes)
        document = validate_glb(output, material_allowlist=checked_target["material_allowlist"],
                                extension_allowlist=checked_target["extension_allowlist"])
        self._validate_anchor_nodes(checked_anchors, document)
        byte_cap = min(checked_host["limits"].get("artifact_bytes", len(output)),
                       checked_target["byte_cap"])
        if len(output) > byte_cap:
            raise ValueError(f"GLB exceeds byte limit {byte_cap}")

        output_sha256 = hashlib.sha256(output).hexdigest()
        acceptance = self._acceptance_for(source_receipt.artifact.sha256, output_sha256)
        artifact = {"uri": "sha256:" + output_sha256, "sha256": output_sha256,
                    "media_type": GLB_MIME, "byte_length": len(output)}
        profile = {
            "profile": "glb.v1", "artifact": artifact,
            "byte_cap": byte_cap,
            "loader": checked_target["loader"], "target": {
                "platform": checked_target["platform"],
                "render_pipeline": checked_target["render_pipeline"],
            },
            "material_allowlist": checked_target["material_allowlist"],
            "extension_allowlist": checked_target["extension_allowlist"],
            "named_anchors": checked_anchors, "bounds": checked_bounds,
            "provenance": {
                "source_receipt": source_receipt.to_record(), "acceptance": acceptance.to_record(),
                "converter": self.converter.__class__.__name__,
                "converted_at": self._timestamp(),
            },
            "fallback_module_ids": checked_module["fallback_module_ids"],
        }
        candidate = {
            "schema_version": "1", "module_id": checked_module["module_id"],
            "revision": checked_module["revision"], "execution_kind": "runtime_asset",
            "provides": checked_module["provides"], "requires": checked_module["requires"],
            "conflicts": checked_module["conflicts"],
            "compatibility": {
                "host_contract_version": "1", "platforms": [checked_target["platform"]],
                "bindings": {
                    checked_target["loader"]["id"]: checked_target["loader"]["version"],
                    checked_target["render_pipeline"]["id"]: checked_target["render_pipeline"]["version"],
                },
            },
            "quality": checked_module["quality"], "artifact": artifact,
            "fallback_module_ids": checked_module["fallback_module_ids"],
            "provenance": {
                "producer": "glb-source-importer", "created_at": profile["provenance"]["converted_at"],
                "parent_module_ids": list(source_receipt.parent_module_ids),
                "label": source_receipt.native_name,
            },
        }
        validate_glb_v1_profile(profile)
        return ImportResult(glb_bytes=output, runtime_asset=candidate, loader_profile=profile)

    def _convert(self, source_bytes: bytes) -> bytes:
        convert = getattr(self.converter, "convert", self.converter)
        output = convert(source_bytes)
        if not isinstance(output, bytes):
            raise ValueError("converter must return GLB bytes")
        return output

    @staticmethod
    def _validate_source(receipt: Any, source_bytes: Any) -> None:
        if not isinstance(receipt, SourceArtifactReceipt):
            raise ValueError("source receipt must be a SourceArtifactReceipt")
        artifact = receipt.artifact
        if (not ID.fullmatch(receipt.work_id) or not ID.fullmatch(receipt.worker_id)
                or receipt.native_name != receipt.work_id + ".blend" or not _valid_timestamp(receipt.created_at)
                or not isinstance(receipt.parent_module_ids, tuple)
                or len(receipt.parent_module_ids) != len(set(receipt.parent_module_ids))
                or not all(isinstance(value, str) and ID.fullmatch(value) for value in receipt.parent_module_ids)
                or not isinstance(artifact, HashAddressedArtifact)
                or artifact.media_type != "application/x-blender" or not SHA256.fullmatch(artifact.sha256)
                or not isinstance(artifact.byte_length, int) or isinstance(artifact.byte_length, bool)
                or artifact.byte_length < 0
                or artifact.uri != "sha256:" + artifact.sha256):
            raise ValueError("source receipt has invalid Blender artifact identity")
        if not isinstance(source_bytes, bytes) or len(source_bytes) != artifact.byte_length:
            raise ValueError("source hash identity does not match receipt")
        if hashlib.sha256(source_bytes).hexdigest() != artifact.sha256:
            raise ValueError("source hash identity does not match receipt")

    def _acceptance_for(self, source_sha256: str, output_sha256: str) -> AcceptanceReceipt:
        """The trust boundary: only this importer issues acceptance after checks pass."""
        return AcceptanceReceipt(
            source_sha256=source_sha256, output_sha256=output_sha256, status="accepted", actor_kind="automated_validator",
            actor_id="glb-importer-validator", policy_id="blender-export-v1",
            accepted_at=self._timestamp(), evidence=(
                AcceptanceEvidence("source-hash", "passed"),
                AcceptanceEvidence("glb-structure", "passed"),
                AcceptanceEvidence("glb-output-hash", "passed"),
            ))

    @staticmethod
    def _validate_host(host: Any) -> dict[str, Any]:
        required = {"schema_version", "host_id", "host_build", "platform", "scripting_backend",
                    "execution_kinds", "loaders", "contracts", "limits"}
        if not isinstance(host, Mapping) or set(host) != required or host.get("schema_version") != "1":
            raise ValueError("host capabilities must match the closed v1 shape")
        if (not isinstance(host["host_id"], str) or not ID.fullmatch(host["host_id"])
                or not isinstance(host["host_build"], str) or not host["host_build"]
                or host["scripting_backend"] not in {"mono", "il2cpp"}
                or not isinstance(host["execution_kinds"], list)
                or not all(value in {"recipe", "runtime_asset", "managed_plugin", "remote_logic"}
                           for value in host["execution_kinds"])
                or "runtime_asset" not in host["execution_kinds"]
                or len(host["execution_kinds"]) != len(set(host["execution_kinds"]))):
            raise ValueError("host does not support runtime_asset")
        if not isinstance(host["loaders"], list) or not all(
                isinstance(value, str) and SEMANTIC_TAG.fullmatch(value) for value in host["loaders"]
        ) or len(host["loaders"]) != len(set(host["loaders"])):
            raise ValueError("host loaders are invalid")
        if (not isinstance(host["contracts"], list) or not all(
                isinstance(value, str) and CONTRACT_NAME.fullmatch(value) for value in host["contracts"])
                or len(host["contracts"]) != len(set(host["contracts"]))):
            raise ValueError("host contracts are invalid")
        if (not isinstance(host["limits"], Mapping)
                or set(host["limits"]) - {"memory_mb", "preload_seconds", "artifact_bytes", "actors"}
                or {"memory_mb", "preload_seconds", "artifact_bytes"} - set(host["limits"])
                or any(not isinstance(host["limits"][key], int) or isinstance(host["limits"][key], bool)
                       or host["limits"][key] < 0 for key in ("preload_seconds", "artifact_bytes"))
                or not isinstance(host["limits"]["memory_mb"], int)
                or isinstance(host["limits"]["memory_mb"], bool) or host["limits"]["memory_mb"] < 1
                or ("actors" in host["limits"] and (not isinstance(host["limits"]["actors"], int)
                    or isinstance(host["limits"]["actors"], bool) or host["limits"]["actors"] < 1))):
            raise ValueError("host must declare a non-negative artifact byte limit")
        if not isinstance(host["platform"], str) or not host["platform"]:
            raise ValueError("host platform is invalid")
        return dict(host)

    @staticmethod
    def _validate_target(target: Any, host: Mapping[str, Any]) -> dict[str, Any]:
        required = {"platform", "loader", "render_pipeline", "material_allowlist", "extension_allowlist"}
        if not isinstance(target, Mapping) or set(target) - (required | {"byte_cap"}) or required - set(target):
            raise ValueError("glb.v1 target has an invalid shape")
        checked = dict(target)
        checked["byte_cap"] = checked.get("byte_cap", host["limits"]["artifact_bytes"])
        if checked["platform"] != host["platform"]:
            raise ValueError("target platform is incompatible with host")
        for key, label in (("loader", "loader"), ("render_pipeline", "render pipeline")):
            value = checked[key]
            if (not isinstance(value, Mapping) or set(value) != {"id", "version"}
                    or not isinstance(value["id"], str) or not SEMANTIC_TAG.fullmatch(value["id"])
                    or not isinstance(value["version"], str) or not value["version"]):
                raise ValueError(f"{label} target is invalid")
            if value["id"] not in host["loaders"]:
                raise ValueError(f"{label} is incompatible with host")
            checked[key] = dict(value)
        for key in ("material_allowlist", "extension_allowlist"):
            values = checked[key]
            if (not isinstance(values, list) or len(values) != len(set(values))
                    or not all(isinstance(value, str) and value for value in values)):
                raise ValueError(f"{key} must contain unique non-empty strings")
        if not isinstance(checked["byte_cap"], int) or checked["byte_cap"] < 0:
            raise ValueError("target byte_cap must be non-negative")
        return checked

    @staticmethod
    def _validate_module(module: Any) -> dict[str, Any]:
        required = {"module_id", "revision", "provides", "requires", "conflicts", "quality", "fallback_module_ids"}
        if not isinstance(module, Mapping) or set(module) != required:
            raise ValueError("module declaration has an invalid shape")
        if not isinstance(module["module_id"], str) or not ID.fullmatch(module["module_id"]):
            raise ValueError("module_id is invalid")
        if (not isinstance(module["revision"], int) or isinstance(module["revision"], bool)
                or module["revision"] < 1):
            raise ValueError("module revision is invalid")
        for key, required_items in (("provides", True), ("requires", False),
                                    ("conflicts", False), ("fallback_module_ids", False)):
            values = module[key]
            pattern = ID if key == "fallback_module_ids" else (CONTRACT_NAME if key == "requires" else SEMANTIC_TAG)
            if (not isinstance(values, list) or (required_items and not values)
                    or len(values) != len(set(values))
                    or not all(isinstance(value, str) and pattern.fullmatch(value) for value in values)):
                raise ValueError(f"module {key} is invalid")
        quality = module["quality"]
        if (not isinstance(quality, Mapping) or set(quality) != {"tier", "score"}
                or not isinstance(quality["tier"], int) or isinstance(quality["tier"], bool)
                or not 0 <= quality["tier"] <= 4
                or not isinstance(quality["score"], (int, float)) or isinstance(quality["score"], bool)
                or quality["score"] < 0):
            raise ValueError("module quality is invalid")
        return {**module, "quality": dict(quality)}

    @staticmethod
    def _validate_anchors(anchors: Any) -> list[dict[str, str]]:
        if not isinstance(anchors, list):
            raise ValueError("named anchors must be a list")
        result = []
        for anchor in anchors:
            if (not isinstance(anchor, Mapping) or set(anchor) != {"name", "node"}
                    or not all(isinstance(anchor[key], str) and anchor[key] for key in ("name", "node"))):
                raise ValueError("named anchor is invalid")
            result.append(dict(anchor))
        if len({anchor["name"] for anchor in result}) != len(result):
            raise ValueError("named anchors must have unique names")
        return result

    @staticmethod
    def _validate_bounds(bounds: Any) -> dict[str, list[float]]:
        if not isinstance(bounds, Mapping) or set(bounds) != {"minimum", "maximum"}:
            raise ValueError("bounds must contain minimum and maximum")
        minimum, maximum = bounds["minimum"], bounds["maximum"]
        if (not all(isinstance(value, list) and len(value) == 3 for value in (minimum, maximum))
                or not all(isinstance(value, (int, float)) for value in minimum + maximum)
                or any(low > high for low, high in zip(minimum, maximum))):
            raise ValueError("bounds are invalid")
        return {"minimum": list(minimum), "maximum": list(maximum)}

    @staticmethod
    def _validate_anchor_nodes(anchors: list[dict[str, str]], document: Mapping[str, Any]) -> None:
        nodes = document.get("nodes", [])
        names = {node.get("name") for node in nodes if isinstance(node, Mapping)}
        missing = sorted(anchor["node"] for anchor in anchors if anchor["node"] not in names)
        if missing:
            raise ValueError("named anchors are absent from GLB: " + ", ".join(missing))

    def _timestamp(self) -> str:
        value = self.clock()
        if value.tzinfo is None:
            raise ValueError("clock must return a timezone-aware datetime")
        return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def validate_glb(data: bytes, *, material_allowlist: list[str],
                 extension_allowlist: list[str]) -> dict[str, Any]:
    """Validate self-contained GLB 2.0 structure and the profile allowlists."""
    if not isinstance(data, bytes) or len(data) < 20:
        raise ValueError("GLB is too short")
    magic, version, declared_length = struct.unpack_from("<4sII", data)
    if magic != GLB_MAGIC or version != 2 or declared_length != len(data):
        raise ValueError("GLB header is invalid")
    offset, json_document, bin_chunk = 12, None, None
    while offset < len(data):
        if offset + 8 > len(data):
            raise ValueError("GLB chunk header is truncated")
        size, kind = struct.unpack_from("<II", data, offset)
        offset += 8
        if size % 4 or offset + size > len(data):
            raise ValueError("GLB chunk is invalid")
        chunk = data[offset:offset + size]
        offset += size
        if kind == GLB_JSON:
            if json_document is not None:
                raise ValueError("GLB has multiple JSON chunks")
            try:
                json_document = json.loads(chunk.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError("GLB JSON is invalid") from error
        elif kind == GLB_BIN:
            if bin_chunk is not None:
                raise ValueError("GLB has multiple binary chunks")
            bin_chunk = chunk
        else:
            raise ValueError("GLB has an unsupported chunk type")
    if offset != len(data) or not isinstance(json_document, dict):
        raise ValueError("GLB must contain one JSON document")
    if json_document.get("asset", {}).get("version") != "2.0":
        raise ValueError("GLB must declare glTF 2.0")
    for extension in json_document.get("extensionsUsed", []) + json_document.get("extensionsRequired", []):
        if extension not in extension_allowlist:
            raise ValueError(f"GLB extension is not allowed: {extension}")
    for material in json_document.get("materials", []):
        if not isinstance(material, Mapping) or material.get("name") not in material_allowlist:
            name = material.get("name") if isinstance(material, Mapping) else None
            raise ValueError(f"GLB material is not allowed: {name!r}")
    buffers = json_document.get("buffers", [])
    if not isinstance(buffers, list):
        raise ValueError("GLB buffers are invalid")
    for buffer in buffers:
        if (not isinstance(buffer, Mapping) or "uri" in buffer
                or not isinstance(buffer.get("byteLength"), int) or buffer["byteLength"] < 0):
            raise ValueError("GLB must not reference external buffers")
        if bin_chunk is None or buffer["byteLength"] > len(bin_chunk):
            raise ValueError("GLB binary buffer is invalid")
    buffer_views = json_document.get("bufferViews", [])
    if not isinstance(buffer_views, list):
        raise ValueError("GLB buffer views are invalid")
    for view in buffer_views:
        if (not isinstance(view, Mapping) or not isinstance(view.get("buffer"), int)
                or not isinstance(view.get("byteLength"), int) or view["buffer"] < 0
                or view["buffer"] >= len(buffers) or view["byteLength"] < 0
                or not isinstance(view.get("byteOffset", 0), int) or view.get("byteOffset", 0) < 0
                or view.get("byteOffset", 0) + view["byteLength"] > buffers[view["buffer"]]["byteLength"]):
            raise ValueError("GLB buffer view is invalid")
    for accessor in json_document.get("accessors", []):
        if not isinstance(accessor, Mapping):
            raise ValueError("GLB accessor is invalid")
        if "bufferView" in accessor and (not isinstance(accessor["bufferView"], int)
                                          or not 0 <= accessor["bufferView"] < len(buffer_views)):
            raise ValueError("GLB accessor buffer view is invalid")
        if "byteOffset" in accessor and (not isinstance(accessor["byteOffset"], int)
                                          or accessor["byteOffset"] < 0):
            raise ValueError("GLB accessor byte offset is invalid")
        if "count" in accessor and (not isinstance(accessor["count"], int) or accessor["count"] < 0):
            raise ValueError("GLB accessor count is invalid")
    for image in json_document.get("images", []):
        if not isinstance(image, Mapping) or "uri" in image or not isinstance(image.get("bufferView"), int):
            raise ValueError("GLB must not reference external images")
        if image["bufferView"] < 0 or image["bufferView"] >= len(buffer_views):
            raise ValueError("GLB image buffer view is invalid")
    return json_document


def validate_glb_v1_profile(profile: Mapping[str, Any]) -> None:
    """Validate the closed metadata sidecar before a host considers loading it."""
    required = {"profile", "artifact", "byte_cap", "loader", "target", "material_allowlist",
                "extension_allowlist", "named_anchors", "bounds", "provenance", "fallback_module_ids"}
    if not isinstance(profile, Mapping) or set(profile) != required or profile.get("profile") != "glb.v1":
        raise ValueError("glb.v1 profile has an invalid shape")
    artifact = profile["artifact"]
    if (not isinstance(artifact, Mapping)
            or set(artifact) != {"uri", "sha256", "media_type", "byte_length"}
            or not isinstance(artifact.get("sha256"), str) or not SHA256.fullmatch(artifact["sha256"])
            or artifact.get("uri") != "sha256:" + artifact["sha256"]
            or artifact.get("media_type") != GLB_MIME
            or not isinstance(artifact.get("byte_length"), int) or artifact["byte_length"] < 0):
        raise ValueError("glb.v1 artifact is invalid")
    if (not isinstance(profile["byte_cap"], int) or profile["byte_cap"] < artifact["byte_length"]):
        raise ValueError("glb.v1 byte cap is invalid")
    _validate_profile_implementation(profile["loader"], "loader")
    target = profile["target"]
    if (not isinstance(target, Mapping) or set(target) != {"platform", "render_pipeline"}
            or not isinstance(target["platform"], str) or not target["platform"]):
        raise ValueError("glb.v1 target is invalid")
    _validate_profile_implementation(target["render_pipeline"], "render pipeline")
    for key in ("material_allowlist", "extension_allowlist"):
        values = profile[key]
        if (not isinstance(values, list) or len(values) != len(set(values))
                or not all(isinstance(value, str) and value for value in values)):
            raise ValueError(f"glb.v1 {key} is invalid")
    GlbSourceImporter._validate_anchors(profile["named_anchors"])
    GlbSourceImporter._validate_bounds(profile["bounds"])
    provenance = profile["provenance"]
    if (not isinstance(provenance, Mapping)
            or set(provenance) != {"source_receipt", "acceptance", "converter", "converted_at"}
            or not isinstance(provenance["converter"], str) or not provenance["converter"]
            or not _valid_timestamp(provenance["converted_at"])):
        raise ValueError("glb.v1 provenance is invalid")
    source = provenance["source_receipt"]
    acceptance = provenance["acceptance"]
    _validate_profile_source_receipt(source)
    _validate_profile_acceptance(acceptance)
    if acceptance["source_sha256"] != source["artifact"]["sha256"]:
        raise ValueError("glb.v1 acceptance source hash is not bound to source receipt")
    if acceptance["output_sha256"] != artifact["sha256"]:
        raise ValueError("glb.v1 acceptance output hash is not bound to artifact")
    fallback_ids = profile["fallback_module_ids"]
    if (not isinstance(fallback_ids, list) or len(fallback_ids) != len(set(fallback_ids))
            or not all(isinstance(value, str) and ID.fullmatch(value) for value in fallback_ids)):
        raise ValueError("glb.v1 fallback linkage is invalid")


def _validate_profile_implementation(value: Any, label: str) -> None:
    if (not isinstance(value, Mapping) or set(value) != {"id", "version"}
            or not isinstance(value["id"], str) or not SEMANTIC_TAG.fullmatch(value["id"])
            or not isinstance(value["version"], str) or not value["version"]):
        raise ValueError(f"glb.v1 {label} is invalid")


def _validate_profile_source_receipt(value: Any) -> None:
    required = {"work_id", "worker_id", "created_at", "native_name", "artifact", "parent_module_ids"}
    if (not isinstance(value, Mapping) or set(value) != required
            or not all(isinstance(value[key], str) and ID.fullmatch(value[key]) for key in ("work_id", "worker_id"))
            or value["native_name"] != value["work_id"] + ".blend" or not _valid_timestamp(value["created_at"])
            or not isinstance(value["parent_module_ids"], list)
            or not all(isinstance(item, str) and ID.fullmatch(item) for item in value["parent_module_ids"])
            or len(value["parent_module_ids"]) != len(set(value["parent_module_ids"]))):
        raise ValueError("glb.v1 source receipt is invalid")
    artifact = value["artifact"]
    if (not isinstance(artifact, Mapping) or set(artifact) != {"uri", "sha256", "media_type", "byte_length"}
            or artifact.get("media_type") != "application/x-blender" or not isinstance(artifact.get("sha256"), str)
            or not SHA256.fullmatch(artifact["sha256"]) or artifact.get("uri") != "sha256:" + artifact["sha256"]
            or not isinstance(artifact.get("byte_length"), int) or artifact["byte_length"] < 0):
        raise ValueError("glb.v1 source artifact is invalid")


def _validate_profile_acceptance(value: Any) -> None:
    required = {"source_sha256", "output_sha256", "status", "actor_kind", "actor_id", "policy_id", "accepted_at", "evidence"}
    if (not isinstance(value, Mapping) or set(value) != required or value.get("status") != "accepted"
            or value.get("actor_kind") != "automated_validator"
            or value.get("actor_id") != "glb-importer-validator" or value.get("policy_id") != "blender-export-v1"
            or not isinstance(value.get("source_sha256"), str) or not SHA256.fullmatch(value["source_sha256"])
            or not isinstance(value.get("output_sha256"), str) or not SHA256.fullmatch(value["output_sha256"])
            or not _valid_timestamp(value.get("accepted_at")) or not isinstance(value.get("evidence"), list)
            or not value["evidence"]):
        raise ValueError("glb.v1 acceptance is invalid")
    ids = []
    for item in value["evidence"]:
        if (not isinstance(item, Mapping) or set(item) != {"evidence_id", "result"}
                or not isinstance(item.get("evidence_id"), str) or not ID.fullmatch(item["evidence_id"])
                or item.get("result") != "passed"):
            raise ValueError("glb.v1 acceptance evidence is invalid")
        ids.append(item["evidence_id"])
    if len(ids) != len(set(ids)) or set(ids) != {"source-hash", "glb-structure", "glb-output-hash"}:
        raise ValueError("glb.v1 acceptance evidence IDs are not unique")


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def main(argv: list[str] | None = None) -> int:
    """Expose whether the real Blender conversion adapter is available."""
    parser = argparse.ArgumentParser(description="Inspect the GLB importer conversion boundary.")
    parser.add_argument("--check-live-conversion", action="store_true")
    args = parser.parse_args(argv)
    if args.check_live_conversion:
        executable = BlenderCliGlbConverter.discover()
        if executable is None:
            print(json.dumps({"live_conversion": "unverified",
                              "reason": "No Blender CLI adapter is available."},
                             sort_keys=True))
            return 0
        completed = subprocess.run([str(executable), "--version"], capture_output=True, text=True,
                                   timeout=15, check=False)
        version = (completed.stdout or completed.stderr).splitlines()[0] if completed.returncode == 0 else "unknown"
        print(json.dumps({"live_conversion": "available", "executable": str(executable),
                          "version": version}, sort_keys=True))
        return 0
    parser.error("use --check-live-conversion; accepted conversion is proven by the importer test suite")
    return 2


if __name__ == "__main__":
    sys.exit(main())
