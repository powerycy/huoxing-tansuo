"""Independent rockfall study: closed fracture cells, offline Bullet, baked GLB.
Run with Blender --background --python tools/build-collapse-study.py.
Does not read or modify game saves, terrain, physics, or event code.
"""
import bpy, bmesh, math, random, json
from pathlib import Path
from mathutils import Vector, Matrix

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'assets/models/collapse-study'
OUT.mkdir(parents=True,exist_ok=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene
DURATION=22;LAST=24*DURATION+1
scene.render.fps=24;scene.frame_start=1;scene.frame_end=LAST
scene.gravity=(0,0,-1.62) # same low-gravity scale, not an Earth-gravity shortcut
rng=random.Random(718)

def stone(name,interior=False):
    mat=bpy.data.materials.new(name);mat.use_nodes=True
    nodes=mat.node_tree.nodes;links=mat.node_tree.links;p=nodes.get('Principled BSDF')
    p.inputs['Roughness'].default_value=.91
    image=nodes.new('ShaderNodeTexImage')
    image.image=bpy.data.images.load(str(ROOT/'assets/models/moon-rocks/moon_rock_01/textures/moon_rock_01_diff_1k.jpg'),check_existing=True)
    links.new(image.outputs['Color'],p.inputs['Base Color'])
    normal=nodes.new('ShaderNodeTexImage');normal.image=bpy.data.images.load(str(ROOT/'assets/models/moon-rocks/moon_rock_01/textures/moon_rock_01_nor_gl_1k.jpg'),check_existing=True)
    normal.image.colorspace_settings.name='Non-Color';n=nodes.new('ShaderNodeNormalMap');n.inputs['Strength'].default_value=.55 if interior else .8
    links.new(normal.outputs['Color'],n.inputs['Color']);links.new(n.outputs['Normal'],p.inputs['Normal'])
    return mat
outer=stone('扫描岩石 · 外表');inside=stone('新鲜断面',True)

def clip(poly,n,b):
    result=[]
    for a,c in zip(poly,poly[1:]+poly[:1]):
        da=a[0]*n[0]+a[1]*n[1]-b;dc=c[0]*n[0]+c[1]*n[1]-b
        if da<=0:result.append(a)
        if (da<0)!=(dc<0):
            t=da/(da-dc);result.append((a[0]+t*(c[0]-a[0]),a[1]+t*(c[1]-a[1])))
    return result

# Weighted Voronoi in the X/Z elevation produces layered, non-grid blocks.
seeds=[]
for row,z in enumerate([.6,2.2,4.0,6.0,8.0,10.0]):
    for x in [-11,-6,-1,4,9,13]:seeds.append((x+rng.uniform(-1.3,1.3)+(row%2)*1.1,z+rng.uniform(-.35,.35)))
outline=[(-15,-.1),(15,-.1),(15,12),(-15,12)]

# Use the project's scanned geometry, not a noise-displaced rectangular wall.
bpy.ops.import_scene.gltf(filepath=str(ROOT/'assets/models/moon-rocks/moon_rock_01/moon_rock_01_1k.gltf'))
imported=list(bpy.context.selected_objects)
master=max([o for o in imported if o.type=='MESH'],key=lambda o:len(o.data.vertices))
matrix=master.matrix_world.copy();master.parent=None;master.matrix_world=matrix
for obj in imported:
    if obj!=master:bpy.data.objects.remove(obj,do_unlink=True)
bpy.ops.object.select_all(action='DESELECT');master.select_set(True);bpy.context.view_layer.objects.active=master
bpy.ops.object.transform_apply(location=False,rotation=True,scale=True)
master.dimensions=(28,6,10);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
coords=[v.co for v in master.data.vertices]
offset=Vector((-(min(v.x for v in coords)+max(v.x for v in coords))/2,-(min(v.y for v in coords)+max(v.y for v in coords))/2,-min(v.z for v in coords)))
for v in master.data.vertices:v.co+=offset
master.location=(0,0,0)
bm=bmesh.new();bm.from_mesh(master.data);bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.0001)
bmesh.ops.holes_fill(bm,edges=[e for e in bm.edges if e.is_boundary],sides=0)
bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(master.data);bm.free()
master.select_set(False)

