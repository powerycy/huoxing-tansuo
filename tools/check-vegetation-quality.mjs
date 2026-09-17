// Real Three CPU checks for live density switches and delayed asset ownership.
// Run: node tools/check-vegetation-quality.mjs
import assert from 'node:assert/strict';
import { register } from 'node:module';
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
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const { KTX2Loader } = await import('three/addons/loaders/KTX2Loader.js');
const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js');
const { FalseEarthGrass, FalseEarthRoseField } = await import('../src/world/false-earth-vegetation.js');
const { GrassFireflies } = await import('../src/world/fireflies.js');
const { FlowerTide } = await import('../src/world/flower-tide.js');
const { readHeroFlower } = await import('../src/game/flower-cinematic.js');
const { QUALITY } = await import('../src/core/quality.js');

const terrainKeys = ['uMacro', 'uFar', 'uDetail', 'uDent', 'uTrail', 'uConst', 'uConst2', 'uCamXZ', 'uLod', 'uTexRes'];
const terrain = {
  heightAt: (x, z) => Math.sin(x * 0.04) * 0.8 + Math.cos(z * 0.03) * 0.6,
  uniforms: Object.fromEntries(terrainKeys.map((key) => [key, { value: new THREE.Vector4() }]))
};
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 8000);
camera.position.set(1, 3, 8);
camera.lookAt(0, 1, -20);
const station = { x: 0, z: 0 }, target = { x: 0, z: -240 };
const rover = { pos: new THREE.Vector3(0, 1, 0), forward: new THREE.Vector3(0, 0, -1) };
const args = { scene, terrain, engine: { camera, renderer: {} }, rover, station, target, quality: { name: 'LOW' } };
const growth = {
  time: 41.25, wave: 0.37, grassWave: 0.43, grassMaturity: 0.68, heroGrowth: 0.58,
  fade: 0.83, residual: 0.02, light: 0.64, sunDir: new THREE.Vector3(0.6, 0.3, -0.4).normalize()
};
const tiers = {
  LOW: { axis: 320, roses: 220, flies: 120, flowers: 900, petals: 280 },
  MEDIUM: { axis: 512, roses: 420, flies: 210, flowers: 1800, petals: 504 },
  HIGH: { axis: 768, roses: 720, flies: 320, flowers: 3000, petals: 924 },
  ULTRA: { axis: 1024, roses: 1100, flies: 420, flowers: 4500, petals: 1344 }
};
const quality = (name) => QUALITY[name.toLowerCase()];
const snapshots = (meshes, excluded = []) => meshes.map((mesh) => Object.fromEntries(
  Object.entries(mesh.material.uniforms).filter(([key]) => !excluded.includes(key)).map(([key, uniform]) =>
    [key, uniform.value?.toArray ? uniform.value.toArray() : uniform.value])));
const grass = new FalseEarthGrass(args);
grass.update(growth);
const grassMeshes = [...grass.meshes];
const grassMaterials = grass.meshes.map((mesh) => mesh.material);
const grassGeometry = grass.meshes.map((mesh) => mesh.geometry);
const grassGrowth = snapshots(grass.meshes, ['uAxis', 'uSpacing']);
const fireflies = new GrassFireflies(args);
fireflies.setQuality(quality('ULTRA'));
fireflies.setQuality(quality('LOW'));
assert.equal(fireflies.prepared, false, 'quality changes before event preparation stay dormant');
assert.equal(fireflies.points.visible, false);
const anchor = { x: 11, z: -9 };
fireflies.prepare({ station: { ...station }, target: { ...target }, anchor, seed: 12345 });
fireflies.update({ ...growth, phase: 'first' });
const flyMaterial = fireflies.material, flyPoints = fireflies.points;
const flyGrowth = snapshots([fireflies.points]);
const flyPrefix = Object.fromEntries(Object.entries(fireflies.geometry.attributes).map(([key, value]) => [key, Array.from(value.array)]));
anchor.x = 500;
const disposalCounts = new Map();
function track(resource, label) {
  if (!disposalCounts.has(resource)) {
    disposalCounts.set(resource, { label, count: 0 });
    resource.addEventListener('dispose', () => disposalCounts.get(resource).count++);
  }
  return resource;
}

