from pathlib import Path
import sys, unittest
sys.path.insert(0,str(Path(__file__).parents[1]/'modal'))
from pure_component_assembly import FORMAT, validate_pure_component_assembly_job

def job():
    return {'format':FORMAT,'run_id':'pilot-001','work_id':'pure-v0','attempt':1,'asset_id':'mech','retired_sha256':['b'*64],'components':[{'component_id':'torso','artifact':{'path':'asset-production/pilot/torso.glb','bytes':42,'sha256':'a'*64,'media_type':'model/gltf-binary'},'location':[0,0,3],'dimensions':[2,1,3],'rotation_degrees':[0,0,0],'mirror_x':False,'material':'structural'}]}
class Tests(unittest.TestCase):
    def test_accepts_hash_locked_component(self): self.assertEqual(validate_pure_component_assembly_job(job()),job())
    def test_rejects_retired_hash(self):
        x=job(); x['retired_sha256']=['a'*64]
        with self.assertRaisesRegex(ValueError,'retired'): validate_pure_component_assembly_job(x)
    def test_rejects_duplicate_component(self):
        x=job(); x['components'].append(dict(x['components'][0]))
        with self.assertRaisesRegex(ValueError,'unique'): validate_pure_component_assembly_job(x)
if __name__=='__main__': unittest.main()
