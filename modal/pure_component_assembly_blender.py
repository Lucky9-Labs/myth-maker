"""Blender implementation for a pure component sculpture assembly."""
import argparse, json, math
from pathlib import Path
import bpy
from mathutils import Vector

def material(name,color,metallic=0.0,roughness=.42):
    m=bpy.data.materials.new(name); m.diffuse_color=(*color,1); m.metallic=metallic; m.roughness=roughness; return m

def main():
    tail=__import__('sys').argv[__import__('sys').argv.index('--')+1:]
    p=argparse.ArgumentParser(); p.add_argument('--job',required=True); p.add_argument('--submissions',required=True); p.add_argument('--output',required=True); a=p.parse_args(tail)
    job=json.loads(Path(a.job).read_text()); out=Path(a.output); submissions=Path(a.submissions)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats={"structural":material("structural",(.055,.065,.075)),"armor-white":material("armor-white",(.72,.69,.64)),"armor-blue":material("armor-blue",(.16,.32,.48)),"lens":material("lens",(.05,.42,.58),.15,.22),"metal":material("metal",(.22,.24,.26),.8,.25)}
    root=bpy.data.objects.new('mech-pure-root',None); bpy.context.collection.objects.link(root); manifest=[]
    for item in job['components']:
        before=set(bpy.context.scene.objects); bpy.ops.import_scene.gltf(filepath=str(submissions/item['artifact']['path'])); meshes=[o for o in bpy.context.scene.objects if o not in before and o.type=='MESH']
        if not meshes: raise RuntimeError('component import produced no mesh: '+item['component_id'])
        bpy.ops.object.select_all(action='DESELECT')
        for o in meshes: o.select_set(True)
        bpy.context.view_layer.objects.active=meshes[0]
        if len(meshes)>1: bpy.ops.object.join()
        o=bpy.context.view_layer.objects.active; o.name=item['component_id']; o.parent=None
        world=o.matrix_world.copy(); o.data.transform(world); o.matrix_world.identity(); bpy.context.view_layer.update()
        dims=Vector(item['dimensions']); current=o.dimensions; o.scale=tuple(dims[i]/current[i] if current[i] else 1 for i in range(3)); bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
        o.location=item['location']; o.rotation_euler=[math.radians(x) for x in item['rotation_degrees']]; o.data.materials.clear(); o.data.materials.append(mats[item['material']]); o.parent=root
        o['source_sha256']=item['artifact']['sha256']; o['component_id']=item['component_id']; manifest.append({'object':o.name,'source_sha256':item['artifact']['sha256'],'mirrored':False})
        if item['mirror_x']:
            q=o.copy(); q.data=o.data.copy(); q.name=item['component_id']+'-mirrored'; bpy.context.collection.objects.link(q); q.location.x=-o.location.x; q.scale.x=-1; q.parent=root; q['source_sha256']=item['artifact']['sha256']; q['component_id']=item['component_id']; manifest.append({'object':q.name,'source_sha256':item['artifact']['sha256'],'mirrored':True})
    bpy.context.view_layer.update()
    world=bpy.context.scene.world or bpy.data.worlds.new('World'); bpy.context.scene.world=world; world.color=(.025,.025,.025)
    for loc,energy,size in [((4,-6,7),1400,5),((-4,-2,4),800,4),((0,5,6),1000,3)]:
        d=bpy.data.lights.new('studio','AREA'); d.energy=energy; d.shape='DISK'; d.size=size; ob=bpy.data.objects.new('studio',d); bpy.context.collection.objects.link(ob); ob.location=loc
    scene=bpy.context.scene; scene.render.engine='BLENDER_EEVEE_NEXT'; scene.render.resolution_x=720; scene.render.resolution_y=720; scene.render.resolution_percentage=100; scene.render.image_settings.file_format='PNG'; scene.render.film_transparent=False
    camera_data=bpy.data.cameras.new('review-camera'); camera=bpy.data.objects.new('review-camera',camera_data); bpy.context.collection.objects.link(camera); scene.camera=camera
    def look(at):
        direction=Vector((0,0,3.4))-camera.location; camera.rotation_euler=direction.to_track_quat('-Z','Y').to_euler(); scene.render.filepath=str(out/at[0]); bpy.ops.render.render(write_still=True)
    camera.location=(7,-10,6); look(('three-quarter.png',)); camera.location=(0,-12,3.5); look(('front.png',)); camera.location=(12,0,3.5); look(('side.png',))
    Path(out/'manifest.json').write_text(json.dumps({'format':'myth-maker.pure-assembly-scene/v1','objects':manifest},indent=2)+'\n')
    bpy.ops.wm.save_as_mainfile(filepath=str(out/'assembly.blend'),check_existing=False)
    bpy.ops.export_scene.gltf(filepath=str(out/'assembly.glb'),export_format='GLB',export_apply=True,export_animations=False)

if __name__=='__main__': main()
