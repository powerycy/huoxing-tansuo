"""Build the compact Death Stranding cargo stack used by the character preview.

Run with Blender:
  blender --background --factory-startup --python tools/prepare_ds_weighted_loadout.py
"""

from pathlib import Path
import math

import bpy
from mathutils import Matrix, Vector


RESOURCE_ROOT = Path(
    "/Users/yuanchaoyi/Documents/Ai项目/死亡搁浅/Death Stranding_resources/Items"
)
PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT = PROJECT_ROOT / "assets/models/cargo/ds-weighted-loadout.glb"

ASSETS = {
    "rack": {
        "mesh": RESOURCE_ROOT
        / "bak0_backpack0/core/bak0_main_def/model/parts/mesh_main_lx.core_0 smd.fbx",
        "color": RESOURCE_ROOT
        / "bak0_backpack0/core/bak0_textures/textures/textures/bak0_main_def_set_1_type_1.dds",
        "normal": RESOURCE_ROOT
        / "bak0_backpack0/core/bak0_textures/textures/textures/bak0_main_def_set_0_type_3_dx10.dds",
        "position": (0.0, 0.300, -0.010),
    },
    "medium": {
        "mesh": RESOURCE_ROOT
        / "bmd0_baggagemedium0/core/bmd0_main_def/model/parts/mesh_main_lx.core_0 smd.fbx",
        "color": RESOURCE_ROOT
        / "bmd0_baggagemedium0/core/bmd0_textures/textures/textures/bmd0_main_def_set_1_type_1.dds",
        "normal": RESOURCE_ROOT
        / "bmd0_baggagemedium0/core/bmd0_textures/textures/textures/bmd0_main_def_set_0_type_3_dx10.dds",
        "position": (0.0, 0.194, -0.105),
    },
    "small": {
        "mesh": RESOURCE_ROOT
        / "bsm0_baggagesmall0/core/bsm0_main_def/model/parts/mesh_main_lx.core_0 smd.fbx",
        "color": RESOURCE_ROOT
        / "bsm0_baggagesmall0/core/bsm0_textures/textures/textures/bsm0_main_def_set_1_type_1.dds",
        "normal": RESOURCE_ROOT
        / "bsm0_baggagesmall0/core/bsm0_textures/textures/textures/bsm0_main_def_set_0_type_3_dx10.dds",
        "position": (0.0, 0.534, -0.105),
    },
    "slim": {
        "mesh": RESOURCE_ROOT
        / "bsm1_baggagesmall1/core/bsm1_main_def/model/parts/mesh_main_lx.core_0 smd.fbx",
        "color": RESOURCE_ROOT
        / "bsm1_baggagesmall1/core/bsm1_textures/textures/textures/bsm1_main_def_set_1_type_1.dds",
        "normal": RESOURCE_ROOT
        / "bsm1_baggagesmall1/core/bsm1_textures/textures/textures/bsm1_main_def_set_0_type_3_dx10.dds",
        "position": (0.0, 0.819, -0.095),
    },
}


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for datablock in list(datablocks):
            if datablock.users == 0:
                datablocks.remove(datablock)


def world_bounds(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    minimum = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
    maximum = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
    return minimum, maximum


def make_material(name, color_path, normal_path):
    material = bpy.data.materials.new(name=f"{name}_material")
    material.use_nodes = True
    material.diffuse_color = (0.28, 0.30, 0.31, 1.0)
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    principled = nodes.get("Principled BSDF")
    principled.inputs["Metallic"].default_value = 0.28
    principled.inputs["Roughness"].default_value = 0.46

    color_image = bpy.data.images.load(str(color_path), check_existing=True)
    color_node = nodes.new("ShaderNodeTexImage")
    color_node.name = f"{name}_base_color"
    color_node.image = color_image
    color_node.image.colorspace_settings.name = "sRGB"
    links.new(color_node.outputs["Color"], principled.inputs["Base Color"])

    normal_image = bpy.data.images.load(str(normal_path), check_existing=True)
    normal_node = nodes.new("ShaderNodeTexImage")
    normal_node.name = f"{name}_normal"
    normal_node.image = normal_image
    normal_node.image.colorspace_settings.name = "Non-Color"
    normal_map = nodes.new("ShaderNodeNormalMap")
    normal_map.inputs["Strength"].default_value = 0.72
    links.new(normal_node.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], principled.inputs["Normal"])
    return material


def import_asset(name, spec, parent):
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.fbx(filepath=str(spec["mesh"]), use_anim=False)
    imported = [obj for obj in bpy.context.scene.objects if obj not in before]
    meshes = [obj for obj in imported if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"No mesh imported for {name}")

    material = make_material(name, spec["color"], spec["normal"])
    for obj in meshes:
        # The extracted FBX files carry a 0.01 scene scale. Restoring that scale
        # produces the original metric dimensions (for example 0.548 m wide).
        obj.scale *= 100.0
        obj.data.materials.clear()
        obj.data.materials.append(material)

    bpy.context.view_layer.update()
    minimum, maximum = world_bounds(meshes)
    center = (minimum + maximum) * 0.5
    for obj in meshes:
        world = obj.matrix_world.copy()
        world.translation -= center
        # Decima's extracted FBX payloads arrive Z-up inside an additional FBX
        # X rotation. Bake one explicit quarter-turn so the browser sees the
        # long case dimension as Y (height), not Z (depth).
        world = Matrix.Rotation(math.radians(90.0), 4, "X") @ world
        obj.parent = parent
        obj.matrix_world = world
        obj.location += Vector(spec["position"])
        obj.name = f"cargo_{name}"
        obj.data.name = f"cargo_{name}_mesh"
    for obj in imported:
        if obj.type != "MESH":
            bpy.data.objects.remove(obj, do_unlink=True)


clear_scene()
root = bpy.data.objects.new("weighted_cargo_root", None)
bpy.context.scene.collection.objects.link(root)

for asset_name, asset_spec in ASSETS.items():
    import_asset(asset_name, asset_spec, root)

bpy.context.view_layer.update()
# Four 4K source textures are unnecessary for a half-screen character preview.
# Downscaling in memory keeps the GLB fast to load without altering source DDS.
for image in bpy.data.images:
    width, height = image.size
    longest = max(width, height)
    if longest > 1024:
        factor = 1024.0 / longest
        image.scale(max(1, round(width * factor)), max(1, round(height * factor)))

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="DESELECT")
root.select_set(True)
for child in root.children_recursive:
    child.select_set(True)
bpy.context.view_layer.objects.active = root

bpy.ops.export_scene.gltf(
    filepath=str(OUTPUT),
    export_format="GLB",
    use_selection=True,
    export_materials="EXPORT",
    export_image_format="AUTO",
    export_texcoords=True,
    export_normals=True,
    export_tangents=True,
    export_yup=True,
)

minimum, maximum = world_bounds([obj for obj in root.children_recursive if obj.type == "MESH"])
size = maximum - minimum
print(f"Exported {OUTPUT}")
print(f"Loadout dimensions: {size.x:.3f} x {size.y:.3f} x {size.z:.3f} m")
