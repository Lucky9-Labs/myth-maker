"""Blender implementation for a pure component sculpture assembly."""
import argparse, json, math
from pathlib import Path
import bpy
from mathutils import Matrix, Vector

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
        before=set(bpy.context.scene.objects)
        source_path=submissions/item['artifact']['path']
        if item['artifact']['media_type']=='application/x-blender':
            with bpy.data.libraries.load(str(source_path),link=False) as (source, target):
                target.objects=source.objects
            for loaded in target.objects:
                if loaded is not None and loaded.name not in bpy.context.scene.objects:
                    bpy.context.collection.objects.link(loaded)
        else:
            bpy.ops.import_scene.gltf(filepath=str(source_path))
        bpy.context.view_layer.update()
        meshes=[o for o in bpy.context.scene.objects if o not in before and o.type=='MESH']
        if not meshes: raise RuntimeError('component import produced no mesh: '+item['component_id'])
        # Keep source mesh datablocks immutable. Bounds and placement operate on
        # object matrices, avoiding an O(vertex-count) rewrite on every assembly.
        source_world={o:o.matrix_world.copy() for o in meshes}
        points=[source_world[o] @ Vector(corner) for o in meshes for corner in o.bound_box]
        lower=Vector((min(p.x for p in points),min(p.y for p in points),min(p.z for p in points)))
        upper=Vector((max(p.x for p in points),max(p.y for p in points),max(p.z for p in points)))
        center=(lower+upper)*.5; current=upper-lower; dims=Vector(item['dimensions'])
        group=bpy.data.objects.new(item['component_id'],None); bpy.context.collection.objects.link(group); group.parent=root
        group.location=item['location']; group.rotation_euler=[math.radians(x) for x in item['rotation_degrees']]
        # Dimensions describe a placement envelope, not a replacement volume.
        # Uniform scaling preserves the Hunyuan component's authored proportions
        # and leaves honest gaps where no generated component exists yet.
        scale_candidates=[dims[i]/current[i] for i in range(3) if current[i]]
        uniform_scale=min(scale_candidates) if scale_candidates else 1.0
        group.scale=(uniform_scale,uniform_scale,uniform_scale)
        bpy.context.view_layer.update()
        for index,o in enumerate(meshes):
            o.name=f"{item['component_id']}-{index:02d}"; o.parent=group
            o.matrix_world=group.matrix_world @ Matrix.Translation(-center) @ source_world[o]
            if item['material']!='source': o.data.materials.clear(); o.data.materials.append(mats[item['material']])
            o['source_sha256']=item['artifact']['sha256']; o['component_id']=item['component_id']
            manifest.append({'object':o.name,'source_sha256':item['artifact']['sha256'],'mirrored':False,
                             'placement_mode':'uniform-envelope','uniform_scale':round(uniform_scale,8)})
        if item['mirror_x']:
            mirror=bpy.data.objects.new(item['component_id']+'-mirrored',None); bpy.context.collection.objects.link(mirror); mirror.parent=root
            mirror.location=(-group.location.x,group.location.y,group.location.z); mirror.rotation_euler=group.rotation_euler; mirror.scale=(-group.scale.x,group.scale.y,group.scale.z)
            for index,o in enumerate(meshes):
                q=o.copy(); q.data=o.data; q.name=f"{item['component_id']}-mirrored-{index:02d}"; bpy.context.collection.objects.link(q); q.parent=mirror
                q.matrix_world=mirror.matrix_world @ Matrix.Translation(-center) @ source_world[o]
                q['source_sha256']=item['artifact']['sha256']; q['component_id']=item['component_id']; manifest.append({'object':q.name,'source_sha256':item['artifact']['sha256'],'mirrored':True,
                    'placement_mode':'uniform-envelope','uniform_scale':round(uniform_scale,8)})
    bpy.context.view_layer.update()
    world=bpy.context.scene.world or bpy.data.worlds.new('World'); bpy.context.scene.world=world; world.color=(.025,.025,.025)
    for loc,energy,size in [((4,-6,7),1400,5),((-4,-2,4),800,4),((0,5,6),1000,3)]:
        d=bpy.data.lights.new('studio','AREA'); d.energy=energy; d.shape='DISK'; d.size=size; ob=bpy.data.objects.new('studio',d); bpy.context.collection.objects.link(ob); ob.location=loc
    scene=bpy.context.scene
    review_preview=job.get('output_mode')=='review-preview'
    # Placement audits need the original silhouette, not production shader work.
    # Workbench renders the untouched imported meshes quickly; full outputs retain
    # Eevee and the source materials for acceptance review.
    scene.render.engine='BLENDER_WORKBENCH' if review_preview else 'BLENDER_EEVEE'
    if review_preview:
        scene.display.shading.light='STUDIO'
        scene.display.shading.color_type='MATERIAL'
        scene.display.shading.show_shadows=True
        scene.display.shading.show_cavity=True
    scene.render.resolution_x=320 if review_preview else 720; scene.render.resolution_y=scene.render.resolution_x; scene.render.resolution_percentage=100; scene.render.image_settings.file_format='PNG'; scene.render.film_transparent=False
    camera_data=bpy.data.cameras.new('review-camera'); camera=bpy.data.objects.new('review-camera',camera_data); bpy.context.collection.objects.link(camera); scene.camera=camera
    def look(at):
        direction=Vector((0,0,3.4))-camera.location; camera.rotation_euler=direction.to_track_quat('-Z','Y').to_euler(); scene.render.filepath=str(out/at[0]); bpy.ops.render.render(write_still=True)
    camera.location=(7,-10,6); look(('three-quarter.png',)); camera.location=(0,-12,3.5); look(('front.png',)); camera.location=(12,0,3.5); look(('side.png',))
    Path(out/'manifest.json').write_text(json.dumps({'format':'myth-maker.pure-assembly-scene/v1','objects':manifest},indent=2)+'\n')
    if job.get('output_mode','full') == 'full':
        bpy.ops.wm.save_as_mainfile(filepath=str(out/'assembly.blend'),check_existing=False)
        bpy.ops.export_scene.gltf(filepath=str(out/'assembly.glb'),export_format='GLB',export_apply=True,export_animations=False)

if __name__=='__main__': main()
