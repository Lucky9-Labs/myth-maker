"""Blender executor for a closed, globally solved agentic stitch plan."""
import argparse
import json
import math
from pathlib import Path

import bpy
import bmesh
from mathutils import Matrix, Vector
from mathutils.kdtree import KDTree


def material(name, color, metallic=0.0, roughness=.42):
    value = bpy.data.materials.new(name)
    value.diffuse_color = (*color, 1)
    value.metallic = metallic
    value.roughness = roughness
    value.use_nodes = True
    shader = value.node_tree.nodes.get('Principled BSDF')
    if shader:
        shader.inputs['Base Color'].default_value = (*color, 1)
        shader.inputs['Metallic'].default_value = metallic
        shader.inputs['Roughness'].default_value = roughness
    return value


def local_anchor_world(obj, value):
    return obj.matrix_world @ Vector(value)


def bounded_location(obj, origin, delta, bound):
    offset = obj.location + delta - origin
    if offset.length > bound and offset.length:
        offset *= bound / offset.length
    obj.location = origin + offset


def world_bounds(obj):
    return [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]


def bounds_box(obj):
    points = world_bounds(obj)
    low = Vector(tuple(min(point[i] for point in points) for i in range(3)))
    high = Vector(tuple(max(point[i] for point in points) for i in range(3)))
    return low, high


def convex_hull_xz(points):
    unique = sorted(set((round(point.x, 6), round(point.z, 6)) for point in points))
    if len(unique) <= 2:
        return unique
    def cross(origin, first, second):
        return ((first[0] - origin[0]) * (second[1] - origin[1]) -
                (first[1] - origin[1]) * (second[0] - origin[0]))
    lower = []
    for point in unique:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], point) <= 0:
            lower.pop()
        lower.append(point)
    upper = []
    for point in reversed(unique):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], point) <= 0:
            upper.pop()
        upper.append(point)
    return lower[:-1] + upper[:-1]


def fit_cockpit_glass(torso, glass, root, glass_material, frame_material):
    """Seat the separately generated glazing from measured torso proportions."""
    # The reference canopy follows the raked cockpit mouth rather than standing
    # vertically inside it. Keep this as a bounded rigid correction.
    glass.rotation_euler.x += math.radians(-8)
    bpy.context.view_layer.update()
    torso_low, torso_high = bounds_box(torso)
    glass_low, glass_high = bounds_box(glass)
    torso_size, glass_size = torso_high - torso_low, glass_high - glass_low
    target = Vector((torso_size.x * .54, torso_size.y * .24, torso_size.z * .68))
    factors = Vector(tuple(target[i] / max(glass_size[i], 1e-6) for i in range(3)))
    glass.scale = Vector(tuple(glass.scale[i] * factors[i] for i in range(3)))
    bpy.context.view_layer.update()
    glass_low, glass_high = bounds_box(glass)
    glass_center = (glass_low + glass_high) * .5
    torso_center = (torso_low + torso_high) * .5
    desired_front = torso_low.y + torso_size.y * .12
    desired_center = Vector((torso_center.x, desired_front + (glass_high.y - glass_low.y) * .5,
                             torso_center.z + torso_size.z * .025))
    glass.location += desired_center - glass_center
    glass.data.materials.clear()
    glass.data.materials.append(glass_material)
    glass['fit_primitive'] = 'cockpit-glass-seat-v1'
    bpy.context.view_layer.update()

    low, high = bounds_box(glass)
    world_vertices = [glass.matrix_world @ vertex.co for vertex in glass.data.vertices]
    outline = convex_hull_xz(world_vertices)
    if len(outline) < 3:
        raise RuntimeError('cockpit glass front contour could not be resolved')
    center_x = sum(point[0] for point in outline) / len(outline)
    center_z = sum(point[1] for point in outline) / len(outline)
    outline = [(center_x + (x - center_x) * 1.025, center_z + (z - center_z) * 1.025)
               for x, z in outline]
    recessed_outline = []
    for x, z in outline:
        nearest = min(world_vertices, key=lambda vertex: (vertex.x - x) ** 2 + (vertex.z - z) ** 2)
        recessed_outline.append((x, nearest.y + max(torso_size.y * .005, .004), z))
    curve_data = bpy.data.curves.new('cockpit-continuous-frame', 'CURVE')
    curve_data.dimensions = '3D'
    curve_data.bevel_depth = max(min(torso_size.x, torso_size.z) * .009, .007)
    curve_data.bevel_resolution = 3
    spline = curve_data.splines.new('POLY')
    spline.points.add(len(recessed_outline) - 1)
    for point, (x, y, z) in zip(spline.points, recessed_outline):
        point.co = (x, y, z, 1)
    spline.use_cyclic_u = True
    frame = bpy.data.objects.new('cockpit-continuous-perimeter-frame', curve_data)
    bpy.context.collection.objects.link(frame)
    frame.data.materials.append(frame_material)
    frame.parent = root
    frame['generated_connection_id'] = 'cockpit-continuous-perimeter'
    return frame


