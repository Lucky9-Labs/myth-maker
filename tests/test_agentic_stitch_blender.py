from pathlib import Path
import unittest


DRIVER = Path(__file__).parents[1] / "modal" / "agentic_stitch_blender.py"


class AgenticStitchBlenderTests(unittest.TestCase):
    def test_solves_the_connection_graph_before_rendering(self):
        source = DRIVER.read_text()
        solve = source.index("for _ in range(24)")
        connect = source.index("connections = []")
        render = source.index("def render(name, location)")
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


if __name__ == "__main__":
    unittest.main()
