import bpy, json
appendages=[obj for obj in bpy.data.objects if obj.name.startswith("generated-tentacle-")]
cones=[obj for obj in bpy.data.objects if obj.name.startswith("generated-fin-")]
details=[]
for obj in appendages:
    spline=obj.data.splines[0]
    radii=[point.radius for point in spline.points]
    details.append({"name":obj.name,"type":obj.type,"point_count":len(spline.points),"radii":radii,"tapered":radii[0] > radii[-1]})
clips=[]
for obj in appendages:
    action=obj.animation_data.action if obj.animation_data else None
    if action:
        clips.append({"target_node":obj.name,"clip_name":action.name,"fcurve_count":1,"frame_start":action.frame_range[0],"frame_end":action.frame_range[1]})
result={"body_shape":"single-curved-tapered-appendage-v1","appendage_count":len(appendages),"straight_cone_count":len(cones),"appendages":details,"clips":clips}
open('/Users/lucky/.codex/worktrees/9170/myth-maker/evidence/build-room-kraken-high-fanout-stress.json.artifacts/261fc2b0-1cf2-4a17-8d1f-b10b97b8ff42/wg-8340e6fcb9c609d3ddc8281669373364/staging/source-inspection.json',"w",encoding="utf-8").write(json.dumps(result,sort_keys=True))
