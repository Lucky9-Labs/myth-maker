import bpy,json,os,math
from mathutils import Matrix
root=os.path.abspath('output/cockpit-mechanical');pose=json.load(open(root+'/service-pose.json'))['nodes'];c=Matrix.Rotation(math.pi/2,4,'X');bpy.context.scene.frame_set(1);rig=bpy.data.objects['Strokah_MechanicalRig'];errors={}
for name in ['shoulder_mount.L','upper_arm.L','forearm.L','hand.L','shoulder_mount.R','upper_arm.R','forearm.R','hand.R','RootNode']:
 v=pose[name.replace('.','')]['matrix'];expected=c@Matrix([v[i::4]for i in range(4)]);actual=bpy.data.objects[name].matrix_world if name=='RootNode'else rig.matrix_world@rig.pose.bones[name].matrix;errors[name]=max(abs(expected[i][j]-actual[i][j])for i in range(4)for j in range(4))
print(errors);assert max(errors.values())<1e-4
json.dump(errors,open(root+'/service-native-validation.json','w'),indent=2)
