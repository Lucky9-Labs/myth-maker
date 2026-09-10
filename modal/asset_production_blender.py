"""Blender-side driver for immutable cloud asset-production jobs.

This file is executed by Blender in Modal. It intentionally has no Modal or
OpenAI dependency; provider orchestration and visual critique stay outside the
geometry process.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys

import bpy
from mathutils import Vector


KIT_VERSION = "myth-maker.asset-core-kit/v1"
REVIEW_PROTOCOL = "myth-maker.asset-review/v2"
REFERENCE_CORRECTION_BATCH = "raptor-reference-batch/v5"
KIT_PRIMITIVES = {
    "panel-profile": {"bevel_ratio": 0.003, "bevel_segments": 2, "armor_role": "removable-armor"},
    "joint-pivot": {"name_tokens": ["joint", "ankle", "elbow", "hip", "knee", "shoulder", "waist", "wrist"]},
    "bilateral-chirality": {"left_tokens": ["-l", "left"], "right_tokens": ["-r", "right"]},
    "weapon-anchors": {"names": ["weapon-root", "primary-grip", "support-grip", "muzzle", "bow-arm-left", "bow-arm-right"]},
    "review-camera": {"projection": "orthographic", "resolution": [640, 640]},
    "export": {"native": "uncompressed-blend", "runtime": "glb-2.0", "animations": True},
}
MATERIALS = {
    "structural": (0.035, 0.045, 0.055, 1.0),
    "armor-white": (0.72, 0.76, 0.78, 1.0),
    "armor-blue": (0.035, 0.18, 0.42, 1.0),
    "cyan-emission": (0.01, 0.55, 0.8, 1.0),
    "lens": (0.02, 0.2, 0.28, 0.55),
}
ANCHORS = ("weapon-root", "primary-grip", "support-grip", "muzzle", "bow-arm-left", "bow-arm-right")


def slug(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    return normalized or "unnamed"


def parse_args() -> argparse.Namespace:
    values = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", required=True)
    parser.add_argument("--inputs", required=True)
    parser.add_argument("--output-root", required=True)
    return parser.parse_args(values)


def source_files(inputs: Path) -> list[Path]:
    return sorted(inputs.glob("*.blend"))


def load_sources(paths: list[Path], assemble: bool) -> None:
    if not paths:
        raise RuntimeError("production job contains no Blender source")
    if len(paths) == 1 and not assemble:
        bpy.ops.wm.open_mainfile(filepath=str(paths[0]), load_ui=False)
        return
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for source in paths:
        with bpy.data.libraries.load(str(source), link=False) as (available, loaded):
            loaded.objects = list(available.objects)
        for obj in loaded.objects:
            if obj is not None and obj.name not in bpy.context.scene.objects:
                bpy.context.scene.collection.objects.link(obj)


def ensure_materials() -> None:
    for name, color in MATERIALS.items():
        material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
        material.diffuse_color = color
        material.use_nodes = True
        shader = material.node_tree.nodes.get("Principled BSDF")
        if shader:
            shader.inputs["Base Color"].default_value = color
            shader.inputs["Metallic"].default_value = 0.55 if name != "lens" else 0.05
            shader.inputs["Roughness"].default_value = 0.3 if name != "lens" else 0.12
            if name == "cyan-emission":
                emission = shader.inputs.get("Emission Color") or shader.inputs.get("Emission")
                strength = shader.inputs.get("Emission Strength")
                if emission:
                    emission.default_value = color
                if strength:
                    strength.default_value = 4.0


def core_kit_manifest() -> dict:
    primitives = []
    for name, parameters in sorted(KIT_PRIMITIVES.items()):
        encoded = json.dumps(parameters, sort_keys=True, separators=(",", ":")).encode()
        primitives.append({"name": name, "parameters": parameters,
                           "parameter_schema_sha256": hashlib.sha256(encoded).hexdigest()})
    return {"format": KIT_VERSION, "primitives": primitives}


def apply_core_kit() -> None:
    ensure_materials()
    joint_tokens = tuple(KIT_PRIMITIVES["joint-pivot"]["name_tokens"])
    for obj in bpy.context.scene.objects:
        name = obj.name.lower()
        if name.endswith(("-l", ".l")) or "left" in name:
            obj["chirality"] = "left"
        elif name.endswith(("-r", ".r")) or "right" in name:
            obj["chirality"] = "right"
        if any(token in name for token in joint_tokens):
            obj["mechanical_pivot"] = True
        if obj.type != "MESH":
            continue
        role = obj.get("asset_role")
        material_name = "armor-blue" if "blue" in name or "canopy" in name else "armor-white" if role == "removable-armor" else "structural"
        if len(obj.data.materials) == 0:
            obj.data.materials.append(bpy.data.materials[material_name])
        if not any(modifier.type == "BEVEL" for modifier in obj.modifiers):
            diagonal = max(obj.dimensions.length, 0.01)
            modifier = obj.modifiers.new("asset-kit-bevel", "BEVEL")
            modifier.width = diagonal * KIT_PRIMITIVES["panel-profile"]["bevel_ratio"]
            modifier.segments = KIT_PRIMITIVES["panel-profile"]["bevel_segments"]
            modifier.limit_method = "ANGLE"


def normalize_scene(job: dict) -> None:
    seen = set()
    for index, obj in enumerate(sorted(bpy.context.scene.objects, key=lambda item: item.name.lower())):
        prior_work = str(obj.get("asset_production_work", ""))
        if prior_work and prior_work != job["work_id"]:
            obj["asset_source_lane"] = prior_work.rsplit("-", 1)[-1]
        base = slug(obj.name)
        name = base
        suffix = 2
        while name in seen:
            name, suffix = f"{base}-{suffix:02d}", suffix + 1
        seen.add(name)
        obj.name = name
        obj["asset_production_run"] = job["run_id"]
        obj["asset_production_work"] = job["work_id"]
        obj["asset_core_kit"] = KIT_VERSION
        lowered = name.lower()
        if "armor" in lowered or "white" in lowered or "blue" in lowered or "canopy" in lowered:
            obj["asset_role"] = "removable-armor"
        elif obj.type in {"MESH", "ARMATURE", "EMPTY"}:
            obj["asset_role"] = "structure"
        if obj.type == "MESH":
            for polygon in obj.data.polygons:
                polygon.use_smooth = False


def isolate_worker_ownership(job_type: str) -> int:
    """Make structure and armor lanes disjoint before immutable fan-in."""
    if job_type not in {"mech-structure", "mech-armor"}:
        return 0
    removed = 0
    keep_role = "structure" if job_type == "mech-structure" else "removable-armor"
    for obj in list(bpy.context.scene.objects):
        if obj.type == "MESH" and obj.get("asset_role") != keep_role:
            bpy.data.objects.remove(obj, do_unlink=True); removed += 1
    return removed


def _thicken(obj, factor: float) -> None:
    dimensions = list(obj.dimensions)
    longest = max(range(3), key=lambda index: dimensions[index])
    for axis in range(3):
            if axis != longest: obj.scale[axis] *= factor


def _lengthen(obj, factor: float) -> None:
    longest = max(range(3), key=lambda index: obj.dimensions[index])
    obj.scale[longest] *= factor


def _scale_local(obj, x: float = 1.0, y: float = 1.0, z: float = 1.0) -> None:
    obj.scale.x *= x
    obj.scale.y *= y
    obj.scale.z *= z


def _taper_ends(obj, factor: float) -> None:
    """Narrow both ends of a casting along its longest local mesh axis."""
    coordinates = [[vertex.co[axis] for vertex in obj.data.vertices] for axis in range(3)]
    ranges = [max(values) - min(values) if values else 0 for values in coordinates]
    longest = max(range(3), key=lambda axis: ranges[axis])
    center = (max(coordinates[longest]) + min(coordinates[longest])) * 0.5
    half = max(ranges[longest] * 0.5, 1e-6)
    for vertex in obj.data.vertices:
        distance = min(1.0, abs(vertex.co[longest] - center) / half)
        cross_scale = 1.0 - (1.0 - factor) * distance
        for axis in range(3):
            if axis != longest: vertex.co[axis] *= cross_scale
    obj.data.update()


def _add_box(name: str, location: tuple[float, float, float], dimensions: tuple[float, float, float],
             material: str, owner) -> None:
    """Add one deterministic beveled hard-surface component in weapon coordinates."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object; obj.name = name; obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for key in ("asset_production_run", "asset_production_work", "asset_core_kit"):
        if owner.get(key) is not None: obj[key] = owner[key]
    obj["asset_role"] = "removable-armor" if material == "armor-white" else "structure"
    obj.data.materials.append(bpy.data.materials[material])
    bevel = obj.modifiers.new("reference-profile-bevel", "BEVEL")
    bevel.width = min(dimensions) * 0.16; bevel.segments = 2; bevel.limit_method = "ANGLE"


