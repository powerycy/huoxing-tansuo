"""Read-only rig and source-motion measurements for the independent preview."""
import bpy
import json
from mathutils import Vector

rig = bpy.data.objects['rig']
names = ['c_root_master.x','c_root.x','root.x','c_spine_01.x','c_spine_02.x','c_spine_03.x','c_head.x']
for side in ('l','r'):
    names += [f'{b}.{side}' for b in ['c_arm_fk','c_forearm_fk','c_hand_fk','c_hand_ik','c_arms_pole','c_foot_ik','c_leg_pole','thigh','leg','foot','toes_01','arm','forearm','hand']]
for name in names:
    bone = rig.pose.bones.get(name)
    if not bone: continue
    print('RIG', json.dumps({'name':name,'parent':bone.parent.name if bone.parent else None,'head':list(bone.bone.head_local),'tail':list(bone.bone.tail_local),'props':dict(bone.items()),'constraints':[(c.type,c.name,getattr(c,'subtarget','')) for c in bone.constraints]}))
print('RIG_WORLD',list(map(list,rig.matrix_world)))
print('RENDER_MESHES',[(o.name,len(o.data.vertices),list(o.dimensions)) for o in bpy.data.objects if o.type=='MESH' and o.visible_get() and not o.hide_render])
for source_path in [
    '/Users/yuanchaoyi/Documents/Ai项目/无限流游戏尝试/mars-delivery-v1/tools/mixamo/Walking-Male-Standard-InPlace.fbx',
    '/Users/yuanchaoyi/Documents/Ai项目/死亡搁浅/sedona-sunset/assets/models/Walking.glb',
]:
    before = set(bpy.data.objects)
    if source_path.endswith('.fbx'): bpy.ops.import_scene.fbx(filepath=source_path)
    else: bpy.ops.import_scene.gltf(filepath=source_path)
    added = set(bpy.data.objects)-before
    arm = next(o for o in added if o.type=='ARMATURE' and o.animation_data and (o.animation_data.action or o.animation_data.nla_tracks))
    if not arm.animation_data.action:
        arm.animation_data.action = arm.animation_data.nla_tracks[0].strips[0].action
        for track in arm.animation_data.nla_tracks: track.mute=True
    start,end=arm.animation_data.action.frame_range
    mx='mixamorig:Hips' in arm.pose.bones
    bnames = ['mixamorig:Hips','mixamorig:LeftUpLeg','mixamorig:LeftLeg','mixamorig:LeftFoot','mixamorig:LeftToeBase','mixamorig:RightFoot','mixamorig:LeftArm','mixamorig:LeftForeArm','mixamorig:LeftHand'] if mx else ['pelvis','thigh_l','calf_l','foot_l','ball_l','foot_r','upperarm_l','lowerarm_l','hand_l']
    print('SOURCE',source_path,'frames',start,end,'world',list(map(list,arm.matrix_world)))
    for name in bnames:
        b=arm.data.bones.get(name)
        if b: print('SOURCE_REST',name,list(arm.matrix_world@b.head_local),list(arm.matrix_world@b.tail_local))
    for i in range(9):
        f=start+(end-start)*i/8
        bpy.context.scene.frame_set(int(f),subframe=f-int(f));bpy.context.view_layer.update()
        print('SAMPLE',i,{n:[round(v,4) for v in arm.matrix_world@arm.pose.bones[n].head] for n in bnames if n in arm.pose.bones})
    for o in added: bpy.data.objects.remove(o,do_unlink=True)