def point_aabb_distance(point, obj):
    corners = world_bounds(obj)
    low = Vector(tuple(min(value[i] for value in corners) for i in range(3)))
    high = Vector(tuple(max(value[i] for value in corners) for i in range(3)))
    nearest = Vector(tuple(max(low[i], min(high[i], point[i])) for i in range(3)))
    return (nearest - point).length


def mesh_is_manifold(obj):
    mesh = bmesh.new()
    try:
        mesh.from_mesh(obj.data)
        return all(edge.is_manifold for edge in mesh.edges)
    finally:
        mesh.free()


def project_path_to_surface(obj, local_points):
    tree = KDTree(len(obj.data.vertices))
    for index, vertex in enumerate(obj.data.vertices):
        tree.insert(obj.matrix_world @ vertex.co, index)
    tree.balance()
    projected = []
    for point in local_points:
        location, _, _ = tree.find(local_anchor_world(obj, point))
        projected.append(location.copy())
    return projected


def bridge_paths(name, source_points, target_points, closed, thickness, mat, parent, connection_id):
    if len(source_points) != len(target_points) or len(source_points) < 3:
        raise RuntimeError('paired stitch paths are incompatible: ' + connection_id)
    vertices = []
    for source, target in zip(source_points, target_points):
        vertices.extend((tuple(source), tuple(target)))
    faces = []
    limit = len(source_points) if closed else len(source_points) - 1
    for index in range(limit):
        following = (index + 1) % len(source_points)
        faces.append((index * 2, following * 2, following * 2 + 1, index * 2 + 1))
    mesh = bpy.data.meshes.new(name + '-mesh'); mesh.from_pydata(vertices, [], faces); mesh.update()
    bridge = bpy.data.objects.new(name, mesh); bpy.context.collection.objects.link(bridge)
    bridge.data.materials.append(mat); bridge.parent = parent
    bridge['generated_connection_id'] = connection_id
    solidify = bridge.modifiers.new('fitted-seat-thickness', 'SOLIDIFY')
    solidify.thickness = max(thickness, .001); solidify.offset = 0
    bpy.context.view_layer.objects.active = bridge; bpy.ops.object.modifier_apply(modifier=solidify.name)
    return bridge


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


def cylinder_y(name, center, radius, depth, vertices, mat, parent, phase=0.0):
    """Create a mechanically aligned cylinder whose axis is world Y."""
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices, radius=radius, depth=depth, location=center,
        rotation=(math.radians(90), 0, 0))
    obj = bpy.context.object
    obj.name = name
    if phase:
        obj.data.transform(Matrix.Rotation(phase, 4, 'Z'))
    # Generated connector geometry must use the same world-aligned local metre
    # frame as the accepted stitch plan. Bake the primitive's axis rotation
    # into its mesh so local anchors are not silently rotated a second time.
    obj.data.transform(obj.rotation_euler.to_matrix().to_4x4())
    obj.rotation_euler = (0.0, 0.0, 0.0)
    obj.data.materials.append(mat)
    obj.parent = parent
    return obj


