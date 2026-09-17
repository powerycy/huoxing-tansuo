import assert from 'node:assert/strict';
import {register} from 'node:module';
import {readFileSync} from 'node:fs';
register('./three-node-loader.mjs',import.meta.url);
const THREE=await import('three');
const {StarfallEvent}=await import('../src/world/starfall-event.js');
const {StarfallCinematic}=await import('../src/game/starfall-cinematic.js');
const {STARFALL,starfallState,faultWidth,faultBend,faultContains,skyTurnAt,quakeImpactAt,seismicDrop}=await import('../src/world/starfall-field.js');
const {DimensionalEscape,ESCAPE}=await import('../src/game/dimensional-escape.js');
const {CameraRig,CAM}=await import('../src/game/camera.js');
const {Terrain,bakeTerrain}=await import('../src/world/terrain.js');
const {DELIVERY_SITE}=await import('../src/game/delivery.js');
const {HOME}=await import('../src/world/props.js');
const main=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
assert.match(main,/new StarfallEvent/);assert.match(main,/new StarfallCinematic/);
assert.doesNotMatch(main,/new DimensionalFold/);assert.match(main,/introDuration: STARFALL.intro/);
assert.match(main,/App\.starfall\?\.setQuality\(q\)/);

function fixture({ground={heightAt:(x,z)=>.025*x+.02*z+Math.sin(z*.03)},origin={x:0,z:0},home={x:0,z:400}}={}){
  const rover={pos:new THREE.Vector3(origin.x+12,ground.heightAt(origin.x+12,origin.z-10)+1.4,origin.z-10),vel:new THREE.Vector3(),omega:new THREE.Vector3(),
    forward:new THREE.Vector3(0,0,1),up:new THREE.Vector3(0,1,0),head:new THREE.Object3D(),cancelBoost(){}};
  rover.head.position.copy(rover.pos).add(new THREE.Vector3(0,2,0));
  const escape=new DimensionalEscape({rover,game:{},origin,home,introDuration:STARFALL.intro});
  const scene=new THREE.Scene();const event=new StarfallEvent({scene,terrain:ground,rover,props:{colliders:[]},escape,quality:{name:'HIGH'}});
  const camera=new THREE.PerspectiveCamera(58,16/9,.1,26000),rig=new CameraRig(camera,ground);
  rig.setMode(CAM.CHASE,rover);
  const cine=new StarfallCinematic({escape,fold:event,rig,terrain:ground,rover});
  return {rover,escape,event,camera,rig,cine,ground};
}
const f=fixture();
for(const [t,beam,sky,quake] of [[0,0,0,0],[5,1,0,0],[16,1,1,0],[26,1,1,1]]){
  f.escape.phase='warning';f.escape._cinematicActive=true;f.escape.introElapsed=t;
  const s=starfallState(f.escape);assert.deepEqual([s.beam,s.sky,s.quake],[beam,sky,quake]);
}
assert.equal(await f.event.paintReady,false,'Node fallback cannot block boot');
assert.ok(skyTurnAt(20)-skyTurnAt(10)>.65,'visible rotation, not a tiny UV wobble');
for(let t=0;t<160;t+=.13){assert.ok(skyTurnAt(t+.01)>=skyTurnAt(t));
  f.escape.introElapsed=Math.min(26,t);f.escape.elapsed=Math.max(0,t-26);f.escape._cinematicActive=t<26;
  f.escape.front=-65+Math.max(0,t-34)*7.5;
  assert.ok(starfallState(f.escape).front<=f.escape.front,'visual rupture cannot lead danger');}
