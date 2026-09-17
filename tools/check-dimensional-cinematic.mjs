import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
register('./three-node-loader.mjs', import.meta.url);
const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { CameraRig, CAM } = await import('../src/game/camera.js');
const { DimensionalEscape, ESCAPE } = await import('../src/game/dimensional-escape.js');
const { DimensionalCinematic, DIMENSIONAL_INTRO_SECONDS, DIMENSIONAL_RETURN_SECONDS, DIMENSIONAL_SHOTS } = await import('../src/game/dimensional-cinematic.js');
const { DimensionalFold, FOLD, FOLD_GLSL } = await import('../src/world/dimensional-fold.js');
const { Terrain, bakeTerrain } = await import('../src/world/terrain.js');
const { DELIVERY_SITE } = await import('../src/game/delivery.js');
const { Props, HOME } = await import('../src/world/props.js');

const input = { lookX: 0, lookY: 0, zoom: 0, looking: false };
const controls = { throttle: 0, steer: 0 };
const smooth = (a,b,x) => { const t=THREE.MathUtils.clamp((x-a)/(b-a),0,1); return t*t*(3-2*t); };
const near = (a,b,e=1e-6,message='numeric tolerance') => assert.ok(Math.abs(a-b)<=e,`${message}: ${a} vs ${b}`);

function fixture(mode=CAM.CHASE, {saved=null, noSubject=false, hills=true, fovScale=.92,
  sourceTerrain=null,sourceSubject=null,origin={x:0,z:0},home={x:0,z:400},realFold=false}={}) {
  const terrain = sourceTerrain || {heightAt:(x,z)=>hills ? .02*x+.01*z+.6*Math.sin(x*.03) : 0};
  const parked={x:origin.x+12,z:origin.z-10};
  const rover = {
    pos:new THREE.Vector3(parked.x,terrain.heightAt(parked.x,parked.z)+1.4,parked.z),
    vel:new THREE.Vector3(),omega:new THREE.Vector3(),
    forward:new THREE.Vector3(0,0,1),up:new THREE.Vector3(0,1,0),
    head:new THREE.Object3D(),cancelBoost(){this.boosting=false;},boosting:false,
  };
  rover.head.position.copy(rover.pos).add(new THREE.Vector3(0,2.3,0));
  const cam=new THREE.PerspectiveCamera(58,16/9,.1,2000),rig=new CameraRig(cam,terrain);
  rig.setMode(mode,rover);rig.yaw=mode===CAM.MAST ? .12 : 2.45;rig.pitch=mode===CAM.MAST ? .08 : .27;
  rig.dist=11;rig.autoCentre=0;rig.fovScale=fovScale;
  for(let i=0;i<180;i++)rig.update(1/60,rover,input,controls);
  const original={mode:rig.mode,yaw:rig.yaw,pitch:rig.pitch,dist:rig.dist,
    position:cam.position.clone(),quaternion:cam.quaternion.clone(),fov:cam.fov};
  const escape=new DimensionalEscape({rover,game:{},origin,home,
    introDuration:DIMENSIONAL_INTRO_SECONDS});
  const {axis}=escape;
  const root=new THREE.Vector3(origin.x+axis.x*-82+axis.z*10,0,origin.z+axis.z*-82-axis.x*10);
  root.y=terrain.heightAt(root.x,root.z);
  const hero=sourceSubject || {root,radius:5,crown:root.clone().add(new THREE.Vector3(0,7,0))};
  // A deterministic two-stage stand-in: first lose height onto the ground,
  // then feed the distant ground image into a pre-existing vertical plane.
  // These tests exercise camera/state contracts without a GPU dependency.
  let fold={
    getCinematicSubject:()=>noSubject ? null : {root:hero.root.clone(),crown:hero.crown.clone(),radius:hero.radius},
    sampleFoldPosition(p){
      const progress=escape.introProgress;
      const front=THREE.MathUtils.lerp(-110,-65,smooth(.16,.50,progress));
      const k=smooth(0,15,front-p.z);
      const rise=smooth(.5,.91,progress);
      const result=p.clone();
      result.y=THREE.MathUtils.lerp(p.y,hero.root.y+(p.y-hero.root.y)*.012,k);
      const depth=Math.max(0,-99-p.z),arc=Math.min(depth/7,Math.PI/2);
      const uprightZ=-99-Math.sin(arc)*7;
      const uprightY=7*(1-Math.cos(arc))+Math.max(0,depth-Math.PI*3.5);
      if(depth>0){result.z=THREE.MathUtils.lerp(p.z,uprightZ,rise);result.y+=uprightY*rise;}
      return result;
    },
    getMuralFocus:()=>new THREE.Vector3(hero.root.x,hero.root.y+45*smooth(.5,.91,escape.introProgress),-106),
  };
  if(realFold)fold=Object.assign(Object.create(DimensionalFold.prototype),{
    terrain,escape,subject:hero,anchorHeight:hero.root.y,_baseHeights:new Map(),
    root:{visible:true},outcrop:{children:[{}]},
    uniforms:{uFoldOrigin:{value:new THREE.Vector2(origin.x,origin.z)},
      uFoldAxis:{value:new THREE.Vector2(axis.x,axis.z)},uFoldFront:{value:FOLD.introStart},
      uFoldOn:{value:0},uFoldBaseY:{value:hero.root.y},uFoldFeed:{value:0},uFoldLift:{value:0}}
  });
  const events=[];
  const cine=new DimensionalCinematic({escape,fold,rig,terrain,rover,onRelease:()=>events.push('release')});
  if(saved)escape.load(saved,'return');else escape.start();
  return {terrain,rover,cam,rig,escape,fold,cine,events,original,time:0,physicsSteps:0,
    lastPosition:cam.position.clone(),lastQuaternion:cam.quaternion.clone(),lastFov:cam.fov,
    maxSpeed:0,maxAngularSpeed:0,maxFovSpeed:0,maxProgressStep:0,lastProgress:escape.introProgress};
}

