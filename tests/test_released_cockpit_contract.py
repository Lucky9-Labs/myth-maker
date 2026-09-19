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

    def test_local_tripo_export_is_hash_pinned_and_keeps_the_eye_separate(self):
        candidate = self.contract["tripo_candidate"]
        self.assertEqual(
            "622769b9eb37b95980a6467faeac6a26d9aaf68d401ad8f26c74146b2265f2c1",
            candidate["local_export"]["sha256"],
        )
        self.assertEqual(1, candidate["local_export"]["parts"])
        self.assertEqual("JPEG 4096x4096", candidate["local_export"]["embedded_texture"])
        self.assertTrue(candidate["fit_tested"])
        self.assertTrue(candidate["runtime_tested"])
        segmentation = self.contract["tripo_segmentation"]
        self.assertEqual(72, segmentation["local_export"]["parts"])
        self.assertIn("guide only", segmentation["use"])
        eye = self.contract["tripo_segmentation"]["eye"]
        self.assertEqual("tripo_part_11", eye["node"])
        self.assertEqual(34, eye["runtime_vertices"])
        self.assertEqual(29, eye["runtime_triangles"])
        self.assertIn("independent", eye["runtime_boundary"])

    def test_runtime_uses_the_new_rendering_pipeline_without_mutating_the_chassis(self):
        runtime = self.contract["unity_runtime"]
        self.assertEqual(
            {"tag": "Samsara", "canopy": "ReleasedStrokah"},
            runtime["race_default"],
        )
        self.assertEqual("MechGame/InkLit", runtime["shader"])
        self.assertIn("glTF V coordinates are inverted", runtime["material_policy"])
        self.assertIn("9.0 HDR", runtime["material_policy"])
        self.assertIn("camera-facing additive optical halo", runtime["material_policy"])
        report = runtime["runtime_report"]
        self.assertEqual(2, report["replacement_renderers"])
        self.assertEqual(2, report["ink_materials"])
        self.assertEqual(2, report["outlined_renderers"])
        self.assertEqual(1, report["shared_base_textures"])
        self.assertEqual(4096, report["base_texture_size"])
        self.assertEqual(0, report["other_chassis_renderers_changed"])
        self.assertEqual(1, report["eye_renderers"])
        self.assertEqual(9.0, report["eye_emission_peak"])
        self.assertEqual(0.0, report["shell_emission_peak"])
        self.assertEqual(18.0, report["eye_emission_blur_radius"])
        self.assertEqual(0.42, report["eye_emission_blur_intensity"])
        self.assertEqual(1, report["lens_halo_renderers"])
        self.assertGreater(report["eye_motion_degrees"], 5)
        self.assertEqual("SHOWME_VERIFIED", runtime["showme"]["status"])
        self.assertEqual("Samsara", runtime["showme"]["enemy_race"])
        self.assertEqual("ReleasedStrokah", runtime["showme"]["default_canopy"])

    def test_race_taxonomy_and_published_asset_are_release_pinned(self):
        self.assertEqual(
            {"Abyssal", "Samsara", "Entropic"},
            set(self.contract["race_taxonomy"]),
        )
        self.assertEqual("Samsara", self.contract["identity"]["faction"])
        self.assertEqual("runtime-released-asset-published", self.contract["status"])
        published = self.contract["published_asset"]
        self.assertEqual("samsara-released-strokah-canopy", published["asset_id"])
        self.assertEqual(1, published["revision"])
        self.assertTrue(published["head_object_verified"])
        self.assertTrue(published["fresh_hydration_verified"])
        self.assertEqual(
            "1245cb03690dae2bf4a6910a60894440eae5b32f5667d2b8843fff440252ea8d",
            published["sha256"],
        )
        self.assertNotIn("publish the hash-pinned", " ".join(self.contract["production_gates"]))
        self.assertIn("Final artist-approved retopology", self.contract["claim_boundary"])


if __name__ == "__main__":
    unittest.main()
