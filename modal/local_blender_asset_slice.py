"""Run one truthful local Blender asset-generation slice for the Build Room.

The one ocean-inspired alien form here is demo bootstrap content only. The
emitted module is generic ``encounter.body``; gameplay semantics are out of scope.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
from typing import Any

from encounter_worker_adapter import HashAddressedArtifact, SourceArtifactReceipt
from glb_source_importer import BlenderCliGlbConverter, GlbSourceImporter


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def stable_id(prefix: str, value: str) -> str:
    return f"{prefix}-{hashlib.sha256(value.encode()).hexdigest()[:32]}"


def run_blender(executable: Path, arguments: list[str], cwd: Path) -> dict[str, Any]:
    command = [str(executable), *arguments]
    started = time.monotonic()
    completed = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=90, check=False)
    receipt = {"argv": command, "cwd": str(cwd), "returncode": completed.returncode,
               "duration_ms": round((time.monotonic() - started) * 1000),
               "stdout_sha256": hashlib.sha256(completed.stdout.encode()).hexdigest(),
               "stderr_sha256": hashlib.sha256(completed.stderr.encode()).hexdigest(),
               "stdout_tail": completed.stdout[-1000:], "stderr_tail": completed.stderr[-1000:]}
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip().replace("\n", " ")[:500]
        raise RuntimeError("Blender command failed" + (f": {detail}" if detail else ""))
    return receipt


def generator_script(source: Path, thumbnail: Path, seed: int) -> str:
    return f'''import bpy, math, random, mathutils
random.seed({seed})
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for item in list(bpy.data.materials): bpy.data.materials.remove(item)
mat=bpy.data.materials.new("standard")
mat.diffuse_color=(0.055,0.38,0.50,1)
mat.metallic=0.12
mat.roughness=0.34
accent=bpy.data.materials.new("standard-accent")
accent.diffuse_color=(0.08,0.82,0.74,1)
accent.metallic=0.05
accent.roughness=0.28
origin=bpy.data.objects.new("encounter-origin",None)
bpy.context.collection.objects.link(origin)
bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, location=(0,0,0.45))
body=bpy.context.object
body.name="generated-body"
body.scale=(0.82,0.62,0.70)
body.data.materials.append(mat)
body.parent=origin
for index in range(4):
    angle=index*math.tau/4+0.2
    bpy.ops.mesh.primitive_cone_add(vertices=16, radius1=0.12, radius2=0.22, depth=1.0, location=(math.cos(angle)*0.58,math.sin(angle)*0.48,-0.05))
    limb=bpy.context.object
    limb.name=f"generated-fin-{{index}}"
    limb.rotation_euler=(0.45,0.0,angle)
    limb.data.materials.append(accent)
    limb.parent=origin
for side in (-1,1):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.10, location=(0.35,side*0.26,0.70))
    eye=bpy.context.object
    eye.name=f"generated-eye-{{side}}"
    eye.data.materials.append(accent)
    eye.parent=origin
def track(obj, point): obj.rotation_euler=(mathutils.Vector(point)-obj.location).to_track_quat("-Z","Y").to_euler()
bpy.ops.object.camera_add(location=(3.3,-3.3,2.4))
camera=bpy.context.object
bpy.context.scene.camera=camera
track(camera,(0,0,0.35))
bpy.ops.object.light_add(type="AREA", location=(2,-2,3.5))
key=bpy.context.object
key.data.energy=900
key.data.shape="DISK"
key.data.size=5
track(key,(0,0,0.2))
bpy.ops.object.light_add(type="AREA", location=(-2,1,1.4))
fill=bpy.context.object
fill.data.energy=350
fill.data.color=(0.12,0.62,0.8)
fill.data.size=4
track(fill,(0,0,0.3))
scene=bpy.context.scene
scene.render.engine="BLENDER_EEVEE"
scene.render.resolution_x=512
scene.render.resolution_y=512
scene.render.resolution_percentage=100
scene.render.image_settings.file_format="PNG"
scene.render.filepath={str(thumbnail)!r}
scene.world.color=(0.008,0.015,0.03)
bpy.ops.wm.save_as_mainfile(filepath={str(source)!r})
bpy.ops.render.render(write_still=True)
'''


def build(args: argparse.Namespace) -> dict[str, Any]:
    if args.seed < 0:
        raise ValueError("seed must be non-negative")
    executable = Path(args.blender) if args.blender else BlenderCliGlbConverter.discover()
    if executable is None or not executable.is_file():
        raise RuntimeError("local Blender CLI is unavailable")
    root = Path(args.output_dir).resolve()
    work_dir = root / args.work_id
    staging, source_dir = work_dir / "staging", work_dir / "source"
    runtime_dir, visual_dir = work_dir / "runtime", work_dir / "visual"
    for directory in (staging, source_dir, runtime_dir, visual_dir):
        directory.mkdir(parents=True, exist_ok=True)
    source_staging, thumb_staging = staging / f"{args.work_id}.blend", staging / f"{args.work_id}.png"
    script = staging / "generate_demo.py"
    script.write_text(generator_script(source_staging, thumb_staging, args.seed), encoding="utf-8")
    generation_receipt = run_blender(executable, ["--background", "--factory-startup", "--disable-autoexec", "--python", str(script)], staging)
    if not source_staging.is_file() or not thumb_staging.is_file():
        raise RuntimeError("Blender generation completed without immutable source or visual output: " + generation_receipt["stdout_tail"].replace("\n", " ")[-500:])
    source_hash, thumbnail_hash = sha256_file(source_staging), sha256_file(thumb_staging)
    source_path = source_dir / f"{args.work_id}.{source_hash}.blend"
    thumbnail_path = visual_dir / f"{args.work_id}.{thumbnail_hash}.png"
    shutil.move(str(source_staging), source_path)
    shutil.move(str(thumb_staging), thumbnail_path)
    created_at = timestamp()
    source_receipt = SourceArtifactReceipt(args.work_id, args.worker_id, created_at, f"{args.work_id}.blend",
        HashAddressedArtifact(f"sha256:{source_hash}", source_hash, "application/x-blender", source_path.stat().st_size), ())
    module_id, asset_id = stable_id("module", f"{args.work_id}:{source_hash}"), stable_id("asset", f"{args.work_id}:{source_hash}")
    fallback_id = f"baseline-{args.encounter_id[-24:]}"
    host = {"schema_version":"1","host_id":"local-build-room","host_build":"local-blender-v1","platform":"local","scripting_backend":"il2cpp","execution_kinds":["recipe","runtime_asset"],"loaders":["gltf","urp"],"contracts":["encounter-module.v1"],"limits":{"memory_mb":1024,"preload_seconds":30,"artifact_bytes":50_000_000}}
    converter = BlenderCliGlbConverter(executable)
    result = GlbSourceImporter(converter).import_validated(
        source_receipt=source_receipt, source_bytes=source_path.read_bytes(), host_capabilities=host,
        target={"platform":"local","loader":{"id":"gltf","version":"2.0"},"render_pipeline":{"id":"urp","version":"17"},"material_allowlist":["standard","standard-accent"],"extension_allowlist":[],"byte_cap":50_000_000},
        module={"module_id":module_id,"revision":1,"provides":["encounter.body"],"requires":["encounter-module.v1"],"conflicts":[],"quality":{"tier":1,"score":1.0},"fallback_module_ids":[fallback_id]},
        named_anchors=[{"name":"encounter-origin","node":"encounter-origin"}], bounds={"minimum":[-1.5,-1.5,-1.5],"maximum":[1.5,1.5,1.5]})
    output_hash = hashlib.sha256(result.glb_bytes).hexdigest()
    output_path = runtime_dir / f"{output_hash}.glb"
    output_path.write_bytes(result.glb_bytes)
    manifest = {"schema_version":"1","kind":"local_blender_generated_asset","evidence_scope":"local_blender_cli_only","seed":args.seed,"encounter_id":args.encounter_id,"work_id":args.work_id,"worker_id":args.worker_id,"created_at":created_at,"asset_id":asset_id,"module":result.runtime_asset,"loader_profile":result.loader_profile,"source":{**source_receipt.to_record(),"path":str(source_path)},"runtime":{**result.runtime_asset["artifact"],"path":str(output_path)},"visual":{"path":str(thumbnail_path),"sha256":thumbnail_hash,"media_type":"image/png","byte_length":thumbnail_path.stat().st_size},"worker_receipt":{"status":"completed","commands":[generation_receipt, converter.last_receipt],"converter":"BlenderCliGlbConverter","note":"Observed local Blender CLI evidence; not Modal, Unity-load, or player proof."}}
    manifest_path = work_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    manifest["manifest_path"] = str(manifest_path)
    return manifest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate one local Blender-backed generic runtime-asset candidate.")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--encounter-id", required=True)
    parser.add_argument("--work-id", required=True)
    parser.add_argument("--worker-id", required=True)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--blender")
    args = parser.parse_args(argv)
    try:
        print(json.dumps(build(args), sort_keys=True, separators=(",", ":")))
        return 0
    except Exception as error:
        print(json.dumps({"error":str(error),"evidence_scope":"local_blender_cli_only"}, sort_keys=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
