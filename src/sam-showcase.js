import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MODEL = 'assets/models/sam/sam-porter-walk-v3.glb';
const CARGO_MODEL = 'assets/models/cargo/ds-weighted-loadout.glb';
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(1920, 1080);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x858b91);
scene.fog = new THREE.Fog(0x858b91, 8, 18);
const camera = new THREE.PerspectiveCamera(43, 1920 / 1080, 0.05, 50);
const target = new THREE.Vector3(0, 1.02, -0.06);

const hemi = new THREE.HemisphereLight(0xeaf7ff, 0x26303a, 2.0);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xfff1db, 4.2);
key.position.set(-3.5, 6.5, 4.0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = key.shadow.camera.bottom = -3;
key.shadow.camera.right = key.shadow.camera.top = 3;
scene.add(key);
const rim = new THREE.DirectionalLight(0x88dff8, 2.2);
rim.position.set(4, 3, -4);
scene.add(rim);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(7, 96),
  new THREE.MeshStandardMaterial({ color: 0x767d83, roughness: 0.88, metalness: 0.02 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const rings = new THREE.GridHelper(10, 20, 0xbcc7cc, 0x979fa4);
rings.material.transparent = true;
rings.material.opacity = 0.34;
scene.add(rings);

const loader = new GLTFLoader();
const [gltf, cargoGltf] = await Promise.all([
  loader.loadAsync(MODEL),
  loader.loadAsync(CARGO_MODEL),
]);
const model = gltf.scene;
// This hidden collision/debug sphere is wider than Sam and must not participate
// in height normalization. Box3 traverses invisible objects too, so remove it.
const scaleHelper = model.getObjectByName('Icosphere');
if (scaleHelper?.parent) scaleHelper.parent.remove(scaleHelper);
model.traverse((object) => {
  if (!object.isMesh) return;
  object.castShadow = true;
  object.receiveShadow = true;
  object.frustumCulled = false;
});
const faceController = createFaceController(model);
model.updateMatrixWorld(true);
const bounds = new THREE.Box3().setFromObject(model);
const scale = 1.82 / (bounds.getSize(new THREE.Vector3()).y || 1);
model.scale.setScalar(scale);
model.updateMatrixWorld(true);
// V3 soles are baked against world Y=0. Rest-pose bounds include boot/rig
// offsets and must not be used to lift the animated character a second time.
model.position.y = 0;

const actor = new THREE.Group();
const cargoRig = new THREE.Group();
const cargo = cargoGltf.scene;
layoutCargoStack(cargo);
cargo.traverse((object) => {
  if (!object.isMesh) return;
  object.castShadow = true;
  object.receiveShadow = true;
  object.frustumCulled = false;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) {
    if (!material) continue;
    material.roughness = Math.max(material.roughness ?? 0.45, 0.38);
    material.metalness = Math.min(material.metalness ?? 0.25, 0.52);
  }
});
cargoRig.add(cargo);
// Layout is in model metres. The cases sit behind the rack; the rack rests
// against the suit's back plate, with its lower edge near the lumbar support.
cargoRig.position.set(0, 0.86 * scale, -0.14 * scale);
cargoRig.scale.setScalar(scale);
// The shoulder contact sits closer to the body than the waist end of the
// frame. This five-degree rake is visible in the approved reference and makes
// the load read as resting on two body supports instead of hanging vertically.
cargoRig.rotation.x = THREE.MathUtils.degToRad(5);
actor.add(model, cargoRig);
scene.add(actor);
const mixer = new THREE.AnimationMixer(model);
const walk = gltf.animations.find((clip) => clip.name === 'Walk');
if (!walk) throw new Error('Walk clip missing');
const action = mixer.clipAction(walk);
action.setLoop(THREE.LoopRepeat, Infinity).play();
action.timeScale = 1.0;

// Bind the rack only after the skeleton has entered its first walk
// pose. Binding it in the untouched rig pose caused the animated spine to add a
// large vertical offset on frame one, making the cargo jump upward into a pole.
mixer.setTime(0);
actor.updateMatrixWorld(true);
// A strapped load is supported between the shoulder blades and the waist. The
// middle spine is a steadier anchor than the upper chest, so the boxes follow
// the carried mass instead of copying every shoulder twist from the walk.
// GLTFLoader removes periods from node names. Looking up the Blender name
// directly silently failed and left the previous rack fixed in world space.
const cargoAnchor = model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName('spine_02.x'));
if (!cargoAnchor) throw new Error('未找到背部骨骼，无法固定货物');
cargoAnchor.attach(cargoRig);

const requestedTime = new URLSearchParams(location.search).get('time');
let playing = requestedTime === null;
if (requestedTime !== null) {
  mixer.setTime(Math.max(0, Number(requestedTime) || 0));
  action.paused = true;
  document.querySelector('#toggle').textContent = '继续';
  document.querySelector('#toggle').classList.add('on');
}
let travelTime = 0;
const groundSpeed = 0.7444168734491314 * scale;
const views = {
  front: new THREE.Vector3(0, 1.18, 4.3),
  back: new THREE.Vector3(0, 1.18, -4.3),
  side: new THREE.Vector3(4.3, 1.18, 0),
  oblique: new THREE.Vector3(3.5, 1.18, -2.0),
  hands: new THREE.Vector3(0, 1.06, 2.55),
};
const selectedView = new URLSearchParams(location.search).get('view') || 'side';
const cameraGoal = (views[selectedView] || views.side).clone();
document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === selectedView));
camera.position.copy(cameraGoal);
camera.lookAt(target);