def _add_side_wedge(name: str, profile: tuple[tuple[float, float], ...], thickness: float,
                    material: str, owner) -> None:
    """Extrude a tapered X/Z profile through Y for a readable side silhouette."""
    half = thickness * 0.5
    vertices = [(x, -half, z) for x, z in profile] + [(x, half, z) for x, z in profile]
    count = len(profile)
    faces = [tuple(range(count)), tuple(range(count, count * 2))]
    for index in range(count):
        following = (index + 1) % count
        faces.append((index, following, following + count, index + count))
    mesh = bpy.data.meshes.new(name + "-mesh"); mesh.from_pydata(vertices, [], faces); mesh.update()
    obj = bpy.data.objects.new(name, mesh); bpy.context.scene.collection.objects.link(obj)
    for key in ("asset_production_run", "asset_production_work", "asset_core_kit"):
        if owner.get(key) is not None: obj[key] = owner[key]
    obj["asset_role"] = "removable-armor" if material == "armor-white" else "structure"
    obj.data.materials.append(bpy.data.materials[material])
    bevel = obj.modifiers.new("reference-profile-bevel", "BEVEL")
    bevel.width = min(thickness * 0.22, 0.035); bevel.segments = 2; bevel.limit_method = "ANGLE"


def _mount_created(obj, owner, location=(0.0, 0.0, 0.0)) -> None:
    """Attach new geometry in an articulation mount's local coordinate system."""
    obj.parent = owner
    obj.location = location
    obj.rotation_euler = (0.0, 0.0, 0.0)


