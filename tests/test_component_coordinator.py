from pathlib import Path
import sys,unittest
sys.path.insert(0,str(Path(__file__).parents[1]/'modal'))
from component_coordinator import FORMAT,validate_component_coordinator_job
def review_job():
 return {'format':'myth-maker.component-review-job/v1','run_id':'pilot-001','work_id':'review-arm','attempt':1,'asset_id':'mech','component_id':'upper-arm','model':'gpt-6-astra','isolated_reference':{'path':'ref.png','bytes':1,'sha256':'0'*64,'media_type':'image/png'},'candidate':{'path':'arm.glb','bytes':1,'sha256':'1'*64,'media_type':'model/gltf-binary'},'attachment_surfaces':[]}
def job(): return {'format':FORMAT,'run_id':'pilot-001','work_id':'cycle-001','attempt':1,'role':'routing','model':'gpt-5.6-luna','objective':'finish mech','state_summary':{},'evidence':[],'max_actions':4,'prepared_actions':[{'action_id':'review-arm','action_type':'review-3d','component_id':'upper-arm','summary':'review candidate','job':review_job()}]}
class Tests(unittest.TestCase):
 def test_accepts_bounded_mech_cycle(self): self.assertEqual(validate_component_coordinator_job(job()),job())
 def test_rejects_railgun_action(self):
  x=job(); x['prepared_actions'][0]['job']['asset_id']='railgun'
  with self.assertRaisesRegex(ValueError,'frozen'): validate_component_coordinator_job(x)
 def test_rejects_placeholder_nested_job_before_dispatch(self):
  x=job(); x['prepared_actions'][0]['job']={'asset_id':'mech'}
  with self.assertRaisesRegex(ValueError,'prepared review-3d job is invalid'): validate_component_coordinator_job(x)
 def test_rejects_too_many_actions(self):
  x=job(); x['max_actions']=5
  with self.assertRaisesRegex(ValueError,'bounds'): validate_component_coordinator_job(x)
 def test_visual_cycle_requires_astra(self):
  x=job(); x['role']='visual'; x['model']='gpt-6-astra'
  self.assertEqual(validate_component_coordinator_job(x),x)
 def test_rejects_visual_evidence_in_luna_routing_cycle(self):
  x=job(); x['evidence']=[{'path':'x.png','bytes':1,'sha256':'0'*64,'media_type':'image/png'}]
  with self.assertRaisesRegex(ValueError,'cannot consume image'): validate_component_coordinator_job(x)
if __name__=='__main__': unittest.main()
