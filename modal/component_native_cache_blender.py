"""Blender-side lossless GLB to native checkpoint conversion."""
import argparse
from pathlib import Path
import bpy

tail=__import__('sys').argv[__import__('sys').argv.index('--')+1:]
p=argparse.ArgumentParser(); p.add_argument('--source',required=True); p.add_argument('--output',required=True); p.add_argument('--component-id',required=True); a=p.parse_args(tail)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=a.source)
meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
if not meshes: raise RuntimeError('native cache import produced no mesh')
for index,obj in enumerate(meshes):
    obj.name=f'{a.component_id}-{index:02d}'
    obj['component_id']=a.component_id
Path(a.output).parent.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=a.output,check_existing=False)