def apply_reference_corrections(job_type: str) -> int:
    """Apply one bounded, versioned defect batch observed against the frozen refs."""
    changed = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH": continue
        name = obj.name.lower()
        if job_type == "mech-structure":
            if "frame-foot-carrier" in name:
                _scale_local(obj, y=1.18, z=0.68); changed += 1
            elif "frame-foot-toe" in name:
                _scale_local(obj, y=1.65, z=0.72); changed += 1
            elif "frame-foot-heel" in name:
                _scale_local(obj, y=0.86, z=0.72); changed += 1
            elif any(token in name for token in ("upper-leg-maincasting", "lower-leg-casting")):
                _thicken(obj, 1.14); changed += 1
            elif any(token in name for token in ("joint-hand-index", "joint-hand-middle", "joint-hand-ring",
                                                  "joint-hand-little", "joint-hand-thumb")):
                _lengthen(obj, 1.28); changed += 1
        elif job_type == "mech-armor":
            if "armor-foot-armor" in name:
                _scale_local(obj, y=1.28, z=0.72); changed += 1
            elif "armor-shoulder-armor" in name:
                _scale_local(obj, x=0.84, y=0.84, z=0.84); changed += 1
            elif "armor-canopy" in name:
                _scale_local(obj, y=1.28, z=0.86)
                obj.rotation_euler.x += math.radians(-8); changed += 2
            elif "shinarmor" in name:
                _thicken(obj, 1.12); changed += 1
        elif job_type == "railgun":
            pass
    if job_type == "railgun":
        owner = next((obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.name.lower() == "receiver"), None)
        if owner is None: raise RuntimeError("railgun reference batch cannot resolve receiver owner")
        ensure_materials()
        # The reference's defining bow blades must read in the fixed side view.
        # Keep every promoted receiver component unchanged and add only these
        # tapered profiles around the cyan rail.
        _add_side_wedge("bow-blade-upper", ((4.20, 0.18), (4.24, 0.34), (3.18, 0.56), (3.46, 0.28)),
                        0.10, "armor-white", owner)
        _add_side_wedge("bow-blade-lower", ((3.46, -0.28), (3.18, -0.56), (4.24, -0.34), (4.20, -0.18)),
                        0.10, "armor-white", owner)
        changed += 2
    if changed == 0:
        raise RuntimeError("reference correction batch matched no owned geometry")
    return changed


