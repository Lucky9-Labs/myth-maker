"""Blender-side lossless GLB to native checkpoint conversion."""
import argparse
from pathlib import Path
import bpy

tail=__import__('sys').argv[__import__('sys').argv.index('--')+1:]
p=argparse.ArgumentParser(); p.add_argument('--source',required=True); p.add_argument('--media-type',required=True); p.add_argument('--output',required=True); p.add_argument('--component-id',required=True); p.add_argument('--review-face-budget',type=int); a=p.parse_args(tail)
bpy.ops.wm.read_factory_settings(use_empty=True)
if a.media_type=='application/x-blender':
    with bpy.data.libraries.load(a.source,link=False) as (source,target): target.objects=source.objects
    for obj in target.objects:
        if obj is not None: bpy.context.collection.objects.link(obj)
else:
    bpy.ops.import_scene.gltf(filepath=a.source)
meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
if not meshes: raise RuntimeError('native cache import produced no mesh')
if a.review_face_budget:
    total=sum(len(o.data.polygons) for o in meshes)
    ratio=min(1.0,a.review_face_budget/max(1,total))
    if ratio<1.0:
        for obj in meshes:
            bpy.context.view_layer.objects.active=obj; obj.select_set(True)
            modifier=obj.modifiers.new('review-only-decimate','DECIMATE'); modifier.ratio=ratio
            bpy.ops.object.modifier_apply(modifier=modifier.name); obj.select_set(False)
for index,obj in enumerate(meshes):
    obj.name=f'{a.component_id}-{index:02d}'
    obj['component_id']=a.component_id
Path(a.output).parent.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=a.output,check_existing=False)
