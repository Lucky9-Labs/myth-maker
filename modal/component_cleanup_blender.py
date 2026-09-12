"""Blender-side bounded cleanup for one isolated GLB."""
from __future__ import annotations
import argparse, json
from pathlib import Path
import bpy
import bmesh
from mathutils import Matrix


def mesh_stats(obj):
    return {"vertices": len(obj.data.vertices), "edges": len(obj.data.edges), "polygons": len(obj.data.polygons),
            "dimensions": [round(float(v), 8) for v in obj.dimensions]}


def main():
    tail = __import__('sys').argv[__import__('sys').argv.index('--') + 1:]
    p = argparse.ArgumentParser(); p.add_argument('--input', required=True); p.add_argument('--output', required=True)
    p.add_argument('--component-id', required=True); p.add_argument('--merge-distance-ratio', type=float, required=True)
    p.add_argument('--decimate-ratio', type=float, required=True)
    p.add_argument('--smooth-factor', type=float, required=True); p.add_argument('--smooth-iterations', type=int, required=True)
    p.add_argument('--max-smooth-displacement-ratio', type=float, required=True)
    p.add_argument('--lower-trim-ratio', type=float, required=True); p.add_argument('--seat-band-ratio', type=float, required=True)
    p.add_argument('--salvage-bounds')
    p.add_argument('--mechanical-patch')
    p.add_argument('--aperture-cutout')
    a = p.parse_args(tail)
    out = Path(a.output); out.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
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
        imported.data.transform(world)
        imported.matrix_world = Matrix.Identity(4)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in meshes: obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1: bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active; obj.name = a.component_id
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    before = mesh_stats(obj); longest = max(float(v) for v in obj.dimensions)
    salvage_removed_vertices = 0
    if a.salvage_bounds:
        bounds = json.loads(a.salvage_bounds)
        working = bmesh.new(); working.from_mesh(obj.data)
        mins = {axis: min(getattr(v.co, axis) for v in working.verts) for axis in 'xyz'}
        spans = {axis: max(getattr(v.co, axis) for v in working.verts) - mins[axis] for axis in 'xyz'}
        doomed = []
        for vert in working.verts:
            outside = False
            for axis in 'xyz':
                normalized = (getattr(vert.co, axis) - mins[axis]) / max(spans[axis], 1e-12)
                outside = outside or normalized < bounds[axis][0] or normalized > bounds[axis][1]
            if outside: doomed.append(vert)
        salvage_removed_vertices = len(doomed)
        if doomed: bmesh.ops.delete(working, geom=doomed, context='VERTS')
        if not working.verts or not working.faces: raise RuntimeError('salvage bounds removed the component')
        working.to_mesh(obj.data); working.free(); obj.data.update()
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    if a.merge_distance_ratio > 0:
        bpy.ops.mesh.remove_doubles(threshold=longest * a.merge_distance_ratio)
    bpy.ops.object.mode_set(mode='OBJECT')
    working = bmesh.new(); working.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(working, faces=working.faces); working.to_mesh(obj.data); working.free()
    seat_vertices = 0
    if a.smooth_iterations and a.smooth_factor:
        working = bmesh.new(); working.from_mesh(obj.data); working.verts.ensure_lookup_table()
        z_min = min(v.co.z for v in working.verts); cutoff = z_min + longest * a.lower_trim_ratio
        boundary = {v for edge in working.edges if not edge.is_manifold for v in edge.verts}
        selected = [v for v in working.verts if v.co.z > cutoff + longest * a.seat_band_ratio and v not in boundary]
        original = {v: v.co.copy() for v in selected}; limit = longest * a.max_smooth_displacement_ratio
        for _ in range(a.smooth_iterations):
            bmesh.ops.smooth_vert(working, verts=selected, factor=a.smooth_factor,
                                  use_axis_x=True, use_axis_y=True, use_axis_z=True)
        for vert, start in original.items():
            delta = vert.co - start
            if delta.length > limit and delta.length:
                vert.co = start + delta.normalized() * limit
        working.to_mesh(obj.data); working.free()
    if a.lower_trim_ratio:
        working = bmesh.new(); working.from_mesh(obj.data)
        z_min = min(v.co.z for v in working.verts); plane_z = z_min + longest * a.lower_trim_ratio
        result = bmesh.ops.bisect_plane(working, geom=list(working.verts)+list(working.edges)+list(working.faces),
                                       dist=max(longest * 1e-7, 1e-9), plane_co=(0, 0, plane_z),
                                       plane_no=(0, 0, 1), clear_inner=True, clear_outer=False)
        cut_edges = [g for g in result.get('geom_cut', []) if isinstance(g, bmesh.types.BMEdge)]
        if cut_edges:
            bmesh.ops.holes_fill(working, edges=cut_edges, sides=0)
        working.to_mesh(obj.data); working.free(); obj.data.update()
        group = obj.vertex_groups.get('canopy-frame-seat') or obj.vertex_groups.new(name='canopy-frame-seat')
        indices = [v.index for v in obj.data.vertices if abs(v.co.z-plane_z) <= longest * max(a.seat_band_ratio, 1e-6)]
        if indices: group.add(indices, 1.0, 'REPLACE')
        seat_vertices = len(indices)
    if a.decimate_ratio < 1:
        modifier = obj.modifiers.new('bounded-component-decimate', 'DECIMATE'); modifier.ratio = a.decimate_ratio
        modifier.use_collapse_triangulate = True; bpy.ops.object.modifier_apply(modifier=modifier.name)
    patch_objects = []
    aperture_vertices = 0
    aperture_name = None
    if a.aperture_cutout:
        aperture = json.loads(a.aperture_cutout)
        minimum = [min((obj.matrix_world @ v.co)[axis] for v in obj.data.vertices) for axis in range(3)]
        maximum = [max((obj.matrix_world @ v.co)[axis] for v in obj.data.vertices) for axis in range(3)]
        extent = [maximum[i] - minimum[i] for i in range(3)]
        center = [minimum[i] + extent[i] * aperture['center'][i] for i in range(3)]
        radii = [max(extent[i] * aperture['size'][i] / 2, longest * 1e-5) for i in range(3)]
        axis_index = 0 if aperture['axis'] == 'x' else 1
        radii[axis_index] = extent[axis_index] * 0.8
        bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, location=center)
        cutter = bpy.context.object; cutter.name = a.component_id + '-aperture-cutter'
        cutter.scale = radii; bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        bpy.context.view_layer.objects.active = obj
        boolean = obj.modifiers.new('bounded-aperture-cutout', 'BOOLEAN')
        boolean.operation = 'DIFFERENCE'; boolean.solver = 'EXACT'; boolean.object = cutter
        bpy.ops.object.modifier_apply(modifier=boolean.name)
        bpy.data.objects.remove(cutter, do_unlink=True)
        group = obj.vertex_groups.get(aperture['seat_name']) or obj.vertex_groups.new(name=aperture['seat_name'])
        tolerance = aperture['seat_band_ratio']
        indices = []
        for vertex in obj.data.vertices:
            world = obj.matrix_world @ vertex.co
            q = sum(((world[i] - center[i]) / radii[i]) ** 2 for i in range(3))
            if abs(q - 1.0) <= tolerance:
                indices.append(vertex.index)
        if indices: group.add(indices, 1.0, 'REPLACE')
        aperture_vertices = len(indices); aperture_name = aperture['seat_name']
    if a.mechanical_patch:
        patch = json.loads(a.mechanical_patch)
        minimum = [min((obj.matrix_world @ v.co)[axis] for v in obj.data.vertices) for axis in range(3)]
        maximum = [max((obj.matrix_world @ v.co)[axis] for v in obj.data.vertices) for axis in range(3)]
        extent = [maximum[i] - minimum[i] for i in range(3)]; center = [(minimum[i] + maximum[i]) / 2 for i in range(3)]
        axis_index = 0 if patch['hub_axis'] == 'x' else 1
        radial = min(extent[(axis_index + 1) % 2], extent[2]) * patch['hub_radius_ratio']
        depth = extent[axis_index] * patch['hub_depth_ratio']
        hub_location = center[:]
        hub_location[axis_index] = minimum[axis_index] + depth / 2 if patch['hub_side'] == 'negative' else maximum[axis_index] - depth / 2
        bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=radial, depth=depth, location=hub_location,
                                            rotation=(0, 1.57079632679, 0) if axis_index == 0 else (1.57079632679, 0, 0))
        hub = bpy.context.object; hub.name = a.component_id + '-closed-hub'; patch_objects.append(hub)
        seat_thickness = extent[2] * patch['seat_thickness_ratio']
        for label, z in (("upper-seat", maximum[2] + seat_thickness / 2), ("lower-seat", minimum[2] - seat_thickness / 2)):
            bpy.ops.mesh.primitive_cube_add(location=(center[0], center[1], z)); seat = bpy.context.object
            seat.name = a.component_id + '-' + label
            seat.dimensions = (extent[0] * patch['seat_width_ratio'], extent[1] * patch['seat_depth_ratio'], seat_thickness)
            bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
            if patch['bevel_ratio']:
                bevel = seat.modifiers.new('bounded-seat-bevel', 'BEVEL'); bevel.width = max(extent) * patch['bevel_ratio']; bevel.segments = 2
                bpy.context.view_layer.objects.active = seat; bpy.ops.object.modifier_apply(modifier=bevel.name)
            patch_objects.append(seat)
    # Blender 4+ exposes normals through mesh validation after edit operations.
    obj.data.validate(verbose=False); obj.data.update()
    after = mesh_stats(obj)
    bpy.ops.wm.save_as_mainfile(filepath=str(out / 'cleaned.blend'), check_existing=False)
    bpy.ops.object.select_all(action='DESELECT'); obj.select_set(True)
    for patch_obj in patch_objects: patch_obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=str(out / 'cleaned.glb'), export_format='GLB', use_selection=True,
                              export_apply=True, export_animations=False)
    (out / 'cleanup-stats.json').write_text(json.dumps({'before': before, 'after': after,
        'seat_vertex_group':'canopy-frame-seat' if seat_vertices else None,'seat_vertices':seat_vertices,
        'salvage_bounds':json.loads(a.salvage_bounds) if a.salvage_bounds else None,
        'salvage_removed_vertices':salvage_removed_vertices,
        'aperture_seat_vertex_group':aperture_name,'aperture_seat_vertices':aperture_vertices,
        'mechanical_patch_objects':[item.name for item in patch_objects]}, indent=2, sort_keys=True)+'\n')


if __name__ == '__main__': main()
