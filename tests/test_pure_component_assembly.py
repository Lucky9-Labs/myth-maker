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
        self.assertNotIn("o.data.transform",driver)
        self.assertIn("source_world[o] @ Vector(corner)",driver)
        self.assertIn("q.data=o.data",driver)
        self.assertNotIn('BLENDER_EEVEE_NEXT',driver)
    def test_dense_composition_has_a_bounded_thirty_minute_window(self):
        runner=(Path(__file__).parents[1]/'modal'/'pure_component_assembly.py').read_text()
        service=(Path(__file__).parents[1]/'modal'/'draft_trial.py').read_text()
        self.assertIn('timeout=28*60',runner)
        decorator=service.split('def run_pure_component_assembly_job',1)[0].rsplit('@app.function',1)[1]
        self.assertIn('timeout=30 * 60',decorator)
    def test_accepts_hash_locked_component(self): self.assertEqual(validate_pure_component_assembly_job(job()),job())
    def test_accepts_hash_locked_native_blender_component(self):
        x=job(); x['components'][0]['artifact']['media_type']='application/x-blender'; x['components'][0]['artifact']['path']='asset-production/pilot/torso.blend'
        self.assertEqual(validate_pure_component_assembly_job(x),x)
    def test_review_proxy_is_preview_only(self):
        x=job(); x['components'][0]['artifact']['media_type']='application/x-blender-review-proxy'; x['components'][0]['artifact']['path']='asset-production/pilot/torso.blend'
        with self.assertRaisesRegex(ValueError,'review proxy'): validate_pure_component_assembly_job(x)
        x['output_mode']='review-preview'; self.assertEqual(validate_pure_component_assembly_job(x),x)
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
    def test_accepts_multiview_neighbor_graph(self):
        x=job(); cid='torso'; x['frozen_reference_sha256']='c'*64
        x['component_evidence']={cid:[{'view':'front','sha256':'d'*64},{'view':'three-quarter','sha256':'e'*64}]}
        x['placement_graph']=[{'component_id':cid,'parent_component_id':None,'parent_anchor':[0,0,0],'self_anchor':[0,0,0],'offset':[0,0,0]}]
        self.assertEqual(validate_pure_component_assembly_job(x),x)
    def test_graph_requires_multiview_for_every_component(self):
        x=job(); x['frozen_reference_sha256']='c'*64; x['component_evidence']={'torso':[{'view':'front','sha256':'d'*64}]}; x['placement_graph']=[]
        with self.assertRaisesRegex(ValueError,'multiview'): validate_pure_component_assembly_job(x)
    def test_blender_solves_rigid_neighbor_anchors_without_fill_scaling(self):
        driver=(Path(__file__).parents[1]/'modal'/'pure_component_assembly_blender.py').read_text()
        self.assertIn("child.location += parent_world-child_world+Vector(node['offset'])",driver)
        self.assertIn("'multiview-neighbor-anchor'",driver)
        self.assertIn("mirror.location=(-source.location.x,source.location.y,source.location.z)",driver)
        self.assertIn("placed_dimensions[item['component_id']]=Vector(current)",driver)
        self.assertNotIn("placed_dimensions[item['component_id']]=Vector(current)*uniform_scale",driver)
if __name__=='__main__': unittest.main()
