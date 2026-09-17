// CPU regression checks, using the exact vendored Three implementation.
// Run: node tools/check-flower-cinematic.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
const threeURL = new URL('../vendor/three/three.module.js', import.meta.url).href;
const addonsURL = new URL('../vendor/three/examples/jsm/', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(s, c, next) {
    if (s === 'three') return {url:${JSON.stringify(threeURL)},shortCircuit:true};
    if (s.startsWith('three/addons/')) return {url:${JSON.stringify(addonsURL)}+s.slice(13),shortCircuit:true};
    return next(s,c);
  }
`), import.meta.url);
const THREE = await import('three');
const { CameraRig, CAM } = await import('../src/game/camera.js');
const { FlowerCinematic, readHeroFlower } = await import('../src/game/flower-cinematic.js');
const { FlowerTide } = await import('../src/world/flower-tide.js');
const { GrassFireflies } = await import('../src/world/fireflies.js');

const terrain = { heightAt: (x, z) => Math.sin(x * 0.17) * 0.3 + Math.sin(z * 0.09) * 0.4 };
const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 8000);
const rig = new CameraRig(camera, terrain);
const rover = {
  pos: new THREE.Vector3(0, 1, 0), vel: new THREE.Vector3(),
  forward: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0),
  head: new THREE.Object3D()
};
const neutral = { lookX: 0, lookY: 0, zoom: 0, looking: false };
const controls = { throttle: 0, steer: 0 };
rig.mode = CAM.ORBIT; rig.yaw = 1.4; rig.pitch = 0.35; rig.dist = 8.5;
rig.update(1 / 60, rover, neutral, controls);
const original = { mode: rig.mode, yaw: rig.yaw, pitch: rig.pitch, dist: rig.dist };

const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.Float32BufferAttribute([-0.2, 1, 0, 0.2, 1.4, 0, 0, 1.2, 0.2], 3));
geometry.setAttribute('uv1', new THREE.Float32BufferAttribute([0.25, 1/6, 0.25, 0.5, 0.25, 5/6], 2));
geometry.setAttribute('aColorMask', new THREE.Float32BufferAttribute([0.7, 0.7, 0.7], 1));
const vat = new Float32Array(2 * 3 * 4);
for (const index of [1, 3, 5]) vat[index * 4 + 1] = 0.2;
const vatTexture = new THREE.DataTexture(vat, 2, 3, THREE.RGBAFormat, THREE.FloatType);
const material = new THREE.ShaderMaterial({ uniforms: {
  uVatPosition: { value: vatTexture }, uFrameCount: { value: 2 }
} });
const mesh = new THREE.InstancedMesh(geometry, material, 1);
const heroMatrix = new THREE.Matrix4().makeTranslation(9, terrain.heightAt(9, -7), -7);
mesh.setMatrixAt(0, heroMatrix);
const field = {
  meshes: [mesh], heroMatrix, heroPosition: new THREE.Vector3().setFromMatrixPosition(heroMatrix),
  companionSpecs: [], eventPrepared: true, prepareEvent() { this.eventPrepared = true; }
};
const hero = readHeroFlower(field);
assert.equal(hero.measured, true);
assert.ok(Math.abs(hero.crown.y - hero.root.y - 1.4) < 1e-6, 'focal point comes from actual last VAT frame');
assert.ok(Math.abs(hero.root.x - 9) < 1e-6, 'hero uses instance zero world transform');

const event = Object.assign(Object.create(FlowerTide.prototype), {
  rig, terrain, rover, roseField: field,
  fireflies: new GrassFireflies({ scene: new THREE.Scene(), terrain, quality: { name: 'LOW' } }),
  engine: { camera }, sky: { anomalyMoonDir: new THREE.Vector3(0, 0.3, -1), setAnomalyMoonDirection() {} },
  _moonAzimuth: new THREE.Vector3(0, 0, -1), _moonDirection: new THREE.Vector3(),
  delivery: { station: { x: 0, z: -10 }, game: { power: 55 } },
  guideTarget: new THREE.Vector3(0, 0, -100),
  phase: 'dormant', phaseT: 0, totalT: 0, triggered: false, completed: false,
  fissure: { material: { uniforms: { uCenter: { value: new THREE.Vector3() } } } },
  _captureViewDirection() {}, _announce() {}, _setPulse() {},
  _applyVisuals(values) { this.visuals = values; }
});
event.cinematic = new FlowerCinematic(event);
assert.equal(event.trigger(), true);
assert.equal(event.fireflies.prepared, true, 'trigger seeds fireflies at the event anchor');
const originalFireflyRoots = Array.from(event.fireflies.geometry.getAttribute('position').array);
assert.equal(event.trigger(), false, 'event is one-shot');
assert.equal(event.cinematicActive, true);

let maximumStep = 0;
let previous = camera.position.clone();
const phases = new Set();
const phaseSamples = new Map();
let heroUnfoldSeconds = 0;
let previousMoonElevation = null;
let peakMoonSpeed = 0;
let revealPresence = 0, opacityAtTwo = 0;
for (let i = 0; i < 60 * 78; i++) {
  // Same integration order as the real game.
  rig.update(1 / 60, rover, neutral, controls);
  event.update(1 / 60);
  event.cinematic.update(1 / 60);
  phases.add(event.phase);
  phaseSamples.set(event.phase, (phaseSamples.get(event.phase) || 0) + 1);
  if (event.phase === 'first' && event.visuals.heroGrowth > 0.01 && event.visuals.heroGrowth < 0.99) {
    heroUnfoldSeconds += 1 / 60;
  }
  maximumStep = Math.max(maximumStep, camera.position.distanceTo(previous));
  previous.copy(camera.position);
  assert.ok(camera.position.y >= terrain.heightAt(camera.position.x, camera.position.z) + 0.39,
    'camera stays above terrain through cuts and return');
  assert.ok([camera.position.x, camera.position.y, camera.position.z, camera.fov].every(Number.isFinite));
  assert.equal(event.visuals.flash, 0, 'event never flashes');
  event._setMoonRise(event.visuals.moonRise);
  const elevation = Math.asin(event._moonDirection.y);
  if (previousMoonElevation !== null) {
    assert.ok(elevation >= previousMoonElevation - 1e-9, 'moon never drops during the sequence');
    peakMoonSpeed = Math.max(peakMoonSpeed, (elevation - previousMoonElevation) * 60);
  }
  previousMoonElevation = elevation;
  if (event.phase === 'warning') {
    revealPresence += (event.visuals.moon - revealPresence) * 0.72 / 60;
    if (Math.abs(event.phaseT - 2) < 1 / 120) {
      const alpha = Math.min(1, revealPresence / 0.72);
      opacityAtTwo = alpha * alpha * (3 - 2 * alpha);
      assert.ok(elevation + Math.asin(2580 / 6500) > 16 * Math.PI / 180,
        'moon edge is already above the habitat ridge by two seconds');
    }
  }
  if (event.phase !== 'warning') assert.equal(event.visuals.moonRise, 1, 'moon rises before grass and remains up');
  if (event.phase === 'warning' || event.phase === 'grass') assert.equal(event.visuals.heroGrowth, 0);
}
assert.deepEqual([...phases], ['warning', 'grass', 'first', 'bloom', 'full', 'navigate']);
assert.equal(event.cinematicActive, false, 'finite sequence returns camera');
assert.equal(event.phase, 'navigate', 'navigation waits for the relay, not a timer');
for (const [phase, seconds] of [['warning', 20], ['grass', 12], ['first', 16], ['bloom', 22], ['full', 4]]) {
  assert.ok(Math.abs(phaseSamples.get(phase) / 60 - seconds) < 0.08, `${phase} lasts ${seconds}s`);
}
assert.ok(heroUnfoldSeconds > 10, 'hero actually unfolds slowly, not a longer hold around a fast opening');
assert.ok(opacityAtTwo > 0.70, 'moon fade-in overlaps the settling camera instead of delaying its reveal');
assert.ok(peakMoonSpeed > 0.02 && peakMoonSpeed < 0.055,
  `moon rises continuously without the old mid-shot burst (${peakMoonSpeed} rad/s)`);
assert.ok(maximumStep < 0.8, `smooth camera path, maximum 60 Hz movement = ${maximumStep}`);
for (const [key, value] of Object.entries(original)) assert.equal(rig[key], value, `restores player ${key}`);

// Rehearsal, skip and save/load: none may replay or fast-forward the world.
event.debugPhase('first', 0.3);
assert.equal(event.cinematicActive, true);
event.cinematic.update(0.1);
const beforeSkip = event.phaseT;
assert.equal(event.skipCinematic(), true);
assert.equal(event.skipCinematic(), false, 'skip is idempotent');
assert.equal(event.phaseT, beforeSkip);
for (let i = 0; i < 90; i++) {
  rig.update(1 / 60, rover, neutral, controls);
  event.update(1 / 60);
  event.cinematic.update(1 / 60);
}
assert.equal(event.cinematicActive, false);
assert.ok(event.phaseT > beforeSkip && event.phase === 'first', 'growth continues after skipped camera');
const saved = event.save();
assert.equal(saved.version, 7);
assert.equal(saved.heroMatrix.length, 16);
assert.equal(event.load(saved), true);
assert.deepEqual(Array.from(event.fireflies.geometry.getAttribute('position').array), originalFireflyRoots,
  'loaded hero anchor restores the same firefly field');
assert.equal(event.cinematicActive, false, 'load never repeats a cutscene');
assert.equal(event.cinematic.seen, true);
for (const [phase, oldSeconds, newSeconds] of [['grass', 6, 12], ['first', 8, 16], ['bloom', 10, 22], ['full', 3, 4]]) {
  assert.equal(event.load({ ...saved, version: 4, phase, phaseT: oldSeconds * 0.5 }), true);
  assert.equal(event.phaseT, newSeconds * 0.5, 'V4 saves retain their growth progress');
  assert.equal(event.cinematicActive, false);
}
const smoothstep = (p) => p * p * (3 - 2 * p);
for (const version of [4, 5]) {
  for (const p of [0, 0.2, 0.5, 0.8, 1]) {
    assert.equal(event.load({ ...saved, version, phase: 'warning', phaseT: 11 * p }), true);
    const progress = event.phaseProgress;
    assert.ok(Math.abs(smoothstep(progress) - smoothstep(smoothstep(p))) < 1e-8,
      'old moon saves retain their physical elevation on the slower, single-eased rise');
    assert.equal(event._moonStartElevation, -0.62, 'legacy moon baseline remains unchanged');
  }
}
assert.equal(event.load({ ...saved, version: 5, phase: 'first', phaseT: 9 }), true);
assert.equal(event.phaseT, 9, 'V5 flower growth already has the correct duration');
assert.equal(event.load({ ...saved, version: 6, phase: 'warning', phaseT: 14 }), true);
assert.equal(event.phaseT, 10, 'V6 rise keeps halfway progress in the shorter shot');
assert.equal(event._moonStartElevation, -0.62);
event._setMoonRise(event.phaseProgress);
assert.ok(Math.abs(event._moonDirection.y - new THREE.Vector3(0, -0.16, -1).normalize().y) < 1e-8,
  'even an old moon below the new baseline retains its exact angle');
const migrated = event.save();
assert.equal(event.load(migrated), true);
assert.equal(event.phaseT, 10, 'V7 progress is not migrated twice');
assert.equal(event._moonStartElevation, -0.62, 'V7 resave retains legacy baseline for unfinished rises');
assert.equal(event.load({ ...saved, version: 7, phase: 'warning', phaseT: 10 }), true);
assert.equal(event._moonStartElevation, -0.14, 'new events use the closer-to-ridge reveal');
assert.equal(event.debugPhase('navigate'), true);
assert.equal(event.cinematicActive, false, 'navigation preview does not lock driving');
event.reset();
assert.equal(event.fireflies.points.visible, false, 'new game has no fireflies before grass');
assert.equal(event.cinematic.seen, false);
assert.equal(event._moonStartElevation, -0.14, 'reset restores the new opening even after a legacy load');
assert.equal(rig.cinematicLocked, false);
assert.equal(event.trigger(), true, 'new game permits a new sequence');
event.reset();
assert.equal(rig.cinematicLocked, false, 'reset cancels live camera ownership');
assert.equal(rig.cinematicReturning, false);
event.fireflies.dispose();
console.log(`PASS: actual VAT hero focus; 74 s sequence + 1.2 s return; moon 20 s / ${(peakMoonSpeed * 180 / Math.PI).toFixed(2)} deg/s peak / ${(opacityAtTwo * 100).toFixed(0)}% opacity by 2s; ${heroUnfoldSeconds.toFixed(2)} s hero unfolding; terrain clearance; max step ${maximumStep.toFixed(3)} m; moon/grass/flower order; skip; V4–V7 save/load; reset; navigation retained`);

// Check the shipped rose, not only the small synthetic VAT above. Material
// images are stripped in memory so this CPU test does not require DOM bitmaps.
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js');
const base = new URL('../assets/models/vegetation/false-earth/', import.meta.url);
const binary = await readFile(new URL('Rose.glb', base));
const length = binary.readUInt32LE(12);
const document = JSON.parse(binary.toString('utf8', 20, 20 + length));
for (const m of document.meshes) for (const p of m.primitives) delete p.material;
delete document.materials; delete document.textures; delete document.images;
document.buffers[0].uri = 'data:application/octet-stream;base64,' + binary.subarray(28 + length).toString('base64');
globalThis.ProgressEvent ??= class ProgressEvent {};
const gltf = await new GLTFLoader().parseAsync(JSON.stringify(document), '');
let rose = null;
gltf.scene.traverse((object) => { if (!rose && object.isMesh) rose = object.geometry; });
const meta = JSON.parse(await readFile(new URL('Rose_meta.json', base), 'utf8'));
const exrBytes = await readFile(new URL('Rose_pos.exr', base));
const exr = new EXRLoader().setDataType(THREE.FloatType).parse(
  exrBytes.buffer.slice(exrBytes.byteOffset, exrBytes.byteOffset + exrBytes.byteLength)
);
const rosePositions = rose.getAttribute('position');
const roseColors = rose.getAttribute('color');
const roseUV = new Float32Array(rosePositions.count * 2);
const roseMasks = new Float32Array(rosePositions.count);
for (let i = 0; i < rosePositions.count; i++) {
  rosePositions.setX(i, -rosePositions.getX(i));
  roseUV[i * 2] = (Math.floor(i / meta.textureHeight) * (meta.frameCount + meta.padding) + 0.5) / meta.textureWidth;
  roseUV[i * 2 + 1] = (i % meta.textureHeight + 0.5) / meta.textureHeight;
  roseMasks[i] = roseColors.getX(i);
}
rose.setAttribute('uv1', new THREE.BufferAttribute(roseUV, 2));
rose.setAttribute('aColorMask', new THREE.BufferAttribute(roseMasks, 1));
const realMesh = new THREE.InstancedMesh(rose, new THREE.ShaderMaterial({ uniforms: {
  uVatPosition: { value: { image: exr } }, uFrameCount: { value: meta.frameCount }
} }), 1);
realMesh.setMatrixAt(0, new THREE.Matrix4().makeScale(18, 18, 18));
const actual = readHeroFlower({ meshes: [realMesh] });
assert.equal(actual.measured, true, 'shipped hero has a readable authored crown');
assert.ok(actual.crown.y > 0.1 && actual.crown.y < 4, 'shipped crown has plausible metre-scale framing');
console.log(`PASS: shipped Rose.glb + 142-frame EXR crown ${actual.crown.toArray().map(n => n.toFixed(3)).join(', ')} m at hero scale 18`);