// Loader fixtures return actual Three geometry, materials and VAT textures.
// Only transport is delayed; production _load/_placements/_addLOD all run.
let batch;
function request(url, factory) {
  const resource = factory();
  return new Promise((resolve, reject) => batch.requests.push({ url, resource, resolve, reject }));
}
function texture(label) { return track(new THREE.Texture(), label); }
function gltf(label) {
  const group = new THREE.Group();
  const geometry = track(new THREE.PlaneGeometry(0.05, 0.1), `${label}: source geometry`);
  geometry.translate(0, 0.05, 0);
  geometry.clone = function () {
    return track(THREE.BufferGeometry.prototype.clone.call(this), `${label}: VAT geometry`);
  };
  const material = track(new THREE.MeshStandardMaterial({ map: texture(`${label}: embedded texture`) }), `${label}: source material`);
  group.add(new THREE.Mesh(geometry, material));
  return { scene: group };
}
const overrides = [];
function override(prototype, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
  overrides.push(() => descriptor ? Object.defineProperty(prototype, name, descriptor) : delete prototype[name]);
  prototype[name] = value;
}
let decoderDisposals = 0;
override(KTX2Loader.prototype, 'detectSupport', function () { return this; });
override(KTX2Loader.prototype, 'dispose', function () { decoderDisposals++; });
override(THREE.FileLoader.prototype, 'loadAsync', (url) => request(url, () => JSON.stringify({ frameCount: 2, textureWidth: 4, textureHeight: 4, padding: 2 })));
override(GLTFLoader.prototype, 'loadAsync', (url) => request(url, () => gltf(url)));
override(EXRLoader.prototype, 'loadAsync', (url) => request(url, () => {
  const data = new Float32Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) data[i * 4 + 1] = 0.06;
  return track(new THREE.DataTexture(data, 4, 4, THREE.RGBAFormat, THREE.FloatType), url);
}));
override(THREE.TextureLoader.prototype, 'loadAsync', (url) => request(url, () => texture(url)));
override(KTX2Loader.prototype, 'loadAsync', (url) => request(url, () => texture(url)));
function release(current) { for (const pending of current.requests) pending.resolve(pending.resource); }

