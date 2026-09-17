"""Convert the supplied Death Stranding standard car FBX to a browser GLB.

Run with:
  blender --background --factory-startup --python tools/convert_ds_standard_car.py
"""

from pathlib import Path

import bpy


PROJECT = Path(__file__).resolve().parents[1]
RESOURCE_ROOT = Path("/Users/yuanchaoyi/Documents/Ai项目/死亡搁浅/Death Stranding_resources")
SOURCE = RESOURCE_ROOT / (
    "Mech/cast_carstandard/core/cast_main_fgh/model/parts/join_geo/"
    "__join__skeleton_jnt_c_b_000_root ascii.fbx"
)
NORMAL = RESOURCE_ROOT / (
    "Mech/cast_carstandard/core/cast_textures/textures/textures/"
    "cast_main_fgh_set_0_type_3_dx10.dds"
)
OUTPUT = PROJECT / "assets/models/ds-standard-car/ds-standard-car.glb"


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def socket(node, *names):
    for name in names:
        if name in node.inputs:
            return node.inputs[name]
    return None


def build_body_material():
    material = bpy.data.materials.new("DS_STANDARD_CAR_BODY")
    material.use_nodes = True
    material.diffuse_color = (0.055, 0.065, 0.07, 1.0)
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    socket(bsdf, "Base Color").default_value = (0.055, 0.065, 0.07, 1.0)
    socket(bsdf, "Metallic").default_value = 0.68
    socket(bsdf, "Roughness").default_value = 0.43

    image = bpy.data.images.load(str(NORMAL), check_existing=True)
    image.colorspace_settings.name = "Non-Color"
    texture = material.node_tree.nodes.new("ShaderNodeTexImage")
    texture.name = "DS vehicle normal"
    texture.image = image
    normal = material.node_tree.nodes.new("ShaderNodeNormalMap")
    normal.inputs["Strength"].default_value = 0.56
    material.node_tree.links.new(texture.outputs["Color"], normal.inputs["Color"])
    material.node_tree.links.new(normal.outputs["Normal"], socket(bsdf, "Normal"))
    return material


def build_grid_material():
    material = bpy.data.materials.new("DS_STANDARD_CAR_GRID")
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    socket(bsdf, "Base Color").default_value = (0.005, 0.12, 0.16, 1.0)
    socket(bsdf, "Metallic").default_value = 0.20
    socket(bsdf, "Roughness").default_value = 0.28
    emission = socket(bsdf, "Emission Color", "Emission")
    if emission:
        emission.default_value = (0.0, 0.65, 0.92, 1.0)
    strength = socket(bsdf, "Emission Strength")
    if strength:
        strength.default_value = 2.2
    return material


clear_scene()
bpy.ops.import_scene.fbx(filepath=str(SOURCE))

# The extractor stores centimetre-scale transforms on the skeleton root. A
# common 100x root scale preserves the skin and all six named wheel bones while
# keeping a compact GLB; the runtime performs the final metre-scale fit.
for root in [obj for obj in bpy.context.scene.objects if obj.parent is None]:
    root.scale *= 100.0

body_material = build_body_material()
grid_material = build_grid_material()
for obj in [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]:
    obj.data.materials.clear()
    obj.data.materials.append(grid_material if obj.name.startswith("0000") else body_material)

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
bpy.context.view_layer.update()
bpy.ops.export_scene.gltf(
    filepath=str(OUTPUT),
    export_format="GLB",
    export_materials="EXPORT",
    export_cameras=False,
    export_lights=False,
)
print(f"Exported {OUTPUT}")
