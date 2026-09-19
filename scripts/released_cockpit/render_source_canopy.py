#!/usr/bin/env python3
"""Render the accepted Strokah canopy mesh alone from four review angles."""

from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "output/cockpit-mechanical/working/strokah-stable-gait-v10.blend"
OUT = ROOT / "output/released-cockpit-v1/working/source-canopy"
TARGET = "tripo_part_61.001"


def look_at(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
    canopy = bpy.data.objects[TARGET]
    for obj in bpy.context.scene.objects:
        obj.hide_render = obj != canopy

    material = bpy.data.materials.new("Canopy silhouette review")
    material.use_nodes = True
    bsdf = material.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (0.035, 0.085, 0.14, 1)
    bsdf.inputs["Metallic"].default_value = 0.62
    bsdf.inputs["Roughness"].default_value = 0.28
    canopy.data.materials.clear()
    canopy.data.materials.append(material)

    corners = [canopy.matrix_world @ Vector(corner) for corner in canopy.bound_box]
    minimum = Vector(tuple(min(point[axis] for point in corners) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in corners) for axis in range(3)))
    center = (minimum + maximum) / 2
    size = maximum - minimum

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.world.color = (0.025, 0.025, 0.028)
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = -0.35

    camera_data = bpy.data.cameras.new("CanopyReferenceCamera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = max(size.x, size.z) * 1.28
    camera = bpy.data.objects.new("CanopyReferenceCamera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    for name, location, energy, color in [
        ("Key", center + Vector((-0.45, -0.55, 0.45)), 420, (0.72, 0.88, 1.0)),
        ("Fill", center + Vector((0.45, -0.30, 0.18)), 230, (1.0, 0.52, 0.25)),
        ("Rim", center + Vector((0.0, 0.45, 0.30)), 330, (0.28, 0.55, 1.0)),
    ]:
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.color = color
        data.shape = "DISK"
        data.size = 0.35
        light = bpy.data.objects.new(name, data)
        light.location = location
        scene.collection.objects.link(light)
        look_at(light, center)

    views = {
        "front": center + Vector((0.0, -0.75, 0.0)),
        "left": center + Vector((-0.75, 0.0, 0.0)),
        "back": center + Vector((0.0, 0.75, 0.0)),
        "three-quarter": center + Vector((0.50, -0.55, 0.10)),
    }
    for name, location in views.items():
        camera.location = location
        look_at(camera, center)
        scene.render.filepath = str(OUT / f"source-canopy-{name}.png")
        bpy.ops.render.render(write_still=True)

    print(f"SOURCE_CANOPY_BOUNDS min={tuple(minimum)} max={tuple(maximum)} size={tuple(size)}")


if __name__ == "__main__":
    main()
