import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {CollapseDust} from './collapse-dust.js';
import {enhanceStudyRocks} from './collapse-rock-material.js';
const $=s=>document.getElementById(s),container=$('view');
const legacy=new URLSearchParams(location.search).get('collapse-version')==='1';
const assetFolder=legacy?'collapse-study':'collapse-study-v2';
const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});
renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
container.prepend(renderer.domElement);renderer.domElement.setAttribute('aria-label','岩坡崩塌实时三维画面');
const scene=new THREE.Scene();scene.background=new THREE.Color('#18252e');scene.fog=new THREE.Fog('#18252e',60,140);
scene.add(new THREE.HemisphereLight(0xc6dbed,0x544c3d,1.05));
const key=new THREE.DirectionalLight(0xffe1bb,3.2);key.position.set(-20,28,19);key.castShadow=true;key.shadow.mapSize.set(2048,2048);
Object.assign(key.shadow.camera,{left:-26,right:26,top:23,bottom:-23,near:1,far:90});key.shadow.bias=-.00015;key.shadow.normalBias=.035;key.shadow.radius=2;scene.add(key);
const fill=new THREE.DirectionalLight(0x9cbde2,.5);fill.position.set(20,12,-16);scene.add(fill);
const camera=new THREE.PerspectiveCamera(43,1,.1,220),target=new THREE.Vector3(0,legacy?3:5,0);
let az=.38,el=legacy?.28:.06,distance=legacy?43:46,time=0,playing=false,mixer,model,report,duration=14,errors=0;
const clay=new THREE.MeshStandardMaterial({color:0x8b8981,roughness:.92});
const materials=new Map(),actions=[],drag={active:false,x:0,y:0};
renderer.debug.onShaderError=(gl,p)=>{errors++;$('error').textContent='着色器编译失败，请保留此页面反馈。';console.error(gl.getProgramInfoLog(p));};
function resize(){const r=container.getBoundingClientRect();renderer.setSize(r.width,r.height);camera.aspect=r.width/r.height;camera.updateProjectionMatrix();}
new ResizeObserver(resize).observe(container);
new ResizeObserver(entries=>{container.style.bottom=`${entries[0].target.getBoundingClientRect().height}px`;}).observe(document.querySelector('footer'));
renderer.domElement.addEventListener('pointerdown',e=>{drag.active=true;drag.x=e.clientX;drag.y=e.clientY;renderer.domElement.setPointerCapture(e.pointerId);});
renderer.domElement.addEventListener('pointermove',e=>{if(!drag.active)return;az-=(e.clientX-drag.x)*.005;el=THREE.MathUtils.clamp(el+(e.clientY-drag.y)*.004,.05,1.15);drag.x=e.clientX;drag.y=e.clientY;});
renderer.domElement.addEventListener('pointerup',()=>drag.active=false);renderer.domElement.addEventListener('pointercancel',()=>drag.active=false);
renderer.domElement.addEventListener('wheel',e=>{e.preventDefault();distance=THREE.MathUtils.clamp(distance*Math.exp(e.deltaY*.001),18,85);},{passive:false});
$('front').onclick=()=>{az=0;el=legacy?.23:.06;distance=legacy?43:46;};$('side').onclick=()=>{az=.65;el=legacy?.28:.12;distance=legacy?43:46;};
$('play').onclick=()=>{if(time>=duration)time=0;playing=!playing;sync();};
$('reset').onclick=()=>{time=0;playing=false;sync();};
$('impact').onclick=()=>{time=Math.min(8,duration);playing=false;sync();};
$('end').onclick=()=>{time=duration;playing=false;sync();};
$('smokePreview').onclick=()=>{
  $('dust').checked=true;
  // In V2, tiny chips dominate the early contact count; preview the principal
  // rockfall cloud instead of choosing a nearly invisible chip puff.
  const contacts=(report?.contacts||[]).filter(c=>c.kind!=='chip').sort((a,b)=>a.time-b.time);
  time=contacts.length?Math.min(duration,contacts[Math.floor(contacts.length*(legacy?.5:.85))].time+1.8):10;
  playing=false;sync();
};
$('time').oninput=()=>{time=+$('time').value;playing=false;sync();};
function updateRockView(){for(const [mesh,material] of materials){
  const state=mesh.userData[$('originalRock').checked?'studyOriginal':'studyEnhanced'];
  if(state)mesh.geometry=state.geometry;
  mesh.material=$('clay').checked?clay:state?.material||material;
}}
$('clay').onchange=$('originalRock').onchange=updateRockView;
document.addEventListener('visibilitychange',()=>{if(document.hidden){playing=false;sync();}});
function sync(){
  $('play').textContent=playing?'暂停':time>=duration?'重新播放':'播放崩塌';$('time').value=time;
  $('clock').textContent=`${time.toFixed(2)} / ${duration.toFixed(2)} 秒`;
  const phase=legacy?(time<2?'完整岩坡':time<3.3?'支撑错动 · 裂口张开':time<5.5?'岩层失稳 · 大块倾倒':time<9?'碰撞与堆积':'崩塌后的断面'):
    time<1.8?'完整岩体':time<3.5?'前缘失稳 · 底部碎落':time<6.8?'支撑消失 · 分区塌落':time<17?'撞击、碎石与扬尘':time<23?'岩块滚动 · 缓慢停稳':'崩塌后的堆积';
  if($('phase').textContent!==phase)$('phase').textContent=phase;
}

