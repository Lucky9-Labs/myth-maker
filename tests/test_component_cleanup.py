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
    def test_rejects_unaccepted_review(self):
        value=job(); value['source_review']['decision']='regenerate'
        with self.assertRaisesRegex(ValueError,'accepted Astra review'): validate_component_cleanup_job(value)
    def test_rejects_review_for_another_candidate(self):
        value=job(); value['source_review']['candidate_sha256']='b'*64
        with self.assertRaisesRegex(ValueError,'matching accepted'): validate_component_cleanup_job(value)
    def test_rejects_destructive_decimation(self):
        value=job(); value['decimate_ratio']=0.01
        with self.assertRaisesRegex(ValueError,'bounded limits'): validate_component_cleanup_job(value)
    def test_rejects_unbounded_surface_cleanup(self):
        value=job(); value['max_smooth_displacement_ratio']=0.01
        with self.assertRaisesRegex(ValueError,'surface parameters'): validate_component_cleanup_job(value)

if __name__=='__main__': unittest.main()