document.querySelectorAll('[data-view]').forEach((button) => {
  button.onclick = () => {
    document.querySelectorAll('[data-view]').forEach((item) => item.classList.toggle('on', item === button));
    cameraGoal.copy(views[button.dataset.view]);
  };
});
document.querySelectorAll('[data-expression]').forEach((button) => {
  button.onclick = () => {
    document.querySelectorAll('[data-expression]').forEach((item) => item.classList.toggle('on', item === button));
    faceController.setMode(button.dataset.expression);
  };
});
document.querySelector('#toggle').onclick = (event) => {
  playing = !playing;
  action.paused = !playing;
  event.currentTarget.textContent = playing ? '暂停' : '继续';
  event.currentTarget.classList.toggle('on', !playing);
};
const timeline = document.querySelector('#phase');
const phaseLabel = document.querySelector('#phase-label');
function seekPhase(value) {
  playing = false;
  // setTime on a paused action does not evaluate it. Sample unpaused first.
  action.paused = false;
  mixer.setTime(value * walk.duration);
  action.paused = true;
  document.querySelector('#toggle').textContent = '继续';
  document.querySelector('#toggle').classList.add('on');
  timeline.value = value;
}
timeline.oninput = () => seekPhase(Number(timeline.value));
document.querySelectorAll('[data-phase]').forEach((button) => {
  button.onclick = () => seekPhase(Number(button.dataset.phase));
});
document.querySelector('#loading').classList.add('hidden');