def apply_parameterized_correction(spec: dict) -> int:
    """Execute a control-plane validated, lane-local geometry patch."""
    ensure_materials(); changed = 0
    for command in spec["commands"]:
        owner = bpy.data.objects.get(command.get("owner", ""))
        if command["op"].startswith("add-") and owner is None:
            raise RuntimeError("parameterized correction owner is unavailable: " + command.get("owner", ""))
        if command["op"] == "add-box":
            _add_box(command["name"], tuple(command["location"]), tuple(command["dimensions"]), command["material"], owner)
        elif command["op"] == "add-mounted-box":
            _add_box(command["name"], (0.0, 0.0, 0.0), tuple(command["dimensions"]), command["material"], owner)
            _mount_created(bpy.data.objects[command["name"]], owner, tuple(command["location"]))
        elif command["op"] == "add-side-wedge":
            _add_side_wedge(command["name"], tuple(tuple(point) for point in command["profile"]), command["thickness"], command["material"], owner)
        elif command["op"] == "add-mounted-side-wedge":
            _add_side_wedge(command["name"], tuple(tuple(point) for point in command["profile"]), command["thickness"], command["material"], owner)
            _mount_created(bpy.data.objects[command["name"]], owner)
        else:
            target = bpy.data.objects.get(command["name"])
            if target is None: raise RuntimeError("parameterized correction target is unavailable: " + command["name"])
            if command["op"] == "scale": _scale_local(target, *command["scale"])
            elif command["op"] == "translate": target.location += Vector(command["delta"])
            elif command["op"] == "rotate-degrees":
                for axis, value in enumerate(command["delta"]): target.rotation_euler[axis] += math.radians(value)
            elif command["op"] == "thicken": _thicken(target, command["factor"])
            elif command["op"] == "lengthen": _lengthen(target, command["factor"])
            elif command["op"] == "taper-ends": _taper_ends(target, command["factor"])
            elif command["op"] == "hide": target.hide_render = True
            elif command["op"] == "set-material":
                target.data.materials.clear()
                target.data.materials.append(bpy.data.materials[command["material"]])
        changed += 1
    return changed


def mount_railgun_to_mech() -> int:
    """Translate Worker C's immutable group from its primary grip to the mech hands."""
    railgun = [obj for obj in bpy.context.scene.objects if "worker-c" in str(obj.get("asset_production_work", ""))]
    hands = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and "hand" in obj.name.lower()]
    grip = next((obj for obj in railgun if obj.name.lower() == "primary-grip"), None)
    if not railgun or not hands or grip is None:
        raise RuntimeError("assembly cannot resolve railgun group, primary grip, and mech hands")
    target = sum((obj.matrix_world.translation for obj in hands), Vector((0, 0, 0))) / len(hands)
    offset = target - grip.matrix_world.translation
    roots = [obj for obj in railgun if obj.parent is None]
    for obj in roots: obj.location += offset
    return len(roots)


