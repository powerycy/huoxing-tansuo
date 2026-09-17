// CPU checks using the actual vendored GLTF material parser and shipped assets.
// Image decoding / GPU shader compilation and visual QA still need a browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
const { prepareRoverMaterial, prepareStationMaterial, prepareLanderMaterial,
  prepareScannedRockMaterial, setMaterialAnisotropy, setPracticalShadow } = await import('../src/core/model-materials.js');
const { Rover } = await import('../src/game/rover.js');
const { Props } = await import('../src/world/props.js');
const { Terrain } = await import('../src/world/terrain.js');

async function loadMaterials(path) {
  const bytes = await readFile(new URL('../' + path, import.meta.url));
  const json = JSON.parse(path.endsWith('.glb')
    ? bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString() : bytes.toString());
  // Keep the real material definitions and extensions, omit geometry/Draco.
  const data = {
    asset: json.asset, materials: json.materials, images: json.images,
    textures: json.textures.map(({ extensions, ...texture }) => texture),
    extensionsUsed: (json.extensionsUsed || []).filter(name => name.startsWith('KHR_materials_') || name === 'KHR_texture_transform'),
    scenes: [{ nodes: [] }], scene: 0
  };
  const loader = new GLTFLoader();
  loader.register(parser => ({
    name: 'CPU_TEXTURE_PLACEHOLDER',
    loadTexture(index) {
      const texture = new THREE.Texture();
      texture.name = `asset-texture-${index}`;
      texture.flipY = false;
      parser.associations.set(texture, { textures: index });
      return Promise.resolve(texture);
    }
  }));
  const result = await loader.parseAsync(JSON.stringify(data), '');
  return { json, materials: await result.parser.getDependencies('material') };
}

const maps = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
  'clearcoatNormalMap', 'specularIntensityMap', 'specularColorMap'];
function assertMapsPreserved(before, after) {
  for (const key of maps) {
    if (!before[key]) continue;
    assert.equal(after[key], before[key], `${before.name}: ${key} texture reference must survive`);
    assert.equal(after[key].channel, before[key].channel);
    assert.equal(after[key].colorSpace, before[key].colorSpace);
  }
  if (before.normalScale) assert.deepEqual(after.normalScale.toArray(), before.normalScale.toArray());
  for (const key of ['roughness', 'metalness', 'envMapIntensity', 'aoMapIntensity']) {
    if (key in after) assert.ok(Number.isFinite(after[key]), `${after.name}: finite ${key}`);
  }
}

const roverAsset = await loadMaterials('assets/models/moon-rover/moon-rover-4k.glb');
const roverMaterials = roverAsset.materials;
const surfaces = roverMaterials.find(material => material.name === 'Surfaces');
const sourceSurfaces = surfaces.clone();
prepareRoverMaterial(surfaces);
assertMapsPreserved(sourceSurfaces, surfaces);
assert.equal(surfaces.roughness, sourceSurfaces.roughness);
assert.equal(surfaces.metalness, sourceSurfaces.metalness);
assert.equal(surfaces.clearcoat, 0.32);
const once = surfaces.onBeforeCompile;
prepareRoverMaterial(surfaces);
assert.equal(surfaces.onBeforeCompile, once);
assert.equal(surfaces.clearcoat, 0.32, 'Shared wheel materials must not repeatedly darken their coat');
const lamp = roverMaterials.find(material => material.name === 'light');
const emitted = lamp.emissiveIntensity;
prepareRoverMaterial(lamp);
assert.equal(lamp.emissiveIntensity, emitted, 'Rover material preparation must not alter light state');

for (const path of ['halley-vi-dorm-pod-2k.glb', 'beacon-9-shelter-2k.glb']) {
  const asset = await loadMaterials(`assets/models/beacon-9/${path}`);
  for (const source of asset.materials) {
    const material = prepareStationMaterial(source, { tint: 0x788187, exposure: 0.94, emissiveScale: 0.65 });
    assertMapsPreserved(source, material);
    if (source.roughnessMap) assert.equal(material.roughness, source.roughness, `${source.name}: retain authored roughness multiplier`);
    if (source.metalnessMap) assert.equal(material.metalness, source.metalness, `${source.name}: retain authored metallic multiplier`);
    assert.equal(material.emissiveIntensity, source.emissiveIntensity * 0.65);
  }
}
const lander = await loadMaterials('assets/models/sled/apollo-lunar-module.glb');
const finishes = new Map(lander.materials.map(source => {
  const material = prepareLanderMaterial(source);
  assertMapsPreserved(source, material);
  return [material.name.split('.')[0], material];
}));
assert.ok(finishes.get('blinn1SG').metalness > finishes.get('blinn7SG').metalness);
assert.ok(finishes.get('blinn6SG').roughness > finishes.get('blinn4SG').roughness);
assert.ok(finishes.get('blinn1SG').userData.regolithFinish.foil);

for (const id of ['moon_rock_01', 'moon_rock_05', 'moon_rock_06', 'moon_rock_07']) {
  const asset = await loadMaterials(`assets/models/moon-rocks/${id}/${id}_1k.gltf`);
  const definition = asset.json.materials[0];
  const texture = asset.json.textures[definition.pbrMetallicRoughness.metallicRoughnessTexture.index];
  assert.match(asset.json.images[texture.source].uri, /_arm_1k\.jpg$/, 'AO restoration requires verified packed ARM');
  const source = asset.materials[0];
  const material = prepareScannedRockMaterial(source, { packedARM: true });
  assertMapsPreserved(source, material);
  assert.equal(material.roughness, source.roughness);
  assert.equal(material.aoMap, source.roughnessMap);
  assert.equal(material.aoMap.channel, source.roughnessMap.channel);
  assert.equal(material.aoMap.colorSpace, THREE.NoColorSpace);
}
const customAO = new THREE.MeshStandardMaterial({ roughness: 0.43, metalness: 0 });
customAO.roughnessMap = new THREE.Texture();
customAO.aoMap = new THREE.Texture();
customAO.aoMap.channel = 1;
customAO.normalScale.set(0.55, -0.75);
const preservedAO = prepareScannedRockMaterial(customAO, { packedARM: true });
assertMapsPreserved(customAO, preservedAO);
const unknown = new THREE.MeshStandardMaterial({ roughnessMap: new THREE.Texture() });
assert.equal(prepareScannedRockMaterial(unknown).aoMap, null, 'An arbitrary roughness map is not an AO map');