assert.ok(quakeImpactAt(24.3)>.99);assert.ok(quakeImpactAt(10)<.0001);
for(const front of [-250,-65,80,320])for(let side=-250;side<250;side+=9){
  assert.equal(seismicDrop(side,front+5,{x:0,z:0},{x:0,z:1},front,1),0,'unbroken driving terrain is unchanged');
  assert.ok(seismicDrop(side,front-70,{x:0,z:0},{x:0,z:1},front,1)>=4,'large landmass moves, not only crack tint');
}
for(const name of ['LOW','MEDIUM','HIGH','ULTRA']){
  f.event.setQuality({name});assert.ok(f.event.strokes.geometry.instanceCount<=26000);
  assert.ok(f.event.mass.dust.geometry.instanceCount<=420);assert.ok(f.event.mass.rocks.geometry.instanceCount<=180);
  const colors=f.event.strokes.geometry.getAttribute('aColor');let warm=0;
  for(let i=0;i<f.event.strokes.geometry.instanceCount;i++)if(colors.getX(i)>colors.getZ(i))warm++;
  assert.ok(warm>200,'every quality level includes golden stars, not only blue background');
}
// Actual production material templates retain their texture sampler budget.
const materialFixture=Object.create(Terrain.prototype);
materialFixture.texMacro=materialFixture.texFar=materialFixture.texDetail=materialFixture.texDent=materialFixture.texGeology=new THREE.Texture();
materialFixture.trailRT={texture:new THREE.Texture()};materialFixture.sunRT={texture:new THREE.Texture()};
materialFixture.TRAIL_EXT=900;materialFixture.dentRes=4096;materialFixture.quality={terrainLightSteps:8};
materialFixture._emptyShadow=new THREE.Texture();materialFixture.buildMaterial();
const sample=materialFixture.material,original=sample.fragmentShader;
f.event.terrain=Object.assign(f.ground,{material:sample,uniforms:sample.uniforms,levels:[]});
f.event.install();assert.match(sample.fragmentShader,/faultContains\(vW\)\)discard/);
assert.match(sample.vertexShader,/wp.xyz=seismicWorld\(wp.xyz\)/);
assert.equal((sample.fragmentShader.match(/sampler2D/g)||[]).length,(original.match(/sampler2D/g)||[]).length);
const first=sample.fragmentShader;f.event.install();assert.equal(sample.fragmentShader,first,'idempotent install');
const cloned=sample.clone();f.event.terrain.levels=[{mesh:{material:cloned}}];f.event.install();
assert.equal(cloned.uniforms.uQuakeFront,f.event.uniforms.uQuakeFront);
// Rock and depth shaders share deformation while keeping pre-existing hooks.
const propsRoot=new THREE.Group(),rockMaterial=new THREE.MeshStandardMaterial(),rock=new THREE.Mesh(new THREE.BoxGeometry(),rockMaterial);
propsRoot.add(rock);f.event.props.group=propsRoot;let hookCount=0;
rockMaterial.onBeforeCompile=()=>{hookCount++;};f.event.mass.install();f.event.mass.install();
const shader={vertexShader:'#include <project_vertex>',uniforms:{}};rockMaterial.onBeforeCompile(shader,{});
assert.equal(hookCount,1);assert.match(shader.vertexShader,/seismicWorld\(earthquakePosition.xyz\)/);
const depthShader={vertexShader:'#include <project_vertex>',uniforms:{}};rock.customDepthMaterial.onBeforeCompile(depthShader,{});
assert.equal(depthShader.uniforms.uQuakeFront,shader.uniforms.uQuakeFront);

// Fixed faults cannot enter the driveable side of the authoritative catch line.
for(let front=-65;front<430;front+=17)for(let side=-500;side<500;side+=3.7){
  for(const delta of [0,.01,.2,2,5,20])assert.equal(faultContains(side,front+5+delta,{x:0,z:0},{x:0,z:1},front,1),false);
  for(let row=-364;row<=624;row+=26){const width=faultWidth(side,row,front,1);
    if(width>.001)assert.ok(row+faultBend(side)+width<front,'open lip stays behind front');}
}

