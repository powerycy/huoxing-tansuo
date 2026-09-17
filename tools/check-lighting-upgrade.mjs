// Run: node tools/check-lighting-upgrade.mjs
// CPU regressions against the vendored Three and real game methods. This does
// not replace browser shader compilation, shadow/acne inspection or frame QA.
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
const { Terrain } = await import('../src/world/terrain.js');
const { Props } = await import('../src/world/props.js');

// Skip only the generated terrain and GPU render targets. The material builder
// and all the lighting methods under test are the production implementations.
const terrain = Object.assign(Object.create(Terrain.prototype), {
  trailRT: { texture: new THREE.Texture() },
  sunRT: { texture: new THREE.Texture() },
  TRAIL_EXT: 900, dentRes: 4096,
  renderer: { shadowMap: { enabled: true } }
});
terrain.buildMaterial();

function activeSamplers(...stages) {
  const declarations = new Map();
  const sources = stages.map(source => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/uniform\s+(?:(?:lowp|mediump|highp)\s+)?sampler\w+\s+([^;]+);/g, (_, list) => {
      for (const spec of list.split(',')) {
        const match = spec.trim().match(/^(\w+)(?:\s*\[\s*(\d+)\s*\])?$/);
        assert.ok(match, `Sampler declaration needs an explicit test budget: ${spec}`);
        const [, name, size] = match;
        const units = Number(size || 1);
        assert.ok(!declarations.has(name) || declarations.get(name) === units,
          `Mismatched sampler declaration across stages: ${name}`);
        declarations.set(name, units);
      }
      return '';
    }));
  const source = sources.join('\n');
  return [...declarations].filter(([name]) => new RegExp(`\\b${name}\\b`).test(source));
}