// Keep ordering identical to main: event guard -> stationary physics -> chase
// state -> ordinary rig/return blend -> authored camera. Main's branch is also
// checked below so this model cannot silently replace the production gate.
function tick(f,dt,{paused=false}={}) {
  if(paused)return;
  if(f.escape.cinematicActive&&!f.cine.active)f.cine.start();
  const locked=f.escape.cinematicActive;
  if(locked) {f.rover.vel.set(0,0,0);f.rover.omega.set(0,0,0);f.rover.cancelBoost();}
  else f.physicsSteps++;
  f.escape.update(dt,{paused:locked});
  f.rig.update(dt,f.rover,input,controls);
  f.cine.update(dt);f.time+=dt;
  const positionStep=f.cam.position.distanceTo(f.lastPosition);
  const angleStep=f.cam.quaternion.angleTo(f.lastQuaternion);
  const fovStep=Math.abs(f.cam.fov-f.lastFov);
  assert.ok(f.cam.position.toArray().every(Number.isFinite),'finite camera position');
  assert.ok(f.cam.quaternion.toArray().every(Number.isFinite),'finite camera rotation');
  near(f.cam.quaternion.length(),1,1e-6,'normalized camera rotation');
  assert.ok(f.cam.fov>20&&f.cam.fov<90,'valid cinematic FOV');
  assert.ok(f.cam.position.y>=f.terrain.heightAt(f.cam.position.x,f.cam.position.z)+.4,
    `camera clearance at ${f.time.toFixed(3)}s`);
  // A wide observation shot may traverse ~100m on its 2.8s return. These
  // ceilings detect a one-frame teleport without forbidding that dolly speed.
  assert.ok(positionStep<.25+dt*160,`position jump ${positionStep.toFixed(3)}m at ${f.time.toFixed(3)}s/${1/dt}Hz`);
  assert.ok(angleStep<.035+dt*4,`rotation jump ${angleStep.toFixed(3)}rad at ${f.time.toFixed(3)}s/${1/dt}Hz`);
  assert.ok(fovStep<.2+dt*45,`FOV jump ${fovStep.toFixed(3)} at ${f.time.toFixed(3)}s`);
  f.maxSpeed=Math.max(f.maxSpeed,positionStep/dt);f.maxAngularSpeed=Math.max(f.maxAngularSpeed,angleStep/dt);
  f.maxFovSpeed=Math.max(f.maxFovSpeed,fovStep/dt);
  f.maxProgressStep=Math.max(f.maxProgressStep,f.escape.introProgress-f.lastProgress);
  f.lastPosition.copy(f.cam.position);f.lastQuaternion.copy(f.cam.quaternion);f.lastFov=f.cam.fov;
  f.lastProgress=f.escape.introProgress;
  if(locked) {
    assert.equal(f.escape.front,ESCAPE.start,'front remains frozen during shot and handoff');
    assert.equal(f.escape.elapsed,0,'warning grace is not consumed by camera');
    assert.equal(f.rover.vel.length(),0,'no cinematic motion');
    assert.equal(f.rover.omega.length(),0,'no cinematic rotation');
  }
}
function untilReleased(f,hz,limit=DIMENSIONAL_INTRO_SECONDS+DIMENSIONAL_RETURN_SECONDS+2) {
  for(let i=0;i<hz*limit&&f.escape.cinematicActive;i++)tick(f,1/hz);
  assert.equal(f.escape.cinematicActive,false,'cinematic must finish');
  assert.equal(f.cine.active,false);assert.equal(f.rig.cinematicLocked,false);
  assert.equal(f.rig.cinematicReturning,false);assert.deepEqual(f.events,['release']);
  assert.equal(f.escape.introProgress,1);assert.equal(f.escape.elapsed,0);
  assert.equal(f.rig.mode,f.original.mode,'camera mode restored');
  near(f.rig.yaw,f.original.yaw);near(f.rig.pitch,f.original.pitch);near(f.rig.dist,f.original.dist);
  assert.ok(f.cam.position.distanceTo(f.original.position)<1e-5,'original camera position restored');
  assert.ok(f.cam.quaternion.angleTo(f.original.quaternion)<1e-5,'original view restored');
  near(f.cam.fov,f.original.fov,.02,'original FOV restored');
}