try {
  batch = { requests: [] };
  const roses = new FalseEarthRoseField(args);
  const firstBatch = batch;
  assert.equal(firstBatch.requests.length, 11);
  roses.prepareEvent();
  const heroMatrix = roses.heroMatrix;
  const heroSaved = heroMatrix.toArray();
  roses.update(growth);
  const event = Object.assign(Object.create(FlowerTide.prototype), {
    scene, terrain, quality: quality('LOW'), delivery: { station, facility: { position: target } },
    grassSystem: grass, roseField: roses, fireflies, phase: 'first', phaseT: 8.3, totalT: 40.3,
    _moonStartElevation: -0.14, _moonDirection: new THREE.Vector3(0.1, 0.3, -0.9),
    cinematic: { active: true, phaseElapsed: 5.2 },
    reset() { assert.fail('quality must never reset the event'); }
  });
  event._buildFlowers();
  const previousWindow = globalThis.window;
  try {
    globalThis.window = { devicePixelRatio: 2 };
    event._buildPetals();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  assert.equal(event.flowers.count, tiers.LOW.flowers);
  assert.equal(event.petals.geometry.drawRange.count, tiers.LOW.petals);
  event.flowers.visible = event.petals.visible = true;
  event.flowers.material.uniforms.uTime.value = growth.time;
  event.flowers.material.uniforms.uWave.value = growth.wave;
  event.flowers.material.uniforms.uFade.value = growth.fade;
  event.petals.material.uniforms.uClock.value = 17.25;
  event.petals.material.uniforms.uIntensity.value = 0.4;
  event.petals.position.set(7, 8, 9);
  const farMesh = event.flowers, petalPoints = event.petals;
  const flowerMatrices = event.flowers.instanceMatrix;
  const farGeometry = event.flowers.geometry, petalGeometry = event.petals.geometry;
  const farState = snapshots([event.flowers, event.petals]);
  const farPrefix = Array.from(flowerMatrices.array.slice(0, tiers.LOW.flowers * 16));
  const farBirth = Array.from(farGeometry.getAttribute('aFlower').array);
  const petalPositions = Array.from(petalGeometry.getAttribute('position').array);
  const petalSeeds = Array.from(petalGeometry.getAttribute('aSeed').array);
  const petalPosition = event.petals.position.toArray();
  const eventSnapshot = [event.phase, event.phaseT, event.totalT, event._moonStartElevation, event._moonDirection.toArray(), { ...event.cinematic }];
  for (const name of ['HIGH', 'ULTRA', 'HIGH']) event.setQuality(quality(name));
  assert.equal(firstBatch.requests.length, 11, 'switches before ready never restart loaders');
  camera.position.set(25, 4, 40);
  camera.lookAt(40, 1, 50);
  const cameraSnapshot = [camera.position.toArray(), camera.quaternion.toArray(), camera.fov];
  release(firstBatch);
  assert.equal(await roses.ready, true);
  assert.equal(roses.meshes[0].count, tiers.HIGH.roses, 'late assets use latest selected tier');
  assert.equal(roses.heroMatrix, heroMatrix, 'late assets preserve the prepared hero object');
  assert.deepEqual(roses.heroMatrix.toArray(), heroSaved);
  assert.equal(roses.group.children.length, 2);
  const roseMeshes = [...roses.meshes];
  const roseMaterials = roses.meshes.map((mesh) => mesh.material);
  const roseMatrices = roses.meshes.map((mesh) => mesh.instanceMatrix);
  const roseGeometry = roses.meshes.map((mesh) => mesh.geometry);
  const companionSpecs = [...roses.companionSpecs];
  const hero = readHeroFlower(roses);
  assert.equal(hero.measured, true, 'crown is measured from actual Three VAT data');
  const rosePrefix = Array.from(roses.meshes[0].instanceMatrix.array.slice(0, tiers.LOW.roses * 16));
  const roseGrowth = snapshots(roses.meshes);
  rover.pos.set(180, 20, 190);
  for (const name of ['LOW', 'MEDIUM', 'HIGH', 'ULTRA', 'HIGH', 'HIGH']) {
    const oldFlyGeometry = track(fireflies.geometry, 'replaced firefly geometry');
    const oldCapacity = fireflies.capacity;
    event.setQuality(quality(name));
    const tier = tiers[name];
    assert.deepEqual(grass.meshes, grassMeshes);
    for (const [i, ratio] of [0.125, 0.5, 1].entries()) {
      assert.equal(grass.meshes[i].geometry.instanceCount, (tier.axis * ratio) ** 2);
      assert.equal(grass.meshes[i].material.uniforms.uAxis.value, tier.axis * ratio);
      assert.equal(grass.meshes[i].material.uniforms.uSpacing.value, 80 / tier.axis);
      assert.equal(grass.meshes[i].material, grassMaterials[i]);
      assert.equal(grass.meshes[i].geometry, grassGeometry[i]);
      for (const key of terrainKeys) assert.equal(grass.meshes[i].material.uniforms[key], terrain.uniforms[key]);
    }
    assert.deepEqual(snapshots(grass.meshes, ['uAxis', 'uSpacing']), grassGrowth, 'grass color, growth and clock survive');
    assert.equal(grass.group.visible, true);
    assert.deepEqual(roses.meshes, roseMeshes);
    assert.equal(roses.group.visible, true);
    assert.equal(roses.heroMatrix, heroMatrix);
    assert.deepEqual(roses.heroMatrix.toArray(), heroSaved);
    assert.deepEqual(readHeroFlower(roses).crown.toArray(), hero.crown.toArray());
    for (let i = 0; i < companionSpecs.length; i++) assert.equal(roses.companionSpecs[i], companionSpecs[i]);
    for (const [i, mesh] of roses.meshes.entries()) {
      assert.equal(mesh.count, tier.roses);
      assert.equal(mesh.material, roseMaterials[i]);
      assert.equal(mesh.geometry, roseGeometry[i]);
      assert.equal(mesh.instanceMatrix, roseMatrices[i]);
      assert.deepEqual(Array.from(mesh.instanceMatrix.array.slice(0, rosePrefix.length)), rosePrefix);
    }
    assert.deepEqual(snapshots(roses.meshes), roseGrowth, 'VAT growth and time do not reset');
    assert.equal(event.flowers, farMesh);
    assert.equal(event.petals, petalPoints);
    assert.equal(event.flowers.geometry, farGeometry);
    assert.equal(event.petals.geometry, petalGeometry);
    assert.equal(event.flowers.instanceMatrix, flowerMatrices);
    assert.equal(event.flowers.count, tier.flowers, 'procedural flowers also change active budget');
    assert.equal(event.petals.geometry.drawRange.count, tier.petals, 'ascending petals also change active budget');
    assert.equal(event.flowers.visible, true);
    assert.equal(event.petals.visible, true);
    assert.deepEqual(Array.from(event.flowers.instanceMatrix.array.slice(0, farPrefix.length)), farPrefix,
      'guide banks and destination crown remain stationary');
    assert.deepEqual(Array.from(farGeometry.getAttribute('aFlower').array), farBirth);
    assert.deepEqual(Array.from(petalGeometry.getAttribute('position').array), petalPositions);
    assert.deepEqual(Array.from(petalGeometry.getAttribute('aSeed').array), petalSeeds);
    assert.deepEqual(event.petals.position.toArray(), petalPosition);
    assert.deepEqual(snapshots([event.flowers, event.petals]), farState, 'far flowers and petals retain growth, clock and intensity');
    assert.equal(fireflies.capacity, tier.flies);
    assert.equal(fireflies.geometry.drawRange.count, tier.flies);
    assert.equal(fireflies.material, flyMaterial);
    assert.equal(fireflies.points, flyPoints);
    assert.equal(fireflies.points.visible, true);
    assert.deepEqual(snapshots([fireflies.points]), flyGrowth, 'live firefly growth and visibility do not reset');
    for (const [key, prefix] of Object.entries(flyPrefix)) {
      assert.deepEqual(Array.from(fireflies.geometry.getAttribute(key).array.slice(0, prefix.length)), prefix,
        'firefly roots, seeds and slopes retain stable prefix despite moving caller anchor');
    }
    assert.equal(disposalCounts.get(oldFlyGeometry).count, oldCapacity === tier.flies ? 0 : 1);
    assert.deepEqual([event.phase, event.phaseT, event.totalT, event._moonStartElevation, event._moonDirection.toArray(), { ...event.cinematic }], eventSnapshot);
    assert.deepEqual([camera.position.toArray(), camera.quaternion.toArray(), camera.fov], cameraSnapshot);
    assert.equal(firstBatch.requests.length, 11, 'switches after ready never request assets');
  }
  // A saved/restored hero changes existing instance zero. A later tier switch
  // must keep that exact transform and the same prepared companion ring.
  roses.prepareEvent();
  const secondHero = roses.heroMatrix;
  const secondCrown = readHeroFlower(roses).crown.toArray();
  roses.setQuality(quality('ULTRA'));
  assert.equal(roses.heroMatrix, secondHero);
  assert.deepEqual(readHeroFlower(roses).crown.toArray(), secondCrown);
  fireflies.reset();
  fireflies.setQuality(quality('LOW'));
  assert.equal(fireflies.points.visible, false, 'a dormant reset cannot be revived by quality');
  assert.equal(fireflies.material.uniforms.uTime.value, 0);
  for (const mesh of [...grass.meshes, ...roses.meshes]) {
    track(mesh.geometry, 'live vegetation geometry');
    track(mesh.material, 'live vegetation material');
    if (mesh.isInstancedMesh) track(mesh, 'rose matrix allocation');
  }
  for (const mesh of [event.flowers, event.petals]) {
    track(mesh.geometry, 'FlowerTide geometry');
    track(mesh.material, 'FlowerTide material');
    if (mesh.isInstancedMesh) { track(mesh, 'FlowerTide matrix allocation'); mesh.dispose(); }
    mesh.geometry.dispose();
    mesh.material.dispose();
    scene.remove(mesh);
  }
  track(fireflies.geometry, 'final firefly geometry');
  track(fireflies.material, 'firefly material');
  grass.dispose(); roses.dispose(); fireflies.dispose();
  grass.dispose(); roses.dispose(); fireflies.dispose();
  assert.equal(scene.children.length, 0);
  assert.equal(grass.setQuality(quality('ULTRA')), false);
  assert.equal(roses.setQuality(quality('ULTRA')), false);
  assert.equal(fireflies.setQuality(quality('ULTRA')), false);

  batch = { requests: [] };
  const cancelled = new FalseEarthRoseField(args);
  cancelled.prepareEvent();
  cancelled.setQuality(quality('ULTRA'));
  cancelled.dispose();
  release(batch);
  assert.equal(await cancelled.ready, false, 'disposed pending load does not attach stale meshes');
  assert.equal(cancelled.meshes.length, 0);
  assert.equal(scene.children.length, 0);

  batch = { requests: [] };
  const failed = new FalseEarthRoseField(args);
  const metadata = batch.requests.find((pending) => pending.url.endsWith('/Rose_meta.json'));
  metadata.reject(new Error('fixture metadata failure'));
  failed.setQuality(quality('HIGH'));
  failed.dispose();
  release(batch);
  assert.equal(await failed.ready, false, 'partial failure also releases later successful assets');
  assert.equal(scene.children.length, 0);
  assert.equal(decoderDisposals, 3, 'each decoder is closed once after all loads settle');
  for (const { label, count } of disposalCounts.values()) assert.equal(count, 1, `${label}: dispose exactly once`);
  console.log('PASS: LOW/MEDIUM/HIGH/ULTRA live budgets for grass, VAT roses, far flowers, petals and fireflies; stable hero/VAT crown/companion, route banks and particle prefixes; intact terrain uniforms, color, growth, moon and camera; one asset load; pending-load cancellation, partial failure and idempotent cleanup');
} finally {
  for (const restore of overrides.reverse()) restore();
}
