"""V2 study only: volumetric fracture of a scan, staged downhill release, baked Bullet.
The V1 blend/GLB remains untouched. No game modules, save files or vehicle physics.
"""
import bpy, bmesh, math, random, json
from pathlib import Path
from mathutils import Vector, Matrix

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets/models/collapse-study-v2'
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
FPS = 24
DURATION = 26
LAST = FPS * DURATION + 1
scene.render.fps = FPS
scene.frame_start = 1
scene.frame_end = LAST
scene.gravity = (0, 0, -1.62)
rng = random.Random(9017)

def material(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    p = nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (.23, .25, .27, 1)
    p.inputs['Roughness'].default_value = .92
    # Preview supplies the shared 4K triplanar texture; don't duplicate it in GLB.
    return mat

inside = material('新鲜断面')

def box_faces():
    v = [Vector((x,y,z)) for z in [-1,16] for y in [-16,9] for x in [-16,16]]
    return [[v[i].copy() for i in f] for f in [(0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)]]

def clip_solid(faces, normal, limit):
    result, cuts = [], []
    for face in faces:
        polygon = []
        for a,b in zip(face,face[1:]+face[:1]):
            da,db = normal.dot(a)-limit,normal.dot(b)-limit
            if da <= 1e-7: polygon.append(a)
            if (da < 0) != (db < 0):
                c = a + (b-a) * (da/(da-db))
                polygon.append(c); cuts.append(c)
        if len(polygon) >= 3: result.append(polygon)
    unique = {}
    for p in cuts: unique[tuple(round(x,6) for x in p)] = p
    cuts = list(unique.values())
    if len(cuts) >= 3:
        center = sum(cuts, Vector()) / len(cuts)
        n = normal.normalized()
        axis = n.cross(Vector((0,0,1)) if abs(n.z)<.9 else Vector((0,1,0))).normalized()
        other = n.cross(axis)
        cuts.sort(key=lambda p: math.atan2((p-center).dot(other),(p-center).dot(axis)))
        result.append(cuts)
    return result

def cut_planes(faces):
    center = sum([p for f in faces for p in f], Vector()) / sum(len(f) for f in faces)
    planes=[]
    for face in faces:
        candidates=[(a-face[0]).cross(b-face[0]) for a,b in zip(face[1:],face[2:])]
        if not candidates:continue
        n=max(candidates,key=lambda v:v.length_squared)
        if n.length_squared<1e-12:continue
        n.normalize()
        if n.dot(face[0]-center)<0:n.negate()
        planes.append((center+(face[0]-center)*.998,n))
    return planes

def rigid(ob, active=True):
    bpy.ops.object.select_all(action='DESELECT');ob.select_set(True);bpy.context.view_layer.objects.active=ob
    bpy.ops.rigidbody.object_add()
    rb=ob.rigid_body;rb.type='ACTIVE' if active else 'PASSIVE'
    rb.collision_shape='CONVEX_HULL';rb.use_margin=True;rb.collision_margin=.002
    rb.friction=.62;rb.restitution=.04;rb.linear_damping=.24;rb.angular_damping=.34
    ob.select_set(False)
    return rb

# Keep scan topology/UV, but explicitly normalize mesh coordinates. A 28×11×14 m
# volume, not a thin sheet extruded through every fracture cell.
bpy.ops.import_scene.gltf(filepath=str(ROOT/'assets/models/moon-rocks/moon_rock_01/moon_rock_01_1k.gltf'))
imported=list(bpy.context.selected_objects)
master=max([o for o in imported if o.type=='MESH'],key=lambda o:len(o.data.vertices))
matrix=master.matrix_world.copy();master.parent=None;master.matrix_world=Matrix.Identity(4);master.data.transform(matrix)
for ob in imported:
    if ob != master: bpy.data.objects.remove(ob,do_unlink=True)
lo=Vector(tuple(min(v.co[i] for v in master.data.vertices) for i in range(3)))
hi=Vector(tuple(max(v.co[i] for v in master.data.vertices) for i in range(3)))
for v in master.data.vertices:
    v.co=Vector(((v.co.x-lo.x)/(hi.x-lo.x)*28-14,(v.co.y-lo.y)/(hi.y-lo.y)*11-5.5,(v.co.z-lo.z)/(hi.z-lo.z)*14+.42))
    # An outward-leaning natural face loses balance once its front footing goes.
    # This is static geology, not an animation that lifts the entire rock sheet.
    v.co.y-=.5*v.co.z
bm=bmesh.new();bm.from_mesh(master.data)
bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.0001)
bmesh.ops.holes_fill(bm,edges=[e for e in bm.edges if e.is_boundary],sides=0)
bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(master.data);bm.free()