const results=[];
for(const hz of [30,60,120])for(const mode of [CAM.CHASE,CAM.ORBIT,CAM.MAST]) {
  const f=fixture(mode);f.cine.start();assert.equal(f.cine.start(),false);
  const heldPosition=f.rover.pos.clone();
  // Camera controls cannot replace the selected view while a shot owns it.
  f.rig.setMode(CAM.PHOTO,f.rover);assert.equal(f.rig.mode,mode);
  for(let i=0;i<hz*4;i++)tick(f,1/hz);
  const paused={save:f.escape.save(),position:f.cam.position.clone(),time:f.time};
  for(let i=0;i<hz*6;i++)tick(f,1/hz,{paused:true});
  assert.deepEqual(f.escape.save(),paused.save);assert.deepEqual(f.cam.position,paused.position);assert.equal(f.time,paused.time);
  untilReleased(f,hz);
  near(f.time,DIMENSIONAL_INTRO_SECONDS+DIMENSIONAL_RETURN_SECONDS,3/hz,'authored shot plus full camera return');
  assert.equal(f.physicsSteps,0);assert.deepEqual(f.rover.pos,heldPosition);
  for(let i=0;i<Math.floor(hz*7.9);i++)tick(f,1/hz);
  assert.equal(f.escape.phase,'warning');assert.equal(f.escape.front,ESCAPE.start);
  for(let i=0;i<Math.ceil(hz*.2);i++)tick(f,1/hz);
  assert.equal(f.escape.phase,'chase');assert.ok(f.escape.front>ESCAPE.start);
  results.push({hz,mode,kind:'full',maxSpeed:+f.maxSpeed.toFixed(2),maxAngularSpeed:+f.maxAngularSpeed.toFixed(2)});
}
for(const hz of [30,60,120])for(const skipAt of [1,8,15,21.5]) {
  const f=fixture(CAM.ORBIT);
  for(let i=0;i<hz*skipAt;i++)tick(f,1/hz);
  const before=f.escape.introProgress,view=f.cam.position.clone();
  assert.equal(f.cine.skip(),true);assert.equal(f.cine.skip(),false);
  assert.equal(f.escape.introProgress,before,'skip must not teleport the collapse wave');
  assert.deepEqual(f.cam.position,view,'skip must not teleport the camera');
  untilReleased(f,hz,DIMENSIONAL_RETURN_SECONDS+1);
  near(f.time,skipAt+DIMENSIONAL_RETURN_SECONDS,3/hz,'skip preserves the full return blend');
  assert.ok(f.maxProgressStep<.08,'collapse finishes progressively during skip handoff');
  results.push({hz,skipAt,kind:'skip',maxProgressStep:+f.maxProgressStep.toFixed(4)});
}