def ensure_railgun_anchors() -> None:
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        return
    low, high = bounds(meshes)
    center = (low + high) * 0.5
    positions = {
        "weapon-root": center,
        "primary-grip": Vector((center.x, center.y, low.z + (high.z-low.z)*0.25)),
        "support-grip": Vector((center.x, center.y + (high.y-low.y)*0.18, center.z)),
        "muzzle": Vector((center.x, high.y, center.z)),
        "bow-arm-left": Vector((low.x, high.y - (high.y-low.y)*0.12, center.z)),
        "bow-arm-right": Vector((high.x, high.y - (high.y-low.y)*0.12, center.z)),
    }
    aliases = {
        "primary-grip": ("socket-rearhand", "socket-rear-hand", "rear-hand"),
        "support-grip": ("socket-supporthand", "socket-support-hand", "support-hand"),
        "muzzle": ("socket-muzzle",), "weapon-root": ("raptorrailgun-root", "railgun-root"),
        "bow-arm-left": ("bladel", "blade-l"), "bow-arm-right": ("blader", "blade-r"),
    }
    for name in ANCHORS:
        obj = bpy.data.objects.get(name) or next((bpy.data.objects.get(alias) for alias in aliases.get(name, ()) if bpy.data.objects.get(alias)), None)
        synthesized = obj is None
        if obj is None:
            obj = bpy.data.objects.new(name, None)
            bpy.context.scene.collection.objects.link(obj)
        elif obj.name != name and obj.type == "EMPTY":
            obj.name = name
        elif obj.name != name:
            source = obj
            obj = bpy.data.objects.new(name, None)
            bpy.context.scene.collection.objects.link(obj)
            obj.matrix_world = source.matrix_world.copy()
        if obj.type == "EMPTY":
            obj.empty_display_type = "ARROWS"
            obj.empty_display_size = max((high - low).length * 0.025, 0.03)
        if synthesized:
            obj.location = positions[name]
        obj["asset_role"] = "attachment-anchor"
        obj["asset_core_kit"] = KIT_VERSION


def ensure_charge_animation() -> None:
    if bpy.data.actions:
        return
    blades = [obj for obj in bpy.context.scene.objects if obj.name in {"bow-arm-left", "bow-arm-right"} or "blade" in obj.name]
    if len(blades) < 2:
        raise RuntimeError("railgun animation requested without two addressable bow arms")
    for index, blade in enumerate(sorted(blades, key=lambda item: item.name)[:2]):
        blade.rotation_mode = "XYZ"
        base = blade.rotation_euler.copy()
        for frame, offset in ((1, 0), (36, math.radians(15) * (-1 if index == 0 else 1)), (37, 0), (48, 0)):
            blade.rotation_euler = base
            blade.rotation_euler.z += offset
            blade.keyframe_insert(data_path="rotation_euler", frame=frame)
    bpy.context.scene.frame_start, bpy.context.scene.frame_end = 1, 48


def bounds(objects: list) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    if not points:
        return Vector((-1, -1, -1)), Vector((1, 1, 1))
    return Vector(tuple(min(point[i] for point in points) for i in range(3))), Vector(tuple(max(point[i] for point in points) for i in range(3)))


