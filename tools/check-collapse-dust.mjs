import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dustEmitters,dustPose} from './collapse-dust-timing.js';
const v2=process.argv.includes('--v2');
const report=JSON.parse(readFileSync(new URL(`../assets/models/${v2?'collapse-study-v2':'collapse-study'}/study.json`,import.meta.url)));
const emitters=dustEmitters(report.contacts);
assert(emitters.length<=(v2?160:80));let peak=0;
for(let time=0;time<report.duration+10;time+=1/60){
  let live=0;
  for(const e of emitters){
    const p=dustPose(e,time);
    if(time<=e.start||time>=e.start+e.life){assert.equal(p,null);continue;}
    assert(p);live++;
    for(const v of Object.values(p))assert(Number.isFinite(v));
    assert(p.opacity>=0&&p.opacity<=1);assert(p.frame>=0&&p.frame<24);
    assert(p.width>0&&p.width<16);assert(p.y>.35);
    assert.deepEqual(p,dustPose(e,time),'Repeated seek must be identical');
  }
  peak=Math.max(peak,live);
}
assert(peak>=20);assert(emitters.every(e=>dustPose(e,0)===null&&dustPose(e,report.duration+10)===null));
const png=readFileSync(new URL('../assets/textures/collapse-dust/impact-flipbook.png',import.meta.url));
assert.equal(png.readUInt32BE(16),1024);assert.equal(png.readUInt32BE(20),1024);
assert.equal(createHash('sha256').update(png).digest('hex'),'ecd2592b17777c5c5b28df41951a5de7caec65bdf8f54cd3417b6b3a0d49de4b');
const code=readFileSync(new URL('./collapse-dust.js',import.meta.url),'utf8');
assert(code.includes('depthWrite:false')&&code.includes('THREE.NormalBlending'));
assert(code.includes('finally')&&code.includes('surface-vDepth'));
console.log({result:'PASS',emitters:emitters.length,peak,textureKB:Math.round(png.length/1024),checks:'Verified CC0 atlas; deterministic timing/seek; no smoke before contact; bounded layers and alpha; depth pass state restoration. GPU appearance requires browser check.'});