for(const at of [5,16.4,DIMENSIONAL_INTRO_SECONDS+.4]) {
  const source=fixture(CAM.CHASE);
  for(let i=0;i<Math.round(at*60);i++)tick(source,1/60);
  const saved=source.escape.save();assert.equal(saved.cinematicActive,true);
  const loaded=fixture(CAM.MAST,{saved});
  assert.equal(loaded.escape.introElapsed,saved.introElapsed);
  untilReleased(loaded,60);
  assert.equal(loaded.escape.front,ESCAPE.start);
}

// The camera observes the source at ground level before looking up. The final
// shot includes the mural's vertical center with spare space for its skyline.
const reveal=fixture(CAM.ORBIT,{hills:false});reveal.cine.start();
for(let i=0;i<60*11;i++)tick(reveal,1/60);
const compressedRoot=reveal.fold.sampleFoldPosition(reveal.cine.hero.root);
const compressedCrown=reveal.fold.sampleFoldPosition(reveal.cine.hero.crown);
assert.ok(compressedCrown.y-compressedRoot.y<.1,'source rock has lost its thickness before the reveal');
assert.ok(reveal.cine._pose(11).look.y<1,'compression shot watches the ground image');
for(let i=0;i<60*5;i++)tick(reveal,1/60);
const risePaused={save:reveal.escape.save(),position:reveal.cam.position.clone(),quaternion:reveal.cam.quaternion.clone()};
for(let i=0;i<60*2;i++)tick(reveal,1/60,{paused:true});
assert.deepEqual(reveal.escape.save(),risePaused.save);
assert.deepEqual(reveal.cam.position,risePaused.position);assert.deepEqual(reveal.cam.quaternion.toArray(),risePaused.quaternion.toArray());
for(let i=0;i<60*5.9;i++)tick(reveal,1/60);
const mural=reveal.fold.getMuralFocus();
assert.ok(reveal.cine.look.y>35,'late shot looks into the upright painting');
assert.ok(reveal.cam.position.y<30,'reveal camera remains beside the consumed world');
const forward=new THREE.Vector3();reveal.cam.getWorldDirection(forward);
assert.ok(forward.angleTo(mural.clone().sub(reveal.cam.position))<.03,'final view settles on mural center');
const skyline=mural.clone().add(new THREE.Vector3(0,45,0)).project(reveal.cam);
const foot=mural.clone().add(new THREE.Vector3(0,-45,0)).project(reveal.cam);
assert.ok(Math.abs(skyline.y)<.76&&Math.abs(foot.y)<.76,`mural height fits inside the letterboxed frame: ${skyline.y}/${foot.y}`);
assert.ok(DIMENSIONAL_SHOTS.at(-1).at<=DIMENSIONAL_INTRO_SECONDS-3,'finished painting gets an observation hold');
assert.equal(DIMENSIONAL_RETURN_SECONDS,2.8,'return duration is unchanged');
assert.equal(ESCAPE.warning,8,'warning remains eight seconds after release');
for(const fovScale of [42/58,82/58]) {
  const framing=fixture(CAM.CHASE,{hills:false,fovScale});
  for(let i=0;i<60*21.9;i++)tick(framing,1/60);
  framing.cam.updateMatrixWorld();
  const focus=framing.fold.getMuralFocus();
  for(const height of [-45,45]) {
    const point=focus.clone().add(new THREE.Vector3(0,height,0)).project(framing.cam);
    assert.ok(Math.abs(point.y)<.76,`mural fits at player FOV ${fovScale*58}: ${point.y}`);
  }
  untilReleased(framing,60);
}

