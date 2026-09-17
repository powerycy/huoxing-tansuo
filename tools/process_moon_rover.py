"""Prepare Watndit's Sketchfab Moon rover for the REGOLITH runtime.

Usage:
  blender -b --python tools/process_moon_rover.py -- input.glb output.glb

The source deliberately ships as a single object.  Its six wheels are made of
thousands of disconnected pieces, so this script groups those pieces around
the measured hub centres and exports named wheel pivots.  The browser can then
spin and steer the wheels while keeping the original UVs and 4K PBR textures.
"""

from pathlib import Path
import sys

import bpy
from mathutils import Vector


HUB_X = (0.226, 2.107, 3.969)
HUB_Y = (-1.346, 1.346)
HUB_Z = -1.314
AXLE_NAMES = ("Front", "Middle", "Rear")
SIDE_NAMES = ("Neg", "Pos")
WHEEL_RADIAL_LIMIT = 0.83
WHEEL_HALF_WIDTH = 0.55


def join_objects(objects, name):
    if not objects:
        raise RuntimeError(f"No geometry collected for {name}")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    joined.name = name
    return joined


def bounds(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    low = Vector((
        min(point.x for point in points),
        min(point.y for point in points),
        min(point.z for point in points),
    ))
    high = Vector((
        max(point.x for point in points),
        max(point.y for point in points),
        max(point.z for point in points),
    ))
    return low, high


def belongs_to_wheel(obj, hub):
    low, high = bounds(obj)
    corners = (
        Vector((x, y, z))
        for x in (low.x, high.x)
        for y in (low.y, high.y)
        for z in (low.z, high.z)
    )
    hx, hy, hz = hub
    return all(
        abs(point.y - hy) < WHEEL_HALF_WIDTH
        and ((point.x - hx) ** 2 + (point.z - hz) ** 2) ** 0.5 < WHEEL_RADIAL_LIMIT
        for point in corners
    )


def set_origin_world(obj, point):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.context.scene.cursor.location = point
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR", center="MEDIAN")


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if len(args) != 2:
        raise SystemExit("Expected input and output GLB paths after --")

    source = Path(args[0]).expanduser().resolve()
    output = Path(args[1]).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=str(source))

    surfaces = [
        obj for obj in bpy.context.scene.objects
        if obj.type == "MESH" and "Surfaces" in obj.name
    ]
    surface = join_objects(surfaces, "MoonRoverSurface")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")
    pieces = [obj for obj in bpy.context.selected_objects if obj.type == "MESH"]

    hubs = [
        (x, y, HUB_Z)
        for x in HUB_X
        for y in HUB_Y
    ]
    wheel_pieces = [[] for _ in hubs]
    body_pieces = []
    for piece in pieces:
        match = next(
            (index for index, hub in enumerate(hubs) if belongs_to_wheel(piece, hub)),
            None,
        )
        if match is None:
            body_pieces.append(piece)
        else:
            wheel_pieces[match].append(piece)

    join_objects(body_pieces, "MoonRoverBody")
    for index, group in enumerate(wheel_pieces):
        axle = index // 2
        side = index % 2
        name = f"Wheel_{AXLE_NAMES[axle]}_{SIDE_NAMES[side]}"
        wheel = join_objects(group, name)
        set_origin_world(wheel, Vector(hubs[index]))

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        export_apply=False,
        export_cameras=False,
        export_lights=False,
    )

    print(f"Exported prepared Moon rover: {output}")


if __name__ == "__main__":
    main()
