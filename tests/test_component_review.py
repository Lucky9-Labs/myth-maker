from __future__ import annotations
from pathlib import Path
import sys,unittest
sys.path.insert(0,str(Path(__file__).parents[1]/"modal"))
from component_review import FORMAT,MODEL,validate_component_review_job
def artifact(path,media): return {"path":path,"bytes":42,"sha256":"a"*64,"media_type":media}
def job(): return {"format":FORMAT,"run_id":"pilot-001","work_id":"hand-review-v1","attempt":1,"asset_id":"mech","component_id":"forearm-hand-module","model":MODEL,"isolated_reference":artifact("asset-production/pilot/ref.png","image/png"),"candidate":artifact("asset-production/pilot/mesh.glb","model/gltf-binary"),"attachment_surfaces":["elbow-seat","primary-grip"]}
class ComponentReviewTests(unittest.TestCase):
    def test_closed_contract(self): self.assertEqual(validate_component_review_job(job()),job())
    def test_rejects_hashless_candidate(self):
        value=job(); value["candidate"]={**value["candidate"],"sha256":"bad"}
        with self.assertRaisesRegex(ValueError,"artifacts"): validate_component_review_job(value)
    def test_accepts_railgun(self):
        value={**job(),"asset_id":"railgun"}; self.assertEqual(validate_component_review_job(value),value)
if __name__=="__main__": unittest.main()
