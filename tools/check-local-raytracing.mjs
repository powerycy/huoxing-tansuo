import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./three-node-loader.mjs', import.meta.url);
const T = await import('three');
const { collectRayTriangles, packRayBVH, tracePackedRay } = await import('../src/core/local-ray-bvh.js');
const { contactRaySize, CONTACT_RAY_GLSL } = await import('../src/core/local-ray-pass.js');
const { Engine } = await import('../src/core/engine.js');
const { QUALITY } = await import('../src/core/quality.js');
const root = new T.Group();
const box = new T.Mesh(new T.BoxGeometry(2,2,2), new T.MeshStandardMaterial()); root.add(box);
const original = Array.from(box.geometry.attributes.position.array);
assert.equal(collectRayTriangles(root).length,12);
const wheel = new T.Group(); wheel.name='Wheel_left'; wheel.add(box.clone()); root.add(wheel);
assert.equal(collectRayTriangles(root).length,24);
assert.equal(collectRayTriangles(root,{excludeWheels:true}).length,12);
wheel.visible=false;
const hidden = box.clone(); hidden.visible=false; root.add(hidden);
const transparent = box.clone(); transparent.material=new T.MeshStandardMaterial({transparent:true}); root.add(transparent);
const custom = box.clone(); custom.material=new T.ShaderMaterial(); root.add(custom);
assert.equal(collectRayTriangles(root).length,12);
assert.throws(()=>collectRayTriangles(root,{limit:4}));
const packed=packRayBVH(collectRayTriangles(root));
assert.throws(()=>packRayBVH(collectRayTriangles(root),2));
assert.equal(tracePackedRay(packRayBVH([]),new T.Vector3(),new T.Vector3(0,1,0)),false);
assert.equal(tracePackedRay(packed,new T.Vector3(0,3,0),new T.Vector3(0,-1,0)),true);
assert.equal(tracePackedRay(packed,new T.Vector3(3,3,0),new T.Vector3(0,-1,0)),false);
assert.equal(tracePackedRay(packed,new T.Vector3(0,3,0),new T.Vector3(0,-1,0),1),false);
// Compare the packed traversal with brute force on deterministic rays.
const triangles=collectRayTriangles(root); let seed=17;
const rand=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296);
for(let i=0;i<500;i++) {
  const o=new T.Vector3(rand()*8-4,rand()*8-4,rand()*8-4),d=new T.Vector3(rand()-.5,rand()-.5,rand()-.5).normalize();
  const ray=new T.Ray(o,d),hit=new T.Vector3();
  const brute=triangles.some(t=>{const p=ray.intersectTriangle(new T.Vector3().fromArray(t),new T.Vector3().fromArray(t,3),new T.Vector3().fromArray(t,6),false,hit);return p&&p.distanceTo(o)>.025&&p.distanceTo(o)<4;});
  assert.equal(tracePackedRay(packed,o,d),brute);
}
root.position.set(10,4,-8);root.rotation.y=.6;root.scale.set(2,3,.5);root.updateMatrixWorld(true);
const local=collectRayTriangles(root);
for(let i=0;i<12;i++) for(let j=0;j<9;j++) assert.ok(Math.abs(local[i][j]-triangles[i][j])<1e-6);
const o=new T.Vector3(0,3,0).applyMatrix4(root.matrixWorld);
const d=new T.Vector3(0,-1,0);const inverse=root.matrixWorld.clone().invert();
const localO=o.clone().applyMatrix4(inverse),localD=d.clone().applyMatrix3(new T.Matrix3().setFromMatrix4(inverse));
assert.equal(tracePackedRay(packed,localO,localD,5),false);
assert.equal(tracePackedRay(packed,localO,localD,7),true);
assert.deepEqual(Array.from(box.geometry.attributes.position.array),original);
for(const ultra of [false,true]) for(const [w,h] of [[1280,720],[2560,1440],[7680,4320]]) {
 const [x,y]=contactRaySize(w,h,ultra);assert.ok(x*y<=(ultra?240000:140000));assert.ok(x<=w/2&&y<=h/2);
}
assert.match(CONTACT_RAY_GLSL,/triangleHit/); assert.doesNotMatch(CONTACT_RAY_GLSL,/uTime|uFrame/);
// Real Three composer lifecycle; GPU execution is checked in the browser.
let ratio=1,viewport=new T.Vector2(1280,720);
const engine=Object.assign(Object.create(Engine.prototype),{
 quality:QUALITY.high,caps:{hdr:true,maxSamples:4,maxTex:8192},stableFramebuffer:true,renderScale:1,
 renderer:{capabilities:{isWebGL2:true},shadowMap:{},getPixelRatio:()=>ratio,setPixelRatio:v=>ratio=v,
 setSize:(w,h)=>viewport.set(w,h),getDrawingBufferSize:out=>out.copy(viewport).multiplyScalar(ratio).floor()},
 scene:new T.Scene(),camera:new T.PerspectiveCamera(),sun:new T.DirectionalLight(),raySources:[{root}]
});
const priorWindow=globalThis.window;globalThis.window={innerWidth:1280,innerHeight:720,devicePixelRatio:1};
try {
 engine.buildComposer();engine.resize();assert.equal(engine.composer.renderTarget1.depthTexture,null);
 for(let cycle=0;cycle<3;cycle++) {
  engine.setRayTracing(true);const pass=engine.rayPass;
  engine.setRayTracing(true);assert.equal(engine.rayPass,pass);
  const a=engine.composer.renderTarget1.depthTexture,b=engine.composer.renderTarget2.depthTexture;
  assert.notEqual(a,b);assert.notEqual(a.source,b.source,'separate Source prevents WebGL feedback loop');
  assert.equal(engine.features.samples,0);
  engine.final.uniforms.uExposure.value=1.23;
  engine.setQuality('ultra');assert.equal(engine.rayPass,pass);assert.equal(pass.disposed,false);
  assert.equal(engine.final.uniforms.uExposure.value,1.23);
  let freed=0;pass.models[0].texture.addEventListener('dispose',()=>freed++);
  engine.setRayTracing(false);assert.equal(pass.disposed,true);assert.equal(freed,1);
  assert.equal(engine.composer.renderTarget1.depthTexture,null);
  assert.equal(engine.composer.renderTarget2.depthTexture,null);
  engine.setRayTracing(false);assert.equal(freed,1);
 }
} finally {
 for(const pass of engine.composer.passes)pass.dispose?.();engine.composer.dispose();
 if(priorWindow===undefined)delete globalThis.window;else globalThis.window=priorWindow;
}
console.log('PASS: triangle filtering, BVH/brute-force 500 rays, transforms, budgets, independent depth Sources, quality continuity and repeated opt-in resource disposal. GPU/FPS not inferred.');
