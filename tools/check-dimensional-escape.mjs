import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./three-node-loader.mjs',import.meta.url);
const THREE=await import('three');
const { DimensionalEscape, ESCAPE }=await import('../src/game/dimensional-escape.js');
const { Rover, DRIVE }=await import('../src/game/rover.js');
const { Game }=await import('../src/game/gameplay.js');
const { Delivery }=await import('../src/game/delivery.js');
const { planEscapeRoute }=await import('../src/game/escape-route.js');
const { HOME }=await import('../src/world/props.js');
const { readFileSync }=await import('node:fs');

function fixture(introDuration = 0) {
  const rover={pos:new THREE.Vector3(),vel:new THREE.Vector3(),omega:new THREE.Vector3(),cancelBoost(){}};
  const game={power:1,hull:1}, events=[];
  const e=new DimensionalEscape({rover,game,origin:{x:0,z:0},home:{x:0,z:400},
    introDuration,
    onStart:()=>events.push('start'),onFail:()=>events.push('fail'),onFinish:()=>events.push('finish')});
  return {rover,game,e,events};
}
const advance=(e,n,options)=>{for(let i=0;i<n*60;i++)e.update(1/60,options);};
const a=fixture();a.e.start();a.e.start();assert.deepEqual(a.events,['start']);
assert.equal(a.game.power,100);assert.equal(a.rover.overcharge,true);assert.equal(a.game.hull,100);
advance(a.e,7);assert.equal(a.e.front,ESCAPE.start);
const paused=a.e.save();advance(a.e,20,{paused:true});assert.deepEqual(a.e.save(),paused);
advance(a.e,2);assert.ok(Math.abs(a.e.front-(ESCAPE.start+ESCAPE.speed))<1e-6);
a.rover.pos.z=380;const front=a.e.front;advance(a.e,1);assert.ok(Math.abs(a.e.front-front-ESCAPE.speed)<1e-6,'no rubber band');
const b=fixture();b.rover.pos.copy(a.rover.pos);b.e.load(a.e.save(),'return');
assert.ok(Math.abs(b.e.front-a.e.front)<1e-6);assert.equal(b.rover.overcharge,true);
b.rover.pos.z=400;b.rover.vel.set(0,0,0);const protectedFront=b.e.front;
advance(b.e,5,{holdingHome:true});assert.equal(b.e.front,protectedFront);
advance(b.e,1,{holdingHome:false});assert.ok(b.e.front>protectedFront);
const unprotected=b.e.front;b.rover.vel.z=1;advance(b.e,1,{holdingHome:true});assert.ok(b.e.front>unprotected);
b.rover.vel.z=0;b.e.finish();const ended=b.e.save();advance(b.e,30);assert.deepEqual(b.e.save(),ended);
assert.equal(b.rover.overcharge,false);assert.equal(b.e.start(),false);assert.equal(b.e.finish(),false);
const c=fixture();c.e.start();advance(c.e,20);assert.equal(c.e.phase,'failed');
assert.equal(c.rover.overcharge,false);assert.deepEqual(c.events,['start','fail']);
assert.equal(c.e.retry(),true);assert.equal(c.e.front,ESCAPE.start);assert.equal(c.game.hull,100);
c.e.load(null,'return');assert.equal(c.e.phase,'warning');
c.e.load({version:1,phase:'chase',elapsed:NaN},'return');assert.equal(c.e.elapsed,0);
c.e.load(null,'complete');assert.equal(c.e.phase,'complete');assert.equal(c.rover.overcharge,false);
c.e.reset();assert.equal(c.e.phase,'idle');

