import bpy,json,os,math
from mathutils import Matrix,Vector
root=os.path.abspath('output/cockpit-mechanical');cfg=json.load(open(root+'/mechanism.json'));scene=bpy.context.scene;scene.frame_set(1);control=bpy.data.objects['CTRL_Cockpit_Open'];control.animation_data.action=None
rest={p['native']:bpy.data.objects[p['native']].matrix_world.copy()for p in cfg['parts']}
def smooth(t):t=max(0,min(1,t));return t*t*t*(t*(t*6-15)+10)
def vec(v):return Vector((v[0],-v[2],v[1]))
checks=[]
for a in [0,.1,.3,.45,.6,.8,1,.65,.2,0]:
 control['open_amount']=a;control.update_tag();bpy.context.view_layer.update()
 for p in cfg['parts']:
  ranges=p.get('travelRanges',[[.3,1]]*3);delta=[p['clearance'][i]*smooth(a/.3)+p['travel'][i]*smooth((a-ranges[i][0])/(ranges[i][1]-ranges[i][0]))for i in range(3)];rs,re=p.get('rotationRange',[.3,1]);angle=p.get('angle',0)*smooth((a-rs)/(re-rs));pivot=vec(p.get('pivot',[0,0,0]));expected=Matrix.Translation(pivot+vec(delta))@Matrix.Rotation(angle,4,vec(p.get('axis',[1,0,0])))@Matrix.Translation(-pivot)@rest[p['native']];actual=bpy.data.objects[p['native']].matrix_world;error=max(abs(expected[i][j]-actual[i][j])for i in range(4)for j in range(4));checks.append(dict(amount=a,part=p['role'],matrix_error=error))
assert max(c['matrix_error']for c in checks)<2e-6,checks
assert bpy.data.objects['tripo_part_61.001'].hide_render
assert max(abs(bpy.data.objects['Cockpit_Glass_Preview'].matrix_world[i][j]-bpy.data.objects['tripo_part_61.001'].matrix_world[i][j])for i in range(4)for j in range(4))<2e-6
json.dump({'checks':checks,'max_error':max(c['matrix_error']for c in checks)},open(root+'/native-validation.json','w'),indent=2)
print('NATIVE_PARITY_PASS',max(c['matrix_error']for c in checks))