# Three depth bands give genuinely volumetric blocks. Irregular spacing avoids a
# tile-grid silhouette; smaller basal cells fail before the large upper masses.
seeds=[]
for level,z in enumerate([1.0,3.9,7.4,11.4]):
    for depth,y in enumerate([-4.3,-.2,4.0]):
        for x in [-11,-5.5,0,5.5,11]:
            seed=Vector((x+rng.uniform(-1,1)+(level%2)*.4,y+rng.uniform(-.7,.7),z+rng.uniform(-.65,.65)))
            seed.y-=.5*seed.z;seeds.append(seed)
blocks=[];moving=[];meta=[]
for i,p in enumerate(seeds):
    print('BEGIN_CELL',i,flush=True)
    faces=box_faces()
    for j,q in enumerate(seeds):
        if i==j: continue
        n=2*(q-p);limit=q.dot(q)-p.dot(p)
        faces=clip_solid(faces,n,limit)
        if not faces: break
    if not faces: continue
    print('CLIPPED',i,len(faces),sum(len(f) for f in faces),flush=True)
    planes=cut_planes(faces)
    ob=master.copy();ob.data=master.data.copy();ob.name=f'体积岩块_{i:02d}';scene.collection.objects.link(ob)
    ob.data.materials.append(inside)
    # Closed half-space cuts are far more predictable here than Exact Boolean
    # against tiny nearly coplanar slivers at three-way Voronoi intersections.
    bm=bmesh.new();bm.from_mesh(ob.data)
    for point,normal in planes:
        if not bm.verts:break
        distances=[normal.dot(v.co-point) for v in bm.verts]
        if max(distances)<.00001:continue
        if min(distances)>.00001:
            bm.clear();break
        result=bmesh.ops.bisect_plane(bm,geom=list(bm.verts)+list(bm.edges)+list(bm.faces),dist=.00001,
            plane_co=point,plane_no=normal,clear_outer=True,clear_inner=False)
        cut_edges=[e for e in result['geom_cut'] if isinstance(e,bmesh.types.BMEdge) and e.is_boundary]
        if cut_edges:
            fill=bmesh.ops.holes_fill(bm,edges=cut_edges,sides=0)
            for cap in fill['faces']:cap.material_index=len(ob.data.materials)-1;cap.smooth=False
    if bm.faces:bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
    bm.to_mesh(ob.data);bm.free();ob.data.update()
    if len(ob.data.vertices)<4: bpy.data.objects.remove(ob,do_unlink=True);continue
    if max(v.co.z for v in ob.data.vertices)-min(v.co.z for v in ob.data.vertices)<.12:
        bpy.data.objects.remove(ob,do_unlink=True);continue
    uv=ob.data.uv_layers.active or ob.data.uv_layers.new(name='UVMap')
    for face in ob.data.polygons:
        if face.material_index==0: continue
        for li in face.loop_indices:
            co=ob.data.vertices[ob.data.loops[li].vertex_index].co
            uv.data[li].uv=(co.x*.3,co.z*.3) if abs(face.normal.y)>.5 else (co.y*.3,co.z*.3)
    bpy.ops.object.select_all(action='DESELECT');ob.select_set(True);bpy.context.view_layer.objects.active=ob
    bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY',center='BOUNDS');ob.select_set(False)
    # A rear basal strip stays connected to the floor; no fixed upper shards.
    active=not (p.z<2 and p.y>1)
    rb=rigid(ob,active);blocks.append(ob)
    if not active: continue
    rb.mass=max(40,ob.dimensions.x*ob.dimensions.y*ob.dimensions.z*2200)
    start=1.0+max(0,p.z)*.30+(p.x+14)*.025+(p.y+.5*p.z+6)*.055+rng.uniform(-.10,.10)
    release=round((start+.65)*FPS)
    rb.kinematic=True;rb.keyframe_insert('kinematic',frame=1);rb.keyframe_insert('kinematic',frame=release)
    ob.keyframe_insert('location',frame=1);ob.keyframe_insert('location',frame=round(start*FPS))
    # Keep all transforms stationary until release. A kinematic translation at
    # the release boundary can snap in Bullet; gravity now supplies all motion.
    ob.keyframe_insert('location',frame=release)
    rb.kinematic=False;rb.keyframe_insert('kinematic',frame=release+1)
    moving.append(ob);meta.append({'name':ob.name,'release':release/FPS,'mass':round(rb.mass),'kind':'primary'})
    print('CELL',i,len(ob.data.polygons),flush=True)