def look_at(camera, target: Vector) -> None:
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def render_views(output: Path, views: list[str], job: dict) -> None:
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    old_camera = bpy.data.objects.get("asset-review-camera")
    if old_camera is not None:
        bpy.data.objects.remove(old_camera, do_unlink=True)
    old_data = bpy.data.cameras.get("asset-review-camera")
    if old_data is not None:
        bpy.data.cameras.remove(old_data)
    camera_data = bpy.data.cameras.new("asset-review-camera")
    camera = bpy.data.objects.new("asset-review-camera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    camera.parent = None
    camera.scale = (1, 1, 1)
    camera_data.shift_x = 0
    camera_data.shift_y = 0
    bpy.context.scene.camera = camera
    camera_data.type = "ORTHO"
    positions = {
        "full-body": (1.0, -1.45, 0.75), "gameplay-distance": (1.4, -2.2, 1.0),
        "first-person": (0.2, -1.0, 0.35), "front": (0, -1.8, 0.1),
        "side": (1.8, 0, 0.1), "rear": (0, 1.8, 0.1),
        "articulation": (1.25, -1.25, 0.65), "grip": (0.65, -0.8, 0.35),
        "charge-rest": (0.8, -1.25, 0.45), "charge-mid": (0.8, -1.25, 0.45),
        "charge-full": (0.8, -1.25, 0.45),
    }
    scene = bpy.context.scene
    # Blender 5.2 folds Eevee Next back under the BLENDER_EEVEE enum name.
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("asset-review-world")
    scene.world.color = (0.025, 0.03, 0.04)
    output.mkdir(parents=True, exist_ok=True)
    for view in views:
        # Camera framing must use the exact set Blender will render. Source WIP
        # often contains hidden alternates whose distant bounds otherwise turn a
        # full-body review into a misleading crop.
        visible = [obj for obj in meshes if not obj.hide_render]
        if job["job_type"] == "kit-assembly" and view in {"full-body", "front", "side", "rear", "articulation"}:
            visible = [obj for obj in visible if obj.get("asset_source_lane") != "c"]
        if not visible:
            raise RuntimeError(f"review view {view} has no renderable mesh geometry")
        bpy.context.view_layer.update()
        low, high = bounds(visible)
        center, size = (low + high) * 0.5, max((high - low).length, 1.0)
        direction = Vector(positions[view]).normalized()
        if job["job_type"] == "railgun" and view == "side":
            dimensions = high - low
            longest = max(range(3), key=lambda axis: dimensions[axis])
            direction = Vector((0, -1, 0)) if longest == 0 else Vector((1, 0, 0))
        camera.location = center + direction * size
        look_at(camera, center)
        # Fit the projected bounds after orienting the camera. Orthographic scale
        # is vertical, so a world-space diagonal is neither necessary nor
        # sufficient when an imported asset has arbitrary axes.
        bpy.context.view_layer.update()
        inverse = camera.matrix_world.inverted()
        projected = [inverse @ (obj.matrix_world @ Vector(corner))
                     for obj in visible for corner in obj.bound_box]
        mid_x = (max(point.x for point in projected) + min(point.x for point in projected)) * 0.5
        mid_y = (max(point.y for point in projected) + min(point.y for point in projected)) * 0.5
        camera.location += camera.matrix_world.to_quaternion() @ Vector((mid_x, mid_y, 0))
        bpy.context.view_layer.update()
        inverse = camera.matrix_world.inverted()
        projected = [inverse @ (obj.matrix_world @ Vector(corner))
                     for obj in visible for corner in obj.bound_box]
        width = max(point.x for point in projected) - min(point.x for point in projected)
        height = max(point.y for point in projected) - min(point.y for point in projected)
        aspect = scene.render.resolution_x / scene.render.resolution_y
        camera_data.ortho_scale = max(height, width / aspect, 0.1) * 1.12
        if view == "charge-rest": scene.frame_set(1)
        if view == "charge-mid": scene.frame_set(max(1, scene.frame_end // 2))
        if view == "charge-full": scene.frame_set(max(1, scene.frame_end))
        hidden = [obj for obj in meshes if obj not in visible]
        prior_hidden = {obj.name: obj.hide_render for obj in hidden}
        try:
            for obj in hidden: obj.hide_render = True
            scene.render.filepath = str(output / f"{view}.png")
            bpy.ops.render.render(write_still=True)
        finally:
            for obj in hidden: obj.hide_render = prior_hidden[obj.name]


def scene_manifest(job: dict) -> dict:
    objects = []
    for obj in sorted(bpy.context.scene.objects, key=lambda item: item.name):
        objects.append({
            "name": obj.name, "type": obj.type, "parent": obj.parent.name if obj.parent else None,
            "role": obj.get("asset_role"),
            "location": [round(value, 6) for value in obj.location],
            "rotation": [round(value, 6) for value in obj.rotation_euler],
            "scale": [round(value, 6) for value in obj.scale],
            "renderable": not obj.hide_render,
            "source_lane": obj.get("asset_source_lane"),
        })
    triangles = 0
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            triangles += sum(max(0, len(poly.vertices) - 2) for poly in obj.data.polygons)
    return {
        "format": "myth-maker.normalized-asset-scene/v1", "run_id": job["run_id"],
        "work_id": job["work_id"], "core_kit": KIT_VERSION,
        "review_protocol": REVIEW_PROTOCOL, "reference_correction_batch": REFERENCE_CORRECTION_BATCH,
        "objects": objects,
        "materials": sorted(material.name for material in bpy.data.materials),
        "actions": sorted(action.name for action in bpy.data.actions),
        "metrics": {"objects": len(objects), "triangles": triangles,
                    "materials": len(bpy.data.materials), "actions": len(bpy.data.actions)},
    }


def fit_report(job: dict, manifest: dict) -> dict:
    blockers = []
    names = {item["name"] for item in manifest["objects"]}
    armor = [item for item in manifest["objects"] if item["role"] == "removable-armor"]
    if job["job_type"] == "mech-armor" and not armor:
        blockers.append("no independently addressable armor objects")
    if job["job_type"] == "railgun":
        missing = sorted(set(ANCHORS) - names)
        if missing:
            blockers.append("missing railgun anchors: " + ", ".join(missing))
        if "animate" in {operation["kind"] for operation in job["operations"]} and not manifest["actions"]:
            blockers.append("railgun animation operation produced no action")
    if "bind-rig" in {operation["kind"] for operation in job["operations"]}:
        pivots = [obj for obj in bpy.context.scene.objects if obj.get("mechanical_pivot")]
        if not pivots and not any(item["type"] == "ARMATURE" for item in manifest["objects"]):
            blockers.append("rig binding has neither an armature nor mechanical pivots")
    if not any(item["type"] == "MESH" for item in manifest["objects"]):
        blockers.append("scene has no mesh geometry")
    mesh_objects = [item for item in manifest["objects"] if item["type"] == "MESH"]
    renderable_meshes = [item for item in mesh_objects if item["renderable"]]
    lane_counts = {lane: sum(item.get("source_lane") == lane for item in renderable_meshes)
                   for lane in ("a", "b", "c")}
    if job["job_type"] == "kit-assembly":
        missing_lanes = [lane for lane, count in lane_counts.items() if count == 0]
        if missing_lanes:
            blockers.append("assembly has no renderable geometry from worker lane(s): " + ", ".join(missing_lanes))
        mech_renderable = [item for item in renderable_meshes if item.get("source_lane") != "c"]
        if len(mech_renderable) < 8:
            blockers.append(f"assembly mech coverage collapsed to {len(mech_renderable)} renderable meshes")
    return {
        "format": "myth-maker.asset-fit-report/v1", "run_id": job["run_id"],
        "work_id": job["work_id"], "blocking": blockers,
        "checks": {"removable_armor_count": len(armor), "required_anchor_count": len(set(ANCHORS) & names),
                   "mesh_count": len(mesh_objects), "renderable_mesh_count": len(renderable_meshes),
                   "renderable_source_lane_counts": lane_counts},
    }


def main() -> int:
    args = parse_args()
    job = json.loads(Path(args.job).read_text(encoding="utf-8"))
    output = Path(args.output_root)
    output.mkdir(parents=True, exist_ok=True)
    kinds = {operation["kind"] for operation in job["operations"]}
    load_sources(source_files(Path(args.inputs)), "assemble" in kinds or job["job_type"] == "kit-assembly")
    if job["job_type"] == "kit-assembly":
        mount_railgun_to_mech()
    normalize_scene(job)
    isolate_worker_ownership(job["job_type"])
    if "apply-reference-corrections" in kinds:
        apply_reference_corrections(job["job_type"])
    if "apply-parameterized-correction" in kinds:
        apply_parameterized_correction(job["correction_spec"])
    if "apply-core-kit" in kinds:
        apply_core_kit()
    if job["job_type"] == "railgun" or "animate" in kinds:
        ensure_railgun_anchors()
    if "animate" in kinds:
        ensure_charge_animation()
    if "render-review" in kinds:
        render_views(output / "renders", job["review_views"], job)
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "asset.blend"), compress=False)
    bpy.ops.export_scene.gltf(filepath=str(output / "asset.glb"), export_format="GLB",
                              export_animations=True, export_apply=False)
    manifest = scene_manifest(job)
    (output / "core-kit-manifest.json").write_text(json.dumps(core_kit_manifest(), indent=2, sort_keys=True), encoding="utf-8")
    (output / "scene-manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    (output / "fit-report.json").write_text(json.dumps(fit_report(job, manifest), indent=2, sort_keys=True), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
