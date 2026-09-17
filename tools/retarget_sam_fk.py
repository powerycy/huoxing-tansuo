"""Bake a clean Mixamo walk onto Sam's animator-facing controls.

The earlier prototype wrote full rotations into hundreds of deformation and
twist bones. Rotations then accumulated down the support chains, which pulled
the arms apart and twisted the legs. This version leaves the authored rig and
its constraints intact, uses native IK for the limbs, and animates pelvis,
spine and shoulder counter-rotation as one gait system. The rig distributes
those controls over its own twist/support bones.
"""

from pathlib import Path
import math
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector


PROJECT = Path("/Users/yuanchaoyi/Documents/Ai项目/无限流游戏尝试/mars-delivery-v1")
CLIP_ROOT = Path("/Users/yuanchaoyi/Documents/Ai项目/死亡搁浅/sedona-sunset/assets/models")
OUTPUT = PROJECT / "assets/models/sam/sam-porter-walk-v2.glb"
REFERENCE_WALK = '--reference-walk' in sys.argv
if REFERENCE_WALK:
    OUTPUT = PROJECT / 'assets/models/sam/sam-porter-walk-v3.glb'
MAX_TEXTURE_SIZE = 1024
FACE_TEXTURE_SIZE = 2048

# Keep only the expressions needed by the browser preview. The source face has
# 52 ARKit-style targets on every facial mesh; exporting all of them would
# multiply the GLB size for expressions this prototype never uses.
FACE_MORPH_NAMES = {
    "eyeBlinkLeft",
    "eyeBlinkRight",
    "jawOpen",
    "mouthSmileLeft",
    "mouthSmileRight",
    "mouthFrownLeft",
    "mouthFrownRight",
    "browDownLeft",
    "browDownRight",
    "browInnerUp",
}
FACE_TEXTURE_PREFIXES = ("sam_head_face_def_set_",)

CLIPS = {
    "Idle": CLIP_ROOT / "Idle.glb",
    "Walk": PROJECT / "tools/mixamo/Walking-Male-Standard-InPlace.fbx",
}

# The source clips supply timing only. Sam's unusually elaborate production
# rig uses different limb axes, so its native IK controls produce a cleaner
# first playable walk than cross-rig FK deltas.
BONE_MAP = []

HAND_CONTROLS = ("c_hand_ik.l", "c_hand_ik.r")
FOOT_CONTROLS = ("c_foot_ik.l", "c_foot_ik.r")
BODY_CONTROLS = (
    "c_root_master.x",
    "c_spine_01.x",
    "c_spine_02.x",
    "c_spine_03.x",
    "c_neck_master.x",
    "c_head.x",
)


SOURCE_BONES = (
    "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "head",
    "hand_l", "hand_r", "foot_l", "foot_r",
)

MIXAMO_BONES = {
    "pelvis": "mixamorig:Hips",
    "spine_01": "mixamorig:Spine",
    "spine_02": "mixamorig:Spine1",
    "spine_03": "mixamorig:Spine2",
    "neck_01": "mixamorig:Neck",
    "head": "mixamorig:Head",
    "hand_l": "mixamorig:LeftHand",
    "hand_r": "mixamorig:RightHand",
    "foot_l": "mixamorig:LeftFoot",
    "foot_r": "mixamorig:RightFoot",
}


def resolve_source_bone(source, semantic_name):
    if semantic_name in source.pose.bones:
        return semantic_name
    mixamo_name = MIXAMO_BONES.get(semantic_name)
    if mixamo_name and mixamo_name in source.pose.bones:
        return mixamo_name
    raise RuntimeError(f"Missing source bone for {semantic_name}")


def source_position(source, bone_name):
    return source.matrix_world @ source.pose.bones[resolve_source_bone(source, bone_name)].head


def source_rotation(source, bone_name):
    resolved = resolve_source_bone(source, bone_name)
    return source.matrix_world.to_quaternion() @ source.pose.bones[resolved].matrix.to_quaternion()


