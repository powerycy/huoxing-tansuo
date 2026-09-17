import assert from 'node:assert/strict';
import {seismicDrop,faultWidth,faultContains,faultBend,starfallState} from '../src/world/starfall-field.js';

const origin={x:0,z:0},axis={x:0,z:1};
let samples=0,interrupted=0,open=0;
// Finite, bounded and settled displacement; safe driving side never deforms.
for(let s=-550;s<=550;s+=11)for(let d=-350;d<=600;d+=19){
  assert.equal(seismicDrop(s,d,origin,axis,d,1),0);
  assert.equal(seismicDrop(s,d,origin,axis,d+2,1),0);
  assert.equal(seismicDrop(s,d,origin,axis,d+80,0),0);
  const settled=seismicDrop(s,d,origin,axis,d+80,1);
  assert.ok(settled>=4&&settled<=14);
  assert.equal(settled,seismicDrop(s,d,origin,axis,d+180,1),'collapsed slabs stay down');
  let previous=0;
  for(let distance=0;distance<=35;distance+=.25){
    const current=seismicDrop(s,d,origin,axis,d+distance,1);
    assert.ok(current>=previous-1e-10,'advancing front cannot rebound the terrain');
    assert.ok(current-previous<.33,'no per-slab release jump');
    previous=current;
  }
  samples++;
}
// Cell boundaries join continuously even on negative world coordinates.
for(let i=-10;i<=10;i++)for(let j=-8;j<=15;j++){
  const x=i*54,z=j*38;
  assert.ok(Math.abs(seismicDrop(x-.0001,z,origin,axis,800,1)-seismicDrop(x+.0001,z,origin,axis,800,1))<1e-5);
  assert.ok(Math.abs(seismicDrop(x,z-.0001,origin,axis,800,1)-seismicDrop(x,z+.0001,origin,axis,800,1))<1e-5);
}
// No new cave reaches the authoritative catch line; different fault rows no
// longer produce identical uninterrupted open stripes.
for(let row=-364;row<=624;row+=26)for(let s=-550;s<=550;s+=5){
  const center=row+faultBend(s),width=faultWidth(s,row,center+70,1);
  assert.ok(width>=0&&width<=2.6);
  if(width<.01)interrupted++;else open++;
  let previous=0;
  for(let distance=0;distance<=30;distance+=.5){
    const front=center+distance,w=faultWidth(s,row,front,1);
    assert.ok(w>=previous-1e-10);
    if(w>.001)assert.ok(center+w<front);
    assert.equal(faultContains(s,front+5,origin,axis,front,1),false);
    previous=w;
  }
}
assert.ok(interrupted>100&&open>100,'faults contain both intact and open stretches');
const releases=[-180,-75,10,100,235].map(s=>seismicDrop(s,0,origin,axis,8,1));
assert.ok(Math.max(...releases)-Math.min(...releases)>.5,'different slabs visibly release at different rates');
const rowWidths=[-130,-104,-78,-52,-26,0,26].map(row=>faultWidth(20,row,700,1));
assert.ok(new Set(rowWidths.map(w=>w.toFixed(3))).size>=4,'rows do not repeat one width profile');

// The authored intro, safe handoff and fixed-speed chase retain their mapping.
for(let t=0;t<=100;t+=.125){
  const front=-65+Math.max(0,t-34)*7.5;
  const state=starfallState({phase:'warning',front,cinematicActive:t<26,introElapsed:Math.min(t,26),introDuration:26,elapsed:Math.max(0,t-26)});
  assert.ok(state.front<=front);
  if(t>=26)assert.equal(state.front,front);
}
console.log(`PASS: ${samples} terrain samples; monotonic staggered descent, bounded continuous slabs, ${interrupted} intact / ${open} open fault segments, safe front and unchanged cinematic/chase mapping. GPU compilation is checked in the browser.`);