# Secondary scan chips provide scale transition. They fall from exterior cracks
# after their neighboring primary band releases, never explode from the center.
bpy.ops.import_scene.gltf(filepath=str(ROOT/'assets/models/moon-rocks/moon_rock_07/moon_rock_07_1k.gltf'))
imported=list(bpy.context.selected_objects)
chip=max([o for o in imported if o.type=='MESH'],key=lambda o:len(o.data.vertices))
matrix=chip.matrix_world.copy();chip.parent=None;chip.matrix_world=Matrix.Identity(4);chip.data.transform(matrix)
for ob in imported:
    if ob!=chip: bpy.data.objects.remove(ob,do_unlink=True)
lo=Vector(tuple(min(v.co[i] for v in chip.data.vertices) for i in range(3)))
hi=Vector(tuple(max(v.co[i] for v in chip.data.vertices) for i in range(3)))
center=(lo+hi)*.5;span=max(hi-lo)
for v in chip.data.vertices:v.co=(v.co-center)/span
# Decimate the tiny scans before duplication, retaining UVs.
bpy.context.view_layer.objects.active=chip
dec=chip.modifiers.new('碎石轻量化','DECIMATE');dec.ratio=.18;bpy.ops.object.modifier_apply(modifier=dec.name)
for i in range(34):
    ob=chip.copy();ob.data=chip.data.copy();ob.name=f'次级碎石_{i:02d}';scene.collection.objects.link(ob)
    size=rng.uniform(.18,.8)
    for v in ob.data.vertices:v.co*=size
    # Front toe / lower exposed face; avoids embedding tiny convex hulls inside
    # a main boulder (which would cause violent contact impulses).
    x,z=rng.uniform(-11,11),rng.uniform(1.0,5.0)
    hit,point,normal,index=master.ray_cast(Vector((x,-15,z)),Vector((0,1,0)))
    if not hit:
        bpy.data.objects.remove(ob,do_unlink=True);continue
    ob.location=point+Vector((0,-size*.12,0))
    ob.rotation_euler=(rng.random()*2,rng.random()*2,rng.random()*2)
    rb=rigid(ob);rb.mass=max(1,size**3*2000)
    # Secondary chips collide with the floor, not the enclosing primary hull.
    rb.collision_collections[0]=False;rb.collision_collections[2+i%18]=True
    release=round((1.8+(ob.location.x+14)*.06+rng.random()*1.1)*FPS)
    rb.kinematic=True;rb.keyframe_insert('kinematic',frame=1);rb.keyframe_insert('kinematic',frame=release)
    rb.kinematic=False;rb.keyframe_insert('kinematic',frame=release+1)
    blocks.append(ob);moving.append(ob);meta.append({'name':ob.name,'release':release/FPS,'mass':round(rb.mass),'kind':'chip'})