for(const hz of [30,60,120]){
  f.escape.reset();f.escape.start();f.cine.cancel();let ticks=0;
  while(f.escape.cinematicActive&&ticks<hz*33){
    const dt=1/hz;if(!f.cine.active)f.cine.start();
    f.escape.update(dt);f.rig.update(dt,f.rover,{lookX:0,lookY:0,zoom:0,looking:false},{throttle:0,steer:0});
    f.cine.update(dt);f.event.update(true,dt,f.camera);
    assert.ok(f.camera.position.toArray().every(Number.isFinite));
    assert.ok(f.camera.position.y>=f.ground.heightAt(f.camera.position.x,f.camera.position.z)+.5);
    assert.ok(f.camera.fov>20&&f.camera.fov<90);
    assert.equal(f.escape.front,ESCAPE.start);assert.equal(f.escape.elapsed,0);ticks++;
  }
  assert.equal(f.escape.cinematicActive,false);assert.ok(Math.abs(ticks/hz-28.8)<.15);
  for(let i=0;i<hz*7;i++)f.escape.update(1/hz);assert.equal(f.escape.phase,'warning');
}
// Termination halts all danger; sky and beam fade, cracks become static scars.
f.escape.finish();for(let i=0;i<100;i++)f.event.update(true,.05,f.camera);
assert.equal(f.event.uniforms.uSkyAmount.value,0);assert.equal(f.event.beamLight.intensity,0);
assert.equal(f.event.debris.visible,false);const front=f.escape.front;f.escape.update(30);assert.equal(f.escape.front,front);
assert.equal(f.event.mass.dust.visible,false);assert.equal(f.event.mass.rocks.visible,false);
f.escape.reset();f.event.update(true,0,f.camera);assert.equal(f.event.root.visible,false);assert.equal(f.event.uniforms.uQuakeOn.value,0);
// A saved/paused shot and a skip still obey the original protected handoff.
for(const at of [3,13,23]){
  f.escape.start();f.escape.introElapsed=at;const save=f.escape.save();f.escape.update(30,{paused:true});assert.deepEqual(f.escape.save(),save);
  f.cine.cancel();f.escape.load(save,'return');assert.equal(f.escape.introElapsed,at);f.cine.start();f.cine.skip();
  for(let i=0;i<240&&f.escape.cinematicActive;i++){
    f.rig.update(1/60,f.rover,{lookX:0,lookY:0,zoom:0,looking:false},{throttle:0,steer:0});f.cine.update(1/60);f.escape.update(1/60,{paused:true});
  }
  assert.equal(f.escape.cinematicActive,false);assert.equal(f.escape.elapsed,0);f.escape.reset();
}
const baking=bakeTerrain(()=>{});let baked;do{baked=baking.next();}while(!baked.done);
const realTerrain=Object.assign(Object.create(Terrain.prototype),baked.value,{dentAt:()=>0});
const real=fixture({ground:realTerrain,origin:DELIVERY_SITE,home:HOME});
real.escape.start();real.escape.introElapsed=25.5;real.escape.advanceIntro=()=>false;
real.cine.start();
for(let i=0;i<240;i++)real.cine.update(1/60);
const actualClearance=real.camera.position.y-realTerrain.heightAt(real.camera.position.x,real.camera.position.z);
assert.ok(actualClearance>=1.2&&actualClearance<45,'actual crater camera stays near the ground');
console.log(JSON.stringify({productionQuakeCamera:real.camera.position.toArray(),aboveGround:actualClearance}));