def capture_source_reference(source, start, end):
    """Measure the whole clip instead of pretending frame one is the floor.

    Mixamo walk cycles commonly begin mid-step. Using that first pose as the
    neutral foot pose made both of Sam's boots snap together at the loop seam
    and lifted both feet during the opposing stride. Each foot now gets its
    own ground height, stride centre and planted rotation from the full clip.
    """
    samples = {name: [] for name in SOURCE_BONES}
    rotations = {name: [] for name in SOURCE_BONES}
    for frame in range(start, end + 1):
        bpy.context.scene.frame_set(frame)
        bpy.context.view_layer.update()
        for name in SOURCE_BONES:
            samples[name].append(source_position(source, name))
            rotations[name].append(source_rotation(source, name))

    bpy.context.scene.frame_set(start)
    bpy.context.view_layer.update()
    refs = {
        "position": {name: values[0] for name, values in samples.items()},
        "rotation": {name: values[0] for name, values in rotations.items()},
        "foot_center": {},
        "foot_ground": {},
        "foot_ground_rotation": {},
    }
    for side in ("l", "r"):
        name = f"foot_{side}"
        values = samples[name]
        planted_index = min(range(len(values)), key=lambda index: values[index].z)
        refs["foot_center"][side] = Vector((
            sum(value.x for value in values) / len(values),
            sum(value.y for value in values) / len(values),
            0.0,
        ))
        refs["foot_ground"][side] = values[planted_index].z
        refs["foot_ground_rotation"][side] = rotations[name][planted_index]
    return refs


def rotation_delta(source, refs, bone_name):
    return source_rotation(source, bone_name) @ refs["rotation"][bone_name].inverted()


def pose_feet_and_body(rig, source, refs, frame):
    """Transfer the mocap pelvis and ankle trajectories into Sam's leg IK."""
    root = rig.pose.bones["c_root_master.x"]
    root.rotation_mode = "QUATERNION"
    root_rest = root.bone.matrix_local
    source_root = source_position(source, "pelvis")
    source_root_ref = refs["position"]["pelvis"]
    root_delta = source_root - source_root_ref
    root_delta.x *= 0.90
    root_delta.y *= 0.90
    root_delta.z *= 0.55
    root.matrix = Matrix.LocRotScale(
        root_rest.translation + root_delta,
        rotation_delta(source, refs, "pelvis")
        @ Quaternion(Vector((1.0, 0.0, 0.0)), 0.035)
        @ root_rest.to_quaternion(),
        Vector((1.0, 1.0, 1.0)),
    )
    root.keyframe_insert("location", frame=frame, group=root.name)
    root.keyframe_insert("rotation_quaternion", frame=frame, group=root.name)

    source_feet = {
        side: source_position(source, f"foot_{side}")
        for side in ("l", "r")
    }
    raw_lifts = {
        side: max(0.0, source_feet[side].z - refs["foot_ground"][side])
        for side in ("l", "r")
    }
    # This source clip contains a short flight phase. A loaded walk must always
    # retain support, so lower the pair together until the lower ankle is the
    # planted foot while preserving the swing foot's relative clearance.
    support_offset = min(raw_lifts.values())

    for side in ("l", "r"):
        source_name = f"foot_{side}"
        foot = rig.pose.bones[f"c_foot_ik.{side}"]
        foot.rotation_mode = "QUATERNION"
        rest = foot.bone.matrix_local
        source_foot = source_feet[side]
        stride_center = refs["foot_center"][side]
        foot_offset = Vector((
            (source_foot.x - stride_center.x) * 0.90,
            (source_foot.y - stride_center.y) * 0.86,
            raw_lifts[side] - support_offset,
        ))
        planted_rotation = refs["foot_ground_rotation"][side]
        foot_rotation = source_rotation(source, source_name) @ planted_rotation.inverted()
        foot.matrix = Matrix.LocRotScale(
            rest.translation + foot_offset,
            foot_rotation @ rest.to_quaternion(),
            Vector((1.0, 1.0, 1.0)),
        )
        foot.keyframe_insert("location", frame=frame, group=foot.name)
        foot.keyframe_insert("rotation_quaternion", frame=frame, group=foot.name)


