from __future__ import annotations
from pathlib import Path
import sys, unittest
sys.path.insert(0, str(Path(__file__).parents[1] / "modal"))
from component_isolation import FORMAT, MODEL, _view_instruction, validate_component_isolation_job

def job():
    return {"format": FORMAT, "run_id": "pilot-001", "work_id": "canopy-isolation-v1",
            "attempt": 1, "asset_id": "mech", "component_id": "canopy-glass", "model": MODEL,
            "reference_polygon": [[.2,.1],[.8,.1],[.7,.9],[.3,.9]],
            "component_description": "A continuous tapered cockpit glass enclosure",
            "material": "transparent cyan glass", "symmetry": "bilateral",
            "attachment_surfaces": ["cockpit-frame", "lower-bezel"], "quality": "medium"}

class ComponentIsolationTests(unittest.TestCase):
    def test_closed_contract(self): self.assertEqual(validate_component_isolation_job(job()), job())
    def test_rejects_unbounded_quality(self):
        value = {**job(), "quality": "max"}
        with self.assertRaisesRegex(ValueError, "low or medium"): validate_component_isolation_job(value)
    def test_accepts_hash_verified_hierarchical_source(self):
        value={**job(),"source_artifact":{"path":"asset-production/pilot/torso.png","bytes":42,"sha256":"a"*64,"media_type":"image/png"}}
        self.assertEqual(validate_component_isolation_job(value),value)

    def test_accepts_orthographic_multiview_mode(self):
        value = {**job(), "view_mode": "orthographic-multiview"}
        self.assertEqual(validate_component_isolation_job(value), value)

    def test_rejects_unknown_view_mode(self):
        with self.assertRaisesRegex(ValueError, "view mode"):
            validate_component_isolation_job({**job(), "view_mode": "turntable-video"})

    def test_multiview_prompt_forbids_cross_view_topology_drift(self):
        instruction = _view_instruction(True)
        self.assertIn("Topology must agree across all four views", instruction)
        self.assertIn("closed hub must remain solid", instruction)
        self.assertIn("Never turn a dark inset, lens, bearing face, or shadow into an opening", instruction)

if __name__ == "__main__": unittest.main()
