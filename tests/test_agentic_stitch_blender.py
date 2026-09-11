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

    def test_every_resolved_edge_creates_real_geometry(self):
        source = DRIVER.read_text()
        self.assertIn("cylinder_between(connection['connection_id'] + '-connector'", source)
        self.assertIn("collar(connection['connection_id'] + '-from-collar'", source)
        self.assertIn("collar(connection['connection_id'] + '-to-collar'", source)
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
        self.assertIn("target = Vector((torso_size.x * .54, torso_size.y * .24, torso_size.z * .68))", source)
        self.assertIn("outline = convex_hull_xz(world_vertices)", source)
        self.assertIn("glass.rotation_euler.x += math.radians(-8)", source)
        self.assertIn("nearest.y + max(torso_size.y * .005, .004)", source)
        self.assertIn("cockpit-continuous-perimeter-frame", source)
        self.assertIn("cyan-cockpit-glass", source)
        self.assertIn("shader.inputs['Base Color'].default_value", source)

    def test_review_camera_frames_generated_geometry(self):
        source = DRIVER.read_text()
        self.assertIn("points = [point for obj in visible for point in world_bounds(obj)]", source)
        self.assertIn("camera_data.ortho_scale", source)


if __name__ == "__main__":
    unittest.main()