// Authored collapse shots and the camera's return are two protected periods.
// The state machine must enforce this even when a caller forgets paused=true.
const intro=fixture(16);assert.equal(intro.e.cinematicActive,false);
assert.equal(intro.e.start(),true);assert.equal(intro.e.start(),false);
assert.deepEqual(intro.events,['start']);assert.equal(intro.e.introActive,true);
assert.equal(intro.e.introProgress,0);intro.rover.pos.z=-100;
advance(intro.e,30);assert.equal(intro.e.phase,'warning');
assert.equal(intro.e.elapsed,0);assert.equal(intro.e.front,ESCAPE.start);
assert.equal(intro.e.introElapsed,0,'ordinary update cannot advance authored shots');
intro.e.advanceIntro(NaN);intro.e.advanceIntro(-1);assert.equal(intro.e.introElapsed,0);
intro.e.advanceIntro(100);assert.equal(intro.e.introElapsed,.1,'large frame is capped');
intro.e.reset();intro.e.start();
for(let i=0;i<360;i++) { intro.e.advanceIntro(1/60);intro.e.update(1/60); }
assert.ok(Math.abs(intro.e.introProgress-.375)<1e-8);
const pausedIntro=intro.e.save();advance(intro.e,30,{paused:true});assert.deepEqual(intro.e.save(),pausedIntro);
const resumedIntro=fixture(16);resumedIntro.e.load(pausedIntro,'return');
assert.equal(resumedIntro.e.cinematicActive,true);assert.equal(resumedIntro.e.introActive,true);
assert.equal(resumedIntro.e.introElapsed,intro.e.introElapsed);assert.equal(resumedIntro.e.elapsed,0);
for(let i=0;i<600;i++) { resumedIntro.e.advanceIntro(1/60);resumedIntro.e.update(1/60); }
assert.equal(resumedIntro.e.introActive,false);assert.equal(resumedIntro.e.introProgress,1);
assert.equal(resumedIntro.e.cinematicActive,true,'camera handoff remains locked after shot');
const handoff=resumedIntro.e.save();advance(resumedIntro.e,30);
assert.deepEqual(resumedIntro.e.save(),handoff,'return camera cannot advance or catch');
const resumedHandoff=fixture(16);resumedHandoff.e.load(handoff,'return');
assert.equal(resumedHandoff.e.introActive,false);assert.equal(resumedHandoff.e.cinematicActive,true);
resumedHandoff.rover.pos.z=400;assert.equal(resumedHandoff.e.finishIntro(),true);
assert.equal(resumedHandoff.e.finishIntro(),false);assert.equal(resumedHandoff.e.cinematicActive,false);
advance(resumedHandoff.e,7.5);assert.equal(resumedHandoff.e.phase,'warning');assert.equal(resumedHandoff.e.front,ESCAPE.start);
advance(resumedHandoff.e,1.5);assert.equal(resumedHandoff.e.phase,'chase');
assert.ok(Math.abs(resumedHandoff.e.front-(ESCAPE.start+ESCAPE.speed))<1e-6,'full warning grace begins after handoff');
const resumedChase=fixture(16);resumedChase.rover.pos.z=400;
resumedChase.e.load(resumedHandoff.e.save(),'return');assert.equal(resumedChase.e.cinematicActive,false);
assert.equal(resumedChase.e.front,resumedHandoff.e.front);
const chaseTime=resumedChase.e.elapsed;assert.equal(resumedChase.e.finishIntro(),false);
assert.equal(resumedChase.e.elapsed,chaseTime,'stale camera completion cannot rewind loaded chase');
const skipped=fixture(16);skipped.e.start();skipped.e.advanceIntro(.1);
assert.equal(skipped.e.skipIntro(),true);assert.equal(skipped.e.introActive,false);
assert.equal(skipped.e.cinematicActive,true);advance(skipped.e,20);assert.equal(skipped.e.elapsed,0);
skipped.e.finishIntro();advance(skipped.e,20);assert.equal(skipped.e.phase,'failed');
assert.equal(skipped.e.cinematicActive,false);assert.equal(skipped.e.retry(),true);
assert.equal(skipped.e.introActive,true);assert.equal(skipped.e.introElapsed,0);
skipped.e.finish();assert.equal(skipped.e.cinematicActive,false);assert.equal(skipped.e.advanceIntro(.1),false);
const old=fixture(16);old.e.load({version:1,phase:'chase',elapsed:21},'return');
assert.equal(old.e.phase,'chase');assert.equal(old.e.cinematicActive,false);
assert.equal(old.e.front,ESCAPE.start+13*ESCAPE.speed);
old.e.load({version:1,phase:'warning',elapsed:3},'return');
assert.equal(old.e.cinematicActive,false);assert.equal(old.e.elapsed,3);
old.e.load(null,'return');assert.equal(old.e.introActive,true,'missing save starts safe introduction');
for(const bad of [
  {...pausedIntro,introElapsed:NaN},{...pausedIntro,introElapsed:17},
  {...pausedIntro,introDuration:-1},{...pausedIntro,introDuration:Infinity},
  {...pausedIntro,cinematicActive:'true'},{...pausedIntro,elapsed:3},
  {...pausedIntro,phase:'chase'},{...pausedIntro,version:999},
]) {
 old.e.load(bad,'return');assert.equal(old.e.elapsed,0);assert.equal(old.e.introElapsed,0);
 assert.equal(old.e.front,ESCAPE.start);assert.equal(old.e.introActive,true);
}
old.e.load({...handoff,phase:'failed',cinematicActive:false},'return');
assert.equal(old.e.phase,'failed');assert.equal(old.e.cinematicActive,false);
old.e.reset();assert.equal(old.e.cinematicActive,false);assert.equal(old.e.introElapsed,0);

