from __future__ import annotations
from pathlib import Path
import sys, unittest
sys.path.insert(0, str(Path(__file__).parents[1] / "modal"))
from component_isolation import FORMAT, MODEL, validate_component_isolation_job

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

if __name__ == "__main__": unittest.main()
