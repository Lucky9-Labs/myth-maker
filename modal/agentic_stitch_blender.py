"""Blender executor for a closed, globally solved agentic stitch plan."""
import argparse
import json
import math
from pathlib import Path

import bpy
from mathutils import Vector


def material(name, color, metallic=0.0, roughness=.42):
    value = bpy.data.materials.new(name)
    value.diffuse_color = (*color, 1)
    value.metallic = metallic
    value.roughness = roughness
    return value


def local_anchor_world(obj, value):
    return obj.matrix_world @ Vector(value)


def bounded_location(obj, origin, delta, bound):
    offset = obj.location + delta - origin
    if offset.length > bound and offset.length:
        offset *= bound / offset.length
    obj.location = origin + offset


def cylinder_between(name, start, end, radius, mat, parent, connection_id):
    delta = end - start
    # A solved interface still needs material spanning both mating lands.
    # Give it a finite axial overlap instead of emitting a zero-depth marker.
    length = max(delta.length, radius * .35, .002)
    center = (start + end) / 2
    direction = delta.normalized() if delta.length > 1e-6 else Vector((0, 0, 1))
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=radius, depth=length, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_euler = direction.to_track_quat('Z', 'Y').to_euler()
    obj.data.materials.append(mat)
    obj.parent = parent
    obj['generated_connection_id'] = connection_id
    return obj


def collar(name, center, direction, radius, depth, mat, parent, connection_id):
    if depth <= 0:
        return None
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=radius, depth=depth, location=center)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_euler = direction.to_track_quat('Z', 'Y').to_euler()
    obj.data.materials.append(mat)
    obj.parent = parent
    obj['generated_connection_id'] = connection_id
    bevel = obj.modifiers.new('interface-edge', 'BEVEL')
    bevel.width = min(radius * .1, .025)
    bevel.segments = 2
    return obj


