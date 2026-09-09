"""Deterministic, generic Blender encounter-recipe construction.

This module is deliberately usable both by the Modal worker and by Blender's
``--python`` entrypoint.  It imports neither Modal nor OpenAI.  A recipe is a
small, closed description of a body, repeated curved appendages, materials,
and a camera.  The Kraken entry in the observed workflow is only one recipe
instance; no Kraken-specific geometry or API behaviour lives here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any, Mapping


ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
RECIPE_FORMAT = "myth-maker.deterministic-encounter-recipe/v1"
MATERIAL_NAMES = ("encounter-body", "encounter-appendage", "encounter-accent", "encounter-ground")
REQUIRED_RECIPE_FIELDS = {"format", "recipe_id", "body", "appendages", "materials", "camera"}


def canonical_json(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def recipe_digest(recipe: Mapping[str, Any]) -> str:
    return sha256(canonical_json(validate_recipe(recipe)))


def _number(value: Any, label: str, *, minimum: float, maximum: float) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise ValueError(f"{label} must be a number from {minimum} through {maximum}")
    return float(value)


def _vector(value: Any, label: str, *, minimum: float, maximum: float) -> list[float]:
    if not isinstance(value, list) or len(value) != 3:
        raise ValueError(f"{label} must be a three-number vector")
    return [_number(item, label, minimum=minimum, maximum=maximum) for item in value]


def _color(value: Any, label: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 4:
        raise ValueError(f"{label} must be an RGBA color")
    return [_number(item, label, minimum=0, maximum=1) for item in value]


def validate_recipe(value: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and return a JSON-safe closed v1 recipe.

    The intentionally narrow vocabulary gives CI a bounded, reproducible
    fallback without claiming gameplay semantics, rigging, or acceptance.
    """
    if not isinstance(value, Mapping) or set(value) != REQUIRED_RECIPE_FIELDS:
        raise ValueError("deterministic encounter recipe has an invalid shape")
    if value.get("format") != RECIPE_FORMAT:
        raise ValueError("deterministic encounter recipe must use the v1 format")
    if not isinstance(value["recipe_id"], str) or not ID.fullmatch(value["recipe_id"]):
        raise ValueError("recipe_id must be a stable v1 identifier")

    body = value["body"]
    if not isinstance(body, Mapping) or set(body) != {"scale", "height"}:
        raise ValueError("body must contain scale and height")
    checked_body = {
        "scale": _vector(body["scale"], "body.scale", minimum=0.2, maximum=20),
        "height": _number(body["height"], "body.height", minimum=0, maximum=20),
    }

    appendages = value["appendages"]
    if not isinstance(appendages, Mapping) or set(appendages) != {"count", "length", "radius", "curl", "elevation"}:
        raise ValueError("appendages must contain count, length, radius, curl, and elevation")
    count = appendages["count"]
    if not isinstance(count, int) or isinstance(count, bool) or not 2 <= count <= 16:
        raise ValueError("appendages.count must be an integer from 2 through 16")
    checked_appendages = {
        "count": count,
        "length": _number(appendages["length"], "appendages.length", minimum=0.5, maximum=30),
        "radius": _number(appendages["radius"], "appendages.radius", minimum=0.03, maximum=3),
        "curl": _number(appendages["curl"], "appendages.curl", minimum=-10, maximum=10),
        "elevation": _number(appendages["elevation"], "appendages.elevation", minimum=-10, maximum=10),
    }

    materials = value["materials"]
    if not isinstance(materials, Mapping) or set(materials) != {"body", "appendage", "accent", "ground"}:
        raise ValueError("materials must contain body, appendage, accent, and ground")
    checked_materials = {name: _color(materials[name], "materials." + name) for name in sorted(materials)}

    camera = value["camera"]
    if not isinstance(camera, Mapping) or set(camera) != {"location", "target", "resolution"}:
        raise ValueError("camera must contain location, target, and resolution")
    resolution = camera["resolution"]
    if not isinstance(resolution, list) or len(resolution) != 2:
        raise ValueError("camera.resolution must be a width and height")
    if (not all(isinstance(item, int) and not isinstance(item, bool) for item in resolution)
            or not all(128 <= item <= 2048 for item in resolution)):
        raise ValueError("camera.resolution values must be integers from 128 through 2048")
    return {
        "format": RECIPE_FORMAT,
        "recipe_id": value["recipe_id"],
        "body": checked_body,
        "appendages": checked_appendages,
        "materials": checked_materials,
        "camera": {
            "location": _vector(camera["location"], "camera.location", minimum=-100, maximum=100),
            "target": _vector(camera["target"], "camera.target", minimum=-100, maximum=100),
            "resolution": list(resolution),
        },
    }


def _look_at(obj: Any, target: list[float]) -> None:
    from mathutils import Vector
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def _material(bpy: Any, name: str, color: list[float], metallic: float = 0.0) -> Any:
    material = bpy.data.materials.new(name)
    material.diffuse_color = color
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = color
    principled.inputs["Roughness"].default_value = 0.38 if metallic else 0.58
    principled.inputs["Metallic"].default_value = metallic
    return material


def _render(bpy: Any, destination: Path) -> None:
    bpy.context.scene.render.filepath = str(destination)
    bpy.ops.render.render(write_still=True)