def pose_upper_body(rig, source, refs, frame):
    """Transfer mocap ribcage counter-rotation and head stabilization."""
    mapping = (
        ("spine_01", "c_spine_01.x", 0.020),
        ("spine_02", "c_spine_02.x", 0.028),
        ("spine_03", "c_spine_03.x", 0.035),
        ("neck_01", "c_neck_master.x", 0.020),
        ("head", "c_head.x", 0.010),
    )
    for source_name, control_name, lean in mapping:
        control = rig.pose.bones[control_name]
        control.rotation_mode = "QUATERNION"
        rest = control.bone.matrix_local
        control.matrix = Matrix.LocRotScale(
            rest_child_translation(control),
            rotation_delta(source, refs, source_name)
            @ Quaternion(Vector((1.0, 0.0, 0.0)), lean)
            @ rest.to_quaternion(),
            Vector((1.0, 1.0, 1.0)),
        )
        control.keyframe_insert("rotation_quaternion", frame=frame, group=control.name)


def pose_hands(rig, source, refs, frame):
    """Use the mocap wrist arcs while Sam's IK solves shoulders and elbows."""
    source_root = source_position(source, "pelvis")
    source_root_ref = refs["position"]["pelvis"]
    target_root_rest = rig.data.bones["c_root_master.x"].matrix_local.translation
    root_delta = source_root - source_root_ref
    root_delta.x *= 0.90
    root_delta.y *= 0.90
    root_delta.z *= 0.55

    for side, sign in (("l", 1.0), ("r", -1.0)):
        source_name = f"hand_{side}"
        current_relative = source_position(source, source_name) - source_root
        reference_relative = refs["position"][source_name] - source_root_ref
        target_reference = target_root_rest + reference_relative * 1.04
        target_reference.z -= 0.025

        hand = rig.pose.bones[f"c_hand_ik.{side}"]
        hand.rotation_mode = "QUATERNION"
        rest = hand.bone.matrix_local
        rest_direction = (hand.bone.tail_local - hand.bone.head_local).normalized()
        relaxed_direction = Vector((0.08 * sign, -0.18, -1.0)).normalized()
        wrist_correction = rest_direction.rotation_difference(relaxed_direction)
        hand.matrix = Matrix.LocRotScale(
            target_reference + root_delta + (current_relative - reference_relative) * 0.82,
            rotation_delta(source, refs, source_name)
            @ wrist_correction
            @ rest.to_quaternion(),
            Vector((1.0, 1.0, 1.0)),
        )
        hand.keyframe_insert("location", frame=frame, group=hand.name)
        hand.keyframe_insert("rotation_quaternion", frame=frame, group=hand.name)

        finger_control = rig.pose.bones[f"c_hand_fk.{side}"]
        # A loaded courier keeps the fingers relaxed around an imaginary grip;
        # the previous 0.46 value still exported as a visibly splayed hand.
        finger_control["fingers_grasp"] = 0.64
        finger_control.keyframe_insert(
            data_path='["fingers_grasp"]', frame=frame, group=finger_control.name
        )


def source_animation(path):
    before_objects = set(bpy.data.objects)
    before_actions = set(bpy.data.actions)
    if path.suffix.lower() == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path))
    else:
        bpy.ops.import_scene.gltf(filepath=str(path))
    objects = [obj for obj in bpy.data.objects if obj not in before_objects]
    actions = [action for action in bpy.data.actions if action not in before_actions]
    armatures = [obj for obj in objects if obj.type == "ARMATURE"]

    source = next(
        (obj for obj in armatures if obj.animation_data and obj.animation_data.action),
        None,
    )
    if source is None:
        for obj in armatures:
            data = obj.animation_data
            strips = [
                strip
                for track in (data.nla_tracks if data else [])
                for strip in track.strips
            ]
            if strips:
                source = obj
                data.action = strips[0].action
                break
    if source is None or not actions:
        raise RuntimeError(f"No source animation in {path}")
    action = source.animation_data.action or actions[0]
    source.animation_data.action = action
    return source, action, objects, actions


