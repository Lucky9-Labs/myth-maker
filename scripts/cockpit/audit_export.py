import json,struct,os
from mathutils import Matrix,Vector
from mathutils.bvhtree import BVHTree
root=os.path.abspath('output/cockpit-mechanical');cfg=json.load(open(root+'/mechanism.json'));pose=json.load(open(root+'/service-pose.json'))['nodes']
f=open(root+'/working/cockpit-glass-preview.glb','rb');f.read(12);n,t=struct.unpack('<II',f.read(8));g=json.loads(f.read(n));n,t=struct.unpack('<II',f.read(8));blob=f.read(n)
def arr(i):
 a=g['accessors'][i];v=g['bufferViews'][a['bufferView']];k={'SCALAR':1,'VEC3':3,'VEC2':2,'VEC4':4}[a['type']];code={5126:'f',5125:'I',5123:'H',5121:'B'}[a['componentType']];size=struct.calcsize(code)*k;off=v.get('byteOffset',0)+a.get('byteOffset',0);stride=v.get('byteStride',size);return [struct.unpack_from('<'+code*k,blob,off+j*stride)for j in range(a['count'])]
def mat(xs):return Matrix([xs[i::4]for i in range(4)])
data={}
for node in g['nodes']:
 if 'mesh' not in node or node['name']=='Terrain_Walk_Test':continue
 name=node['name'].replace('.','');m=mat(pose[name]['matrix']);vs=[];faces=[]
 for p in g['meshes'][node['mesh']]['primitives']:
  start=len(vs);vs.extend(m@Vector(v)for v in arr(p['attributes']['POSITION']));ids=[x[0]for x in arr(p['indices'])];faces.extend(tuple(start+ids[i+j]for j in range(3))for i in range(0,len(ids),3))
 data[name]=(vs,faces)
def smooth(t):t=max(0,min(1,t));return t*t*t*(t*(t*6-15)+10)
moving={p['node']:p for p in cfg['parts']}
static={name:BVHTree.FromPolygons(v,f,all_triangles=True)for name,(v,f)in data.items()if name not in moving}
rows=[]
for step in range(41):
 a=step/40;trees=static.copy()
 for name,p in moving.items():
  d=Vector([p['clearance'][i]*smooth(a/.3)+p['travel'][i]*smooth((a-p.get('travelRanges',[[.3,1]]*3)[i][0])/(p.get('travelRanges',[[.3,1]]*3)[i][1]-p.get('travelRanges',[[.3,1]]*3)[i][0]))for i in range(3)]);v,f=data[name];pivot=Vector(p.get('pivot',[0,0,0]));r=Matrix.Rotation(p.get('angle',0)*smooth((a-p.get('rotationRange',[.3,1])[0])/(p.get('rotationRange',[.3,1])[1]-p.get('rotationRange',[.3,1])[0])),3,Vector(p.get('axis',[1,0,0])));trees[name]=BVHTree.FromPolygons([pivot+d+r@(x-pivot) for x in v],f,all_triangles=True)
 hits={}
 for name in moving:
  for other in data:
   if name==other or(other in moving and other<name):continue
   count=len(trees[name].overlap(trees[other]))
   if count:hits[name+' / '+other]=count
 rows.append(dict(amount=a,intersections=hits))
 print(a,hits,flush=True)
json.dump(rows,open(root+'/export-clearance.json','w'),indent=2)