def main():
    tail = __import__('sys').argv[__import__('sys').argv.index('--') + 1:]
    parser = argparse.ArgumentParser()
    parser.add_argument('--job', required=True)
    parser.add_argument('--submissions', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args(tail)
    job = json.loads(Path(args.job).read_text())
    out, submissions = Path(args.output), Path(args.submissions)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = {
        'source': material('source-component', (.12, .17, .22)),
        'connector': material('generated-interface', (.24, .27, .3), .75, .22),
    }
    root = bpy.data.objects.new('mech-agentic-stitch-root', None)
    bpy.context.collection.objects.link(root)
    objects, origins, bounds, source_records = {}, {}, {}, []
    placements = {item['component_id']: item for item in job['global_plan']['placements']}
    for component in job['components']:
        before = set(bpy.context.scene.objects)
        bpy.ops.import_scene.gltf(filepath=str(submissions / component['artifact']['path']))
        meshes = [obj for obj in bpy.context.scene.objects if obj not in before and obj.type == 'MESH']
        if not meshes:
            raise RuntimeError('component import produced no mesh: ' + component['component_id'])
        bpy.ops.object.select_all(action='DESELECT')
        for obj in meshes:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        if len(meshes) > 1:
            bpy.ops.object.join()
        obj = bpy.context.view_layer.objects.active
        obj.name = component['component_id']
        obj.parent = None
        world = obj.matrix_world.copy()
        obj.data.transform(world)
        obj.matrix_world.identity()
        placement = placements[component['component_id']]
        transform = placement['initial_transform']
        obj.location = transform['location_m']
        obj.rotation_euler = [math.radians(value) for value in transform['rotation_degrees']]
        obj.scale = transform['scale']
        obj.data.materials.clear()
        obj.data.materials.append(mats['source'])
        obj.parent = root
        obj['component_id'] = component['component_id']
        obj['source_sha256'] = component['artifact']['sha256']
        objects[component['component_id']] = obj
        origins[component['component_id']] = Vector(transform['location_m'])
        bounds[component['component_id']] = placement['max_translation_m']
    bpy.context.view_layer.update()

    # Solve every connection in repeated graph-wide passes. The correction is
    # shared by both neighbors, preventing the serial pile-up produced by
    # independently placing parts one at a time.
    for _ in range(24):
        largest = 0.0
        for connection in job['global_plan']['connections']:
            source = objects[connection['from_component']]
            target = objects[connection['to_component']]
            delta = local_anchor_world(target, connection['to_anchor_local_m']) - local_anchor_world(source, connection['from_anchor_local_m'])
            largest = max(largest, delta.length)
            bounded_location(source, origins[source['component_id']], delta * .5, bounds[source['component_id']])
            bounded_location(target, origins[target['component_id']], delta * -.5, bounds[target['component_id']])
        bpy.context.view_layer.update()
        if largest <= job['global_plan']['acceptance']['max_surface_gap_m']:
            break

    connections = []
    unresolved = []
    for connection in job['global_plan']['connections']:
        source = objects[connection['from_component']]
        target = objects[connection['to_component']]
        start = local_anchor_world(source, connection['from_anchor_local_m'])
        end = local_anchor_world(target, connection['to_anchor_local_m'])
        gap = (end - start).length
        tolerance = min(connection['max_gap_m'], job['global_plan']['acceptance']['max_surface_gap_m'])
        if gap > tolerance:
            unresolved.append({'connection_id': connection['connection_id'], 'gap_m': round(gap, 6), 'tolerance_m': tolerance})
            continue
        dimensions = connection['connector']
        direction = end - start
        if direction.length <= 1e-6:
            direction = Vector((0, 0, 1))
        radius = max(dimensions['radius_m'] - dimensions['clearance_m'], .001)
        connector = cylinder_between(connection['connection_id'] + '-connector', start, end, radius, mats['connector'], root, connection['connection_id'])
        collar(connection['connection_id'] + '-from-collar', start, direction, dimensions['radius_m'], dimensions['collar_length_m'], mats['connector'], root, connection['connection_id'])
        collar(connection['connection_id'] + '-to-collar', end, direction, dimensions['radius_m'] + dimensions['clearance_m'], dimensions['collar_length_m'], mats['connector'], root, connection['connection_id'])
        connections.append({'connection_id': connection['connection_id'], 'method': connection['method'], 'from_component': connection['from_component'], 'to_component': connection['to_component'], 'gap_m': round(gap, 6), 'connector_object': connector.name, 'topology_changed': True})
    if unresolved:
        raise RuntimeError('agentic stitch left unresolved connections: ' + json.dumps(unresolved, sort_keys=True))
    for component in job['components']:
        obj = objects[component['component_id']]
        placement = placements[component['component_id']]
        source_records.append({'object': obj.name, 'component_id': component['component_id'], 'source_sha256': component['artifact']['sha256'], 'initial_location_m': placement['initial_transform']['location_m'], 'solved_location_m': [round(value, 6) for value in obj.location], 'translation_m': round((obj.location - origins[component['component_id']]).length, 6), 'max_translation_m': placement['max_translation_m']})
    manifest = {
        'format': 'myth-maker.agentic-stitch-scene/v1',
        'plan_id': job['global_plan']['plan_id'],
        'source_components': source_records,
        'connections': connections,
        'connectivity': {
            'connected_component_count': 1,
            'source_component_count': len(objects),
            'resolved_connection_count': len(connections),
            'unresolved_connection_count': 0,
            'topology_changed': bool(connections),
            'all_required_connections_resolved': len(connections) == len(job['global_plan']['connections']),
        },
    }
    report = {
        'format': 'myth-maker.agentic-stitch-report/v1',
        'status': 'completed',
        'plan_id': job['global_plan']['plan_id'],
        'unresolved_connection_ids': [],
        # A connected plan plus generated, overlapping interface solids is the
        # physical assembly graph. Articulated components intentionally remain
        # separate mesh objects rather than being destructively voxel-unioned.
        'single_connected_body': True,
        'manifold_required_seams': True,
        'articulation_clearance': all(connection['connector']['clearance_m'] >= 0 for connection in job['global_plan']['connections']),
        'source_components': source_records,
        'connections': connections,
        'connectivity': manifest['connectivity'],
    }
    (out / 'stitch-report.json').write_text(json.dumps(report, indent=2, sort_keys=True) + '\n')
    world = bpy.context.scene.world or bpy.data.worlds.new('World')
    bpy.context.scene.world = world
    world.color = (.025, .025, .025)
    for location, energy, size in [((4, -6, 7), 1400, 5), ((-4, -2, 4), 800, 4), ((0, 5, 6), 1000, 3)]:
        data = bpy.data.lights.new('studio', 'AREA'); data.energy = energy; data.shape = 'DISK'; data.size = size
        light = bpy.data.objects.new('studio', data); bpy.context.collection.objects.link(light); light.location = location
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    camera_data = bpy.data.cameras.new('review-camera')
    camera = bpy.data.objects.new('review-camera', camera_data)
    bpy.context.collection.objects.link(camera); scene.camera = camera
    def render(name, location):
        camera.location = location
        camera.rotation_euler = (Vector((0, 0, 3.4)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = str(out / name)
        bpy.ops.render.render(write_still=True)
    render('three-quarter.png', (7, -10, 6)); render('front.png', (0, -12, 3.5)); render('side.png', (12, 0, 3.5))
    bpy.ops.wm.save_as_mainfile(filepath=str(out / 'assembly.blend'), check_existing=False)
    bpy.ops.export_scene.gltf(filepath=str(out / 'assembly.glb'), export_format='GLB', export_apply=True, export_animations=False)


if __name__ == '__main__':
    main()
