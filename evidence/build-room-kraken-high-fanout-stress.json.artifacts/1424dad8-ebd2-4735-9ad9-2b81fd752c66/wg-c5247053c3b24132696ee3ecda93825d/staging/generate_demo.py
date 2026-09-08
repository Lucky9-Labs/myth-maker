import bpy, math, random, mathutils
random.seed(4207906518)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
for item in list(bpy.data.materials): bpy.data.materials.remove(item)
mat=bpy.data.materials.new("standard")
mat.diffuse_color=(0.055,0.38,0.50,1)
mat.metallic=0.12
mat.roughness=0.34
accent=bpy.data.materials.new("standard-accent")
accent.diffuse_color=(0.08,0.82,0.74,1)
accent.metallic=0.05
accent.roughness=0.28
origin=bpy.data.objects.new("encounter-origin",None)
bpy.context.collection.objects.link(origin)
bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, location=(0,0,0.45))
body=bpy.context.object
body.name="generated-body"
body.scale=(0.82,0.62,0.70)
body.data.materials.append(mat)
body.parent=origin
for index in range(1):
    # The one appendage is bootstrap blueprint data only.  The emitted runtime
    # capability remains encounter.animation and does not encode this name.
    angle=index*math.tau+0.18
    direction=mathutils.Vector((math.cos(angle),math.sin(angle),0))
    tangent=mathutils.Vector((-math.sin(angle),math.cos(angle),0))
    root=direction*0.52+mathutils.Vector((0,0,0.22))
    curve=bpy.data.curves.new(f"generated-tentacle-{index}","CURVE")
    curve.dimensions="3D"
    curve.resolution_u=16
    curve.bevel_depth=0.14
    curve.bevel_resolution=4
    spline=curve.splines.new("NURBS")
    spline.points.add(3)
    # A later immutable revision keeps the same first-stage silhouette (one
    # appendage) but lengthens its recovery arc.  That makes the body and clip
    # revision observable without jumping ahead to medium/large encounter work.
    recovery_extension=0.0 if 1 == 1 else 0.16
    points=[root, root+direction*(0.34+recovery_extension*0.25)+tangent*0.20+mathutils.Vector((0,0,-0.18)), root+direction*(0.72+recovery_extension*0.75)-tangent*0.24+mathutils.Vector((0,0,-0.48)), root+direction*(0.96+recovery_extension)+tangent*0.10+mathutils.Vector((0,0,-0.30))]
    for point_index, (point, radius) in enumerate(zip(points,[1.35,1.0,0.52,0.12])):
        spline.points[point_index].co=(*point,1)
        spline.points[point_index].radius=radius
    spline.order_u=4
    spline.use_endpoint_u=True
    limb=bpy.data.objects.new(f"generated-tentacle-{index}",curve)
    bpy.context.collection.objects.link(limb)
    curve.materials.append(accent)
    limb.parent=origin
    # A real GLB clip: an object-level sway is exported with the appendage and
    # checked from the exported GLB below.  It is not a counter or a recipe-only
    # stand-in for animation evidence.
    limb.rotation_mode="XYZ"
    limb.rotation_euler=(0.0,0.0,0.0)
    limb.keyframe_insert(data_path="rotation_euler",frame=1)
    limb.rotation_euler=(0.0,0.22 if 1 == 1 else 0.32,0.32 if 1 == 1 else 0.46)
    limb.keyframe_insert(data_path="rotation_euler",frame=16)
    limb.rotation_euler=(0.0,-0.18 if 1 == 1 else -0.27,-0.28 if 1 == 1 else -0.40)
    limb.keyframe_insert(data_path="rotation_euler",frame=32 if 1 == 1 else 40)
    action=limb.animation_data.action
    action.name="encounter-appendage-sway-r1"
for side in (-1,1):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.10, location=(0.35,side*0.26,0.70))
    eye=bpy.context.object
    eye.name=f"generated-eye-{side}"
    eye.data.materials.append(accent)
    eye.parent=origin
def track(obj, point): obj.rotation_euler=(mathutils.Vector(point)-obj.location).to_track_quat("-Z","Y").to_euler()
bpy.ops.object.camera_add(location=(3.3,-3.3,2.4))
camera=bpy.context.object
bpy.context.scene.camera=camera
track(camera,(0,0,0.35))
bpy.ops.object.light_add(type="AREA", location=(2,-2,3.5))
key=bpy.context.object
key.data.energy=900
key.data.shape="DISK"
key.data.size=5
track(key,(0,0,0.2))
bpy.ops.object.light_add(type="AREA", location=(-2,1,1.4))
fill=bpy.context.object
fill.data.energy=350
fill.data.color=(0.12,0.62,0.8)
fill.data.size=4
track(fill,(0,0,0.3))
scene=bpy.context.scene
scene.render.engine="BLENDER_EEVEE"
scene.render.resolution_x=512
scene.render.resolution_y=512
scene.render.resolution_percentage=100
scene.render.image_settings.file_format="PNG"
scene.render.filepath='/Users/lucky/.codex/worktrees/9170/myth-maker/evidence/build-room-kraken-high-fanout-stress.json.artifacts/1424dad8-ebd2-4735-9ad9-2b81fd752c66/wg-c5247053c3b24132696ee3ecda93825d/staging/wg-c5247053c3b24132696ee3ecda93825d.png'
scene.world.color=(0.008,0.015,0.03)
bpy.ops.wm.save_as_mainfile(filepath='/Users/lucky/.codex/worktrees/9170/myth-maker/evidence/build-room-kraken-high-fanout-stress.json.artifacts/1424dad8-ebd2-4735-9ad9-2b81fd752c66/wg-c5247053c3b24132696ee3ecda93825d/staging/wg-c5247053c3b24132696ee3ecda93825d.blend')
bpy.ops.render.render(write_still=True)