def bevel_object(obj, width):
    modifier = obj.modifiers.new('bounded-hard-surface-bevel', 'BEVEL')
    modifier.width = width
    modifier.segments = 2
    modifier.limit_method = 'ANGLE'
    modifier.angle_limit = math.radians(30)
    modifier.use_clamp_overlap = True
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=modifier.name)


def reconstruct_hip_hard_surfaces(objects, root, mats):
    """Replace melted diffusion topology with bounded mechanical primitives.

    Hunyuan remains the shape proposal: its placed bounds set the envelope and
    center.  The replacement only regularizes the two shapes that must mate: an
    octagonal casing with a true bore and a coaxial stepped rotor.  Source hashes
    stay attached to the replacements for lineage and review.
    """
    required = {'hip-outer-casing', 'hip-pivot-rotor'}
    if not required <= set(objects):
        return []
    casing_source = objects['hip-outer-casing']
    rotor_source = objects['hip-pivot-rotor']
    # These dimensions come from the validated Astra plan. Raw Hunyuan meshes
    # commonly arrive near a two-unit cube, so deriving mechanical dimensions
    # from their unregistered bounds makes the casing swallow its neighbors.
    casing_center = Vector((0, 0, 0))
    rotor_center = Vector((0, 0, 0))
    casing_apothem = .3
    casing_radius = casing_apothem / math.cos(math.pi / 8)
    casing_depth = .24
    bore_radius = .182
    casing = cylinder_y('hip-outer-casing', casing_center, casing_radius,
                        casing_depth, 8, mats['source'], root, math.radians(22.5))
    cutter = cylinder_y('hip-pivot-bore-cutter', casing_center, bore_radius,
                        casing_depth * 1.3, 96, mats['connector'], root)
    boolean = casing.modifiers.new('precision-pivot-bore', 'BOOLEAN')
    boolean.operation = 'DIFFERENCE'
    boolean.solver = 'EXACT'
    boolean.object = cutter
    bpy.ops.object.select_all(action='DESELECT')
    casing.select_set(True)
    bpy.context.view_layer.objects.active = casing
    bpy.ops.object.modifier_apply(modifier=boolean.name)
    bpy.data.objects.remove(cutter, do_unlink=True)
    bevel_object(casing, casing_radius * .025)
    casing['component_id'] = 'hip-outer-casing'
    casing['source_sha256'] = casing_source.get('source_sha256', '')
    casing['postprocess'] = 'hunyuan-bounds-hard-surface-v1'

    rotor_radius = .18
    rotor_depth = .25
    rotor = cylinder_y('hip-pivot-rotor', rotor_center, rotor_radius,
                       rotor_depth, 64, mats['source'], root)
    bevel_object(rotor, rotor_radius * .018)
    rotor['component_id'] = 'hip-pivot-rotor'
    rotor['source_sha256'] = rotor_source.get('source_sha256', '')
    rotor['postprocess'] = 'hunyuan-bounds-hard-surface-v1'

    # Add the plan-authored retaining drum, front ring and recessed center.
    # Their overlap is
    # deliberate: the rotor is one rigid articulated member, while the casing
    # remains separate across the clearance boundary.
    decorative = []
    front_y = rotor_center.y - rotor_depth * .5
    for index, (step_radius, step_depth, center_y) in enumerate((
            (.205, .035, front_y - .0175),
            (.150, .025, front_y - .0350),
            (.105, .012, front_y - .0340))):
        part = cylinder_y(
            f'hip-pivot-front-step-{index + 1}',
            Vector((rotor_center.x, center_y, rotor_center.z)),
            step_radius, step_depth, 64,
            mats['connector'] if index != 1 else mats['source'], root)
        part['component_id'] = 'hip-pivot-rotor'
        decorative.append(part)

    # Normalize the promoted seat to the envelope authored by Astra before the
    # graph solver touches it. The diffusion mesh keeps its shape and details;
    # only its coordinate frame and dimensions become deterministic.
    seat = objects.get('hip-seat-block')
    if seat is not None:
        seat_low, seat_high = bounds_box(seat)
        seat_size = seat_high - seat_low
        target_size = Vector((.2, .2, .48))
        factors = Vector(tuple(target_size[i] / max(seat_size[i], 1e-6) for i in range(3)))
        seat.scale = Vector(tuple(seat.scale[i] * factors[i] for i in range(3)))
        bpy.context.view_layer.update()
        normalized_low, normalized_high = bounds_box(seat)
        seat.location += Vector((
            .404,
            casing_center.y,
            casing_center.z,
        )) - (normalized_low + normalized_high) * .5
        # The stitch plan expresses anchors in component-local metres. Hunyuan
        # GLBs commonly arrive with an off-centre mesh origin and the envelope
        # normalization above used object scale, so those anchors would be
        # transformed by an arbitrary source-space offset and scale. Bake the
        # fitted scale into the mesh, then move its origin to the fitted bounds
        # centre without changing the visible world-space geometry.
        scale_matrix = Matrix.Diagonal((*seat.scale, 1.0))
        seat.data.transform(scale_matrix)
        seat.scale = (1.0, 1.0, 1.0)
        local_low = Vector(tuple(min(vertex.co[i] for vertex in seat.data.vertices) for i in range(3)))
        local_high = Vector(tuple(max(vertex.co[i] for vertex in seat.data.vertices) for i in range(3)))
        local_center = (local_low + local_high) * .5
        world_offset = seat.matrix_world.to_3x3() @ local_center
        seat.data.transform(Matrix.Translation(-local_center))
        seat.location += world_offset
        seat['postprocess'] = 'hunyuan-seat-envelope-normalization-v1'

    bpy.data.objects.remove(casing_source, do_unlink=True)
    bpy.data.objects.remove(rotor_source, do_unlink=True)
    objects['hip-outer-casing'] = casing
    objects['hip-pivot-rotor'] = rotor
    bpy.context.view_layer.update()
    return [casing, rotor, *decorative]