def rest_child_translation(pose_bone):
    rest = pose_bone.bone.matrix_local
    if not pose_bone.parent:
        return rest.translation.copy()
    parent_rest = pose_bone.parent.bone.matrix_local
    local_rest = parent_rest.inverted() @ rest
    return (pose_bone.parent.matrix @ local_rest).translation


def bake_clip(rig, name, path):
    source, source_action, imported_objects, imported_actions = source_animation(path)
    start = math.floor(source_action.frame_range[0])
    end = math.ceil(source_action.frame_range[1])
    action = bpy.data.actions.new(name=name)
    rig.animation_data_create()
    rig.animation_data.action = action

    bpy.context.scene.frame_set(start)
    bpy.context.view_layer.update()
    source_reference = capture_source_reference(source, start, end)

    ordered = sorted(
        BONE_MAP,
        key=lambda pair: len(rig.data.bones[pair[1]].parent_recursive),
    )
    source_object_rotation = source.matrix_world.to_quaternion()
    target_object_rotation = rig.matrix_world.to_quaternion()

    for frame in range(start, end + 1):
        bpy.context.scene.frame_set(frame)
        # Reset only the controls this clip owns. The production constraints
        # and support bones must remain live so the suit deforms as authored.
        for _, target_name in ordered:
            target = rig.pose.bones[target_name]
            target.matrix_basis.identity()
        for control_name in HAND_CONTROLS + FOOT_CONTROLS + BODY_CONTROLS:
            rig.pose.bones[control_name].matrix_basis.identity()
        bpy.context.view_layer.update()

        for source_name, target_name in ordered:
            source_pose = source.pose.bones.get(source_name)
            source_rest = source.data.bones.get(source_name)
            target_pose = rig.pose.bones.get(target_name)
            target_rest = rig.data.bones.get(target_name)
            if not all((source_pose, source_rest, target_pose, target_rest)):
                raise RuntimeError(f"Missing retarget bone {source_name} -> {target_name}")

            source_rest_world = source_object_rotation @ source_rest.matrix_local.to_quaternion()
            source_pose_world = source_object_rotation @ source_pose.matrix.to_quaternion()
            source_delta_world = source_pose_world @ source_rest_world.inverted()
            target_rest_world = target_object_rotation @ target_rest.matrix_local.to_quaternion()
            target_world_rotation = source_delta_world @ target_rest_world
            target_armature_rotation = target_object_rotation.inverted() @ target_world_rotation

            target_pose.matrix = Matrix.LocRotScale(
                rest_child_translation(target_pose),
                target_armature_rotation,
                Vector((1.0, 1.0, 1.0)),
            )
            target_pose.rotation_mode = "QUATERNION"
            target_pose.keyframe_insert("rotation_quaternion", frame=frame, group=target_name)

        pose_feet_and_body(rig, source, source_reference, frame)
        pose_upper_body(rig, source, source_reference, frame)
        pose_hands(rig, source, source_reference, frame)
        bpy.context.view_layer.update()

    rig.animation_data.action = None
    track = rig.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, start, action)

    for obj in imported_objects:
        bpy.data.objects.remove(obj, do_unlink=True)
    for imported_action in imported_actions:
        if imported_action.users == 0:
            bpy.data.actions.remove(imported_action)
    print(f"FK_RETARGETED {name} frames {start}-{end}")


rig = bpy.data.objects.get("rig")
if rig is None:
    raise RuntimeError("Sam rig not found")

