"""Render an immutable GLB component from fixed diagnostic viewpoints."""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path
import bpy
from mathutils import Vector

def material(name, color):
    value = bpy.data.materials.new(name); value.diffuse_color = (*color, 1.0); return value

def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    output = Path(args.output); output.mkdir(parents=True, exist_ok=False)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=args.input)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes: raise RuntimeError("component GLB contains no mesh")
    points = [o.matrix_world @ Vector(corner) for o in meshes for corner in o.bound_box]
    low = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    high = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    center = (low + high) / 2; extent = high - low; scale = 4.0 / max(extent)
    root = bpy.data.objects.new("component-review-root", None); bpy.context.scene.collection.objects.link(root)
    for obj in meshes:
        obj.parent = root
        if not obj.data.materials: obj.data.materials.append(material("review-clay", (0.22, 0.48, 0.62)))
    root.location = -center * scale; root.scale = (scale,) * 3
    world = bpy.context.scene.world or bpy.data.worlds.new("World"); bpy.context.scene.world = world
    world.color = (0.025, 0.025, 0.025)
    bpy.ops.object.light_add(type="AREA", location=(4, -5, 6)); bpy.context.object.data.energy=1000; bpy.context.object.data.shape="DISK"; bpy.context.object.data.size=5
    bpy.ops.object.light_add(type="AREA", location=(-4, 2, 3)); bpy.context.object.data.energy=650; bpy.context.object.data.size=4
    bpy.ops.object.camera_add(); camera=bpy.context.object; bpy.context.scene.camera=camera
    scene=bpy.context.scene; scene.render.engine="BLENDER_EEVEE_NEXT"; scene.render.resolution_x=640; scene.render.resolution_y=640; scene.render.resolution_percentage=100
    scene.render.image_settings.file_format="PNG"; scene.render.film_transparent=False
    def render(name, location):
        camera.location=location; direction=Vector((0,0,0))-camera.location; camera.rotation_euler=direction.to_track_quat('-Z','Y').to_euler()
        camera.data.type="ORTHO"; camera.data.ortho_scale=5.5; scene.render.filepath=str(output/f"{name}.png"); bpy.ops.render.render(write_still=True)
    render("three-quarter", (5,-7,4)); render("front", (0,-8,0.6)); render("side", (8,0,0.6))
    stats={"mesh_objects":len(meshes),"vertices":sum(len(o.data.vertices) for o in meshes),"edges":sum(len(o.data.edges) for o in meshes),
           "polygons":sum(len(o.data.polygons) for o in meshes),"bounds":[round(v,6) for v in extent],
           "loose_parts":len(meshes),"materials":len({m.name for o in meshes for m in o.data.materials if m})}
    (output/"stats.json").write_text(json.dumps(stats,indent=2,sort_keys=True)+"\n")
if __name__ == "__main__": main()