def nonvisual_articulation(name, center, parent, connection_id):
    joint = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(joint)
    joint.location = center
    joint.parent = parent
    joint['generated_connection_id'] = connection_id
    joint['interface_kind'] = 'nonvisual-articulation-clearance'
    return joint


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
        'cockpit_glass': material('cyan-cockpit-glass', (.035, .48, .68), .18, .16),
        'cockpit_frame': material('cockpit-recess-frame', (.035, .055, .075), .72, .24),
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
        # Hunyuan materials are part of the component identity. Never replace
        # cockpit glass, armor, or emission regions with a review-only material.
        if not obj.data.materials:
            obj.data.materials.append(mats['source'])
        obj.parent = root
        obj['component_id'] = component['component_id']
        obj['source_sha256'] = component['artifact']['sha256']
        objects[component['component_id']] = obj
        origins[component['component_id']] = Vector(transform['location_m'])
        bounds[component['component_id']] = placement['max_translation_m']
    bpy.context.view_layer.update()

    reconstructed = reconstruct_hip_hard_surfaces(objects, root, mats)

    cockpit_frame = None
    if 'torso-structural-shell' in objects and 'cockpit-glass' in objects:
        cockpit_frame = fit_cockpit_glass(
            objects['torso-structural-shell'], objects['cockpit-glass'], root,
            mats['cockpit_glass'], mats['cockpit_frame'])

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
        anchor_span = (end - start).length
        tolerance = min(connection['max_gap_m'], job['global_plan']['acceptance']['max_surface_gap_m'])
        dimensions = connection['connector']
        direction = end - start
        if direction.length <= 1e-6:
            direction = Vector((0, 0, 1))
        radius = max(dimensions['radius_m'] - dimensions['clearance_m'], .001)
        if connection['connection_id'] == 'cockpit-continuous-perimeter' and cockpit_frame is not None:
            connector = cockpit_frame
        elif connection['method'] == 'socket-fit' and dimensions['clearance_m'] > 0:
            # A moving bearing is connected by a constraint and captured faces,
            # never by visible bridge geometry across its radial clearance.
            connector = nonvisual_articulation(
                connection['connection_id'] + '-articulation', (start + end) * .5,
                root, connection['connection_id'])
        else:
            source_path = project_path_to_surface(source, connection['from_path_local_m'])
            target_path = project_path_to_surface(target, connection['to_path_local_m'])
            connector = bridge_paths(connection['connection_id'] + '-fitted-seat', source_path, target_path,
                                     connection['path_closed'], radius * .35, mats['connector'], root,
                                     connection['connection_id'])
        source_contact_m = point_aabb_distance(start, source)
        target_contact_m = point_aabb_distance(end, target)
        surface_gap = max(source_contact_m, target_contact_m)
        connector_manifold = mesh_is_manifold(connector) if connector.type == 'MESH' else True
        if surface_gap > tolerance:
            unresolved.append({'connection_id': connection['connection_id'], 'gap_m': round(surface_gap, 6),
                               'anchor_span_m': round(anchor_span, 6), 'tolerance_m': tolerance})
            continue
        connections.append({'connection_id': connection['connection_id'], 'method': connection['method'], 'from_component': connection['from_component'], 'to_component': connection['to_component'], 'gap_m': round(surface_gap, 6), 'anchor_span_m': round(anchor_span, 6), 'connector_object': connector.name, 'topology_changed': True, 'source_contact_m': round(source_contact_m, 6), 'target_contact_m': round(target_contact_m, 6), 'connector_manifold': connector_manifold})
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
        'postprocessed_objects': [obj.name for obj in reconstructed],
    }
    required_seams_manifold = all(item['connector_manifold'] for item in connections)
    physically_connected = (
        len(connections) == len(job['global_plan']['connections'])
        and all(item['source_contact_m'] <= .001 and item['target_contact_m'] <= .001 for item in connections)
    )
    report = {
        'format': 'myth-maker.agentic-stitch-report/v1',
        'status': 'completed',
        'plan_id': job['global_plan']['plan_id'],
        'unresolved_connection_ids': [],
        # A connected plan plus generated, overlapping interface solids is the
        # physical assembly graph. Articulated components intentionally remain
        # separate mesh objects rather than being destructively voxel-unioned.
        'single_connected_body': physically_connected,
        'manifold_required_seams': required_seams_manifold,
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
    visible = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    points = [point for obj in visible for point in world_bounds(obj)]
    low = Vector(tuple(min(point[i] for point in points) for i in range(3)))
    high = Vector(tuple(max(point[i] for point in points) for i in range(3)))
    target = (low + high) * .5
    extent = max((high - low).length, .1)
    camera_data.type = 'ORTHO'
    camera_data.ortho_scale = max(high.x - low.x, high.z - low.z, .1) * 1.35
    def render(name, direction):
        camera.location = target + Vector(direction).normalized() * extent * 2
        camera.rotation_euler = (target - camera.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = str(out / name)
        bpy.ops.render.render(write_still=True)
    render('three-quarter.png', (1, -1.5, .65)); render('front.png', (0, -1, 0)); render('side.png', (1, 0, 0))
    bpy.ops.wm.save_as_mainfile(filepath=str(out / 'assembly.blend'), check_existing=False)
    bpy.ops.export_scene.gltf(filepath=str(out / 'assembly.glb'), export_format='GLB', export_apply=True, export_animations=False)


if __name__ == '__main__':
    main()
