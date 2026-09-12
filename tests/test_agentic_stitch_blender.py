from pathlib import Path
import unittest


DRIVER = Path(__file__).parents[1] / "modal" / "agentic_stitch_blender.py"


class AgenticStitchBlenderTests(unittest.TestCase):
    def test_solves_the_connection_graph_before_rendering(self):
        source = DRIVER.read_text()
        solve = source.index("for _ in range(24)")
        connect = source.index("connections = []")
        render = source.index("def render(name, direction)")
        self.assertLess(solve, connect)
        self.assertLess(connect, render)
        self.assertIn("bounded_location(source", source)
        self.assertIn("bounded_location(target", source)

    def test_cockpit_specific_fit_is_not_detached_by_generic_solver(self):
        source = DRIVER.read_text()
        self.assertIn("connection['connection_id'] == 'cockpit-continuous-perimeter' and cockpit_frame is not None", source)
        fit = source.index("cockpit_frame = fit_cockpit_glass")
        skip = source.index("# The cockpit fitter has already registered")
        solve = source.index("bounded_location(source")
        self.assertLess(fit, skip)
        self.assertLess(skip, solve)

    def test_every_resolved_edge_creates_real_geometry(self):
        source = DRIVER.read_text()
        self.assertIn("project_path_to_surface(source, connection['from_path_local_m'])", source)
        self.assertIn("project_path_to_surface(target, connection['to_path_local_m'])", source)
        self.assertIn("bridge_paths(connection['connection_id'] + '-fitted-seat'", source)
        self.assertIn("surface_gap = max(source_contact_m, target_contact_m)", source)
        self.assertIn("'anchor_span_m': round(anchor_span, 6)", source)
        self.assertIn("raise RuntimeError('agentic stitch left unresolved connections:", source)

    def test_manifest_preserves_source_identity_and_proves_connectivity(self):
        source = DRIVER.read_text()
        self.assertIn("obj['source_sha256']", source)
        self.assertIn("'unresolved_connection_count': 0", source)
        self.assertIn("'all_required_connections_resolved'", source)
        self.assertIn("'topology_changed': bool(connections)", source)

    def test_preserves_component_materials_and_measures_acceptance(self):
        source = DRIVER.read_text()
        self.assertIn("if not obj.data.materials", source)
        self.assertIn("point_aabb_distance(start, source)", source)
        self.assertIn("mesh_is_manifold(connector)", source)
        self.assertIn("'single_connected_body': physically_connected", source)
        self.assertIn("'manifold_required_seams': required_seams_manifold", source)

    def test_has_bounded_cockpit_fit_primitive(self):
        source = DRIVER.read_text()
        self.assertIn("def fit_cockpit_glass", source)
        self.assertIn("target = Vector((torso_size.x * .43, torso_size.y * .19, torso_size.z * .60))", source)
        self.assertIn("desired_front = torso_low.y + torso_size.y * .23", source)
        self.assertIn("Keep the Hunyuan-authored canopy surface intact", source)
        self.assertIn("inner_point = center + radial * .985", source)
        self.assertIn("outer_point = center + radial * 1.10", source)
        self.assertNotIn("math.sin(math.pi * vertical)", source)
        self.assertNotIn("torso_tree.find", source)
        self.assertIn("def remove_small_mesh_islands", source)
        self.assertIn("glass['removed_internal_vertices']", source)
        self.assertIn("def cockpit_mating_boundaries", source)
        self.assertIn("convex_hull_xz(glass_vertices)", source)
        self.assertNotIn("front_slice =", source)
        self.assertIn("glass.rotation_euler.x += math.radians(-8)", source)
        self.assertIn("def cockpit_perimeter_band", source)
        self.assertIn("full-silhouette-boundary-seat-v4", source)
        self.assertIn("torso.data.materials[0]", source)
        self.assertIn("cockpit-continuous-perimeter-frame", source)
        self.assertIn("cyan-cockpit-glass", source)
        self.assertIn("shader.inputs['Base Color'].default_value", source)

    def test_reconstructs_melted_hip_parts_from_hunyuan_bounds(self):
        source = DRIVER.read_text()
        self.assertIn("def reconstruct_hip_hard_surfaces", source)
        self.assertIn("required = {'hip-outer-casing', 'hip-pivot-rotor'}", source)
        self.assertIn("vertices=vertices", source)
        self.assertIn("boolean.operation = 'DIFFERENCE'", source)
        self.assertIn("boolean.solver = 'EXACT'", source)
        self.assertIn("'postprocess'", source)
        self.assertIn("'hunyuan-bounds-hard-surface-v1'", source)
        self.assertIn("'postprocessed_objects'", source)
        self.assertIn("math.radians(22.5)", source)
        self.assertIn("hunyuan-seat-envelope-normalization-v1", source)
        self.assertIn("casing_apothem = .3", source)
        self.assertIn("casing_radius = casing_apothem / math.cos(math.pi / 8)", source)
        self.assertIn("bore_radius = .182", source)
        self.assertIn("rotor_radius = .18", source)
        self.assertIn(".205, .035, 256", source)
        self.assertIn(".150, .025, 256", source)
        self.assertIn(".105, .04, 256", source)
        self.assertIn(".102, .012, 256", source)
        self.assertIn("ring_boolean.operation = 'DIFFERENCE'", source)
        self.assertNotIn("hip-seat-clean-outboard-panel", source)
        self.assertNotIn("local-planar-seat-panel-v1", source)
        self.assertIn("target_size = Vector((.2, .2, .48))", source)
        self.assertIn("scale_matrix = Matrix.Diagonal((*seat.scale, 1.0))", source)
        self.assertIn("seat.data.transform(Matrix.Translation(-local_center))", source)
        self.assertIn("seat.location += world_offset", source)

    def test_socket_fit_keeps_articulation_clearance_empty(self):
        source = DRIVER.read_text()
        self.assertIn("def nonvisual_articulation", source)
        self.assertIn("connection['method'] == 'socket-fit'", source)
        self.assertIn("dimensions['clearance_m'] > 0", source)
        self.assertIn("nonvisual-articulation-clearance", source)

    def test_generated_cylinders_use_world_aligned_local_anchor_frame(self):
        source = DRIVER.read_text()
        self.assertIn("obj.data.transform(obj.rotation_euler.to_matrix().to_4x4())", source)
        self.assertIn("obj.rotation_euler = (0.0, 0.0, 0.0)", source)

    def test_review_camera_frames_generated_geometry(self):
        source = DRIVER.read_text()
        self.assertIn("points = [point for obj in visible for point in world_bounds(obj)]", source)
        self.assertIn("camera_data.ortho_scale", source)


if __name__ == "__main__":
    unittest.main()
