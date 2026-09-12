from __future__ import annotations
from pathlib import Path
import sys, unittest
sys.path.insert(0,str(Path(__file__).parents[1]/'modal'))
from component_cleanup import FORMAT, validate_component_cleanup_job

def artifact(): return {'path':'asset-production/pilot/candidate.glb','bytes':42,'sha256':'a'*64,'media_type':'model/gltf-binary'}
def job():
    return {'format':FORMAT,'run_id':'pilot-001','work_id':'canopy-cleanup-v1','attempt':1,'asset_id':'mech','component_id':'canopy',
            'candidate':artifact(),'source_review':{'work_id':'canopy-review-v1','candidate_sha256':'a'*64,'decision':'clean'},
            'merge_distance_ratio':0.00001,'decimate_ratio':0.12,
            'smooth_factor':0.15,'smooth_iterations':3,'max_smooth_displacement_ratio':0.002,
            'lower_trim_ratio':0.1,'seat_band_ratio':0.015}

class ComponentCleanupTests(unittest.TestCase):
    def test_closed_accepted_contract(self): self.assertEqual(validate_component_cleanup_job(job()),job())
    def test_rejects_regenerate_without_salvage_bounds(self):
        value=job(); value['source_review']['decision']='regenerate'
        with self.assertRaisesRegex(ValueError,'requires bounded salvage'): validate_component_cleanup_job(value)
    def test_accepts_regenerate_candidate_for_bounded_salvage(self):
        value=job(); value['source_review']['decision']='regenerate'; value['salvage_bounds']={'x':[0.2,0.8],'y':[0,1],'z':[0.05,0.95]}
        self.assertEqual(validate_component_cleanup_job(value),value)
    def test_accepts_regenerate_candidate_for_bounded_mechanical_patch(self):
        value=job(); value['source_review']['decision']='regenerate'
        value['mechanical_patch']={'type':'capped-hub-seats','hub_axis':'y','hub_side':'negative',
            'hub_radius_ratio':0.28,'hub_depth_ratio':0.12,'seat_width_ratio':0.55,
            'seat_depth_ratio':0.5,'seat_thickness_ratio':0.08,'bevel_ratio':0.015}
        self.assertEqual(validate_component_cleanup_job(value),value)
    def test_rejects_unbounded_mechanical_patch(self):
        value=job(); value['mechanical_patch']={'type':'capped-hub-seats','hub_axis':'z','hub_side':'negative',
            'hub_radius_ratio':0.8,'hub_depth_ratio':0.12,'seat_width_ratio':0.55,
            'seat_depth_ratio':0.5,'seat_thickness_ratio':0.08,'bevel_ratio':0.015}
        with self.assertRaisesRegex(ValueError,'mechanical patch'): validate_component_cleanup_job(value)
    def test_accepts_regenerate_candidate_for_bounded_aperture_cutout(self):
        value=job(); value['source_review']['decision']='regenerate'
        value['aperture_cutout']={'type':'ellipsoid-through-cut','axis':'y','center':[0.5,0.35,0.56],
            'size':[0.62,1.0,0.72],'seat_name':'cockpit-glass-seat','seat_band_ratio':0.015}
        self.assertEqual(validate_component_cleanup_job(value),value)
    def test_rejects_unbounded_aperture_cutout(self):
        value=job(); value['aperture_cutout']={'type':'ellipsoid-through-cut','axis':'z','center':[0.5,0.5,0.5],
            'size':[1.2,1.0,0.7],'seat_name':'bad seat','seat_band_ratio':0.1}
        with self.assertRaisesRegex(ValueError,'aperture cutout'): validate_component_cleanup_job(value)
    def test_accepts_regenerate_candidate_for_bounded_interface_rebuild(self):
        value=job(); value['source_review']['decision']='regenerate'
        value['interface_rebuild']=[{'name':'upper-arm-pivot','shape':'annulus','axis':'x',
            'center_ratio':[0.5,0.5,0.5],'size_ratio':[0.08,0.6,0.6],
            'inner_radius_ratio':0.55,'bevel_ratio':0.01}]
        self.assertEqual(validate_component_cleanup_job(value),value)
    def test_rejects_invalid_interface_rebuild(self):
        value=job(); value['interface_rebuild']=[{'name':'upper-arm-pivot','shape':'box','axis':'x',
            'center_ratio':[1.2,0.5,0.5],'size_ratio':[0.08,0.6,0.6],
            'inner_radius_ratio':0.2,'bevel_ratio':0.01}]
        with self.assertRaisesRegex(ValueError,'interface rebuild'): validate_component_cleanup_job(value)
    def test_rejects_invalid_salvage_bounds(self):
        value=job(); value['salvage_bounds']={'x':[0.8,0.2],'y':[0,1],'z':[0,1]}
        with self.assertRaisesRegex(ValueError,'salvage bounds'): validate_component_cleanup_job(value)
    def test_rejects_review_for_another_candidate(self):
        value=job(); value['source_review']['candidate_sha256']='b'*64
        with self.assertRaisesRegex(ValueError,'matching Astra'): validate_component_cleanup_job(value)
    def test_rejects_destructive_decimation(self):
        value=job(); value['decimate_ratio']=0.01
        with self.assertRaisesRegex(ValueError,'bounded limits'): validate_component_cleanup_job(value)
    def test_rejects_unbounded_surface_cleanup(self):
        value=job(); value['max_smooth_displacement_ratio']=0.01
        with self.assertRaisesRegex(ValueError,'surface parameters'): validate_component_cleanup_job(value)

    def test_accepts_bounded_longitudinal_socket_cutouts(self):
        value = job()
        value['source_review']['decision'] = 'regenerate'
        value['socket_cutouts'] = [
            {'name': 'elbow-seat', 'axis': 'z', 'side': 'positive',
             'center_ratio': [.5, .5, 1], 'radius_ratio': .18,
             'depth_ratio': .12, 'seat_band_ratio': .006},
            {'name': 'wrist-seat', 'axis': 'z', 'side': 'negative',
             'center_ratio': [.5, .5, 0], 'radius_ratio': .14,
             'depth_ratio': .1, 'seat_band_ratio': .006},
        ]
        self.assertEqual(validate_component_cleanup_job(value), value)

    def test_rejects_unbounded_socket_cutout(self):
        value = job()
        value['socket_cutouts'] = [{'name': 'wrist-seat', 'axis': 'z', 'side': 'negative',
            'center_ratio': [.5, .5, 0], 'radius_ratio': .8,
            'depth_ratio': .1, 'seat_band_ratio': .006}]
        with self.assertRaisesRegex(ValueError, 'socket cutouts'):
            validate_component_cleanup_job(value)

    def test_accepts_regenerate_candidate_for_faceted_through_ring(self):
        value = job()
        value['source_review']['decision'] = 'regenerate'
        value['faceted_ring_rebuild'] = {
            'type': 'faceted-through-ring', 'sides': 8,
            'center_ratio': [.5, .5, .56], 'size_ratio': [.94, .9, .34],
            'inner_ratio': .68, 'bevel_ratio': .008, 'replace_source': True,
            'upper_seat_name': 'torso-waist', 'lower_seat_name': 'pelvis-armor-seat'}
        self.assertEqual(validate_component_cleanup_job(value), value)

    def test_rejects_closed_or_unbounded_faceted_ring(self):
        value = job()
        value['faceted_ring_rebuild'] = {
            'type': 'faceted-through-ring', 'sides': 5,
            'center_ratio': [.5, .5, .5], 'size_ratio': [1, 1, .3],
            'inner_ratio': .1, 'bevel_ratio': .08, 'replace_source': False,
            'upper_seat_name': 'bad seat', 'lower_seat_name': 'lower'}
        with self.assertRaisesRegex(ValueError, 'faceted ring rebuild'):
            validate_component_cleanup_job(value)

    def test_blender_socket_cleanup_preserves_existing_open_rims(self):
        script = (Path(__file__).parents[1] / 'modal' / 'component_cleanup_blender.py').read_text()
        self.assertIn("seat_source = 'existing-rim'", script)
        self.assertIn("inner = radius * .65", script)
        self.assertIn("outer = radius * 1.35", script)

    def test_blender_faceted_ring_is_explicitly_through_open(self):
        script = (Path(__file__).parents[1] / 'modal' / 'component_cleanup_blender.py').read_text()
        self.assertIn("'through_opening': True", script)
        self.assertIn("mesh.from_pydata(vertices, [], faces)", script)

if __name__=='__main__': unittest.main()