def rigid(obj,kind='ACTIVE'):
    bpy.context.view_layer.objects.active=obj;obj.select_set(True)
    bpy.ops.rigidbody.object_add();rb=obj.rigid_body;rb.type=kind
    rb.collision_shape='CONVEX_HULL';rb.use_margin=True;rb.collision_margin=.008
    rb.friction=.82;rb.restitution=.035;rb.linear_damping=.23;rb.angular_damping=.30
    obj.select_set(False)

blocks=[];moving=[];meta=[]
for i,p in enumerate(seeds):
    poly=outline[:]
    for j,q in enumerate(seeds):
        if i==j:continue
        # 2.7x vertical metric makes strata wider than tall.
        n=(2*(q[0]-p[0]),2*7.29*(q[1]-p[1]));b=q[0]**2-p[0]**2+7.29*(q[1]**2-p[1]**2)
        poly=clip(poly,n,b)
        if len(poly)<3:break
    if len(poly)<3:continue
    cx=sum(a[0] for a in poly)/len(poly);cz=sum(a[1] for a in poly)/len(poly)
    # Tiny pre-fracture seams; maintain matching irregular boundaries.
    poly=[(cx+(x-cx)*.989,cz+(z-cz)*.989) for x,z in poly];count=len(poly)
    verts=[(x,y,z) for y in [-8,8] for x,z in poly]
    faces=[tuple(reversed(range(count))),tuple(range(count,2*count))]
    faces.extend((j,(j+1)%count,(j+1)%count+count,j+count) for j in range(count))
    mesh=bpy.data.meshes.new(f'岩层断块_{i:02d}');mesh.from_pydata(verts,[],faces);mesh.update()
    ob=bpy.data.objects.new(mesh.name,mesh);scene.collection.objects.link(ob)
    mesh.materials.append(inside)
    bm=bmesh.new();bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(mesh);bm.free();mesh.update()
    uv=mesh.uv_layers.new(name='RockUV')
    for face in mesh.polygons:
        normal=face.normal
        for li in face.loop_indices:
            v=mesh.vertices[mesh.loops[li].vertex_index].co
            if abs(normal.y)>.55:coord=(v.x*.28,v.z*.28)
            elif abs(normal.x)>.55:coord=(v.y*.28,v.z*.28)
            else:coord=(v.x*.28,v.y*.28)
            uv.data[li].uv=coord
    cutter=ob
    ob=master.copy();ob.data=master.data.copy();ob.name=f'岩层断块_{i:02d}';scene.collection.objects.link(ob)
    ob.data.materials.append(inside)
    bpy.context.view_layer.objects.active=ob
    modifier=ob.modifiers.new('实心扫描岩石切分','BOOLEAN');modifier.operation='INTERSECT';modifier.solver='EXACT';modifier.object=cutter
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(cutter,do_unlink=True)
    if len(ob.data.vertices)<4:bpy.data.objects.remove(ob,do_unlink=True);continue
    mesh=ob.data
    # Boolean caps must use the exported active UV layer, not a second cutter
    # layer that would leave every new face sampling one constant texture pixel.
    uv=mesh.uv_layers.active
    for face in mesh.polygons:
        if face.material_index==0:continue
        face.use_smooth=False
        for li in face.loop_indices:
            v=mesh.vertices[mesh.loops[li].vertex_index].co
            uv.data[li].uv=(v.y*.35,v.z*.35) if abs(face.normal.x)>.55 else (v.x*.35,v.y*.35)
    bpy.context.view_layer.objects.active=ob;ob.select_set(True)
    bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY',center='BOUNDS');ob.select_set(False)
    # Only the lowest foundation stays fixed. Upper edges must fall too: fixed
    # outline shards would otherwise remain implausibly suspended after failure.
    active=cz>1.3
    rigid(ob,'ACTIVE' if active else 'PASSIVE');blocks.append(ob)
    if not active:
        # Foundation remnants are background, not sources of release impulses.
        ob.rigid_body.collision_collections[0]=False;ob.rigid_body.collision_collections[1]=True
    if active:
        ob.rotation_mode='XYZ'
        rb=ob.rigid_body;rb.mass=max(50,ob.dimensions.x*ob.dimensions.y*ob.dimensions.z*2200)
        base=ob.location.copy();release=101
        rb.kinematic=True;rb.keyframe_insert('kinematic',frame=1);rb.keyframe_insert('kinematic',frame=release)
        ob.keyframe_insert('location',frame=1);ob.keyframe_insert('rotation_euler',frame=1)
        ob.keyframe_insert('location',frame=48);ob.keyframe_insert('rotation_euler',frame=48)
        # One coherent hinged sheet until release, rather than independently
        # rotating intersecting collision hulls (which would create explosions).
        pivot=Vector((0,-3.15,.35))
        for frame in range(49,release+1):
            t=(frame-48)/(release-48);t=t*t*(3-2*t)
            angle=math.radians(38)*t;rot=Matrix.Rotation(angle,3,'X')
            ob.location=pivot+rot@(base-pivot);ob.rotation_euler.x=angle
            ob.keyframe_insert('location',frame=frame);ob.keyframe_insert('rotation_euler',frame=frame)
        rb.kinematic=False;rb.keyframe_insert('kinematic',frame=release+1)
        moving.append(ob);meta.append({'name':ob.name,'release':release/24,'mass':round(rb.mass)})

