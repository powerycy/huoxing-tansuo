"""Bake a supported walk on Sam's native IK rig; no browser pose overrides.

Retains the supplied Mixamo pelvis/chest rhythm and anatomical wrist/elbow
trajectories, with a shorter stride and an explicit heel/sole/toe support phase.
Video reference: jwbi2Y_kvws, 01:51–02:32 (visual reference, not extracted motion).
"""
import bpy
import math
import json
from pathlib import Path
from mathutils import Matrix, Quaternion, Vector

FPS = 60
PERIOD = 1.3
STEPS = round(PERIOD * FPS)
STANCE = 0.62
STRIDE = 0.60
SOLE_HEIGHT = 0.002
SPEED = STRIDE / (STANCE * PERIOD)
AXIS_X = Vector((1, 0, 0))
AXIS_Z = Vector((0, 0, 1))
IDENTITY = Quaternion()


def smooth_keys(p, keys):
    for (a, x), (b, y) in zip(keys, keys[1:]):
        if p <= b:
            t = max(0, (p-a)/(b-a))
            return x + (y-x) * (t*t*(3-2*t))
    return keys[-1][1]


def foot_path(p):
    if p <= STANCE:
        y = STRIDE * (p / STANCE - .5)
        lift = 0.0
    else:
        t = (p-STANCE)/(1-STANCE)
        # Match the stance velocity at both ends of the swing trajectory.
        tangent = STRIDE * (1-STANCE) / STANCE
        y = (2*t**3-3*t*t+1)*STRIDE/2 + (t**3-2*t*t+t)*tangent
        y += (-2*t**3+3*t*t)*(-STRIDE/2) + (t**3-t*t)*tangent
        lift = .057 * math.sin(math.pi*t)**1.45
    pitch = smooth_keys(p, [(0,-12),(.10,0),(.42,0),(.62,25),(.72,17),(.84,-2),(.95,-12),(1,-12)])
    return y, lift, math.radians(pitch)


def key_pose(bone, frame):
    bone.rotation_mode = 'QUATERNION'
    bone.keyframe_insert('location', frame=frame, group=bone.name)
    bone.keyframe_insert('rotation_quaternion', frame=frame, group=bone.name)


def place(bone, position, rotation):
    bone.rotation_mode = 'QUATERNION'
    bone.matrix = Matrix.LocRotScale(position, rotation, Vector((1,1,1)))


def child_position(bone):
    if not bone.parent: return bone.bone.head_local.copy()
    offset = bone.parent.bone.matrix_local.inverted() @ bone.bone.matrix_local
    return (bone.parent.matrix @ offset).translation


def boot_floor(obj):
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    value = min((evaluated.matrix_world @ v.co).z for v in mesh.vertices)
    evaluated.to_mesh_clear()
    return value


