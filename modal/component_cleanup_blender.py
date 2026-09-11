"""Blender-side bounded cleanup for one isolated GLB."""
from __future__ import annotations
import argparse, json
from pathlib import Path
import bpy
import bmesh


def mesh_stats(obj):
    return {"vertices": len(obj.data.vertices), "edges": len(obj.data.edges), "polygons": len(obj.data.polygons),
            "dimensions": [round(float(v), 8) for v in obj.dimensions]}


def main():
    tail = __import__('sys').argv[__import__('sys').argv.index('--') + 1:]
    p = argparse.ArgumentParser(); p.add_argument('--input', required=True); p.add_argument('--output', required=True)
    p.add_argument('--component-id', required=True); p.add_argument('--merge-distance-ratio', type=float, required=True)
    p.add_argument('--decimate-ratio', type=float, required=True); a = p.parse_args(tail)
    out = Path(a.output); out.mkdir(parents=True, exist_ok=True)
    bpy.ops.import_scene.gltf(filepath=a.input)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    if not meshes: raise RuntimeError('component GLB contains no mesh')
    # Hunyuan GLBs can carry the reconstructed aspect ratio on an Empty parent
    # while the child mesh remains in a normalized 2x2x2 domain.  Bake the full
    # world matrix before selecting only meshes; otherwise cleanup/export drops
    # the parent and silently turns a valid component back into its source cube.
    for imported in meshes:
        world = imported.matrix_world.copy()
        imported.parent = None
        imported.matrix_world = world
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes: obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1: bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active; obj.name = a.component_id
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    before = mesh_stats(obj); longest = max(float(v) for v in obj.dimensions)
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    if a.merge_distance_ratio > 0:
        bpy.ops.mesh.remove_doubles(threshold=longest * a.merge_distance_ratio)
    bpy.ops.object.mode_set(mode='OBJECT')
    working = bmesh.new(); working.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(working, faces=working.faces); working.to_mesh(obj.data); working.free()
    if a.decimate_ratio < 1:
        modifier = obj.modifiers.new('bounded-component-decimate', 'DECIMATE'); modifier.ratio = a.decimate_ratio
        modifier.use_collapse_triangulate = True; bpy.ops.object.modifier_apply(modifier=modifier.name)
    # Blender 4+ exposes normals through mesh validation after edit operations.
    obj.data.validate(verbose=False); obj.data.update()
    after = mesh_stats(obj)
    bpy.ops.wm.save_as_mainfile(filepath=str(out / 'cleaned.blend'), check_existing=False)
    bpy.ops.object.select_all(action='DESELECT'); obj.select_set(True); bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=str(out / 'cleaned.glb'), export_format='GLB', use_selection=True,
                              export_apply=True, export_animations=False)
    (out / 'cleanup-stats.json').write_text(json.dumps({'before': before, 'after': after}, indent=2, sort_keys=True)+'\n')


if __name__ == '__main__': main()