def build_recipe(recipe: Mapping[str, Any], output: Path, frames: Path, glb: Path) -> dict[str, Any]:
    """Build the generic recipe in Blender and render three real staged frames."""
    recipe = validate_recipe(recipe)
    import bpy
    import math

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.curves, bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)

    frames.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    glb.parent.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    # Blender 4 and 5 expose the current realtime engine as BLENDER_EEVEE.
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x, scene.render.resolution_y = recipe["camera"]["resolution"]
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.world.color = (0.008, 0.012, 0.03)

    body_mat = _material(bpy, MATERIAL_NAMES[0], recipe["materials"]["body"], metallic=0.18)
    appendage_mat = _material(bpy, MATERIAL_NAMES[1], recipe["materials"]["appendage"], metallic=0.05)
    accent_mat = _material(bpy, MATERIAL_NAMES[2], recipe["materials"]["accent"], metallic=0.25)
    ground_mat = _material(bpy, MATERIAL_NAMES[3], recipe["materials"]["ground"])

    bpy.ops.object.camera_add(location=recipe["camera"]["location"])
    camera = bpy.context.object
    camera.name = "encounter-camera"
    _look_at(camera, recipe["camera"]["target"])
    scene.camera = camera
    bpy.ops.object.light_add(type="AREA", location=(4, -6, 9))
    key = bpy.context.object
    key.name = "encounter-key-light"
    key.data.energy, key.data.shape, key.data.size = 1300, "DISK", 5
    _look_at(key, recipe["camera"]["target"])
    bpy.ops.object.light_add(type="AREA", location=(-6, 2, 5))
    fill = bpy.context.object
    fill.name = "encounter-fill-light"
    fill.data.energy, fill.data.color, fill.data.size = 900, (0.28, 0.45, 1.0), 4
    _look_at(fill, recipe["camera"]["target"])

    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, location=(0, 0, recipe["body"]["height"]))
    body = bpy.context.object
    body.name = "encounter-body"
    body.scale = recipe["body"]["scale"]
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    body.data.materials.append(body_mat)
    _render(bpy, frames / "000-initial.png")

    appendage = recipe["appendages"]
    for index in range(appendage["count"]):
        angle = (math.tau * index) / appendage["count"]
        radial = max(recipe["body"]["scale"][0], recipe["body"]["scale"][1]) * 0.72
        start = (math.cos(angle) * radial, math.sin(angle) * radial, appendage["elevation"])
        direction = (math.cos(angle), math.sin(angle), 0)
        tangent = (-math.sin(angle), math.cos(angle), 0)
        curve = bpy.data.curves.new(f"appendage-{index:02d}", type="CURVE")
        curve.dimensions, curve.resolution_u, curve.bevel_depth, curve.bevel_resolution = "3D", 16, appendage["radius"], 5
        spline = curve.splines.new("BEZIER")
        spline.bezier_points.add(3)
        for point_index, point in enumerate(spline.bezier_points):
            distance = appendage["length"] * point_index / 3
            curl = appendage["curl"] * (point_index / 3) ** 2
            point.co = (start[0] + direction[0] * distance + tangent[0] * curl,
                        start[1] + direction[1] * distance + tangent[1] * curl,
                        start[2] + 0.45 * point_index + 0.22 * point_index * point_index)
            point.handle_left_type = point.handle_right_type = "AUTO"
        curve.materials.append(appendage_mat)
        object_ = bpy.data.objects.new(f"encounter-appendage-{index:02d}", curve)
        bpy.context.collection.objects.link(object_)
    _render(bpy, frames / "010-appendages.png")

    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, -0.04))
    ground = bpy.context.object
    ground.name = "encounter-ground"
    ground.data.materials.append(ground_mat)
    for x in (-0.62, 0.62):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12,
                                             location=(x, -recipe["body"]["scale"][1] * 0.78,
                                                       recipe["body"]["height"] + 0.28))
        eye = bpy.context.object
        eye.name = "encounter-accent-eye-left" if x < 0 else "encounter-accent-eye-right"
        eye.scale = (0.24, 0.18, 0.24)
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        eye.data.materials.append(accent_mat)
    bpy.ops.wm.save_as_mainfile(filepath=str(output), check_existing=False)
    bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", export_apply=True,
                              export_materials="EXPORT", check_existing=False)
    _render(bpy, frames / "020-final.png")
    return {"recipe_id": recipe["recipe_id"], "stages": ["initial", "appendages", "final"]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build one deterministic generic encounter recipe in Blender.")
    parser.add_argument("--recipe", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--frames", required=True, type=Path)
    parser.add_argument("--glb", required=True, type=Path)
    arguments = list(sys.argv[1:] if argv is None else argv)
    # Blender retains its conventional ``--`` separator in ``sys.argv`` for a
    # script entrypoint; callers using this module directly need not include it.
    if "--" in arguments:
        arguments = arguments[arguments.index("--") + 1:]
    args = parser.parse_args(arguments)
    recipe = json.loads(args.recipe.read_text(encoding="utf-8"))
    result = build_recipe(recipe, args.output, args.frames, args.glb)
    print(json.dumps(result, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