// Existing textures, including clearcoat normal and specular extension maps,
// change anisotropy live without changing data or UV semantics.
for (const value of [16, 8, 4, 16]) {
  setMaterialAnisotropy(surfaces, value);
  for (const key of maps) if (surfaces[key]) assert.equal(surfaces[key].anisotropy, value);
  assertMapsPreserved(sourceSurfaces, surfaces);
}

// Compose production terrain lighting after the surface hook, as boot does.
const terrain = Object.assign(Object.create(Terrain.prototype), {
  trailRT: { texture: new THREE.Texture() }, sunRT: { texture: new THREE.Texture() },
  TRAIL_EXT: 900, dentRes: 4096, renderer: { shadowMap: { enabled: true } }
});
terrain.buildMaterial();
const group = new THREE.Group();
group.add(new THREE.Mesh(new THREE.BoxGeometry(), surfaces),
  new THREE.Mesh(new THREE.BoxGeometry(), finishes.get('blinn1SG')));
terrain.installMeshLighting(group);
for (const mesh of group.children) {
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  mesh.material.onBeforeCompile(shader, {});
  assert.ok(shader.uniforms.uFinishDust);
  assert.equal(shader.uniforms.uLocalTerrainMask, terrain.uniforms.uSunMask);
  assert.match(shader.fragmentShader, /inverseTransformDirection\(nonPerturbedNormal, viewMatrix\)/);
  assert.ok(shader.fragmentShader.indexOf('#include <normal_fragment_maps>') < shader.fragmentShader.indexOf('float finishDust'));
  assert.equal((shader.fragmentShader.match(/float finishDust/g) || []).length, 1);
  assert.doesNotMatch(shader.fragmentShader, /sampler2D\s+uFinish/, 'Finishes must not add texture samplers');
}

// Exercise the real rover/props quality setters. A same-cast resize and an
// off/on transition both dispose old targets exactly once, including VSM maps.
const beam = new THREE.SpotLight();
const otherBeam = new THREE.SpotLight();
const stationLight = new THREE.SpotLight();
const rover = Object.assign(Object.create(Rover.prototype), { root: new THREE.Group(), headlightSources: [beam, otherBeam] });
const props = Object.assign(Object.create(Props.prototype), {
  group: new THREE.Group(), stationHeroLight: stationLight, setBoulderDensity() {}
});
let disposed = 0;
function allocate(light) {
  if (!light.castShadow) return;
  assert.equal(light.shadow.map, null);
  for (const key of ['map', 'mapPass']) {
    light.shadow[key] = new THREE.WebGLRenderTarget(light.shadow.mapSize.x, light.shadow.mapSize.y);
    light.shadow[key].addEventListener('dispose', () => disposed++);
  }
}
for (const q of [
  { roverShadow: 1024, stationShadow: 1536, anisotropy: 8 },
  { roverShadow: 2048, stationShadow: 2048, anisotropy: 16 },
  { roverShadow: 1024, stationShadow: 1536, anisotropy: 8 },
  { roverShadow: 512, stationShadow: 0, anisotropy: 4 },
  { roverShadow: 0, stationShadow: 0, anisotropy: 2 },
  { roverShadow: 2048, stationShadow: 2048, anisotropy: 16 }
]) {
  q.boulders = 2200;
  const liveTargets = [beam, stationLight].reduce((n, light) => n + (light.shadow.map ? 2 : 0), 0);
  const before = disposed;
  rover.setQuality(q);
  props.setQuality(q);
  assert.equal(disposed - before, liveTargets, 'Each quality transition must release the previous render targets');
  assert.equal(beam.castShadow, q.roverShadow > 0);
  assert.equal(otherBeam.castShadow, false, 'Only the hero rover beam may cast');
  assert.equal(stationLight.castShadow, q.stationShadow > 0);
  if (beam.castShadow) assert.equal(beam.shadow.mapSize.x, q.roverShadow);
  if (stationLight.castShadow) assert.equal(stationLight.shadow.mapSize.y, q.stationShadow);
  allocate(beam); allocate(stationLight);
  const currentMap = beam.shadow.map;
  const stableDisposals = disposed;
  rover.setQuality(q); props.setQuality(q);
  assert.equal(beam.shadow.map, currentMap, 'Reapplying a tier must reuse its shadow map');
  assert.equal(disposed, stableDisposals);
}
// Y-only mismatch must also invalidate a stale target.
beam.shadow.mapSize.y = 1024;
const oldDisposals = disposed;
setPracticalShadow(beam, 2048);
assert.equal(disposed - oldDisposals, 2);
setPracticalShadow(stationLight, 0);

console.log('PASS: actual rover/base/lander/rock glTF material definitions; preserved maps, UV channels, PBR factors and emissive scaling.');
console.log('PASS: differentiated finishes, idempotent rover coating, existing terrain hooks, no extra finish samplers.');
console.log('PASS: HIGH ↔ ULTRA → MEDIUM → LOW → ULTRA shadow resolution / disposal and live anisotropy.');