bpy.data.objects.remove(master,do_unlink=True)
# Rigid catch surface. Kept in the exported scene so visual/physical heights match.
bpy.ops.mesh.primitive_cube_add(size=1,location=(0,-15,-.25))
floor=bpy.context.object;floor.name='接触地面';floor.dimensions=(100,100,1.2)
bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
floor.data.materials.append(outer);rigid(floor,'PASSIVE')
world=scene.rigidbody_world;world.substeps_per_frame=12;world.solver_iterations=40
world.point_cache.frame_start=1;world.point_cache.frame_end=LAST

# Evaluate offline Bullet sequentially, then explicitly bake transforms. Browser
# playback never runs a second physics simulation or updates gameplay collision.
samples={ob.name:[] for ob in moving};previous={}
for f in range(1,LAST+1):
    scene.frame_set(f);deps=bpy.context.evaluated_depsgraph_get()
    for ob in moving:
        matrix=ob.evaluated_get(deps).matrix_world.copy();samples[ob.name].append(matrix)
    if f%48==0:print('BAKE',f,flush=True)

contacts=[];max_speed=0;final_speed=0;max_distance=0
for ob in moving:
    frames=samples[ob.name];minz=min(v.co.z for v in ob.data.vertices)
    for k in range(1,len(frames)):
        speed=(frames[k].translation-frames[k-1].translation).length*24
        max_speed=max(max_speed,speed)
        if k>len(frames)-12:final_speed=max(final_speed,speed)
    max_distance=max(max_distance,(frames[-1].translation-frames[0].translation).length)
    # True mesh-ground contact samples for synchronized visual dust in the viewer.
    last_bottom=None
    for k,matrix in enumerate(frames):
        if k<90:continue
        bottom=min((matrix@v.co).z for v in ob.data.vertices)
        if bottom<.49 and last_bottom is not None and last_bottom>.49:
            center=matrix.translation;contacts.append({'time':k/24,'position':[center.x,max(.43,bottom),-center.y],'size':min(3.5,ob.dimensions.x*.5)})
            break
        last_bottom=bottom
    ob.animation_data_clear();bpy.context.view_layer.objects.active=ob;ob.select_set(True);bpy.ops.rigidbody.object_remove();ob.select_set(False)
    ob.rotation_mode='QUATERNION';prev=None
    for k,matrix in enumerate(frames):
        if k%2 and k!=len(frames)-1:continue
        loc,rot,scale=matrix.decompose()
        if prev is not None and rot.dot(prev)<0:rot.negate()
        prev=rot.copy();ob.location=loc;ob.rotation_quaternion=rot
        ob.keyframe_insert('location',frame=k+1);ob.keyframe_insert('rotation_quaternion',frame=k+1)
    # Linear sampling avoids overshoot through the contact plane.
    action=ob.animation_data.action
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for fc in bag.fcurves:
                    for kp in fc.keyframe_points:kp.interpolation='LINEAR'

scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'collapse-study.blend'))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=str(OUT/'collapse-study.glb'),export_format='GLB',export_animations=True,
    export_animation_mode='SCENE',export_frame_range=True,export_force_sampling=True,export_materials='EXPORT',export_cameras=False,export_lights=False)
report={'duration':DURATION,'fps':24,'gravity':1.62,'blocks':len(blocks),'moving':len(moving),'contacts':contacts,'pieces':meta,
        'maxSpeed':max_speed,'finalSpeed':final_speed,'maxTravel':max_distance,
        'triangles':sum(len(o.data.polygons) for o in blocks),'method':'Offline Blender Bullet; fixed topology; baked rigid transforms; not live destruction.'}
(OUT/'study.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False),flush=True)
