import {readFileSync,statSync} from 'node:fs';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url),v2=process.argv.includes('--v2'),asset=new URL(`assets/models/${v2?'collapse-study-v2':'collapse-study'}/`,root);
const report=JSON.parse(readFileSync(new URL('study.json',asset)));
const bytes=readFileSync(new URL('collapse-study.glb',asset));
assert.equal(bytes.readUInt32LE(0),0x46546c67);assert.equal(bytes.readUInt32LE(4),2);
const jsonLength=bytes.readUInt32LE(12),g=JSON.parse(bytes.subarray(20,20+jsonLength).toString().trim());
const binStart=20+jsonLength+8;
assert(g.animations?.length,'Baked animation must be exported');
assert(report.moving>=8&&report.blocks>report.moving,'Active pieces + standing shoulders');
assert.equal(report.gravity,1.62);assert(report.maxSpeed<10,'Reject explosive release velocities');
assert(report.maxTravel<35,'Reject fragments launched far outside the test area');
assert(report.finalSpeed<2,'Reject unfinished high-speed flight at end');
assert(report.contacts.length>=4,'Need sampled ground contact events');
if(v2){
  assert.equal(report.version,2);
  assert(report.primary>=15&&report.chips>=15,'Volumetric primary blocks and smaller scan debris');
  assert(report.preReleaseRise<.001,'No upward sheet lift before physics release');
  const releases=report.pieces.filter(p=>p.kind==='primary').map(p=>p.release);
  assert(Math.max(...releases)-Math.min(...releases)>2,'Failure must spread rather than release simultaneously');
}
const animated=new Set();let samples=0;
for(const anim of g.animations)for(const channel of anim.channels){
  const sampler=anim.samplers[channel.sampler],a=g.accessors[sampler.output],view=g.bufferViews[a.bufferView];
  assert(['translation','rotation','scale'].includes(channel.target.path));
  const components=a.type==='VEC4'?4:3;assert.equal(a.componentType,5126);
  for(let i=0;i<a.count;i++)for(let c=0;c<components;c++){
    const offset=binStart+(view.byteOffset||0)+(a.byteOffset||0)+i*(view.byteStride||components*4)+c*4;
    assert(Number.isFinite(bytes.readFloatLE(offset)));samples++;
  }
  if(channel.target.path==='translation')animated.add(channel.target.node);
}
assert(animated.size>=report.moving);
const html=readFileSync(new URL('tools/collapse-study.html',root),'utf8');
assert(/id="dust"[^>]*checked/.test(html),'Smoke should be visible by default');
assert(!/id="shake"[^>]*checked/.test(html),'Camera shake stays off by default');
const js=readFileSync(new URL('tools/collapse-study.js',root),'utf8');
assert(!/localStorage|indexedDB|src\/main\.js|startGame/.test(js),'Preview is isolated from game and saves');
assert(statSync(new URL('collapse-study.glb',asset)).size<10*1024*1024);
console.log(JSON.stringify({result:'PASS',blocks:report.blocks,moving:report.moving,clips:g.animations.length,
  finiteSamples:samples,maxSpeed:report.maxSpeed,finalSpeed:report.finalSpeed,contacts:report.contacts.length,
  sizeMB:+(bytes.length/1024/1024).toFixed(2),note:'Asset/animation safety checks; not a claim of visual realism.'},null,2));
