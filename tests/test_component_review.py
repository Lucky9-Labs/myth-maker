from __future__ import annotations
from pathlib import Path
import sys,unittest
sys.path.insert(0,str(Path(__file__).parents[1]/"modal"))
from component_review import FORMAT,MODEL,_validate_result,validate_component_review_job
def artifact(path,media): return {"path":path,"bytes":42,"sha256":"a"*64,"media_type":media}
def job(): return {"format":FORMAT,"run_id":"pilot-001","work_id":"hand-review-v1","attempt":1,"asset_id":"mech","component_id":"forearm-hand-module","model":MODEL,"isolated_reference":artifact("asset-production/pilot/ref.png","image/png"),"candidate":artifact("asset-production/pilot/mesh.glb","model/gltf-binary"),"attachment_surfaces":["elbow-seat","primary-grip"]}
class ComponentReviewTests(unittest.TestCase):
    def test_closed_contract(self): self.assertEqual(validate_component_review_job(job()),job())
    def test_rejects_hashless_candidate(self):
        value=job(); value["candidate"]={**value["candidate"],"sha256":"bad"}
        with self.assertRaisesRegex(ValueError,"artifacts"): validate_component_review_job(value)
    def test_accepts_railgun(self):
        value={**job(),"asset_id":"railgun"}; self.assertEqual(validate_component_review_job(value),value)
    def test_normalizes_model_metadata_and_component_identity(self):
        value={"format":"wrong","component_id":"alias","scores":{key:50 for key in ("reference_fidelity","surface_coherence","part_completeness","attachment_readiness","articulation_readiness")},"blocking_defects":[],"cleanup_actions":[],"integration_guidance":[],"decision":"clean","explanation":"extra"}
        result=_validate_result(value,"forearm-hand-module")
        self.assertEqual(set(result),{"format","component_id","scores","blocking_defects","cleanup_actions","integration_guidance","decision"})
        self.assertEqual(result["component_id"],"forearm-hand-module")
if __name__=="__main__": unittest.main()