// Exercise the production particle buffers, not only their pure timing helpers.
// The chase sample looks back toward the rupture from the safe side of the line.
realTerrain.uniforms={}; // The baked CPU fixture has no renderer/material setup.
const particleStateAt=(time)=>{
  const e=real.escape;e.phase=time<34?'warning':'chase';e._cinematicActive=time<26;
  e.introElapsed=Math.min(26,time);e.elapsed=Math.max(0,time-26);
  e.front=ESCAPE.start+Math.max(0,time-34)*ESCAPE.speed;
  if(time<26){
    const pose=real.cine._pose(time);
    real.camera.position.copy(pose.position);real.camera.quaternion.copy(pose.quaternion);real.camera.fov=pose.fov;
  }else{
    const point=(a,s,h)=>{const p=new THREE.Vector3(e.origin.x+e.axis.x*a+e.axis.z*s,0,e.origin.z+e.axis.z*a-e.axis.x*s);
      p.y=realTerrain.heightAt(p.x,p.z)+h;return p;};
    real.camera.position.copy(point(e.front+45,15,7));real.camera.lookAt(point(e.front-40,0,6));real.camera.fov=65;
  }
  real.camera.updateProjectionMatrix();real.camera.updateMatrixWorld();real.event.update(true,0,real.camera);
};
const particleSnapshot=()=>Object.fromEntries(['dust','rocks'].map(kind=>{
  const mesh=real.event.mass[kind],count=mesh.geometry.instanceCount;
  const names=kind==='dust'?['aPose','aStyle']:['aPose','aSpin'];
  return [kind,{visible:mesh.visible,count,...Object.fromEntries(names.map(name=>{
    const attribute=mesh.geometry.attributes[name];return [name,Array.from(attribute.array.slice(0,count*attribute.itemSize))];
  }))}];
}));
const verifyParticles=(label,dustBudget,rockBudget)=>{
  const snapshot=particleSnapshot(),matrix=real.camera.matrixWorldInverse.elements;
  for(const [kind,budget] of [['dust',dustBudget],['rocks',rockBudget]]){
    const buffer=snapshot[kind];assert.equal(buffer.visible,true,`${label}: ${kind} active`);
    assert.ok(buffer.count>0&&buffer.count<=budget,`${label}: ${kind} populated within tier budget (got ${buffer.count})`);
    for(const [name,array] of Object.entries(buffer))if(Array.isArray(array))
      assert.ok(array.every(Number.isFinite),`${label}: ${kind}.${name} is finite`);
    let lastDepth=Infinity;
    for(let i=0;i<buffer.count;i++){
      const p=buffer.aPose,j=i*4,depth=-(matrix[2]*p[j]+matrix[6]*p[j+1]+matrix[10]*p[j+2]+matrix[14]);
      assert.ok(depth<=lastDepth+1e-4,`${label}: ${kind} blends back-to-front in view space`);lastDepth=depth;
      assert.ok(p[j+3]>0,`${label}: ${kind} size is positive`);
      const fade=kind==='dust'?buffer.aStyle[j+2]:buffer.aSpin[i*2+1];
      assert.ok(fade>=0&&fade<=1,`${label}: ${kind} alpha remains bounded`);
      if(kind==='dust')assert.ok(buffer.aStyle[j+1]>=0&&buffer.aStyle[j+1]<=24,`${label}: flipbook index stays in its atlas`);
    }
  }
  return snapshot;
};
assert.equal(await real.event.mass.dustReady,false,'missing DOM leaves a working procedural dust fallback');
assert.equal(real.event.mass.dust.material.uniforms.uAtlasReady.value,0);
assert.equal(real.event.mass.dust.material.uniforms.uAtlas.value.isDataTexture,true);
const particleCounts=[];
for(const [name,dustBudget,rockBudget] of [['LOW',90,40],['MEDIUM',160,70],['HIGH',280,120],['ULTRA',420,180]]){
  real.event.setQuality({name});
  for(const time of [20,25.5,42]){
    particleStateAt(time);
    const snapshot=verifyParticles(`${name} at ${time}s`,dustBudget,rockBudget);
    particleCounts.push({tier:name,time,dust:snapshot.dust.count,rocks:snapshot.rocks.count});
    const saved=real.escape.save();real.escape.update(3,{paused:true});real.event.update(true,0,real.camera);
    assert.deepEqual(real.escape.save(),saved,'pause does not advance escape time');
    assert.deepEqual(particleSnapshot(),snapshot,`${name} at ${time}s: paused buffers do not move`);
    particleStateAt(17);assert.equal(real.event.mass.dust.geometry.instanceCount,0);assert.equal(real.event.mass.rocks.geometry.instanceCount,0);
    particleStateAt(time);assert.deepEqual(particleSnapshot(),snapshot,`${name} at ${time}s: rewinding and replay reconstruct identical buffers`);
  }
}
const rockShader=real.event.mass.rocks.material;
assert.equal(rockShader.transparent,true);assert.match(rockShader.vertexShader,/vFade\s*=\s*aSpin\.y/);
assert.match(rockShader.fragmentShader,/gl_FragColor\s*=\s*vec4\([^;]*,\s*vFade\s*\)/,'fragment alpha consumes the particle fade attribute');
real.escape.finish();real.event.update(true,0,real.camera);
for(const mesh of [real.event.mass.dust,real.event.mass.rocks]){
  assert.equal(mesh.visible,false,'completion hides every particle layer');
  assert.equal(mesh.geometry.instanceCount,0,'completion clears submitted particle counts');
}
console.log(JSON.stringify({particleCounts}));
console.log('PASS: sky/beam/quake ordering; all-tier brush composition; production terrain shader + no new sampler; clone/idempotence; real fissure safety; 30/60/120 Hz lock + handoff + warning; skip/save/pause; finish/retry reset; actual crater camera; production particle buffers at all tiers, finite attributes, view-depth sorting, pause/rewind determinism, fallback and fade wiring. GPU/FPS not inferred.');
