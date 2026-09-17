import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
register('./three-node-loader.mjs',import.meta.url);
const T=await import('three');
const { chargeState, chargePrompt }=await import('../src/game/charging.js');
const { Game }=await import('../src/game/gameplay.js');
const { HOME }=await import('../src/world/props.js');
const props={stationChargePoint:{x:-240,z:132,r:4.4},stationOnline:true,relayChargePoint:{x:-128,z:-114,r:4.4}};
const rover={pos:new T.Vector3(),vel:new T.Vector3(),up:new T.Vector3(0,1,0),sunVis:1,
 motorLoad:0,lampPower:0,highBeamPower:0,boostBlend:0,armOut:false};
const game=Object.assign(Object.create(Game.prototype),{rover,props,
 sky:{anomalyMoonDir:{y:.5},anomalyMoonKey:.46,sunDir:{y:-1}},terrain:{heightAt:()=>0},
 scan:{active:false,cool:0},drill:{active:false},t:0,met:0,power:42,heat:12,hull:100,deliveryMode:true,
 missionIdx:999,bay:[],anoms:[],interact:{t:0},hud:{setPrompt(){}},audio:{ui(){}},log(){}});
function step(pressed,{locked=false,throttle=0}={}){game.update(.1,{throttle,interactionLocked:locked},{down:()=>false,hit:k=>pressed&&k==='KeyT'});}
for(const [id,p] of [['SLED',HOME],['HALLEY VI',props.stationChargePoint],['RELAY',props.relayChargePoint]]){
 rover.pos.set(p.x,0,p.z);rover.vel.set(0,0,0);game.power=42;
 const before=game.power;step(false);assert.ok(game.power<before,'parking alone never charges');
 assert.match(chargePrompt(rover,game.power),/按 <kbd>T/);
 const ready=game.power;for(let i=0;i<10;i++)step(i===0);
 assert.equal(rover.chargingSite,id);assert.equal(rover.charging,true);assert.ok(game.power>ready+8);
 assert.match(chargePrompt(rover,game.power),/停止/);
 const charging=game.power;step(false);assert.ok(game.power>charging,'release must keep charging');
 const charged=game.power;step(true);assert.ok(game.power<charged);assert.equal(rover.coupled,false);
 step(false);assert.equal(rover.coupled,false,'stays off until another press');
 step(true);assert.equal(rover.coupled,true);
 rover.vel.set(1,0,0);step(true);assert.equal(rover.coupled,false);assert.match(chargePrompt(rover,game.power),/停车/);
 rover.vel.set(0,0,0);step(true,{throttle:1});assert.equal(rover.coupled,false);
 step(true);assert.equal(rover.coupled,true);
 step(false,{locked:true});assert.equal(rover.coupled,false,'photo/locked control cancels a latch');
 step(false);assert.equal(rover.coupled,false,'unlock never reconnects automatically');
 game.power=99.8;step(true);assert.equal(game.power,100);assert.match(chargePrompt(rover,game.power),/已满/);
 rover.pos.x+=7;step(true);assert.equal(rover.coupled,false);assert.match(chargePrompt(rover,game.power),/驶入/);
 rover.pos.x+=100;step(true);assert.equal(chargePrompt(rover,game.power),'');
}
props.stationOnline=false;rover.pos.set(props.stationChargePoint.x,0,props.stationChargePoint.z);game.power=20;
step(true);assert.equal(rover.coupled,false);assert.match(chargePrompt(rover,game.power),/恢复基地/);
assert.equal(chargeState(rover,props,HOME,true).coupled,false);
props.stationOnline=true;assert.equal(chargeState(rover,props,HOME,true).coupled,true);
const terrain=readFileSync(new URL('../src/world/terrain.js',import.meta.url),'utf8');
assert.match(terrain,/petalVisibility = 0\.015 \+ 0\.985\*sm\*ci/);
assert.match(terrain,/flowerSilver\*carpet\*petalVisibility/);
const { GlassField }=await import('../src/world/glass-rocks.js');
const glass=Object.assign(Object.create(GlassField.prototype),{scanGlow:0,material:new T.MeshStandardMaterial(),plateMaterial:new T.MeshStandardMaterial()});
glass.update(.1);assert.equal(glass.material.emissiveIntensity,0);assert.equal(glass.plateMaterial.emissiveIntensity,0);
glass.reveal(1);glass.update(.1);assert.ok(glass.material.emissiveIntensity>0);
glass.update(2);assert.equal(glass.material.emissiveIntensity,0);
const delivery=readFileSync(new URL('../src/game/delivery.js',import.meta.url),'utf8');
assert.doesNotMatch(delivery,/chargePrompt/,'charging is not mixed into E mission prompts');
const propsSource=readFileSync(new URL('../src/world/props.js',import.meta.url),'utf8');
assert.doesNotMatch(propsSource,/addChargeSign|chargeSigns|ChargeSign-/,'no floating charger name boards');
assert.match(propsSource,/LoneRelayChargeBay/,'physical charge bay remains');
console.log('PASS: all 3 chargers; tap on/off, persists after release, motion/range/offline/full/locked cancellation; separate battery hint; shadow-gated carpet; scan-only glass emission.');
