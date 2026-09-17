import fs from 'node:fs/promises';
import * as THREE from '../vendor/three/three.module.js';
import { GLTFLoader } from '../vendor/three/examples/jsm/loaders/GLTFLoader.js';

async function loadGeometry(path) {
  const bytes=await fs.readFile(path);
  const jsonLength=bytes.readUInt32LE(12);
  const json=JSON.parse(bytes.toString('utf8',20,20+jsonLength));
  const binStart=20+jsonLength+8;
  // Geometry and animations are tested without allocating texture bitmaps.
  for (const m of json.meshes) for (const p of m.primitives) delete p.material;
  delete json.materials;delete json.textures;delete json.images;
  json.buffers[0].uri='data:application/octet-stream;base64,'+bytes.subarray(binStart).toString('base64');
  globalThis.ProgressEvent ??= class ProgressEvent{};
  const gltf=await new GLTFLoader().parseAsync(JSON.stringify(json),'');
  return gltf;
}
const file=process.argv[2] || 'assets/models/sam/sam-porter-walk-v3.glb';
const gltf=await loadGeometry(file);
const model=gltf.scene;
model.getObjectByName('Icosphere')?.removeFromParent();
const boots={l:[],r:[]};
const meshes=[];
model.traverse(o=>{if(o.isMesh){meshes.push(o.name);for(const s of ['l','r'])if(o.name.startsWith('boot'+s)||o.parent?.name==='boot'+s)boots[s].push(o);}});
const mixer=new THREE.AnimationMixer(model);
const clip=gltf.animations.find(c=>c.name==='Walk');
mixer.clipAction(clip).play();
const v=new THREE.Vector3();
function meshFloor(mesh){let z=Infinity;for(let i=0;i<mesh.geometry.attributes.position.count;i++){mesh.getVertexPosition(i,v).applyMatrix4(mesh.matrixWorld);z=Math.min(z,v.y);}return z;}
const samples=[];
for(let i=0;i<156;i++){
  mixer.setTime(i/156*clip.duration);model.updateMatrixWorld(true);
  model.traverse(o=>{if(o.isSkinnedMesh)o.skeleton.update();});
  const floor={}; for(const s of ['l','r'])floor[s]=Math.min(...boots[s].map(meshFloor));
  const joints={};for(const n of ['root.x','spine_03.x','head.x','arm.l','forearm.l','hand.l','thigh.l','leg.l','foot.l'])joints[n]=model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n)).getWorldPosition(new THREE.Vector3()).toArray();
  samples.push({time:i/156*clip.duration,floor,joints});
}
const morphs=new Set();model.traverse(o=>{for(const n of Object.keys(o.morphTargetDictionary??{}))morphs.add(n);});
const report={file,duration:clip.duration,boots:Object.fromEntries(Object.entries(boots).map(([s,m])=>[s,m.map(o=>o.name)])),supportMax:Math.max(...samples.map(s=>Math.min(s.floor.l,s.floor.r))),supportMin:Math.min(...samples.map(s=>Math.min(s.floor.l,s.floor.r))),headRange:['x','y','z'].map((_,a)=>{const values=samples.map(s=>s.joints['head.x'][a]);return Math.max(...values)-Math.min(...values);}),morphs:[...morphs],samples};
const handPositions=samples.map(s=>s.joints['hand.l']);
report.leftHand={lateralMin:Math.min(...handPositions.map(p=>p[0])),lateralMax:Math.max(...handPositions.map(p=>p[0])),swing:Math.max(...handPositions.map(p=>p[2]))-Math.min(...handPositions.map(p=>p[2]))};
await fs.writeFile('docs/animation-reference/walk-v3-browser-measurements.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({...report,samples:samples.filter((_,i)=>i%26===0)},null,2));
if(!boots.l.length||!boots.r.length||!Number.isFinite(report.supportMax))throw Error('Boot mesh measurements missing');
if(report.supportMax>.015||report.supportMin<-.01)throw Error('Exported foot contact outside tolerance');
if(report.leftHand.lateralMin<.12||report.leftHand.lateralMax>.40||report.leftHand.swing<.08)throw Error('Arm is crossing the torso or frozen in the bind pose');
if(morphs.size!==10)throw Error('Required face morphs were not preserved');
