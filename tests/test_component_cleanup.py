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

if __name__=='__main__': unittest.main()