// Count the VS + FS union, not merely the fragment stage. The Apple driver's
// 16-unit allocation limit was exceeded by the first two-shadow implementation.
const samplers = activeSamplers(terrain.material.vertexShader, terrain.material.fragmentShader);
const samplerUnits = samplers.reduce((sum, [, units]) => sum + units, 0);
assert.ok(samplerUnits <= 16, `Terrain uses ${samplerUnits} texture units; supported budget is 16`);
for (const name of ['uMacro', 'uFar', 'uDetail', 'uDent', 'uRShadow', 'uLampShadow', 'uFacilityShadow']) {
  assert.ok(samplers.some(([sampler]) => sampler === name), `${name} must be counted`);
}
assert.deepEqual(activeSamplers('uniform sampler2D both; void main(){ texture2D(both,vec2(0)); }',
  'uniform sampler2D both; uniform sampler2D unused; void main(){ texture2D(both,vec2(0)); }'),
[['both', 1]], 'The budget helper must deduplicate a uniform shared by both shader stages');
for (const name of ['uRShadow', 'uLampShadow', 'uFacilityShadow']) {
  const texture = terrain.uniforms[name].value;
  assert.ok(texture.isDataTexture, `${name} must have a complete fallback texture`);
  assert.deepEqual([...texture.image.data], [255, 255, 255, 255]);
}
assert.doesNotMatch(terrain.material.fragmentShader, /smoothstep\(0\.5,\s*0\.42/);

// Existing rock/custom PBR callbacks survive, shared materials are patched
// once, and custom flower/grass ShaderMaterials are deliberately untouched.
const material = new THREE.MeshStandardMaterial();
let previousCalls = 0;
material.onBeforeCompile = shader => {
  previousCalls++;
  shader.uniforms.retainedRockControl = { value: 42 };
};
material.customProgramCacheKey = () => 'existing-rock-program';
const shaderMaterial = new THREE.ShaderMaterial();
const basicMaterial = new THREE.MeshBasicMaterial();
const shaderCallback = shaderMaterial.onBeforeCompile;
const basicCallback = basicMaterial.onBeforeCompile;
const root = new THREE.Group();
const geometry = new THREE.BoxGeometry();
root.add(new THREE.Mesh(geometry, material), new THREE.InstancedMesh(geometry, material, 2),
  new THREE.Mesh(geometry, shaderMaterial), new THREE.Mesh(geometry, basicMaterial));
terrain.installMeshLighting(root);
const installedCallback = material.onBeforeCompile;
terrain.installMeshLighting(root);
assert.equal(material.onBeforeCompile, installedCallback, 'Repeated install must not stack callbacks');
assert.equal(shaderMaterial.onBeforeCompile, shaderCallback, 'Grass/flower shaders are out of scope');
assert.equal(basicMaterial.onBeforeCompile, basicCallback, 'Unlit materials are out of scope');
const shader = {
  uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
  fragmentShader: THREE.ShaderLib.standard.fragmentShader
};
material.onBeforeCompile(shader, {});
assert.equal(previousCalls, 1);
assert.equal(shader.uniforms.retainedRockControl.value, 42);
assert.equal(shader.uniforms.uLocalTerrainMask, terrain.uniforms.uSunMask);
assert.equal(shader.uniforms.uLocalTerrainKey, terrain.uniforms.uSunDir);
assert.equal(shader.uniforms.uLocalEnvironmentGain, terrain.uniforms.uMeshEnvGain);
assert.equal(material.customProgramCacheKey(), 'existing-rock-program|local-terrain-key-v1');
assert.match(shader.vertexShader, /instanceMatrix \* localTerrainWorld/);
assert.match(shader.fragmentShader, /texture2D\(uLocalTerrainMask,terrainUV\)\.r/);
assert.match(shader.fragmentShader, /envMapIntensity \* uLocalEnvironmentGain/);
assert.match(shader.fragmentShader, /getDirectionalLightInfo\( directionalLight, directLight \);/);
assert.match(shader.fragmentShader, /getSpotLightInfo\( spotLight, geometryPosition, directLight \);/);

// Rotated/transformed hierarchies matter: guessed rover-centre lamp positions
// caused terrain and the imported meshes to receive visibly different beams.
const lights = new THREE.Group();
lights.position.set(20, 7, -30);
lights.rotation.y = 0.9;
function createLamp(position, target, intensity = 210) {
  const light = new THREE.SpotLight(0xffffff, intensity, 46, 0.66, 0.55);
  light.position.fromArray(position);
  light.target = new THREE.Object3D();
  light.target.position.fromArray(target);
  light.castShadow = true;
  light.shadow.map = new THREE.WebGLRenderTarget(8, 8);
  light.shadow.mapSize.set(8, 8);
  lights.add(light, light.target);
  return light;
}
const roverLamp = createLamp([1, 3, 4], [0, 0, 10]);
const stationLamp = createLamp([-7, 9, -20], [-8, 0, -30]);
terrain.syncPracticalLights(roverLamp, stationLamp);
const U = terrain.uniforms;
const position = roverLamp.getWorldPosition(new THREE.Vector3());
const direction = roverLamp.target.getWorldPosition(new THREE.Vector3()).sub(position).normalize();
assert.ok(U.uLamp.value.distanceTo(position) < 1e-8);
assert.ok(U.uLampDir.value.distanceTo(direction) < 1e-8);
assert.equal(U.uLampCone.value.x, Math.cos(roverLamp.angle));
assert.equal(U.uLampCone.value.y, Math.cos(roverLamp.angle * (1 - roverLamp.penumbra)));
assert.equal(U.uLampRange.value, roverLamp.distance, 'Terrain beam range must follow the physical headlight');
const stationPosition = stationLamp.getWorldPosition(new THREE.Vector3());
assert.deepEqual(U.uFacilityB.value.toArray().slice(0, 3), stationPosition.toArray());
assert.equal(U.uFacilityB.value.w, stationLamp.distance);
assert.equal(U.uFacilityBPower.value, 1);
assert.equal(U.uLampShadow.value, roverLamp.shadow.map.texture);
assert.equal(U.uFacilityShadow.value, stationLamp.shadow.map.texture);
assert.equal(U.uLampShadowMat.value, roverLamp.shadow.matrix);
assert.equal(U.uFacilityShadowMat.value, stationLamp.shadow.matrix);
roverLamp.shadow.matrix.elements[12] = 123;
assert.equal(U.uLampShadowMat.value.elements[12], 123, 'Shadow update must remain live, not a copied frame');
assert.equal(U.uLampShadowTexel.value, 1 / 8);
stationLamp.intensity = 0;
terrain.syncPracticalLights(roverLamp, stationLamp);
assert.equal(U.uFacilityBPower.value, 0);
stationLamp.intensity = 210;
stationLamp.visible = false;
terrain.syncPracticalLights(roverLamp, stationLamp);
assert.equal(U.uFacilityBPower.value, 0);
terrain.renderer.shadowMap.enabled = false;
terrain.syncPracticalLights(roverLamp, stationLamp);
assert.equal(U.uLampShadowOn.value, 0);
assert.equal(U.uFacilityShadowOn.value, 0);
terrain.renderer.shadowMap.enabled = true;
roverLamp.castShadow = false;
terrain.syncPracticalLights(roverLamp, stationLamp);
assert.equal(U.uLampShadowOn.value, 0);
terrain.syncPracticalLights(null, null);
assert.equal(U.uFacilityBPower.value, 0);
assert.equal(U.uLampShadowOn.value, 0);
assert.equal(U.uFacilityShadowOn.value, 0);

// Exercise the real station wake/reset method without loading a GLB or DOM.
const emissive = () => ({ emissiveIntensity: 99 });
const props = Object.assign(Object.create(Props.prototype), {
  stationTerminalMat: emissive(), stationWindowMat: emissive(),
  stationInteriorLight: { intensity: 99 },
  stationNativeEmissives: [{ material: emissive(), intensity: 0.7 }],
  stationExteriorMaterials: [{ material: emissive(), intensity: 3.8 }],
  stationExteriorLights: [{ light: { intensity: 99 }, intensity: 210 }]
});
function assertAllOff() {
  assert.equal(props.stationOnline, false);
  assert.equal(props.stationTerminalMat.emissiveIntensity, 0);
  assert.equal(props.stationWindowMat.emissiveIntensity, 0);
  assert.equal(props.stationInteriorLight.intensity, 0);
  assert.equal(props.stationNativeEmissives[0].material.emissiveIntensity, 0);
  assert.equal(props.stationExteriorMaterials[0].material.emissiveIntensity, 0);
  assert.equal(props.stationExteriorLights[0].light.intensity, 0);
}
props.setStationPowerProgress(-1);
assertAllOff();
props.setStationPowerProgress(0.10);
assert.ok(props.stationTerminalMat.emissiveIntensity > 0);
assert.equal(props.stationWindowMat.emissiveIntensity, 0);
props.setStationPowerProgress(0.30);
assert.ok(props.stationWindowMat.emissiveIntensity > 0);
assert.equal(props.stationExteriorLights[0].light.intensity, 0);
let previous = [0, 0, 0];
for (let i = 0; i <= 100; i++) {
  props.setStationPowerProgress(i / 100);
  const next = [props.stationWindowMat.emissiveIntensity,
    props.stationExteriorMaterials[0].material.emissiveIntensity,
    props.stationExteriorLights[0].light.intensity];
  next.forEach((value, index) => assert.ok(value >= previous[index], 'Wake-up intensity must not flicker'));
  previous = next;
}
props.setStationPowerProgress(2);
assert.equal(props.stationOnline, true);
assert.equal(props.stationWindowMat.emissiveIntensity, 3.2);
assert.equal(props.stationInteriorLight.intensity, 48);
assert.equal(props.stationExteriorLights[0].light.intensity, 210);
props.setStationPowerProgress(0);
assertAllOff();

for (const lamp of [roverLamp, stationLamp]) lamp.shadow.map.dispose();
for (const object of [geometry, material, shaderMaterial, basicMaterial, terrain.material,
  terrain._emptyShadow, terrain.sunRT.texture, terrain.trailRT.texture]) object.dispose();
console.log(`PASS: ${samplerUnits}/16 combined terrain sampler units; chained/idempotent material hooks;`);
console.log('PASS: real lamp transforms, cone parameters, live shadow matrices and complete fallbacks;');
console.log('PASS: station terminal → windows → exterior sequence, monotonic illumination and full reset.');
