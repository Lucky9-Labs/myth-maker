from pathlib import Path
import sys, unittest
sys.path.insert(0,str(Path(__file__).parents[1]/'modal'))
from component_native_cache import FORMAT, validate_component_native_cache_job

def job():
    return {'format':FORMAT,'run_id':'pilot-001','work_id':'torso-native-cache','attempt':1,'asset_id':'mech','component_id':'torso','source':{'path':'asset-production/pilot/torso.glb','bytes':42,'sha256':'a'*64,'media_type':'model/gltf-binary'}}

class Tests(unittest.TestCase):
    def test_accepts_hash_locked_glb(self): self.assertEqual(validate_component_native_cache_job(job()),job())
    def test_rejects_native_source(self):
        x=job(); x['source']['media_type']='application/x-blender'
        with self.assertRaisesRegex(ValueError,'source'): validate_component_native_cache_job(x)
    def test_rejects_path_escape(self):
        x=job(); x['source']['path']='../torso.glb'
        with self.assertRaisesRegex(ValueError,'source'): validate_component_native_cache_job(x)
    def test_conversion_is_explicitly_lossless(self):
        driver=(Path(__file__).parents[1]/'modal'/'component_native_cache_blender.py').read_text()
        self.assertIn('bpy.ops.import_scene.gltf',driver)
        self.assertIn('bpy.ops.wm.save_as_mainfile',driver)
        self.assertNotIn('DECIMATE',driver)
        runner=(Path(__file__).parents[1]/'modal'/'component_native_cache.py').read_text()
        self.assertIn('"geometry_changed":False',runner)
        self.assertIn('"model_calls":0',runner)