// Real delivery input route: docking starts exactly once; home requires hold E.
const h=fixture(), d=Object.create(Delivery.prototype);
Object.assign(d,{stage:'relay',scan:{},rover:h.rover,rig:{mode:0},integrity:100,game:{unlock(){},enterDeliveryMode(){}},
 hud:{flashDiscovery(){},log(){},el:{drillprog:{style:{}}}},audio:{ui(){},radio(){}},
 _setFacilityPower(){},_layoutStageRoute(){},_syncGameState(){},
 onStage:(_,stage)=>{if(stage==='return')h.e.start();},onComplete:()=>h.e.finish()});
h.rover.pos.set(-140,0,-104);d._dockCargo();assert.equal(d.stage,'return');assert.equal(h.e.active,true);
d._dockCargo();assert.equal(h.events.length,1);
// Exercise hold/release in Delivery.update, not just its completion method.
Object.assign(d,{movedOnce:true,moveHintT:0,interact:0,_updateScan(){},_syncCargo(){}});
h.rover.pos.set(HOME.x-9,0,HOME.z);
const deliveryStep=held=>d.update(.1,{throttle:0},{hit:()=>false,down:k=>held&&k==='KeyE'});
deliveryStep(true);assert.equal(d.holdingHome,true);assert.equal(d.stage,'return');
deliveryStep(false);assert.equal(d.holdingHome,false);assert.equal(d.interact,0);
for(let i=0;i<15;i++)deliveryStep(true);assert.equal(d.stage,'return');
deliveryStep(true);assert.equal(h.e.phase,'complete');assert.equal(d.transmitted,true);

// Actual rover solver, only model/texture construction is stubbed.
Rover.prototype.build=function(){};Rover.prototype.loadMoonRoverExterior=()=>Promise.resolve();
const idle={throttle:0,steer:0,brake:1,boost:false,tc:true};
function create(degrees=0) {
 const slope=Math.tan(degrees*Math.PI/180);
 const terrain={heightAt:(x,z)=>z*slope,normalAt:(x,z,e,out)=>out.set(0,1,-slope).normalize()};
 const r=new Rover(terrain,new THREE.Scene());r.placeAt(0,0);
 r.quat.setFromUnitVectors(new THREE.Vector3(0,1,0),new THREE.Vector3(0,1,-slope).normalize());
 for(let i=0;i<240;i++)r.step(1/120,idle,terrain);
 r.vel.set(0,0,0);r.omega.set(0,0,0);for(const w of r.wheels)w.spinVel=0;
 return {r,terrain};
}
const results=[];
for(const hz of [30,60,120])for(const degrees of [0,30,50])for(const boost of [false,true]) {
 const {r,terrain}=create(degrees);r.overcharge=true;const start=r.pos.clone();let alignment=1;
 for(let i=0;i<hz*12;i++) {
  r.step(1/hz,{...idle,brake:0,throttle:1,boost},terrain);
  assert.ok(r.pos.toArray().every(Number.isFinite));assert.ok(Math.abs(r.quat.length()-1)<1e-6);
  alignment=Math.min(alignment,r.up.dot(new THREE.Vector3(0,1,-Math.tan(degrees*Math.PI/180)).normalize()));
 }
 const speed=r.speed;assert.ok(speed>(boost?29:15),`speed ${speed} @${hz}/${degrees}/${boost}`);
 assert.ok(alignment>.88,`upright ${alignment}`);
 const stop=r.pos.clone();for(let i=0;i<hz*5;i++)r.step(1/hz,idle,terrain);
 assert.ok(r.vel.length()<.75,`must park: ${r.vel.length()}`);
 results.push({hz,degrees,boost,speed:+speed.toFixed(2),distance:+r.pos.distanceTo(start).toFixed(1),stopDistance:+r.pos.distanceTo(stop).toFixed(1)});
}
const original=DRIVE.maxSpeed;assert.equal(original,8.4,'settings untouched');
const savedMotion=create(), restoredMotion=create();
const motionA=new DimensionalEscape({rover:savedMotion.r,game:{},origin:{x:0,z:0},home:{x:0,z:400}});
const motionB=new DimensionalEscape({rover:restoredMotion.r,game:{},origin:{x:0,z:0},home:{x:0,z:400}});
motionA.start();savedMotion.r.vel.set(1,2,30);savedMotion.r.pos.set(3,4,5);savedMotion.r.headlights=true;
motionB.load(motionA.save(),'return');assert.equal(motionB.restoredMotion,true);
assert.deepEqual(restoredMotion.r.vel.toArray(),[1,2,30]);assert.deepEqual(restoredMotion.r.pos.toArray(),[3,4,5]);
assert.equal(restoredMotion.r.headlights,true);
const airA=create(),airB=create();airB.r.overcharge=true;
for(const f of [airA,airB]){f.r.pos.set(0,100,0);f.r.vel.set(0,1,10);}
for(let i=0;i<60;i++)for(const f of [airA,airB])f.r.step(1/60,{...idle,brake:0,throttle:1,boost:true},f.terrain);
assert.deepEqual(airA.r.pos.toArray(),airB.r.pos.toArray(),'no airborne propulsion / unchanged gravity');