# Sam's native IK solves elbows, knees, twist chains and suit support bones.
for side in ("l", "r"):
    rig.pose.bones[f"c_hand_ik.{side}"]["ik_fk_switch"] = 0.0
    rig.pose.bones[f"c_foot_ik.{side}"]["ik_fk_switch"] = 0.0

for action in list(bpy.data.actions):
    bpy.data.actions.remove(action)
if rig.animation_data:
    # animation_data_clear also deletes native constraint/custom-property
    # drivers. Keep those alive: otherwise IK/FK switches and finger grasp
    # values have no effect and support chains are frozen in their old mode.
    rig.animation_data.action = None
    for track in list(rig.animation_data.nla_tracks):
        rig.animation_data.nla_tracks.remove(track)

bpy.context.scene.render.fps = 30
for clip_name, clip_path in CLIPS.items():
    if REFERENCE_WALK and clip_name == 'Walk':
        sys.path.insert(0, str(PROJECT / 'tools'))
        from sam_reference_walk import bake_reference_walk
        bake_reference_walk(rig, clip_path)
    else:
        bake_clip(rig, clip_name, clip_path)

# Strip unused facial targets before export, but keep the original neutral
# Basis. Drivers are Blender-only rig machinery; the browser controls the kept
# morphs directly, so clear those drivers and reset the neutral values here.
kept_morph_targets = 0
for obj in bpy.context.scene.objects:
    if obj.type != "MESH" or not obj.data.shape_keys:
        continue
    shape_keys = obj.data.shape_keys
    if shape_keys.animation_data:
        shape_keys.animation_data_clear()
    for key in shape_keys.key_blocks:
        key.value = 0.0
    for key in reversed(list(shape_keys.key_blocks)[1:]):
        if key.name not in FACE_MORPH_NAMES:
            obj.shape_key_remove(key)
    kept_morph_targets += max(0, len(shape_keys.key_blocks) - 1)

# Keep the two original 2K face maps; bound the rest to 1K for the browser.
used_images = set()
for obj in bpy.context.scene.objects:
    if obj.type != "MESH" or not obj.visible_get() or obj.hide_render:
        continue
    for slot in obj.material_slots:
        material = slot.material
        if not material or not material.use_nodes or not material.node_tree:
            continue
        for node in material.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image:
                used_images.add(node.image)

scaled = 0
for image in used_images:
    width, height = image.size
    largest = max(width, height)
    limit = (
        FACE_TEXTURE_SIZE
        if image.name.startswith(FACE_TEXTURE_PREFIXES)
        else MAX_TEXTURE_SIZE
    )
    if width < 1 or height < 1 or largest <= limit:
        continue
    factor = limit / largest
    image.scale(max(1, round(width * factor)), max(1, round(height * factor)))
    scaled += 1

for obj in bpy.context.scene.objects:
    obj.select_set(False)
selected = []
for obj in bpy.context.scene.objects:
    # The cuff uses a second armature that is not part of this first retarget.
    # Excluding it prevents the prop from floating beside Sam in the browser.
    render_mesh = (
        obj.type == "MESH"
        and obj.name != "cuffs"
        and obj.visible_get()
        and not obj.hide_render
    )
    required_rig = obj.name == "rig"
    if render_mesh or required_rig:
        obj.hide_set(False)
        obj.select_set(True)
        selected.append(obj)

bpy.context.view_layer.objects.active = rig
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(OUTPUT),
    export_format="GLB",
    use_selection=True,
    export_animations=True,
    export_animation_mode="NLA_TRACKS",
    export_bake_animation=True,
    export_skins=True,
    export_morph=True,
    export_morph_normal=False,
    export_morph_tangent=False,
    export_cameras=False,
    export_lights=False,
    export_yup=True,
)

print(
    f"SAM_FK_EXPORT {OUTPUT} {OUTPUT.stat().st_size} bytes "
    f"{len(selected)} objects {len(bpy.data.actions)} actions "
    f"{kept_morph_targets} morph targets {scaled} textures scaled"
)