const output = document.createElement('canvas');
output.width = 1920; output.height = 1080;
output.id = 'recording-canvas';
renderer.domElement.style.display = 'none';
document.body.prepend(output);
const ctx = output.getContext('2d', { alpha: false });
const status = document.querySelector('#record-status');
const startButton = document.querySelector('#record-start');
const faceButton = document.querySelector('#face-preview');
const stageList = [
  [0, 'side', 'neutral', null, '中等负重行走', '正侧面 · 连续步态与重心变化'],
  [6, 'front', 'neutral', null, '正面观察', '左右摆臂 · 腿部交替与身体协调'],
  [12, 'back', 'neutral', null, '背部货物', '背面 · 货架随身体运动'],
  [18, 'oblique', 'neutral', null, '斜后侧观察', '人物轮廓 · 负重姿态与货物层次'],
  [24, 'hands', 'neutral', null, '手部与摆臂', '近景 · 手指姿态与行走联动'],
  [29, 'side', 'neutral', 0, '步态分解 / 脚跟接触', '暂停并定位到步行动画的指定阶段'],
  [32, 'side', 'neutral', .16, '步态分解 / 承重', '观察支撑腿、膝盖与重心'],
  [35, 'side', 'neutral', .35, '步态分解 / 经过', '观察摆动腿经过身体下方'],
  [38, 'side', 'neutral', .60, '步态分解 / 脚尖离地', '观察后脚抬起与下一步衔接'],
  [41, 'face', 'neutral', null, '面部 / 自然与自动眨眼', '保留面部形变 · 自动眨眼持续运行'],
  [48, 'face', 'smile', null, '面部 / 微笑', '嘴角与眉部表情平滑切换'],
  [53, 'face', 'serious', null, '面部 / 严肃', '眉部与嘴角的组合变化'],
  [58, 'face', 'speak', null, '面部 / 嘴部测试', '程序驱动张合演示 · 无语音同步'],
  [63, 'oblique', 'neutral', null, 'SAM PORTER / 步行 V3', '行走 · 多视角 · 步态分解 · 面部表情'],
];
views.face = new THREE.Vector3(0, 1.69, 0.92);
const goalTarget = target.clone();
let activeStage = -1, demoTime = 0, recording = false, finished = false;
let recorder, chunks = [], mode = 'preview';
let recordedFrames = 0, recordStart = 0;
function stageAt(time) {
  let index = 0;
  stageList.forEach((s, i) => { if (time >= s[0]) index = i; });
  return index;
}
function applyStage(index, snap = false) {
  activeStage = index;
  const [, view, expression, phase] = stageList[index];
  cameraGoal.copy(views[view]);
  goalTarget.set(0, view === 'face' ? 1.68 : 1.02, view === 'face' ? 0.03 : -0.06);
  faceController.setMode(expression);
  if (phase !== null) seekPhase(phase);
  else { playing = true; action.paused = false; }
  if (snap) { camera.position.copy(cameraGoal); target.copy(goalTarget); }
}
function drawOverlay() {
  ctx.drawImage(renderer.domElement, 0, 0, 1920, 1080);
  const [, view, expression, phase, title, detail] = stageList[Math.max(0, activeStage)];
  ctx.fillStyle = '#111b25cc'; ctx.fillRect(0, 0, 1920, 94);
  ctx.fillStyle = '#f1f6f9'; ctx.font = '500 25px sans-serif';
  ctx.fillText('SAM PORTER', 54, 43);
  ctx.font = '16px sans-serif'; ctx.fillStyle = '#aebec8';
  ctx.fillText('步行 V3  /  功能展示', 54, 72);
  const sections = ['负重行走', '多视角', '步态分解', '面部表情'];
  const section = activeStage === 0 ? 0 : activeStage < 5 ? 1 : activeStage < 9 ? 2 : 3;
  sections.forEach((s, i) => {
    const x = 1260 + i * 153;
    ctx.fillStyle = i === section ? '#8ae0ec' : '#a1aeb7'; ctx.font = '20px sans-serif';
    ctx.fillText(s, x, 54);
    if (i === section) ctx.fillRect(x, 68, 82, 2);
  });
  ctx.fillStyle = '#111b25e8'; ctx.fillRect(0, 922, 1920, 158);
  ctx.fillStyle = '#f1f6f9'; ctx.font = '500 33px sans-serif'; ctx.fillText(title, 54, 977);
  ctx.fillStyle = '#b5c6d0'; ctx.font = '23px sans-serif'; ctx.fillText(detail, 54, 1021);
  ctx.font = '18px monospace'; ctx.fillStyle = '#8ae0ec';
  ctx.textAlign = 'right'; ctx.fillText('独立人物预览  /  实时渲染', 1866, 984);
  ctx.fillStyle = '#b5c6d0'; ctx.fillText(`${String(Math.floor(demoTime)).padStart(2, '0')} / 68 SEC`, 1866, 1020); ctx.textAlign = 'left';
  ctx.fillStyle = '#273943'; ctx.fillRect(54, 1054, 1812, 3);
  ctx.fillStyle = '#8ae0ec'; ctx.fillRect(54, 1054, 1812 * Math.min(1, demoTime / 68), 3);
}
startButton.onclick = () => {
  if (recording) return;
  demoTime = 0; activeStage = -1; finished = false; mode = 'record';
  mixer.setTime(0); applyStage(0, true);
  const stream = output.captureStream(30);
  const mimeType = 'video/webm;codecs=vp8';
  if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error('浏览器不支持 WebM 录制');
  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 14000000 });
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    status.textContent = '录制完成，正在保存视频……';
    try {
      const blob = new Blob(chunks, { type: mimeType });
      const response = await fetch('http://127.0.0.1:5188/recording', { method: 'POST', body: blob });
      if (!response.ok) throw new Error(`保存失败 ${response.status}`);
      const result = await response.json();
      status.textContent = `视频已保存 · ${Math.round(blob.size / 1024 / 1024)} MB · ${Math.round(recordedFrames / 68)} 渲染帧/秒`;
      document.body.dataset.recording = 'saved';
    } catch (e) { status.textContent = e.message; document.body.dataset.recording = 'error'; }
    startButton.disabled = false;
  };
  recordedFrames = 0; recordStart = performance.now();
  recorder.start(1000); recording = true;
  startButton.disabled = true; status.textContent = '正在录制 · 0 / 68 秒';
  document.body.dataset.recording = 'running';
};
faceButton.onclick = () => { if (!recording) { demoTime = 42; mode = 'face'; applyStage(9, true); } };
const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (recording) demoTime = Math.min(68, (performance.now() - recordStart) / 1000);
  else if (mode === 'preview') demoTime = (demoTime + dt) % 68;
  const next = stageAt(demoTime);
  if (next !== activeStage) applyStage(next);
  if (playing) { mixer.update(dt); travelTime += dt; rings.position.z = -(travelTime * groundSpeed) % .5; }
  faceController.update(dt);
  // Orbit around the actor; a straight interpolation from front to back
  // crosses through the character and ruins the demonstration transition.
  const blend = 1 - Math.exp(-dt * 5);
  const yaw = Math.atan2(camera.position.x, camera.position.z);
  const goalYaw = Math.atan2(cameraGoal.x, cameraGoal.z);
  const turn = Math.atan2(Math.sin(goalYaw - yaw), Math.cos(goalYaw - yaw));
  const radius = THREE.MathUtils.lerp(Math.hypot(camera.position.x, camera.position.z), Math.hypot(cameraGoal.x, cameraGoal.z), blend);
  camera.position.set(Math.sin(yaw + turn * blend) * radius,
    THREE.MathUtils.lerp(camera.position.y, cameraGoal.y, blend),
    Math.cos(yaw + turn * blend) * radius);
  target.lerp(goalTarget, 1 - Math.exp(-dt * 5));
  camera.lookAt(target);
  renderer.render(scene, camera);
  drawOverlay();
  if (recording) {
    recordedFrames++;
    status.textContent = `正在录制 · ${Math.floor(demoTime)} / 68 秒`;
    if (demoTime >= 68) { recording = false; finished = true; mode = 'done'; recorder.stop(); }
  }
  requestAnimationFrame(frame);
}
status.textContent = '已就绪 · 1920 × 1080 · 30 fps · 68 秒';
startButton.disabled = false;
frame();