const dust=new CollapseDust(scene,renderer,camera);
try{
  const [gltf,data]=await Promise.all([new GLTFLoader().loadAsync(`../assets/models/${assetFolder}/collapse-study.glb`),fetch(`../assets/models/${assetFolder}/study.json`).then(r=>{if(!r.ok)throw Error('缺少动画清单');return r.json();})]);
  model=gltf.scene;report=data;
  let rocksEnhanced=false;
  try{await enhanceStudyRocks(model,renderer);rocksEnhanced=true;}
  catch(error){$('error').textContent='增强岩石材质加载失败，暂用原版岩石；崩塌动画仍可播放。';console.error(error);}
  scene.add(model);model.traverse(o=>{if(!o.isMesh)return;o.castShadow=o.receiveShadow=true;materials.set(o,o.material);
    if(o.name==='接触地面'){o.castShadow=false;o.material=new THREE.MeshStandardMaterial({color:0x64625a,roughness:1});materials.set(o,o.material);}
  });
  if(!gltf.animations.length)throw Error('GLB 中没有烘焙动画');
  mixer=new THREE.AnimationMixer(model);duration=Math.max(...gltf.animations.map(c=>c.duration));$('time').max=duration;
  for(const clip of gltf.animations){const action=mixer.clipAction(clip);action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();actions.push(action);}
  try{await dust.load(data.contacts);}catch(error){$('error').textContent='烟尘素材加载失败，岩块动画仍可播放。';console.error(error);}
  $('loading').textContent=legacy?`${data.moving} 块活动岩层 / ${data.blocks} 块总岩层 · 旧版动作`:`重做版 · ${data.primary} 块活动主岩体 + ${data.chips} 块扫描碎石 · 分区崩塌`;
  $('detail').textContent=`低重力 ${data.gravity} m/s² · ${rocksEnhanced?'4K 岩石细节 / 冷灰干燥断面':'原版岩石材质'} / ${legacy?'旧版动作':'无整体抬升 / 离线碰撞'} · 正式游戏未改动`;
  $('versionLink').href=legacy?'./collapse-study.html':'?collapse-version=1';$('versionLink').textContent=legacy?'查看重做版':'查看旧版动作';
  $('play').disabled=$('reset').disabled=false;sync();
}catch(e){$('error').textContent=`加载失败：${e.message}`;console.error(e);}

let last=performance.now(),frames=0,stamp=last;
function render(now){requestAnimationFrame(render);const dt=Math.min((now-last)/1000,.05);last=now;
  if(playing){time=Math.min(duration,time+dt*+$('speed').value);if(time>=duration)playing=false;sync();}
  if(mixer){for(const action of actions){action.enabled=true;action.paused=false;}mixer.setTime(time);}
  camera.position.set(target.x+Math.sin(az)*Math.cos(el)*distance,target.y+Math.sin(el)*distance,target.z+Math.cos(az)*Math.cos(el)*distance);
  if($('shake').checked&&playing){const pulse=(report?.contacts||[]).reduce((n,c)=>Math.max(n,Math.exp(-(((time-c.time)/.13)**2))),0);camera.position.x+=Math.sin(time*43)*pulse*.055;camera.position.y+=Math.sin(time*57)*pulse*.045;}
  camera.lookAt(target);dust.update(time,$('dust').checked,+$('dustStrength').value);dust.captureDepth();
  renderer.render(scene,camera);frames++;
  if(now-stamp>750){$('diagnostics').textContent=`动画 ${time.toFixed(2)} 秒 · ${Math.round(frames*1000/(now-stamp))} 帧/秒 · 烟尘 ${dust.visibleCount} 层 · ${renderer.info.render.triangles.toLocaleString()} 三角形 · 着色器错误 ${errors}`;stamp=now;frames=0;}
}
requestAnimationFrame(render);
