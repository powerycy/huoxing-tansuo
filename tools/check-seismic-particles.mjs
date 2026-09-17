import assert from 'node:assert/strict';
import { seismicArrivalTime, seismicDustPose, seismicRockPose } from '../src/world/seismic-particles.js';
import { starfallState } from '../src/world/starfall-field.js';

for (const front of [-312, -220, -100, -65, -40, 0, 300]) {
  const time=seismicArrivalTime(front);
  const e={phase:'chase',cinematicActive:time<26,introElapsed:time,introDuration:26,
    elapsed:Math.max(0,time-26),front:time<34?-65:-65+(time-34)*7.5};
  assert.ok(Math.abs(starfallState(e).front-front)<1e-5,'particle birth matches actual visual front');
}
const source={x:40,y:-12,z:-110,birth:20,seed:3.27,size:14};
assert.equal(seismicDustPose(source,20),null);
assert.equal(seismicRockPose(source,20),null);
for(let t=20.05;t<29;t+=.13)for(const layer of [0,1]){
  const p=seismicDustPose(source,t,layer);if(!p)continue;
  assert.deepEqual(p,seismicDustPose(source,t,layer),'seeking/pausing does not drift or respawn clouds');
  assert.ok(Math.hypot(p.x-source.x,p.z-source.z)<4.01,'a cloud stays at its source instead of following the front');
  assert.ok(p.frame>=0&&p.frame<=24&&p.opacity>=0&&p.opacity<=.56);
}
const a=seismicRockPose(source,20.5),b=seismicRockPose(source,21),c=seismicRockPose(source,21.5);
assert.equal(a.size,b.size,'rocks retain their dimensions through flight');
assert.ok(Math.abs(c.y-2*b.y+a.y+3.71*.25)<1e-8,'fragments follow the existing Mars gravity');
assert.equal(seismicDustPose(source,40),null);assert.equal(seismicRockPose(source,40),null);
console.log('PASS: fixed-origin births, seek/pause determinism, finite flipbook/fade, constant fragment size and ballistic gravity.');