bpy.data.objects.remove(chip,do_unlink=True)
bpy.data.objects.remove(master,do_unlink=True)

bpy.ops.mesh.primitive_cube_add(size=1,location=(0,-15,-.25))
floor=bpy.context.object;floor.name='接触地面';floor.dimensions=(100,100,1.2)
bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);rigid(floor,False)
for c in range(1,20):floor.rigid_body.collision_collections[c]=True
world=scene.rigidbody_world;world.substeps_per_frame=16;world.solver_iterations=50
world.point_cache.frame_start=1;world.point_cache.frame_end=LAST
samples={ob.name:[] for ob in moving}
for f in range(1,LAST+1):
    scene.frame_set(f);deps=bpy.context.evaluated_depsgraph_get()
    for ob in moving:samples[ob.name].append(ob.evaluated_get(deps).matrix_world.copy())
    if f%48==0:print('BAKE',f,flush=True)

contacts=[];max_speed=0;final_speed=0;max_travel=0;pre_release_rise=0
for ob,info in zip(moving,meta):
    frames=samples[ob.name]
    for k in range(1,len(frames)):
        speed=(frames[k].translation-frames[k-1].translation).length*FPS
        max_speed=max(max_speed,speed)
        if k>len(frames)-12:final_speed=max(final_speed,speed)
        if k<=round(info['release']*FPS)-1:pre_release_rise=max(pre_release_rise,frames[k].translation.z-frames[0].translation.z)
    max_travel=max(max_travel,(frames[-1].translation-frames[0].translation).length)
    bottom_before=None
    for k,m in enumerate(frames):
        if k<round(info['release']*FPS)-1:continue
        bottom=min((m@v.co).z for v in ob.data.vertices)
        if bottom<.49 and bottom_before is not None and bottom_before>=.49:
            verts=[m@v.co for v in ob.data.vertices];low=[v for v in verts if v.z<bottom+.15]
            point=sum(low,Vector())/len(low)
            size=min(2.8,max(.18,ob.dimensions.length*.25))
            contacts.append({'time':k/FPS,'position':[point.x,max(.38,bottom),-point.y],'size':size,'kind':info['kind']})
            break
        bottom_before=bottom
    ob.animation_data_clear();bpy.context.view_layer.objects.active=ob
    bpy.ops.object.select_all(action='DESELECT');ob.select_set(True);bpy.ops.rigidbody.object_remove();ob.select_set(False)
    ob.rotation_mode='QUATERNION';prev=None
    for k,m in enumerate(frames):
        if k%2 and k!=len(frames)-1:continue
        loc,rot,scale=m.decompose()
        if prev is not None and rot.dot(prev)<0:rot.negate()
        prev=rot.copy();ob.location=loc;ob.rotation_quaternion=rot
        ob.keyframe_insert('location',frame=k+1);ob.keyframe_insert('rotation_quaternion',frame=k+1)
    for layer in ob.animation_data.action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for fc in bag.fcurves:
                    for kp in fc.keyframe_points:kp.interpolation='LINEAR'

scene.frame_set(1)
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'collapse-study.blend'))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=str(OUT/'collapse-study.glb'),export_format='GLB',export_animations=True,
    export_animation_mode='SCENE',export_frame_range=True,export_force_sampling=True,export_materials='EXPORT',export_cameras=False,export_lights=False)
report={'version':2,'duration':DURATION,'fps':FPS,'gravity':1.62,'blocks':len(blocks),'moving':len(moving),
    'contacts':contacts,'pieces':meta,'maxSpeed':max_speed,'finalSpeed':final_speed,'maxTravel':max_travel,
    'preReleaseRise':pre_release_rise,'primary':sum(x['kind']=='primary' for x in meta),'chips':sum(x['kind']=='chip' for x in meta),
    'method':'3D Voronoi clipped scan; statically leaning face; sequential gravity release; offline Bullet; no shared hinge.'}
(OUT/'study.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in report.items() if k not in ['contacts','pieces']},ensure_ascii=False),flush=True)