// A source vertex transported elsewhere is not terrain above this camera or
// its sightline. A locally lifted source still requires ordinary clearance.
const clearance=fixture(CAM.CHASE,{hills:false});
clearance.fold.sampleFoldPosition=p=>p.clone().add(new THREE.Vector3(80,300,90));
const clearPosition=new THREE.Vector3(0,3,0),clearTarget=new THREE.Vector3(0,2,-25);
clearance.cine._clear(clearPosition,clearTarget);
near(clearPosition.y,3,1e-6,'distant mural projection does not lift camera');
clearance.fold.sampleFoldPosition=p=>p.clone().add(new THREE.Vector3(0,4,0));
clearance.cine._clear(clearPosition,new THREE.Vector3(0,5,-25));
assert.ok(clearPosition.y>=5.2,'nearby folded surface still has camera clearance');

// Earlier saves normalize their old 16-second clock into the extended shot.
const migrated=fixture(CAM.MAST,{saved:{version:2,phase:'warning',elapsed:0,reason:'',
  introDuration:16,introElapsed:12,cinematicActive:true,motion:null}});
near(migrated.escape.introElapsed,DIMENSIONAL_INTRO_SECONDS*.75);
untilReleased(migrated,60);

// Production integration: use the actual baked crater heights and the real
// fold mapping, including source imagery being fed upward after compression.
const baking=bakeTerrain(()=>{});let bakeStep;
do{bakeStep=baking.next();}while(!bakeStep.done);
const realTerrain=Object.assign(Object.create(Terrain.prototype),bakeStep.value,{dentAt:()=>0});
// Parse the shipped scan vertices and apply production normalization/placement.
// Textures stay as CPU placeholders; image/shader QA still runs in the game.
const scanVariants=[];
for(const id of ['moon_rock_01','moon_rock_05','moon_rock_06','moon_rock_07']) {
  const url=new URL(`../assets/models/moon-rocks/${id}/${id}_1k.gltf`,import.meta.url);
  const json=JSON.parse(readFileSync(url,'utf8'));
  const buffers=json.buffers.map(buffer=>readFileSync(new URL(buffer.uri,url)));
  const loader=new GLTFLoader();
  loader.register(parser=>({
    name:'CPU_LOCAL_ASSETS',
    loadBufferView(index) {
      const view=json.bufferViews[index],buffer=buffers[view.buffer];
      const start=buffer.byteOffset+(view.byteOffset||0);
      return Promise.resolve(buffer.buffer.slice(start,start+view.byteLength));
    },
    loadTexture(index) {
      const texture=new THREE.Texture();
      parser.associations.set(texture,{textures:index});
      return Promise.resolve(texture);
    }
  }));
  const gltf=await loader.parseAsync(JSON.stringify(json),'');
  scanVariants.push(Props.prototype._prepareScannedVariant.call({quality:{anisotropy:1}},gltf,id));
}
const witness=Object.assign(Object.create(DimensionalFold.prototype),{
  terrain:realTerrain,scene:new THREE.Scene(),props:{scanVariants,colliders:[]},
  escape:new DimensionalEscape({rover:{},game:{},origin:DELIVERY_SITE,home:HOME})
});
witness._buildCinematicOutcrop();
const productionOptions={sourceTerrain:realTerrain,sourceSubject:witness.subject,
  origin:DELIVERY_SITE,home:HOME,realFold:true};

