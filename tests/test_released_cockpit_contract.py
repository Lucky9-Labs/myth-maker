import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ReleasedCockpitContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = json.loads(
            (ROOT / "output/released-cockpit-v1/design-contract.json").read_text()
        )

    def test_scope_is_the_exact_canopy_replacement_only(self):
        self.assertEqual("cockpit_identity", self.contract["replacement_scope"]["slot"])
        self.assertEqual(
            ["tripo_part_61.001"],
            self.contract["replacement_scope"]["replaces_source_nodes"],
        )
        self.assertEqual(
            "tripo_part_61.001",
            self.contract["source"]["replace_node"],
        )

    def test_geometry_is_explicitly_concave_not_a_canopy(self):
        identity = self.contract["identity"]
        self.assertIn(
            "deep concave socket silhouette in side view",
            identity["required_features"],
        )
        self.assertIn("convex canopy or dome", identity["forbidden_features"])
        self.assertIn("helmet silhouette", identity["forbidden_features"])
        self.assertEqual(
            "thin broken cranial rim",
            identity["depth_order_front_to_back"][0],
        )
        self.assertEqual(
            "dark rear cavity",
            identity["depth_order_front_to_back"][-1],
        )

    def test_generation_is_one_multiview_candidate(self):
        self.assertEqual("Tripo Multiview", self.contract["multiview_input"]["mode"])
        self.assertEqual(
            {"front", "left", "right", "back"},
            set(self.contract["multiview_input"]["views"]),
        )
        self.assertEqual(
            "ca172c62-35b7-4740-a2fa-5147a00baae6",
            self.contract["tripo_candidate"]["asset_id"],
        )

    def test_claim_boundary_remains_honest(self):
        candidate = self.contract["tripo_candidate"]
        self.assertIsNone(candidate["local_export"])
        self.assertFalse(candidate["fit_tested"])
        self.assertFalse(candidate["runtime_tested"])
        self.assertIn(
            "fit and scale it against the exact source bounds",
            self.contract["production_gates"],
        )


if __name__ == "__main__":
    unittest.main()