window.SAM_PREVIEW = { actor, model, cargoRig, mixer, action, camera, faceController };

function createFaceController(character) {
  const channels = new Map();
  character.traverse((object) => {
    if (!object.isMesh || !object.morphTargetDictionary || !object.morphTargetInfluences) return;
    for (const [name, index] of Object.entries(object.morphTargetDictionary)) {
      if (!channels.has(name)) channels.set(name, []);
      channels.get(name).push({ influences: object.morphTargetInfluences, index });
    }
  });

  const current = new Map();
  const setMorph = (name, value) => {
    current.set(name, value);
    for (const channel of channels.get(name) ?? []) channel.influences[channel.index] = value;
  };
  const targetFor = (mode, time) => {
    const values = {
      jawOpen: 0.012 + Math.max(0, Math.sin(time * 1.7)) * 0.008,
      mouthSmileLeft: 0.018,
      mouthSmileRight: 0.018,
      mouthFrownLeft: 0,
      mouthFrownRight: 0,
      browDownLeft: 0,
      browDownRight: 0,
      browInnerUp: 0.012,
    };
    if (mode === 'smile') {
      values.mouthSmileLeft = 0.44;
      values.mouthSmileRight = 0.44;
      values.browInnerUp = 0.05;
    } else if (mode === 'serious') {
      values.mouthSmileLeft = 0;
      values.mouthSmileRight = 0;
      values.mouthFrownLeft = 0.18;
      values.mouthFrownRight = 0.18;
      values.browDownLeft = 0.26;
      values.browDownRight = 0.26;
    } else if (mode === 'speak') {
      values.jawOpen = 0.06 + Math.max(0, Math.sin(time * 7.2)) * 0.24;
      values.mouthSmileLeft = 0.04;
      values.mouthSmileRight = 0.04;
      values.browInnerUp = 0.05 + Math.max(0, Math.sin(time * 2.4)) * 0.04;
    }
    return values;
  };

  let mode = 'neutral';
  let elapsed = 0;
  let blinkStart = -1;
  let nextBlink = 1.6 + Math.random() * 2.4;
  const blinkDuration = 0.18;
  const update = (dt) => {
    elapsed += dt;
    if (blinkStart < 0 && elapsed >= nextBlink) blinkStart = elapsed;
    let blink = 0;
    if (blinkStart >= 0) {
      const progress = (elapsed - blinkStart) / blinkDuration;
      if (progress >= 1) {
        blinkStart = -1;
        nextBlink = elapsed + 2.2 + Math.random() * 3.8;
      } else {
        blink = Math.sin(progress * Math.PI) ** 0.72;
      }
    }
    setMorph('eyeBlinkLeft', blink);
    // A tiny phase offset prevents the blink from reading as a mechanical wipe.
    setMorph('eyeBlinkRight', Math.max(0, blink - 0.035));

    const targets = targetFor(mode, elapsed);
    const smoothing = 1 - Math.exp(-Math.max(dt, 1 / 120) * 9);
    for (const [name, targetValue] of Object.entries(targets)) {
      const value = THREE.MathUtils.lerp(current.get(name) ?? 0, targetValue, smoothing);
      setMorph(name, value);
    }
  };
  update(1 / 60);

  return {
    channels,
    update,
    setMode(nextMode) {
      mode = ['neutral', 'smile', 'serious', 'speak'].includes(nextMode) ? nextMode : 'neutral';
      update(1 / 60);
    },
  };
}

