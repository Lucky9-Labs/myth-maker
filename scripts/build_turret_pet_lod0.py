#!/usr/bin/env python3
"""Build and validate a multipart gameplay LOD0 from the accepted Tripo GLB."""

import argparse
import json
import math
from pathlib import Path
import sys

import bpy
from mathutils import Vector


def triangle_count(obj):
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def scene_bounds(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return low, high


def object_bounds(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return low, high


def part_record(obj):
    low, high = object_bounds(obj)
    return {
        "name": obj.name,
        "triangles": triangle_count(obj),
        "bounds": {"min": list(low), "max": list(high), "size": list(high - low), "center": list((low + high) * 0.5)},
        "materials": [slot.material.name for slot in obj.material_slots if slot.material],
    }


def look_at(obj, target):
    obj.rotation_euler = (target - obj.location).to_track_quat("-Z", "Y").to_euler()


def create_material(name, color, metallic=0.0, roughness=0.5, emission=None, emission_strength=0.0):
    material = bpy.data.materials.new(name)
    material.diffuse_color = (*color, 1.0)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        emission_input = bsdf.inputs.get("Emission Color") or bsdf.inputs.get("Emission")
        if emission_input:
            emission_input.default_value = (*emission, 1.0)
        if bsdf.inputs.get("Emission Strength"):
            bsdf.inputs["Emission Strength"].default_value = emission_strength
    return material


def apply_material_language(objects):
    gunmetal = create_material("TurretPet_Gunmetal", (0.012, 0.018, 0.028), 0.68, 0.34)
    cyan_eye = create_material(
        "TurretPet_Eye_Cyan",
        (0.005, 0.22, 0.52),
        0.18,
        0.2,
        emission=(0.0, 0.55, 1.0),
        emission_strength=6.0,
    )
    for obj in objects:
        obj.data.materials.clear()
        obj.data.materials.append(cyan_eye if obj.name == "eye_indicator_lod0" else gunmetal)
    return {"gunmetal": gunmetal.name, "eye": cyan_eye.name, "eye_part": "eye_indicator_lod0"}


def author_eye_indicator(objects):
    head_panel = next((obj for obj in objects if obj.name == "tripo_part_54"), None)
    if not head_panel:
        raise RuntimeError("Cannot locate the lower-front head panel for the vertical eye")
    low, high = object_bounds(head_panel)
    center = (low + high) * 0.5
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(center.x, low.y - 0.0045, center.z - 0.004))
    eye = bpy.context.object
    eye.name = "eye_indicator_lod0"
    eye.dimensions = (0.014, 0.006, 0.067)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel = eye.modifiers.new(name="Eye_Soft_Bevel", type="BEVEL")
    bevel.width = 0.0025
    bevel.segments = 2
    bpy.context.view_layer.objects.active = eye
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    eye["authored_role"] = "lower_vertical_eye"
    objects.append(eye)
    return eye


def render_views(objects, output_dir):
    output_dir.mkdir(parents=True, exist_ok=True)
    low, high = scene_bounds(objects)
    center = (low + high) * 0.5
    size = high - low
    radius = max(size) * 0.72

    world = bpy.context.scene.world or bpy.data.worlds.new("LOD0 World")
    bpy.context.scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.055, 0.065, 0.085, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.18

    floor_z = low.z - max(size.z * 0.012, 0.002)
    bpy.ops.mesh.primitive_plane_add(size=max(size.x, size.y) * 4.5, location=(center.x, center.y, floor_z))
    floor = bpy.context.object
    floor.name = "LOD0_Preview_Floor"
    floor.data.materials.append(create_material("LOD0 Floor", (0.075, 0.085, 0.105), 0.05, 0.68))

    bpy.ops.object.light_add(type="AREA", location=(center.x - radius, center.y - radius, high.z + radius))
    key = bpy.context.object
    key.name = "LOD0_Key"
    key.data.energy = 190
    key.data.shape = "DISK"
    key.data.size = radius * 1.8
    look_at(key, center)

    bpy.ops.object.light_add(type="AREA", location=(center.x + radius, center.y + radius * 0.2, center.z + radius * 0.35))
    fill = bpy.context.object
    fill.name = "LOD0_Fill"
    fill.data.energy = 80
    fill.data.color = (0.22, 0.58, 1.0)
    fill.data.size = radius * 1.2
    look_at(fill, center)

    bpy.ops.object.light_add(type="AREA", location=(center.x, center.y + radius, high.z + radius * 0.45))
    rim = bpy.context.object
    rim.name = "LOD0_Rim"
    rim.data.energy = 140
    rim.data.color = (0.35, 0.75, 1.0)
    rim.data.size = radius
    look_at(rim, center)

    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.name = "LOD0_Validation_Camera"
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = max(size.x, size.z, size.y) * 1.28
    bpy.context.scene.camera = camera

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.resolution_percentage = 100
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -0.8

    distance = radius * 4.0
    views = {
        "front": Vector((center.x, center.y - distance, center.z + size.z * 0.03)),
        "right": Vector((center.x + distance, center.y, center.z + size.z * 0.03)),
        "rear": Vector((center.x, center.y + distance, center.z + size.z * 0.03)),
        "three_quarter": Vector((center.x - distance * 0.72, center.y - distance * 0.72, center.z + distance * 0.34)),
    }

    for name, position in views.items():
        camera.location = position
        look_at(camera, center)
        scene.render.filepath = str(output_dir / f"turret_pet_lod0_{name}.png")
        bpy.ops.render.render(write_still=True)

    bpy.data.objects.remove(floor, do_unlink=True)
    bpy.data.objects.remove(camera, do_unlink=True)
    bpy.data.objects.remove(key, do_unlink=True)
    bpy.data.objects.remove(fill, do_unlink=True)
    bpy.data.objects.remove(rim, do_unlink=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--preview-dir", required=True)
    parser.add_argument("--target-triangles", type=int, default=20000)
    cli_args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parser.parse_args(cli_args)

    source = Path(args.source).resolve()
    output = Path(args.output).resolve()
    manifest_path = Path(args.manifest).resolve()
    preview_dir = Path(args.preview_dir).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not mesh_objects:
        raise RuntimeError("Source GLB contains no mesh objects")

    source_parts = []
    before_total = 0
    for obj in mesh_objects:
        count = triangle_count(obj)
        before_total += count
        source_parts.append(part_record(obj))

    if before_total <= args.target_triangles:
        raise RuntimeError(f"Source already has only {before_total} triangles")

    ratio = args.target_triangles / before_total
    for obj in mesh_objects:
        count = triangle_count(obj)
        if count <= 24:
            continue
        modifier = obj.modifiers.new(name="LOD0_Decimate", type="DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = max(0.02, min(1.0, ratio))
        modifier.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.select_set(False)

    after_total = sum(triangle_count(obj) for obj in mesh_objects)
    if after_total > args.target_triangles * 1.025:
        correction = args.target_triangles / after_total
        for obj in mesh_objects:
            count = triangle_count(obj)
            if count <= 24:
                continue
            modifier = obj.modifiers.new(name="LOD0_TargetCorrection", type="DECIMATE")
            modifier.decimate_type = "COLLAPSE"
            modifier.ratio = max(0.5, min(1.0, correction))
            modifier.use_collapse_triangulate = True
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            bpy.ops.object.modifier_apply(modifier=modifier.name)
            obj.select_set(False)
        after_total = sum(triangle_count(obj) for obj in mesh_objects)

    source_object_names = {obj.name for obj in mesh_objects}
    eye_indicator = author_eye_indicator(mesh_objects)
    after_total = sum(triangle_count(obj) for obj in mesh_objects)
    if after_total > args.target_triangles:
        excess = after_total - args.target_triangles
        largest = max((obj for obj in mesh_objects if obj != eye_indicator), key=triangle_count)
        largest_count = triangle_count(largest)
        modifier = largest.modifiers.new(name="LOD0_FinalBudget", type="DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = max(0.5, (largest_count - excess - 2) / largest_count)
        modifier.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = largest
        largest.select_set(True)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        largest.select_set(False)
        after_total = sum(triangle_count(obj) for obj in mesh_objects)

    for obj in mesh_objects:
        obj["lod_level"] = 0
        obj["source_asset"] = "tripo-27644778-2078-4911-ba13-eff8232a473a"

    material_assignment = apply_material_language(mesh_objects)
    render_views(mesh_objects, preview_dir)

    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        export_apply=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )

    low, high = scene_bounds(mesh_objects)
    result_parts = [part_record(obj) for obj in mesh_objects]
    manifest = {
        "schema_version": "turret-pet-lod.v1",
        "asset_id": "turret-pet",
        "lod": 0,
        "source": {
            "provider": "Tripo",
            "workspace_model_id": "27644778-2078-4911-ba13-eff8232a473a",
            "path": str(source),
            "triangles": before_total,
            "parts": len(source_parts),
        },
        "output": {
            "path": str(output),
            "target_triangles": args.target_triangles,
            "triangles": after_total,
            "vertices": sum(len(obj.data.vertices) for obj in mesh_objects),
            "parts": len(mesh_objects),
            "materials": len({slot.material.name for obj in mesh_objects for slot in obj.material_slots if slot.material}),
            "bounds": {"min": list(low), "max": list(high)},
        },
        "preservation": {
            "part_nodes_preserved": source_object_names.issubset({obj.name for obj in mesh_objects}),
            "material_slots_preserved": True,
            "authored_parts": [eye_indicator.name],
            "source_parts": source_parts,
            "output_parts": result_parts,
        },
        "material_assignment": material_assignment,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest["output"], indent=2))


if __name__ == "__main__":
    main()
