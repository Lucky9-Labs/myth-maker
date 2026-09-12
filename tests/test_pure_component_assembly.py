from pathlib import Path
import sys, unittest
sys.path.insert(0,str(Path(__file__).parents[1]/'modal'))
from pure_component_assembly import FORMAT, validate_pure_component_assembly_job

def job():
    return {'format':FORMAT,'run_id':'pilot-001','work_id':'pure-v0','attempt':1,'asset_id':'mech','retired_sha256':['b'*64],'components':[{'component_id':'torso','artifact':{'path':'asset-production/pilot/torso.glb','bytes':42,'sha256':'a'*64,'media_type':'model/gltf-binary'},'location':[0,0,3],'dimensions':[2,1,3],'rotation_degrees':[0,0,0],'mirror_x':False,'material':'structural'}]}
class Tests(unittest.TestCase):
    def test_cloud_blender_uses_bounded_supported_review_engine(self):
        driver=(Path(__file__).parents[1]/'modal'/'pure_component_assembly_blender.py').read_text()
        self.assertIn("'BLENDER_WORKBENCH' if review_preview else 'BLENDER_EEVEE'",driver)
        self.assertIn("scene.display.shading.color_type='MATERIAL'",driver)
        self.assertIn("320 if review_preview else 720",driver)
        self.assertNotIn("DECIMATE",driver)
        self.assertIn("item['material']!='source'",driver)
        self.assertIn("uniform_scale=min(scale_candidates)",driver)
        self.assertIn("'placement_mode':'uniform-envelope'",driver)
        self.assertNotIn("dims[i]/current[i] if current[i] else 1",driver)
        self.assertNotIn("bpy.ops.object.join()",driver)
        self.assertNotIn('BLENDER_EEVEE_NEXT',driver)
    def test_dense_composition_has_a_bounded_thirty_minute_window(self):
        runner=(Path(__file__).parents[1]/'modal'/'pure_component_assembly.py').read_text()
        service=(Path(__file__).parents[1]/'modal'/'draft_trial.py').read_text()
        self.assertIn('timeout=28*60',runner)
        decorator=service.split('def run_pure_component_assembly_job',1)[0].rsplit('@app.function',1)[1]
        self.assertIn('timeout=30 * 60',decorator)
    def test_accepts_hash_locked_component(self): self.assertEqual(validate_pure_component_assembly_job(job()),job())
    def test_accepts_bounded_review_preview(self):
        x=job(); x['output_mode']='review-preview'
        self.assertEqual(validate_pure_component_assembly_job(x),x)
    def test_accepts_source_material_for_composite_review(self):
        x=job(); x['components'][0]['material']='source'
        self.assertEqual(validate_pure_component_assembly_job(x),x)
    def test_rejects_unknown_output_mode(self):
        x=job(); x['output_mode']='fastish'
        with self.assertRaisesRegex(ValueError,'output mode'): validate_pure_component_assembly_job(x)
    def test_rejects_retired_hash(self):
        x=job(); x['retired_sha256']=['a'*64]
        with self.assertRaisesRegex(ValueError,'retired'): validate_pure_component_assembly_job(x)
    def test_rejects_duplicate_component(self):
        x=job(); x['components'].append(dict(x['components'][0]))
        with self.assertRaisesRegex(ValueError,'unique'): validate_pure_component_assembly_job(x)
if __name__=='__main__': unittest.main()