function layoutCargoStack(root) {
  // The lower two cases present their broad faces to the rear, while the slim
  // top case lies flat across the upper rack like the approved reference. This
  // avoids the old silhouette of three thin vertical boards on a pole.
  const layout = {
    cargo_rack: { y: 0.300, z: 0.000, rx: 0 },
    cargo_medium: { y: 0.194, z: -0.105, rx: 0 },
    cargo_small: { y: 0.534, z: -0.105, rx: 0 },
    cargo_slim: { y: 0.742, z: -0.180, rx: Math.PI / 2 },
  };
  root.updateMatrixWorld(true);
  const pieces = [];
  for (const [name, placement] of Object.entries(layout)) {
    const object = root.getObjectByName(name);
    if (!object?.isMesh) throw new Error(`未找到货物：${name}`);
    // Preserve authored orientation, then centre the actual geometry. FBX
    // origins are not case centres; overwriting Euler angles alone made the
    // old boxes stack with incorrect offsets and concealed the rack overlap.
    object.geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
    object.geometry.computeBoundingBox();
    const center = object.geometry.boundingBox.getCenter(new THREE.Vector3());
    object.geometry.translate(-center.x, -center.y, -center.z);
    object.removeFromParent();
    object.scale.setScalar(1);
    object.rotation.set(placement.rx, 0, 0);
    object.position.set(0, placement.y, placement.z);
    pieces.push(object);
  }
  root.clear();
  root.add(...pieces);
  root.updateMatrixWorld(true);
}
