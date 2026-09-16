"""Create an additive cockpit rig in a derivative file; never writes the accepted source."""
import bpy,json,os,math
from mathutils import Vector,Matrix,Quaternion
root=os.path.abspath('output/cockpit-mechanical');cfg=json.load(open(root+'/mechanism.json'));scene=bpy.context.scene;scene.frame_set(1)
# Freeze the sampled accepted pose for this isolated mechanical review. Keep every
# source action datablock and every joint/mesh datum; no limb animation is rewritten.
for obj in scene.objects:
 if obj.animation_data:
  if obj.animation_data.action:
   obj.animation_data.action.use_fake_user=True
   obj['cockpit_source_action']=obj.animation_data.action.name
   obj.animation_data.action=None
  for track in obj.animation_data.nla_tracks:track.mute=True
pose=json.load(open(root+'/service-pose.json'))['nodes']
conversion=Matrix.Rotation(math.pi/2,4,'X')
def service_matrix(name):
 values=pose[name.replace('.','')]['matrix'];return conversion@Matrix([values[i::4]for i in range(4)])
rig=bpy.data.objects['Strokah_MechanicalRig']
# The waist is untouched by the service pose: verify coordinate conversion first.
assert max(abs((rig.matrix_world@rig.pose.bones['waist'].matrix)[i][j]-service_matrix('waist')[i][j])for i in range(4)for j in range(4))<1e-4
for side in ['L','R']:
 for name in ['shoulder_mount','upper_arm','forearm','hand']:
  bone=rig.pose.bones[name+'.'+side]
  bone.matrix=rig.matrix_world.inverted()@service_matrix(bone.name)
  bpy.context.view_layer.update()
 # Runtime acceptance reparents the shoulder shell to the upper arm.
 shell=bpy.data.objects['tripo_part_34.00'+('2' if side=='L' else '3')]
 shell.parent=rig;shell.parent_type='BONE';shell.parent_bone='upper_arm.'+side
 shell.matrix_world=service_matrix(shell.name)
weapon=bpy.data.objects['RootNode']
for constraint in weapon.constraints:constraint.mute=True
weapon.matrix_world=service_matrix('RootNode')
bpy.context.view_layer.update()
control=bpy.data.objects.new('CTRL_Cockpit_Open',None);scene.collection.objects.link(control);control.empty_display_type='PLAIN_AXES';control.empty_display_size=.08;control['open_amount']=0.0;control.id_properties_ui('open_amount').update(min=0,max=1,description='0 seated; 1 open. Reversible rigid cam-slide path.');control['notes']='Additive cockpit controls. Source anatomy and existing animation are retained. Browser proof uses the accepted grip solver in a lowered service pose.'
# Built-in driver operations only: no Python handlers or auto-run trust required.
s0='(min(1,max(0,u/0.3))**3*(min(1,max(0,u/0.3))*(min(1,max(0,u/0.3))*6-15)+10))'
s1='(min(1,max(0,(u-0.3)/0.7))**3*(min(1,max(0,(u-0.3)/0.7))*(min(1,max(0,(u-0.3)/0.7))*6-15)+10))'
def vector(v):return Vector((v[0],-v[2],v[1]))
def driver(obj,prop,i,expr):
 d=obj.driver_add(prop,i).driver;d.type='SCRIPTED';v=d.variables.new();v.name='u';v.type='SINGLE_PROP';v.targets[0].id=control;v.targets[0].data_path='["open_amount"]';d.expression=expr
 for name,propname in [('c','clearance_phase'),('t','travel_phase')]+list(phase_vars.items()):
  if name not in expr:continue
  v=d.variables.new();v.name=name;v.type='SINGLE_PROP';v.targets[0].id=control;v.targets[0].data_path='["'+propname+'"]'
control['clearance_phase']=0.;control['travel_phase']=0.
for prop,expression in [('clearance_phase',s0),('travel_phase',s1)]:
 d=control.driver_add('["'+prop+'"]').driver;d.type='SCRIPTED';v=d.variables.new();v.name='u';v.type='SINGLE_PROP';v.targets[0].id=control;v.targets[0].data_path='["open_amount"]';d.expression=expression
