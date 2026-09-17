"""Prepare the authored Sam model for the browser walking prototype.

The source GLB was exported from SAM_PORTER_SUIT.blend with the Mixamo idle,
walk, run and backwards clips retargeted onto Sam's original deformation rig.
This pass keeps that rig and the clips intact while limiting embedded textures
to 1K so the first playable character build does not add a 127 MB download.
"""

from pathlib import Path

import bpy


SOURCE = Path(
    "/Users/yuanchaoyi/Documents/Ai项目/死亡搁浅/sedona-sunset/"
    "assets/models/SamPorterAnimated.glb"
)
OUTPUT = Path(
    "/Users/yuanchaoyi/Documents/Ai项目/无限流游戏尝试/mars-delivery-v1/"
    "assets/models/sam/sam-porter-walk.glb"
)
MAX_TEXTURE_SIZE = 1024


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(SOURCE))

scaled = []
for image in bpy.data.images:
    width, height = image.size
    largest = max(width, height)
    if width < 1 or height < 1 or largest <= MAX_TEXTURE_SIZE:
        continue
    factor = MAX_TEXTURE_SIZE / largest
    target_width = max(1, round(width * factor))
    target_height = max(1, round(height * factor))
    image.scale(target_width, target_height)
    scaled.append((image.name, width, height, target_width, target_height))

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=str(OUTPUT),
    export_format="GLB",
    use_selection=False,
    export_animations=True,
    export_animation_mode="NLA_TRACKS",
    export_bake_animation=True,
    export_skins=True,
    export_morph=False,
    export_cameras=False,
    export_lights=False,
    export_yup=True,
)

print(
    f"SAM_BROWSER_EXPORT {OUTPUT} {OUTPUT.stat().st_size} bytes "
    f"{len(bpy.data.objects)} objects {len(bpy.data.actions)} actions "
    f"{len(scaled)} textures scaled"
)