// Preview checkpoints and resumed saves can enter with the parked chase lens
// still pointing away from the mural. Its interpolated look range must not
// be mistaken for an obstructed subject that needs a hundreds-of-metres lift.
const checkpointResults=[];
for(const hz of [30,60,120])for(const at of [16.5,21.8]) {
  const checkpoint=fixture(CAM.CHASE,{...productionOptions,fovScale:1});
  checkpoint.escape.introElapsed=at;
  checkpoint.escape.advanceIntro=()=>false;
  const yaw=Math.atan2(HOME.x-checkpoint.rover.pos.x,HOME.z-checkpoint.rover.pos.z);
  checkpoint.rover.forward.set(Math.sin(yaw),0,Math.cos(yaw));
  checkpoint.rig.yaw=yaw+Math.PI;checkpoint.rig.pitch=.18;checkpoint.rig.dist=12.2;
  checkpoint.rig.first=true;checkpoint.cine.start();
  checkpoint.lastPosition.copy(checkpoint.cam.position);
  checkpoint.lastQuaternion.copy(checkpoint.cam.quaternion);checkpoint.lastFov=checkpoint.cam.fov;
  let maxAboveGround=0;
  for(let i=0;i<hz*4;i++) {
    tick(checkpoint,1/hz);
    const p=checkpoint.cam.position,aboveGround=p.y-realTerrain.heightAt(p.x,p.z);
    maxAboveGround=Math.max(maxAboveGround,aboveGround);
    assert.ok(aboveGround<25,`late entry remains over the ground at ${at}s/${hz}Hz: ${aboveGround}`);
  }
  assert.ok(checkpoint.cam.position.distanceTo(checkpoint.cine._pose(at).position)<1e-6,
    'held checkpoint settles on the authored camera pose');
  checkpointResults.push({hz,at,maxAboveGround});
}
const crestExpression=FOLD_GLSL.match(/float foldCrest\(float s\)\s*\{[\s\S]*?return\s+([^;]+);/)[1];
const crestAt=new Function('s',`return ${crestExpression.replace(/\b(sin|pow|max)\(/g,'Math.$1(')}`);
const framingResults=[];
for(const fovScale of [42/58,.92,82/58]) {
  const actual=fixture(CAM.CHASE,{...productionOptions,fovScale});
  for(let i=0;i<60*21.8;i++)tick(actual,1/60);
  actual.cam.updateMatrixWorld();
  const {axis,origin}=actual.escape,u=actual.fold.uniforms;
  let visibleCrest=0,onscreenColumns=0,lowCrest=Infinity,highCrest=-Infinity;
  let visibleLeft=Infinity,visibleRight=-Infinity;
  for(let side=-400;side<=400;side+=2) {
    const bow=1.8*Math.sin(side*.018)+.65*Math.sin(side*.057);
    const d=u.uFoldFront.value+bow-FOLD.apron-FOLD.radius;
    const height=.6+crestAt(side);
    const point=new THREE.Vector3(origin.x+axis.x*d+axis.z*side,u.uFoldBaseY.value+height,
      origin.z+axis.z*d-axis.x*side).project(actual.cam);
    if(Math.abs(point.x)<.94&&point.z>-1&&point.z<1){
      onscreenColumns++;lowCrest=Math.min(lowCrest,height);highCrest=Math.max(highCrest,height);
      if(Math.abs(point.y)<.70){visibleCrest++;visibleLeft=Math.min(visibleLeft,point.x);visibleRight=Math.max(visibleRight,point.x);}
    }
  }
  const aboveGround=actual.cam.position.y-realTerrain.heightAt(actual.cam.position.x,actual.cam.position.z);
  const upward=actual.cine.look.y-actual.cam.position.y;
  assert.ok(upward>20,'actual final shot looks up into the painting');
  assert.ok(aboveGround>=1.2&&aboveGround<25,'actual final camera stays above the original ground, below an aerial viewpoint');
  near(actual.cam.position.y,actual.cine.hero.root.y+18,1e-6,'transported imagery does not hoist the observer');
  assert.ok(visibleCrest>=10&&visibleRight-visibleLeft>.15,'a visible irregular skyline survives without fitting the whole painting');
  framingResults.push({fov:fovScale*58,camera:actual.cam.position.toArray(),look:actual.cine.look.toArray(),
    aboveGround,upward,visibleCrest,onscreenColumns,visibleScreenSpan:(visibleRight-visibleLeft)/2,lowCrest,highCrest});
  untilReleased(actual,60);
}
console.log(JSON.stringify({productionSubject:witness.subject,productionFraming:framingResults,
  lateEntry:checkpointResults},null,2));
const cancel=fixture();for(let i=0;i<120;i++)tick(cancel,1/60);
cancel.cine.cancel();cancel.escape.reset();assert.equal(cancel.rig.cinematicLocked,false);
assert.equal(cancel.rig.cinematicReturning,false);assert.equal(cancel.cine.active,false);
assert.equal(cancel.escape.cinematicActive,false);assert.deepEqual(cancel.events,[]);
// A menu/new-game reset intentionally re-establishes the ordinary camera;
// continuity applies after entering that new scene, not across the reset cut.
cancel.escape.start();cancel.cine.start();
assert.ok(cancel.cam.position.distanceTo(cancel.original.position)<1e-6,'reset restores the ordinary view before a fresh shot');
cancel.lastPosition.copy(cancel.cam.position);cancel.lastQuaternion.copy(cancel.cam.quaternion);
cancel.lastFov=cancel.cam.fov;untilReleased(cancel,60);
const failed=fixture();tick(failed,1/60);failed.escape.fail('test');failed.cine.update(1/60);
assert.equal(failed.cine.active,false);assert.equal(failed.rig.cinematicLocked,false);
const missing=fixture(CAM.CHASE,{noSubject:true});assert.equal(missing.cine.start(),false);
assert.equal(missing.escape.cinematicActive,false,'missing subject fails open, not a permanent lock');
assert.equal(missing.escape.elapsed,0);assert.equal(missing.rig.cinematicLocked,false);
for(const mode of [CAM.CHASE,CAM.ORBIT,CAM.MAST]) {
  const entry=fixture(mode);entry.rig.first=true;
  entry.cam.position.set(80,60,100);entry.cam.lookAt(0,0,0);
  assert.equal(entry.cine.start(),true);
  assert.ok(entry.cam.position.distanceTo(entry.original.position)<1e-6,
    'first gameplay camera is established before capturing a cinematic, not the menu orbit');
  entry.lastPosition.copy(entry.cam.position);entry.lastQuaternion.copy(entry.cam.quaternion);entry.lastFov=entry.cam.fov;
  tick(entry,1/60);
}

const main=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
// The legacy mural remains independently testable; production now uses the
// longer starfall sequence but shares this lock/handoff implementation.
assert.match(main,/introDuration:\s*STARFALL.intro/);
assert.match(main,/const cinematic\s*=\s*!!rupture\.cinematicActive\s*\|\|\s*escape\.cinematicActive/);
assert.match(main,/if \(App\.state === ST\.PLAY\) stepWorld\(dt, raw, input\)/,'pause gates cinematic clock');
assert.match(main,/if \(cinematic\)\s*\{[\s\S]*?rover\.vel\.set\(0, 0, 0\);[\s\S]*?rover\.omega\.set\(0, 0, 0\);[\s\S]*?rover\.sync\(\);\s*\} else if \(!photo\)/);
assert.match(main,/escape\.update\(dt,\{paused:controlsLocked,holdingHome:delivery\.holdingHome\}\)/);
assert.match(main,/uLetterbox\.value[\s\S]*?cinematic \? 0\.12/);
assert.match(main,/escapeCamera\.active && escape\.introElapsed > 0\.8 && input\.hit\('Space'\)/);
assert.match(main,/if \(!cinematic && input\.hit\('KeyC'\)\)/);
assert.match(main,/if \(!cinematic && input\.hit\('KeyP'\)\)/);
assert.match(main,/const state = App\.escapeCamera\?\.state \|\| App\.rupture\?\.cinematicState/);
const cameraTick=main.indexOf('escapeCamera.update(dt);');
assert.ok(cameraTick>main.indexOf('rig.update(dt, rover, {'));
assert.ok(main.indexOf('terrain.update(dt, engine.camera, App.lightDir);',cameraTick)>cameraTick,
  'camera position is final before terrain/sky LOD update');
console.log(JSON.stringify({status:'PASS',checks:'real cinematic + CameraRig + escape; 30/60/120Hz; 22s shot and 2.8s return; ground compression then tall mural reveal; letterbox framing; production fold with baked terrain; grounded upward final shot and partially visible irregular skyline at FOV extremes; position/rotation/FOV continuity; local and transported surface clearance; pause before and during rise; CHASE/ORBIT/MAST restoration; skip at 1/8/15/21.5s; save/load during shot and handoff; old save timing migration; protected 8s warning; cancel/reset/fail; missing assets; main wiring',results},null,2));