s0='c';s1='t'
records=[]
for p in cfg['parts']:
 phase_vars={}
 for var,interval in [('rx',p.get('travelRanges',[[.3,1]]*3)[0]),('ry',p.get('travelRanges',[[.3,1]]*3)[1]),('rz',p.get('travelRanges',[[.3,1]]*3)[2]),('rr',p.get('rotationRange',[.3,1]))]:
  prop=p['role']+'_'+var;control[prop]=0.;phase_vars[var]=prop
  start,end=interval;t=f'min(1,max(0,(u-{start})/{end-start}))'
  d=control.driver_add('["'+prop+'"]').driver;v=d.variables.new();v.name='u';v.targets[0].id=control;v.targets[0].data_path='["open_amount"]';d.expression=f'{t}**3*({t}*({t}*6-15)+10)'
 o=bpy.data.objects[p['native']];world=o.matrix_world.copy();basis=o.matrix_basis.copy();parent=world@basis.inverted();inv=parent.inverted();pivot=vector(p.get('pivot',[0,0,0]));r=world.translation-pivot
 mover=bpy.data.objects.new('COCKPIT_'+p['role'],None);scene.collection.objects.link(mover);mover.parent=o.parent;mover.parent_type=o.parent_type;mover.parent_bone=o.parent_bone;mover.matrix_parent_inverse=o.matrix_parent_inverse.copy();mover.matrix_basis=basis;mover.rotation_mode='QUATERNION';mover.empty_display_size=.025
 const=inv@(pivot+Vector((r.x,0,0)));co=inv.to_3x3()@Vector((0,r.y,r.z));si=inv.to_3x3()@Vector((0,-r.z,r.y));cl=inv.to_3x3()@vector(p['clearance']);tr=inv.to_3x3()@vector(p['travel']);angle=p.get('angle',0);a=f'({angle:.10g}*rr)'
 travel=[inv.to_3x3()@vector([p['travel'][j] if j==k else 0 for j in range(3)]) for k in range(3)]
 for i in range(3):driver(mover,'location',i,f'{const[i]:.10g}+({co[i]:.10g})*cos({a})+({si[i]:.10g})*sin({a})+({cl[i]:.10g})*c'+''.join(f'+({travel[j][i]:.10g})*{var}'for j,var in enumerate(['rx','ry','rz'])))
 q0=parent.to_quaternion().inverted()@world.to_quaternion();q1=parent.to_quaternion().inverted()@Quaternion((0,1,0,0))@world.to_quaternion()
 for i in range(4):driver(mover,'rotation_quaternion',i,f'({q0[i]:.10g})*cos({a}/2)+({q1[i]:.10g})*sin({a}/2)')
 o.parent=mover;o.parent_type='OBJECT';o.parent_bone='';o.matrix_parent_inverse=Matrix.Identity(4);o.matrix_basis=Matrix.Identity(4)
 if p['role']=='canopy':
  glass=json.load(open(root+'/working/glass-surface.json'))
  mesh=bpy.data.meshes.new('Cockpit_Exterior_Glass_Preview')
  mesh.from_pydata([vector(v) for v in glass['vertices']],[],glass['triangles']);mesh.update()
  pane=bpy.data.objects.new('Cockpit_Glass_Preview',mesh);scene.collection.objects.link(pane);pane.parent=mover;pane.matrix_basis=Matrix.Identity(4)
  for polygon in mesh.polygons:polygon.use_smooth=True
  for material in o.data.materials:mesh.materials.append(material)
  pane['notes']='Non-destructive outer-surface preview. Full original canopy remains hidden beside this object for later internal-mass cleanup.'
  o.hide_render=True;o.hide_set(True)
 records.append((o,world,p))
# Separate timeline demo on the normalized control; the accepted motion actions remain intact.
for f,u in [(1,0),(12,0),(52,1),(68,1),(88,.50),(98,.75),(128,0),(144,0)]:
 control['open_amount']=u;control.keyframe_insert(data_path='["open_amount"]',frame=f)
control.animation_data.action.name='Cockpit_Open_Hold_Reverse_Close'
for fc in control.animation_data.action.layers[0].strips[0].channelbags[0].fcurves:
 for k in fc.keyframe_points:k.interpolation='LINEAR'
# Save closed neutral at original frame; custom property can be scrubbed independently.
scene.frame_set(1);bpy.context.view_layer.update()
errors={o.name:max(abs(o.matrix_world[i][j]-w[i][j])for i in range(4)for j in range(4))for o,w,p in records}
assert max(errors.values())<1e-5,errors
control['closed_matrix_error']=max(errors.values());scene.frame_end=144
bpy.ops.wm.save_as_mainfile(filepath=root+'/working/strokah-cockpit-mechanical-v1.blend')
json.dump({'closed_matrix_error':errors,'panels':[p for o,w,p in records],'controller':'CTRL_Cockpit_Open[open_amount]'},open(root+'/native-receipt.json','w'),indent=2)
print('COCKPIT_NATIVE_SAVED',errors)