// Geometric route avoids blocking models rather than plotting across them.
const obstacles=[{x:0,z:40,r:10},{x:8,z:72,r:7}], flat={heightAt:()=>0};
const route=planEscapeRoute({x:0,z:0},{x:0,z:110},flat,obstacles);
assert.ok(route.length>5);
for(const p of route)for(const o of obstacles)assert.ok(Math.hypot(p.x-o.x,p.z-o.z)>o.r+2.5);
assert.deepEqual(planEscapeRoute({x:0,z:0},{x:0,z:110},flat,[{x:0,z:0,r:500}]),[]);

// Overcharge runs through the actual pack accounting before lamp shutdown.
const rpack={pos:new THREE.Vector3(),vel:new THREE.Vector3(),up:new THREE.Vector3(0,1,0),sunVis:1,
 motorLoad:1,lampPower:1,highBeamPower:1,boostBlend:1,headlights:true,highBeams:true,armOut:false};
const pack=Object.assign(Object.create(Game.prototype),{rover:rpack,props:{},overcharge:true,
 sky:{anomalyMoonDir:{y:.5},anomalyMoonKey:.46,sunDir:{y:-1}},terrain:{heightAt:()=>0},
 scan:{active:false,cool:0},drill:{active:false},t:0,met:0,power:0,heat:12,hull:100,deliveryMode:true,
 missionIdx:999,bay:[],anoms:[],interact:{t:0},hud:{setPrompt(){}},audio:{ui(){}},log(){}});
for(let i=0;i<100;i++)pack.update(.1,{throttle:1},{down:()=>false,hit:()=>false});
assert.equal(pack.power,100);assert.equal(rpack.headlights,true);assert.equal(rpack.highBeams,true);
assert.equal(rpack.powerScale,1);assert.equal(rpack.boostAvailable,1);
pack.overcharge=false;pack.update(.1,{throttle:1},{down:()=>false,hit:()=>false});assert.ok(pack.power<100);
let stranded=false;
pack.overcharge=true;pack.escapeEvent={active:true,fail(){stranded=true;}};pack.strand();assert.equal(stranded,true);

// Entry/terminal gates and preview storage isolation are part of the contract.
const main=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
assert.match(main,/stage === 'return'\) escape\?\.start/);
assert.match(main,/onComplete: \(\) => escape\?\.finish/);
assert.match(main,/escape\.update\(dt,\{paused:controlsLocked,holdingHome:delivery.holdingHome\}\)/);
assert.match(main,/if \(escape\.active\) dt=Math\.min\(dt,0.05\)/);
assert.match(main,/const d = App.escape\?\.active \? 0 : DRIVE.commsDelay/);
assert.match(main,/App\.state !== ST\.END &&/);
assert.match(main,/App\.fold\.uniforms\.uFoldOn\.value===0/);
const storage=new Map();globalThis.localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
globalThis.location={search:''};const normal=(await import('../src/core/save.js?escape-normal')).Save;
normal.write({power:31});globalThis.location.search='?escape-preview=1';
const preview=(await import('../src/core/save.js?escape-preview')).Save;preview.clear();preview.write({power:100});
assert.equal(normal.read().power,31);assert.equal(preview.read().power,100);
console.log(JSON.stringify({status:'PASS',checks:'trigger once; protected intro; camera handoff; full warning grace; skip; v2 intro/handoff/chase save and v1 migration; invalid saves; warning; fixed pursuit; pause; valid home protection; release; save/load; retry; immutable ending; real six-wheel overcharge; braking; slope stability; airborne gravity; obstacle route',results},null,2));
