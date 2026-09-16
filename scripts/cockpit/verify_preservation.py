import bpy,json,hashlib,struct,os
root=os.path.abspath('output/cockpit-mechanical')
def snapshot():
 meshes={}
 for o in bpy.data.objects:
  if o.type=='MESH':
   h=hashlib.sha256()
   for v in o.data.vertices:h.update(struct.pack('<3f',*v.co))
   for p in o.data.polygons:h.update(struct.pack('<'+'I'*len(p.vertices),*p.vertices))
   meshes[o.name]=h.hexdigest()
 rig=bpy.data.objects['Strokah_MechanicalRig'];bones={b.name:([*b.head_local],[*b.tail_local],b.parent.name if b.parent else None)for b in rig.data.bones}
 return meshes,bones
source=snapshot();bpy.ops.wm.open_mainfile(filepath=root+'/working/strokah-cockpit-mechanical-v1.blend');candidate=snapshot();assert source[1]==candidate[1] and all(candidate[0].get(k)==v for k,v in source[0].items()),'Source geometry or rest skeleton changed'
json.dump({'unchanged_meshes':len(source[0]),'unchanged_rest_bones':len(source[1]),'geometry_and_rest_skeleton_identical':True},open(root+'/preservation.json','w'),indent=2)
print('PRESERVED',len(source[0]),'meshes',len(source[1]),'bones')