def bake_reference_walk(rig, path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=str(path))
    added = set(bpy.data.objects)-before
    source = next(o for o in added if o.type=='ARMATURE' and o.animation_data and o.animation_data.action)
    source_action = source.animation_data.action
    start,end=source_action.frame_range
    bpy.context.scene.render.fps = FPS
    # Source FBX was imported at 30 fps. It is sampled by its own frame range;
    # the target clip below uses 60 fps for contact and loop interpolation.
    sw = source.matrix_world
    spos=lambda name: sw @ source.pose.bones['mixamorig:'+name].head
    srot=lambda name: sw.to_quaternion() @ source.pose.bones['mixamorig:'+name].matrix.to_quaternion()
    srest=lambda name: sw.to_quaternion() @ source.data.bones['mixamorig:'+name].matrix_local.to_quaternion()
    delta=lambda name: srot(name) @ srest(name).inverted()

    roots=[]; ankle_y=[]
    for i in range(80):
        f=start+(end-start)*i/80
        bpy.context.scene.frame_set(int(f),subframe=f%1); bpy.context.view_layer.update()
        roots.append(spos('Hips'))
        ankle_y.append(spos('LeftFoot').y)
    mean=sum(roots,Vector())/len(roots)
    contact=ankle_y.index(min(ankle_y))/len(ankle_y)

    for track in rig.animation_data.nla_tracks: track.mute=True
    action=bpy.data.actions.new('Walk')
    rig.animation_data.action=action
    # Only native animation controls are authored. Deformation/support/twist
    # chains are evaluated by the production rig and baked by glTF export.
    controls=['c_root_master.x','c_root.x','c_spine_01.x','c_spine_02.x','c_spine_03.x','c_neck_master.x','c_head.x']
    for side in ('l','r'):
        controls += [f'{n}.{side}' for n in ('c_hand_ik','c_arm_fk','c_forearm_fk','c_hand_fk','c_foot_ik','c_arms_pole','c_leg_pole')]
        for name in ('c_arms_pole','c_leg_pole'):
            for constraint in rig.pose.bones[f'{name}.{side}'].constraints:
                constraint.mute=True
    boots={side:bpy.data.objects['boot'+side] for side in ('l','r')}
    report=[]
    for i in range(STEPS+1):
        # The last sample is exactly the first; no loop seam drift.
        phase=(i/STEPS)%1
        source_phase=(phase+contact)%1
        f=start+(end-start)*source_phase
        bpy.context.scene.frame_set(int(f),subframe=f%1)
        for name in controls: rig.pose.bones[name].matrix_basis.identity()
        bpy.context.view_layer.update()
        frame=i
        root=rig.pose.bones['c_root_master.x']
        movement=spos('Hips')-mean
        root_pos=root.bone.head_local + Vector((movement.x*.72, -.014+movement.y*.5, -.032+movement.z*.72))
        # Separate pelvis motion from the spine. The lumbar controls receive
        # absolute world orientations below, so this is not accumulated lean.
        root_delta=IDENTITY.slerp(delta('Hips'),.70)
        place(root,root_pos,Quaternion(AXIS_X,math.radians(2.0)) @ root_delta @ root.bone.matrix_local.to_quaternion())
        key_pose(root,frame); bpy.context.view_layer.update()

        for source_name,target_name,lean,keep in (
            ('Spine','c_spine_01.x',3.0,.8),
            ('Spine1','c_spine_02.x',4.0,.85),
            ('Spine2','c_spine_03.x',4.8,.9),
            ('Neck','c_neck_master.x',1.2,.7),
            ('Head','c_head.x',0.0,.55),
        ):
            bone=rig.pose.bones[target_name]
            rotation=Quaternion(AXIS_X,math.radians(lean)) @ IDENTITY.slerp(delta(source_name),keep) @ bone.bone.matrix_local.to_quaternion()
            place(bone,child_position(bone),rotation)
            key_pose(bone,frame); bpy.context.view_layer.update()

        foot_phases={}
        for side,word,sign,offset in [('l','Left',1,0),('r','Right',-1,.5)]:
            p=(phase+offset)%1; foot_phases[side]=p
            y,lift,pitch=foot_path(p)
            foot=rig.pose.bones[f'c_foot_ik.{side}']
            pos=foot.bone.head_local.copy(); pos.x=sign*.105; pos.y=y
            rotation=Quaternion(AXIS_X,pitch) @ foot.bone.matrix_local.to_quaternion()
            place(foot,pos,rotation)
            knee=rig.pose.bones[f'c_leg_pole.{side}']
            place(knee,Vector((sign*.13,-.52+y*.25,.46)),knee.bone.matrix_local.to_quaternion())
            key_pose(knee,frame)
            bpy.context.view_layer.update()
            # Place each deformed sole during the bake, not the character root
            # at runtime. Heel roll therefore raises the ankle and bends the
            # knee without bouncing or translating the complete character.
            for _ in range(2):
                pos.z += SOLE_HEIGHT+lift-boot_floor(boots[side])
                place(foot,pos,rotation); bpy.context.view_layer.update()
            key_pose(foot,frame)

            u=(spos(word+'ForeArm')-spos(word+'Arm')).normalized()
            v=(spos(word+'Hand')-spos(word+'ForeArm')).normalized()
            # Native FK preserves the measured upper/lower arm directions
            # without an IK pole flipping the elbow inward through the torso.
            u=Vector((max(sign*u.x,.06)*sign,u.y*.78,u.z)).normalized()
            v=Vector((max(sign*v.x,-.025)*sign,v.y*.84-.025,v.z)).normalized()
            switch=rig.pose.bones[f'c_hand_ik.{side}']
            switch['ik_fk_switch']=1.0
            switch.keyframe_insert(data_path='["ik_fk_switch"]',frame=frame)
            bpy.context.view_layer.update()
            for control,direction in [('c_arm_fk',u),('c_forearm_fk',v),('c_hand_fk',v)]:
                bone=rig.pose.bones[f'{control}.{side}']
                rest_dir=(bone.bone.tail_local-bone.bone.head_local).normalized()
                rotation=rest_dir.rotation_difference(direction) @ bone.bone.matrix_local.to_quaternion()
                place(bone,child_position(bone),rotation)
                key_pose(bone,frame); bpy.context.view_layer.update()
            grasp=rig.pose.bones[f'c_hand_fk.{side}']
            grasp['fingers_grasp']=.64
            grasp.keyframe_insert(data_path='["fingers_grasp"]',frame=frame)
        bpy.context.view_layer.update()
        floors={s:boot_floor(boots[s]) for s in boots}
        report.append({'phase':round(phase,4),'feet':floors,'root':list(root.head),'head':list(rig.pose.bones['head.x'].head)})

    # Linear keys preserve the measured 60 Hz trajectory and prevent Bezier
    # handles from dipping below the ground or overshooting a loop boundary.
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for fc in bag.fcurves:
                    for k in fc.keyframe_points: k.interpolation='LINEAR'
    rig.animation_data.action=None
    for track in rig.animation_data.nla_tracks: track.mute=False
    track=rig.animation_data.nla_tracks.new(); track.name='Walk'
    track.strips.new('Walk',0,action)
    rig['walk_speed_mps']=SPEED
    rig['walk_period_seconds']=PERIOD
    for o in added: bpy.data.objects.remove(o,do_unlink=True)
    audit=Path(__file__).resolve().parents[1]/'docs/animation-reference/walk-v3-measurements.json'
    audit.write_text(json.dumps({'fps':FPS,'period':PERIOD,'speed':SPEED,'stance':STANCE,'samples':report},indent=2))
    print('REFERENCE_WALK', 'frames',STEPS+1,'support max',max(min(s['feet'].values()) for s in report),'speed',SPEED,flush=True)
