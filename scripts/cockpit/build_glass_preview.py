"""Non-destructive preview: retain only exterior front-facing canopy triangles in a copy."""
exec(open('scripts/cockpit/audit_export.py').read().split('rows=[]')[0].replace('cockpit-glass-preview.glb','accepted.glb'))
import copy
node=next(n for n in g['nodes']if n['name']=='tripo_part_61.001');mesh=g['meshes'][node['mesh']];p=mesh['primitives'][0];positions=arr(p['attributes']['POSITION']);indices=[x[0]for x in arr(p['indices'])];local=[Vector(v)for v in positions];triangles=[tuple(indices[i:i+3])for i in range(0,len(indices),3)];tree=BVHTree.FromPolygons(local,triangles,all_triangles=True)
keep=[]
for face in triangles:
 a,b,c=[local[i]for i in face];normal=(b-a).cross(c-a)
 if normal.z<=0:continue
 center=(a+b+c)/3
 # Interior forward-facing folds do not become glass; retain the frontmost skin.
 hit,_,_,_=tree.ray_cast(center+Vector((0,0,2)),Vector((0,0,-1)),3)
 if hit is not None and abs(hit.z-center.z)<.00005:keep.extend(face)
assert len(keep)>1000
while len(blob)%4:blob+=b'\0'
offset=len(blob);chunk=struct.pack('<'+'I'*len(keep),*keep);blob+=chunk;g['bufferViews'].append({'buffer':0,'byteOffset':offset,'byteLength':len(chunk),'target':34963});g['accessors'].append({'bufferView':len(g['bufferViews'])-1,'componentType':5125,'count':len(keep),'type':'SCALAR'});p['indices']=len(g['accessors'])-1
# Glass surface is deliberately double sided, with no invented inner volume.
if 'material'in p:g['materials'][p['material']]['doubleSided']=True
g['buffers'][0]['byteLength']=len(blob);j=json.dumps(g,separators=(',',':')).encode();j+=b' '*((-len(j))%4);blob+=b'\0'*((-len(blob))%4)
with open(root+'/working/cockpit-glass-preview.glb','wb')as f:f.write(struct.pack('<III',0x46546c67,2,12+8+len(j)+8+len(blob))+struct.pack('<II',len(j),0x4e4f534a)+j+struct.pack('<II',len(blob),0x004e4942)+blob)
json.dump({'vertices':positions,'triangles':[keep[i:i+3]for i in range(0,len(keep),3)],'original_triangles':len(indices)//3,'glass_triangles':len(keep)//3},open(root+'/working/glass-surface.json','w'))
print('PREVIEW_GLASS',len(keep)//3,'of',len(indices)//3,'triangles; source untouched')
